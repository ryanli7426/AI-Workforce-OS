import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ApiClient,
  Employee,
  ManagementAudit,
  ManagementCommand,
  ManagementResult,
  Project,
} from '../api.ts'
import { EmployeesManager, ProjectsManager } from './management.tsx'

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false },
      mutations: { retry: false },
    },
  })
}

function wrap(ui: ReactElement, client = createQueryClient()): ReactElement {
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}

function projectFixture(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    workspaceId: 'local',
    name: '演示项目',
    ownerId: 'owner-1',
    repositoryPath: '/tmp/repo',
    worktreeRoot: '/tmp/worktrees',
    allowedTaskTypes: ['code', 'docs'],
    archived: false,
    version: 1,
    ...overrides,
  }
}

function employeeFixture(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'emp-1',
    workspaceId: 'local',
    name: '演示员工',
    role: 'coder',
    responsibilities: ['编码'],
    capabilities: ['editing'],
    runtimeId: 'claude-local',
    projectIds: ['proj-1'],
    maxConcurrency: 1,
    timeoutMs: 60_000,
    enabled: false,
    version: 1,
    ...overrides,
  }
}

function auditFixture(overrides: Partial<ManagementAudit> = {}): ManagementAudit {
  return {
    id: 'audit-1',
    actorId: 'owner-1',
    workspaceId: 'local',
    kind: 'employee',
    resourceId: 'emp-1',
    action: 'employee-update',
    reason: '调整岗位',
    beforeVersion: 1,
    afterVersion: 2,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

function mockApi(partial: Partial<ApiClient> = {}): ApiClient {
  return {
    manage: vi.fn(),
    managementHistory: vi.fn(async () => ({ items: [] })),
    executions: vi.fn().mockResolvedValue({items:[]}),
    me: vi.fn(),
    overview: vi.fn(),
    employees: vi.fn(async () => [employeeFixture()]),
    projects: vi.fn(async () => [projectFixture()]),
    tasks: vi.fn(),
    task: vi.fn(),
    execution: vi.fn(),
    logs: vi.fn(),
    command: vi.fn(),
    ...partial,
  }
}

class ConflictError extends Error {
  readonly status = 409
  readonly code = 'VERSION_CONFLICT'
  constructor() {
    super('version conflict')
    this.name = 'ConflictError'
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('EmployeesManager', () => {
  it('creates employees as disabled config and requires a separate enable confirmation', async () => {
    const commands: Array<{ key: string; command: ManagementCommand }> = []
    let employees = [employeeFixture({ enabled: false, version: 1 })]
    const api = mockApi({
      employees: vi.fn(async () => employees),
      manage: vi.fn(async (key, command) => {
        commands.push({ key, command })
        if (command.kind === 'employee-create') {
          const created = employeeFixture({
            id: command.input.id,
            name: command.input.name,
            role: command.input.role,
            responsibilities: command.input.responsibilities,
            capabilities: command.input.capabilities,
            runtimeId: command.input.runtimeId,
            projectIds: command.input.projectIds,
            maxConcurrency: command.input.maxConcurrency,
            timeoutMs: command.input.timeoutMs,
            enabled: false,
            version: 1,
          })
          employees = [...employees, created]
          return { kind: 'employee', employee: created, replayed: false } satisfies ManagementResult
        }
        if (command.kind === 'employee-enable') {
          employees = employees.map(item => item.id === command.id
            ? { ...item, enabled: command.input.enabled, version: item.version + 1 }
            : item)
          const employee = employees.find(item => item.id === command.id)!
          return { kind: 'employee', employee, replayed: false } satisfies ManagementResult
        }
        throw new Error(`unexpected ${command.kind}`)
      }),
    })

    render(wrap(<EmployeesManager api={api} />))
    expect(await screen.findByText('演示员工')).toBeTruthy()
    expect(screen.getByText(/创建后的员工始终为未启用/)).toBeTruthy()

    fireEvent.change(screen.getByLabelText('员工 ID'), { target: { value: 'emp-new' } })
    fireEvent.change(screen.getByLabelText('员工名称'), { target: { value: '新员工' } })
    fireEvent.change(screen.getByLabelText('员工岗位'), { target: { value: 'reviewer' } })
    fireEvent.change(screen.getByLabelText('职责'), { target: { value: '审查\n反馈' } })
    fireEvent.change(screen.getByLabelText('能力'), { target: { value: 'reading' } })
    fireEvent.click(screen.getByLabelText('绑定项目 演示项目'))
    fireEvent.change(screen.getByLabelText('最大并发'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('超时毫秒'), { target: { value: '120000' } })
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '补充审查人力' } })
    fireEvent.click(screen.getByRole('button', { name: '预览创建' }))

    const createPreview = await screen.findByRole('region', { name: '操作确认预览' })
    expect(within(createPreview).getByText(/操作：创建员工（创建后为未启用）/)).toBeTruthy()
    expect(within(createPreview).getByText(/名称：新员工/)).toBeTruthy()
    expect(within(createPreview).getByText(/岗位：reviewer/)).toBeTruthy()
    expect(within(createPreview).getByText(/职责：审查、反馈/)).toBeTruthy()
    expect(within(createPreview).getByText(/能力：reading/)).toBeTruthy()
    expect(within(createPreview).getByText(/Runtime：claude-local/)).toBeTruthy()
    expect(within(createPreview).getByText(/项目成员：proj-1/)).toBeTruthy()
    expect(within(createPreview).getByText(/最大并发：2/)).toBeTruthy()
    expect(within(createPreview).getByText(/超时（毫秒）：120000/)).toBeTruthy()
    expect(within(createPreview).getByText(/启用状态：未启用/)).toBeTruthy()
    expect(commands).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: '确认提交' }))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]?.command).toEqual({
      kind: 'employee-create',
      reason: '补充审查人力',
      input: {
        id: 'emp-new',
        name: '新员工',
        role: 'reviewer',
        responsibilities: ['审查', '反馈'],
        capabilities: ['reading'],
        runtimeId: 'claude-local',
        projectIds: ['proj-1'],
        maxConcurrency: 2,
        timeoutMs: 120_000,
      },
    })
    expect(await screen.findByText('命令已生效。')).toBeTruthy()

    fireEvent.click(await screen.findByRole('button', { name: '编辑员工 新员工' }))
    expect(await screen.findByRole('button', { name: '预览启用' })).toBeTruthy()
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '确认可接单' } })
    fireEvent.click(screen.getByRole('button', { name: '预览启用' }))
    expect(screen.getByText(/启用仅切换可接单配置/)).toBeTruthy()
    const enablePreview = await screen.findByRole('region', { name: '操作确认预览' })
    expect(within(enablePreview).getByText(/操作：启用员工/)).toBeTruthy()
    expect(within(enablePreview).getByText(/启用状态：启用/)).toBeTruthy()
    expect(within(enablePreview).getByText(/期望版本：1/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }))
    await waitFor(() => expect(commands).toHaveLength(2))
    expect(commands[1]?.command).toEqual({
      kind: 'employee-enable',
      id: 'emp-new',
      reason: '确认可接单',
      input: { expectedVersion: 1, enabled: true },
    })
  })

  it('locks sensitive fields while enabled and sends exact name/role-only update DTO', async () => {
    const commands: ManagementCommand[] = []
    const api = mockApi({
      employees: vi.fn(async () => [employeeFixture({ enabled: true, version: 3 })]),
      manage: vi.fn(async (_key, command) => {
        commands.push(command)
        return {
          kind: 'employee',
          employee: employeeFixture({
            enabled: true,
            version: 4,
            name: command.kind === 'employee-update' ? command.input.name ?? '演示员工' : '演示员工',
            role: command.kind === 'employee-update' ? command.input.role ?? 'coder' : 'coder',
          }),
          replayed: false,
        } satisfies ManagementResult
      }),
    })

    render(wrap(<EmployeesManager api={api} />))
    fireEvent.click(await screen.findByRole('button', { name: '编辑员工 演示员工' }))
    expect(await screen.findByText(/敏感字段/)).toBeTruthy()
    expect((screen.getByLabelText('职责') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByLabelText('能力') as HTMLTextAreaElement).disabled).toBe(true)
    expect((screen.getByLabelText('Runtime') as HTMLSelectElement).disabled).toBe(true)
    expect((screen.getByLabelText('最大并发') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('超时毫秒') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('绑定项目 演示项目') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('员工名称') as HTMLInputElement).disabled).toBe(false)
    expect((screen.getByLabelText('员工岗位') as HTMLInputElement).disabled).toBe(false)

    fireEvent.change(screen.getByLabelText('员工名称'), { target: { value: '改名员工' } })
    fireEvent.change(screen.getByLabelText('员工岗位'), { target: { value: 'lead' } })
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '仅改名称岗位' } })
    fireEvent.click(screen.getByRole('button', { name: '预览更新' }))
    const preview = await screen.findByRole('region', { name: '操作确认预览' })
    expect(within(preview).getByText(/名称：改名员工/)).toBeTruthy()
    expect(within(preview).getByText(/岗位：lead/)).toBeTruthy()
    expect(within(preview).getByText(/期望版本：3/)).toBeTruthy()
    expect(within(preview).queryByText(/Runtime：/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).toEqual({
      kind: 'employee-update',
      id: 'emp-1',
      reason: '仅改名称岗位',
      input: {
        expectedVersion: 3,
        name: '改名员工',
        role: 'lead',
      },
    })
    expect(commands[0]).not.toHaveProperty('input.runtimeId')
    expect(commands[0]).not.toHaveProperty('input.projectIds')
    expect(commands[0]).not.toHaveProperty('input.capabilities')
    expect(commands[0]).not.toHaveProperty('input.responsibilities')
    expect(commands[0]).not.toHaveProperty('input.maxConcurrency')
    expect(commands[0]).not.toHaveProperty('input.timeoutMs')
  })

  it('preserves draft and original expectedVersion when polled query data changes during edit', async () => {
    const client = createQueryClient()
    const api = mockApi({
      employees: vi.fn(async () => [employeeFixture({ enabled: false, version: 2, name: '演示员工' })]),
    })

    render(wrap(<EmployeesManager api={api} />, client))
    fireEvent.click(await screen.findByRole('button', { name: '编辑员工 演示员工' }))
    fireEvent.change(screen.getByLabelText('员工名称'), { target: { value: '本地草稿名' } })
    fireEvent.change(screen.getByLabelText('最大并发'), { target: { value: '3' } })

    client.setQueryData(['employees'], [
      employeeFixture({ enabled: false, version: 9, name: '远端新名', maxConcurrency: 8 }),
    ])

    expect(await screen.findByText(/远端记录已变更/)).toBeTruthy()
    expect(screen.getByText(/基准版本 2 → 当前 9/)).toBeTruthy()
    expect((screen.getByLabelText('员工名称') as HTMLInputElement).value).toBe('本地草稿名')
    expect((screen.getByLabelText('最大并发') as HTMLInputElement).value).toBe('3')

    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '仍按原基准提交' } })
    fireEvent.click(screen.getByRole('button', { name: '预览更新' }))
    const preview = await screen.findByRole('region', { name: '操作确认预览' })
    expect(within(preview).getByText(/期望版本：2/)).toBeTruthy()
    expect(within(preview).getByText(/名称：本地草稿名/)).toBeTruthy()
    expect(within(preview).getByText(/最大并发：3/)).toBeTruthy()
    expect(within(preview).queryByText(/期望版本：9/)).toBeNull()
  })

  it('keeps pending confirmation expectedVersion when query refreshes underneath', async () => {
    const client = createQueryClient()
    const commands: ManagementCommand[] = []
    const api = mockApi({
      employees: vi.fn(async () => [employeeFixture({ enabled: false, version: 4 })]),
      manage: vi.fn(async (_key, command) => {
        commands.push(command)
        return {
          kind: 'employee',
          employee: employeeFixture({
            enabled: false,
            version: 5,
            name: command.kind === 'employee-update' ? command.input.name ?? '演示员工' : '演示员工',
          }),
          replayed: false,
        } satisfies ManagementResult
      }),
    })

    render(wrap(<EmployeesManager api={api} />, client))
    fireEvent.click(await screen.findByRole('button', { name: '编辑员工 演示员工' }))
    fireEvent.change(screen.getByLabelText('员工名称'), { target: { value: '确认中的草稿' } })
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '确认时远端变了' } })
    fireEvent.click(screen.getByRole('button', { name: '预览更新' }))
    const preview = await screen.findByRole('region', { name: '操作确认预览' })
    expect(within(preview).getByText(/期望版本：4/)).toBeTruthy()

    client.setQueryData(['employees'], [
      employeeFixture({ enabled: false, version: 11, name: '被他人改过' }),
    ])
    expect(await screen.findByText(/远端记录已变更/)).toBeTruthy()
    expect(within(preview).getByText(/期望版本：4/)).toBeTruthy()
    expect(within(preview).getByText(/名称：确认中的草稿/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '确认提交' }))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).toEqual({
      kind: 'employee-update',
      id: 'emp-1',
      reason: '确认时远端变了',
      input: {
        expectedVersion: 4,
        name: '确认中的草稿',
        role: 'coder',
      },
    })
  })

  it('on 409 clears preview/reason, force-reopens fresh row, and does not silently upgrade draft', async () => {
    let version = 2
    const commands: ManagementCommand[] = []
    const api = mockApi({
      employees: vi.fn(async () => [employeeFixture({ enabled: false, version, name: '演示员工' })]),
      manage: vi.fn(async (_key, command) => {
        commands.push(command)
        version = 5
        throw new ConflictError()
      }),
    })

    render(wrap(<EmployeesManager api={api} />))
    fireEvent.click(await screen.findByRole('button', { name: '编辑员工 演示员工' }))
    fireEvent.change(screen.getByLabelText('员工名称'), { target: { value: '冲突更新' } })
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '第一次确认' } })
    fireEvent.click(screen.getByRole('button', { name: '预览更新' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认提交' }))

    expect((await screen.findByRole('alert')).textContent ?? '').toMatch(/409/)
    expect(screen.queryByRole('region', { name: '操作确认预览' })).toBeNull()
    expect((screen.getByLabelText('操作原因') as HTMLTextAreaElement).value).toBe('')
    expect((screen.getByLabelText('员工名称') as HTMLInputElement).value).toBe('演示员工')

    fireEvent.change(screen.getByLabelText('员工名称'), { target: { value: '基于新快照' } })
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '基于新版本再确认' } })
    fireEvent.click(screen.getByRole('button', { name: '预览更新' }))
    const preview = await screen.findByRole('region', { name: '操作确认预览' })
    expect(within(preview).getByText(/期望版本：5/)).toBeTruthy()
    expect(within(preview).getByText(/名称：基于新快照/)).toBeTruthy()
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({
      kind: 'employee-update',
      input: { expectedVersion: 2, name: '冲突更新' },
    })
  })

  it('reuses stable idempotency key after ambiguous network failure', async () => {
    const commands: Array<{ key: string; command: ManagementCommand }> = []
    const api = mockApi({
      employees: vi.fn(async () => [employeeFixture({ enabled: false, version: 4 })]),
      manage: vi.fn(async (key, command) => {
        commands.push({ key, command })
        if (commands.length === 1) throw new Error('network')
        return {
          kind: 'employee',
          employee: employeeFixture({ enabled: false, version: 5, name: '重试员工' }),
          replayed: false,
        } satisfies ManagementResult
      }),
    })

    render(wrap(<EmployeesManager api={api} />))
    fireEvent.click(await screen.findByRole('button', { name: '编辑员工 演示员工' }))
    fireEvent.change(screen.getByLabelText('员工名称'), { target: { value: '重试员工' } })
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '网络不稳仍同意图' } })
    fireEvent.click(screen.getByRole('button', { name: '预览更新' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认提交' }))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect((await screen.findByRole('alert')).textContent ?? '').toMatch(/命令失败/)

    fireEvent.click(screen.getByRole('button', { name: '确认提交' }))
    await waitFor(() => expect(commands).toHaveLength(2))
    expect(commands[1]?.key).toBe(commands[0]?.key)
    expect(commands[1]?.command).toEqual(commands[0]?.command)
    expect(await screen.findByText('命令已生效。')).toBeTruthy()
  })

  it('loads real bounded history with actor, action, reason and versions', async () => {
    const history = vi.fn(async () => ({
      items: [
        auditFixture({
          id: 'audit-9',
          actorId: 'owner-77',
          action: 'employee-enable',
          reason: '开放接单',
          beforeVersion: 2,
          afterVersion: 3,
        }),
      ],
    }))
    const api = mockApi({ managementHistory: history })

    render(wrap(<EmployeesManager api={api} />))
    fireEvent.click(await screen.findByRole('button', { name: '编辑员工 演示员工' }))
    expect(await screen.findByText(/开放接单/)).toBeTruthy()
    expect(screen.getByText(/操作者 owner-77/)).toBeTruthy()
    expect(screen.getByText(/employee-enable/)).toBeTruthy()
    expect(screen.getByText(/版本 2 → 3/)).toBeTruthy()
    expect(history).toHaveBeenCalledWith('employee', 'emp-1', expect.anything())
  })
})

describe('ProjectsManager', () => {
  it('updates only mutable fields and warns on archive scope', async () => {
    const commands: ManagementCommand[] = []
    let project = projectFixture({ version: 2 })
    const api = mockApi({
      projects: vi.fn(async () => [project]),
      manage: vi.fn(async (_key, command) => {
        commands.push(command)
        if (command.kind === 'project-update') {
          project = {
            ...project,
            name: command.input.name ?? project.name,
            ownerId: command.input.ownerId ?? project.ownerId,
            allowedTaskTypes: command.input.allowedTaskTypes ?? project.allowedTaskTypes,
            version: project.version + 1,
          }
          return { kind: 'project', project, replayed: false } satisfies ManagementResult
        }
        if (command.kind === 'project-archive') {
          project = { ...project, archived: true, version: project.version + 1 }
          return { kind: 'project', project, replayed: false } satisfies ManagementResult
        }
        throw new Error(`unexpected ${command.kind}`)
      }),
    })

    render(wrap(<ProjectsManager api={api} />))
    fireEvent.click(await screen.findByRole('button', { name: '编辑项目 演示项目' }))
    expect(screen.getByText(/仓库路径与工作树根目录创建后不可修改/)).toBeTruthy()
    expect((screen.getByLabelText('仓库路径') as HTMLInputElement).disabled).toBe(true)
    expect((screen.getByLabelText('工作树根目录') as HTMLInputElement).disabled).toBe(true)

    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '更新项目' } })
    fireEvent.change(screen.getByLabelText('业务负责人'), { target: { value: 'owner-2' } })
    fireEvent.change(screen.getByLabelText('允许任务类型'), { target: { value: 'code\nops' } })
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '调整负责人与类型' } })
    fireEvent.click(screen.getByRole('button', { name: '预览更新' }))
    const updatePreview = await screen.findByRole('region', { name: '操作确认预览' })
    expect(within(updatePreview).getByText(/名称：更新项目/)).toBeTruthy()
    expect(within(updatePreview).getByText(/业务负责人：owner-2/)).toBeTruthy()
    expect(within(updatePreview).getByText(/允许任务类型：code、ops/)).toBeTruthy()
    expect(within(updatePreview).getByText(/期望版本：2/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).toEqual({
      kind: 'project-update',
      id: 'proj-1',
      reason: '调整负责人与类型',
      input: {
        expectedVersion: 2,
        name: '更新项目',
        ownerId: 'owner-2',
        allowedTaskTypes: ['code', 'ops'],
      },
    })

    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '停止未来接入' } })
    fireEvent.click(screen.getByRole('button', { name: '预览归档' }))
    expect(screen.getByText(/阻止该项目的未来任务接入/)).toBeTruthy()
    expect(screen.getByText(/不会因此停止/)).toBeTruthy()
    const preview = await screen.findByRole('region', { name: '操作确认预览' })
    expect(within(preview).getByText(/归档项目/)).toBeTruthy()
    expect(within(preview).getByText(/期望版本：3/)).toBeTruthy()
    expect(within(preview).getByText(/归档状态：归档/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }))
    await waitFor(() => expect(commands).toHaveLength(2))
    expect(commands[1]).toEqual({
      kind: 'project-archive',
      id: 'proj-1',
      reason: '停止未来接入',
      input: { expectedVersion: 3 },
    })
  })

  it('preserves project draft expectedVersion across query refresh while editing', async () => {
    const client = createQueryClient()
    const api = mockApi({
      projects: vi.fn(async () => [projectFixture({ version: 2, name: '演示项目' })]),
    })

    render(wrap(<ProjectsManager api={api} />, client))
    fireEvent.click(await screen.findByRole('button', { name: '编辑项目 演示项目' }))
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '草稿项目名' } })
    fireEvent.change(screen.getByLabelText('业务负责人'), { target: { value: 'owner-draft' } })

    client.setQueryData(['projects'], [
      projectFixture({ version: 7, name: '远端项目', ownerId: 'owner-remote' }),
    ])

    expect(await screen.findByText(/远端记录已变更/)).toBeTruthy()
    expect((screen.getByLabelText('项目名称') as HTMLInputElement).value).toBe('草稿项目名')
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '按原版本归档前先更新' } })
    fireEvent.click(screen.getByRole('button', { name: '预览更新' }))
    const preview = await screen.findByRole('region', { name: '操作确认预览' })
    expect(within(preview).getByText(/期望版本：2/)).toBeTruthy()
    expect(within(preview).getByText(/名称：草稿项目名/)).toBeTruthy()
    expect(within(preview).getByText(/业务负责人：owner-draft/)).toBeTruthy()
  })

  it('creates project with absolute paths and shows history data', async () => {
    const commands: ManagementCommand[] = []
    const history = vi.fn(async () => ({
      items: [
        auditFixture({
          id: 'audit-p1',
          actorId: 'owner-9',
          kind: 'project',
          resourceId: 'proj-new',
          action: 'project-create',
          reason: '新仓库接入',
          beforeVersion: null,
          afterVersion: 1,
        }),
      ],
    }))
    const api = mockApi({
      projects: vi.fn(async () => []),
      managementHistory: history,
      manage: vi.fn(async (_key, command) => {
        commands.push(command)
        if (command.kind !== 'project-create') throw new Error('unexpected')
        return {
          kind: 'project',
          project: projectFixture({
            id: command.input.id,
            name: command.input.name,
            ownerId: command.input.ownerId,
            repositoryPath: command.input.repositoryPath,
            worktreeRoot: command.input.worktreeRoot,
            allowedTaskTypes: command.input.allowedTaskTypes,
            version: 1,
          }),
          replayed: false,
        } satisfies ManagementResult
      }),
    })

    render(wrap(<ProjectsManager api={api} />))
    expect(await screen.findByText('暂无记录')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('项目 ID'), { target: { value: 'proj-new' } })
    fireEvent.change(screen.getByLabelText('项目名称'), { target: { value: '新项目' } })
    fireEvent.change(screen.getByLabelText('业务负责人'), { target: { value: 'owner-9' } })
    fireEvent.change(screen.getByLabelText('仓库路径'), { target: { value: '/srv/repo' } })
    fireEvent.change(screen.getByLabelText('工作树根目录'), { target: { value: '/srv/worktrees' } })
    fireEvent.change(screen.getByLabelText('允许任务类型'), { target: { value: 'code' } })
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '新仓库接入' } })
    fireEvent.click(screen.getByRole('button', { name: '预览创建' }))
    const createPreview = await screen.findByRole('region', { name: '操作确认预览' })
    expect(within(createPreview).getByText(/仓库路径：\/srv\/repo/)).toBeTruthy()
    expect(within(createPreview).getByText(/工作树根目录：\/srv\/worktrees/)).toBeTruthy()
    expect(within(createPreview).getByText(/允许任务类型：code/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).toEqual({
      kind: 'project-create',
      reason: '新仓库接入',
      input: {
        id: 'proj-new',
        name: '新项目',
        ownerId: 'owner-9',
        repositoryPath: '/srv/repo',
        worktreeRoot: '/srv/worktrees',
        allowedTaskTypes: ['code'],
      },
    })

    const apiWithProject = mockApi({
      projects: vi.fn(async () => [projectFixture({ id: 'proj-new', name: '新项目' })]),
      managementHistory: history,
    })
    const second = render(wrap(<ProjectsManager api={apiWithProject} />))
    fireEvent.click(await second.findByRole('button', { name: '编辑项目 新项目' }))
    const historyPanel = await second.findByLabelText('项目变更历史')
    expect(await within(historyPanel).findByText(/新仓库接入/)).toBeTruthy()
    expect(within(historyPanel).getByText(/操作者 owner-9/)).toBeTruthy()
    expect(within(historyPanel).getByText(/版本 — → 1/)).toBeTruthy()
    expect(history).toHaveBeenCalledWith('project', 'proj-new', expect.anything())
  })
})

describe('existing archived project membership', () => {
 it('shows retained archived bindings, permits profile-only edits and allows explicit unbinding', async () => {
  const commands:ManagementCommand[]=[]
  const api=mockApi({projects:vi.fn(async()=>[projectFixture({archived:true})]),manage:vi.fn(async(_key:string,command:ManagementCommand):Promise<ManagementResult>=>{commands.push(command);return {kind:'employee',employee:employeeFixture({version:2}),replayed:false}})})
  render(wrap(<EmployeesManager api={api}/>))
  fireEvent.click(await screen.findByRole('button',{name:'编辑员工 演示员工'}))
  expect(screen.getByLabelText('绑定项目 演示项目')).toBeDefined()
  expect(screen.getByText(/已归档/)).toBeDefined()
  fireEvent.change(screen.getByLabelText('员工名称'),{target:{value:'新名称'}})
  fireEvent.change(screen.getByLabelText('操作原因'),{target:{value:'仅更新资料，不改变原项目绑定'}})
  fireEvent.click(screen.getByRole('button',{name:'预览更新'}));fireEvent.click(await screen.findByRole('button',{name:'确认提交'}))
  await waitFor(()=>expect(commands).toHaveLength(1))
  expect(commands[0]).toMatchObject({kind:'employee-update',input:{expectedVersion:1,name:'新名称',role:'coder'}})
  expect(commands[0] && 'projectIds' in commands[0].input).toBe(false)
  fireEvent.click(screen.getByLabelText('绑定项目 演示项目'))
  fireEvent.change(screen.getByLabelText('操作原因'),{target:{value:'明确移除已归档项目绑定'}})
  fireEvent.click(screen.getByRole('button',{name:'预览更新'}));fireEvent.click(await screen.findByRole('button',{name:'确认提交'}))
  await waitFor(()=>expect(commands).toHaveLength(2))
  expect(commands[1]).toMatchObject({kind:'employee-update',input:{expectedVersion:2,projectIds:[]}})
 })
})
