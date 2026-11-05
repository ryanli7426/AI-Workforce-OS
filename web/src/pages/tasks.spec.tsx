import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState, type ReactElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ApiClient,
  Employee,
  LocalTaskCommand,
  ProductTaskDetail,
  ProductTaskListResult,
  Project,
  TaskCommandResult,
} from '../api.ts'
import { TaskPage, TasksPage } from './tasks.tsx'

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  })
}

function wrap(ui: ReactElement, client = createQueryClient()): ReactElement {
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>
}

function baseTicket(overrides: Partial<ProductTaskDetail['ticket']> & { lifecycle?: ProductTaskDetail['ticket']['lifecycle'] } = {}): ProductTaskDetail['ticket'] {
  const lifecycle = overrides.lifecycle ?? {
    status: 'WAITING_APPROVAL' as const,
    version: 3,
    issue: {
      source: 'manual:local:proj-1',
      issueId: 'issue-1',
      revision: 'rev-1',
      updatedAt: '2026-01-01T00:00:00.000Z',
      description: '修复登录',
      priority: 1,
      closed: false,
    },
    taskType: 'code',
    policy: { approvalRequired: true, reviewRequired: true, retryLimit: 2 },
    policyVersion: 'policy-1',
    attempts: 0,
  }
  return {
    id: 'task-1',
    title: '修复登录',
    decisionId: 'decision-1',
    mandate: {
      strength: 'explicit',
      policyVersion: 'policy-1',
      basis: { via: 'listed' },
      actor: { source: 'manual:local:proj-1', id: 'owner-1' },
      scope: 'local',
    },
    channels: [],
    assignments: [],
    inputs: [],
    undelivered: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T01:00:00.000Z',
    origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] },
    ...overrides,
    lifecycle,
  }
}

function detailFixture(overrides: Partial<ProductTaskDetail> = {}): ProductTaskDetail {
  return {
    ticket: baseTicket(),
    executions: [],
    history: [],
    historyTruncated: false,
    executionsTruncated: false,
    ...overrides,
  }
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
    runtimeId: 'runtime-local',
    projectIds: ['proj-1'],
    maxConcurrency: 1,
    timeoutMs: 60_000,
    enabled: true,
    version: 1,
    ...overrides,
  }
}

function executionFixture(overrides: Partial<ProductTaskDetail['executions'][number]> = {}): ProductTaskDetail['executions'][number] {
  return {
    executionId: 'exec-1',
    assignmentId: 'asg-1',
    ticketId: 'task-1',
    agentId: 'emp-1',
    runtime: 'claude',
    generation: 1,
    cwd: '/tmp',
    inputRevision: 'in-1',
    policyVersion: 'policy-1',
    state: 'FAILED',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:10:00.000Z',
    lastSequence: 1,
    exitCode: 1,
    ...overrides,
  }
}

function listResult(items: ProductTaskListResult['items'], nextCursor?: number): ProductTaskListResult {
  return nextCursor === undefined ? { items } : { items, nextCursor }
}

function mockApi(partial: Partial<ApiClient> = {}): ApiClient {
  return {
    executions: vi.fn().mockResolvedValue({items:[]}),
    manage: vi.fn().mockRejectedValue(new Error('Unused management command')),
    managementHistory: vi.fn().mockResolvedValue({items:[]}),
    me: vi.fn(),
    overview: vi.fn(),
    employees: vi.fn(async () => [employeeFixture()]),
    projects: vi.fn(async () => [projectFixture()]),
    tasks: vi.fn(async () => listResult([])),
    task: vi.fn(),
    execution: vi.fn(),
    logs: vi.fn(async () => ({ ticketId: 'task-1', executions: [] })),
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
  window.location.hash = ''
  vi.restoreAllMocks()
})

describe('TasksPage', () => {
  it('lists tasks and creates with validation, stable idempotency key, and success link', async () => {
    const commands: Array<{ key: string; command: LocalTaskCommand }> = []
    const api = mockApi({
      tasks: vi.fn(async () => listResult([
        {
          id: 'task-1',
          title: '已有任务',
          status: 'QUEUED',
          updatedAt: '2026-01-01T00:00:00.000Z',
          priority: 1,
          source: 'manual:local:proj-1',
          rowid: 10,
        },
      ])),
      command: vi.fn(async (key, command) => {
        commands.push({ key, command })
        if (commands.length === 1) throw new Error('network')
        return {
          ticket: baseTicket({ id: 'task-new', title: '新建任务' }),
          replayed: commands.length > 2,
        } satisfies TaskCommandResult
      }),
    })

    render(wrap(<TasksPage api={api} />))

    expect((await screen.findByRole('link', { name: '已有任务' })).getAttribute('href')).toBe('#/tasks/task-1')

    fireEvent.change(screen.getByLabelText('创建项目'), { target: { value: 'proj-1' } })
    await waitFor(() => expect((screen.getByLabelText('任务类型') as HTMLSelectElement).disabled).toBe(false))
    fireEvent.change(screen.getByLabelText('任务类型'), { target: { value: 'code' } })
    fireEvent.change(screen.getByLabelText('任务标题'), { target: { value: '新建任务' } })
    fireEvent.change(screen.getByLabelText('任务描述'), { target: { value: '详细说明' } })
    fireEvent.change(screen.getByLabelText('优先级'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('issueId'), { target: { value: 'issue-9' } })

    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]?.command).toEqual({
      kind: 'create',
      input: {
        issueId: 'issue-9',
        projectId: 'proj-1',
        title: '新建任务',
        description: '详细说明',
        taskType: 'code',
        priority: 2,
      },
    })

    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(commands).toHaveLength(2))
    expect(commands[1]?.key).toBe(commands[0]?.key)
    expect((await screen.findByRole('link', { name: /打开任务 task-new/ })).getAttribute('href')).toBe('#/tasks/task-new')

    fireEvent.change(screen.getByLabelText('任务标题'), { target: { value: '另一个标题' } })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(commands).toHaveLength(3))
    expect(commands[2]?.key).not.toBe(commands[0]?.key)
    expect(commands[2]?.command).toMatchObject({
      kind: 'create',
      input: { title: '另一个标题' },
    })
  })

  it('applies hash query filters on mount, wires employee filter, and resets cursor', async () => {
    const seenOptions: unknown[] = []
    window.location.hash = '#/tasks?projectId=proj-1&employeeId=emp-1&state=FAILED'
    const api = mockApi({
      tasks: vi.fn(async (options) => {
        seenOptions.push(options)
        if (options?.beforeRowid) {
          return listResult([
            {
              id: 'task-page-2',
              title: '第二页',
              status: 'FAILED',
              updatedAt: '2026-01-01T00:00:00.000Z',
              priority: 1,
              source: 'manual:local:proj-1',
              rowid: 5,
              agentId: 'emp-1',
            },
          ])
        }
        return listResult([
          {
            id: 'task-page-1',
            title: '第一页',
            status: 'FAILED',
            updatedAt: '2026-01-01T00:00:00.000Z',
            priority: 1,
            source: 'manual:local:proj-1',
            rowid: 20,
            agentId: 'emp-1',
          },
        ], 20)
      }),
    })

    render(wrap(<TasksPage api={api} />))
    expect(await screen.findByText('第一页')).toBeTruthy()
    await waitFor(() => {
      const latest = seenOptions.at(-1) as {
        states?: string[]
        projectId?: string
        employeeId?: string
        beforeRowid?: number
      }
      expect(latest.states).toEqual(['FAILED'])
      expect(latest.projectId).toBe('proj-1')
      expect(latest.employeeId).toBe('emp-1')
      expect(latest.beforeRowid).toBeUndefined()
    })
    expect((screen.getByLabelText('状态筛选') as HTMLSelectElement).value).toBe('FAILED')
    expect((screen.getByLabelText('项目筛选') as HTMLSelectElement).value).toBe('proj-1')
    expect((screen.getByLabelText('员工筛选') as HTMLSelectElement).value).toBe('emp-1')
    expect(api.employees).toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(await screen.findByText('第二页')).toBeTruthy()
    expect(seenOptions.some(item => (item as { beforeRowid?: number }).beforeRowid === 20)).toBe(true)

    fireEvent.change(screen.getByLabelText('员工筛选'), { target: { value: '' } })
    await waitFor(() => {
      const latest = seenOptions.at(-1) as { employeeId?: string; beforeRowid?: number }
      expect(latest.employeeId).toBeUndefined()
      expect(latest.beforeRowid).toBeUndefined()
    })
  })

  it('ignores invalid hash query IDs and states safely', async () => {
    const seenOptions: unknown[] = []
    window.location.hash = '#/tasks?projectId=bad id&employeeId=!!!&state=NOT_A_STATE'
    const api = mockApi({
      tasks: vi.fn(async (options) => {
        seenOptions.push(options)
        return listResult([])
      }),
    })

    render(wrap(<TasksPage api={api} />))
    await waitFor(() => expect(seenOptions.length).toBeGreaterThan(0))
    const latest = seenOptions.at(-1) as {
      states?: string[]
      projectId?: string
      employeeId?: string
    }
    expect(latest.states).toBeUndefined()
    expect(latest.projectId).toBeUndefined()
    expect(latest.employeeId).toBeUndefined()
    expect((screen.getByLabelText('状态筛选') as HTMLSelectElement).value).toBe('')
    expect((screen.getByLabelText('项目筛选') as HTMLSelectElement).value).toBe('')
    expect((screen.getByLabelText('员工筛选') as HTMLSelectElement).value).toBe('')
  })

  it('resets cursor pagination when filters change and supports approvals view', async () => {
    const seenOptions: unknown[] = []
    const api = mockApi({
      tasks: vi.fn(async (options) => {
        seenOptions.push(options)
        if (options?.beforeRowid) {
          return listResult([
            {
              id: 'task-page-2',
              title: '第二页',
              status: 'REVIEW',
              updatedAt: '2026-01-01T00:00:00.000Z',
              priority: 1,
              source: 'manual:local:proj-1',
              rowid: 5,
            },
          ])
        }
        return listResult([
          {
            id: 'task-page-1',
            title: '第一页',
            status: 'WAITING_APPROVAL',
            updatedAt: '2026-01-01T00:00:00.000Z',
            priority: 1,
            source: 'manual:local:proj-1',
            rowid: 20,
          },
        ], 20)
      }),
    })

    function Harness(): ReactNode {
      const [approvals, setApprovals] = useState(false)
      return (
        <div>
          <button type="button" onClick={() => setApprovals(true)}>切到审批</button>
          <TasksPage api={api} approvals={approvals} />
        </div>
      )
    }

    render(wrap(<Harness />))
    expect(await screen.findByText('第一页')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '下一页' }))
    expect(await screen.findByText('第二页')).toBeTruthy()
    expect(seenOptions.some(item => (item as { beforeRowid?: number }).beforeRowid === 20)).toBe(true)

    fireEvent.change(screen.getByLabelText('状态筛选'), { target: { value: 'FAILED' } })
    await waitFor(() => {
      const latest = seenOptions.at(-1) as { states?: string[]; beforeRowid?: number }
      expect(latest.states).toEqual(['FAILED'])
      expect(latest.beforeRowid).toBeUndefined()
    })

    fireEvent.click(screen.getByRole('button', { name: '切到审批' }))
    await waitFor(() => {
      const latest = seenOptions.at(-1) as { states?: string[]; beforeRowid?: number }
      expect(latest.states).toEqual(['WAITING_APPROVAL', 'REVIEW'])
      expect(latest.beforeRowid).toBeUndefined()
    })
    expect(screen.queryByLabelText('创建项目')).toBeNull()
    expect(screen.getByText(/审批视图固定筛选/)).toBeTruthy()
    expect(screen.getByLabelText('员工筛选')).toBeTruthy()
  })
})

describe('TaskPage', () => {
  it('requires confirmation with version preview and supports approve action', async () => {
    const commands: Array<{ key: string; command: LocalTaskCommand }> = []
    const api = mockApi({
      task: vi.fn(async () => detailFixture()),
      command: vi.fn(async (key, command) => {
        commands.push({ key, command })
        return {
          ticket: baseTicket({
            lifecycle: {
              ...baseTicket().lifecycle!,
              status: 'QUEUED',
              version: 4,
            },
          }),
          replayed: false,
        }
      }),
    })

    render(wrap(<TaskPage api={api} ticketId="task-1" />))
    expect(await screen.findByText(/版本 3/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '可以执行' } })
    fireEvent.click(screen.getByRole('button', { name: '预览确认' }))

    const preview = await screen.findByRole('region', { name: '操作确认预览' })
    expect(within(preview).getByText(/操作：批准执行/)).toBeTruthy()
    expect(within(preview).getByText(/任务：task-1/)).toBeTruthy()
    expect(within(preview).getByText(/版本：3/)).toBeTruthy()
    expect(within(preview).getByText(/原因：可以执行/)).toBeTruthy()
    expect(within(preview).queryByText(/expectedVersion/)).toBeNull()
    expect(commands).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: '确认提交' }))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]?.command).toEqual({
      kind: 'approve',
      ticketId: 'task-1',
      expectedVersion: 3,
      reason: '可以执行',
    })
    expect(await screen.findByText('命令已生效。')).toBeTruthy()
  })

  it('reuses stable action idempotency key after uncertain network failure', async () => {
    const commands: Array<{ key: string; command: LocalTaskCommand }> = []
    const api = mockApi({
      task: vi.fn(async () => detailFixture()),
      command: vi.fn(async (key, command) => {
        commands.push({ key, command })
        if (commands.length === 1) throw new Error('network')
        return {
          ticket: baseTicket({
            lifecycle: {
              ...baseTicket().lifecycle!,
              status: 'QUEUED',
              version: 4,
            },
          }),
          replayed: false,
        }
      }),
    })

    render(wrap(<TaskPage api={api} ticketId="task-1" />))
    await screen.findByText(/版本 3/)

    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '网络不稳仍同意图' } })
    fireEvent.click(screen.getByRole('button', { name: '预览确认' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认提交' }))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect((await screen.findByRole('alert')).textContent ?? '').toMatch(/命令失败/)

    fireEvent.click(screen.getByRole('button', { name: '确认提交' }))
    await waitFor(() => expect(commands).toHaveLength(2))
    expect(commands[1]?.key).toBe(commands[0]?.key)
    expect(commands[1]?.command).toEqual(commands[0]?.command)
    expect(await screen.findByText('命令已生效。')).toBeTruthy()
  })

  it('on 409 clears draft and reason so a fresh confirmation is required', async () => {
    let version = 3
    const commands: LocalTaskCommand[] = []
    const api = mockApi({
      task: vi.fn(async () => detailFixture({
        ticket: baseTicket({
          lifecycle: {
            ...baseTicket().lifecycle!,
            version,
          },
        }),
      })),
      command: vi.fn(async (_key, command) => {
        commands.push(command)
        version = 4
        throw new ConflictError()
      }),
    })

    render(wrap(<TaskPage api={api} ticketId="task-1" />))
    await screen.findByText(/版本 3/)

    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '批准一下' } })
    fireEvent.click(screen.getByRole('button', { name: '预览确认' }))
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }))

    expect((await screen.findByRole('alert')).textContent ?? '').toMatch(/409/)
    await waitFor(() => expect(screen.getByText(/版本 4/)).toBeTruthy())
    expect(screen.queryByRole('region', { name: '操作确认预览' })).toBeNull()
    expect(screen.queryByLabelText('操作原因')).toBeNull()
    expect(commands).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '批准' }))
    expect((screen.getByLabelText('操作原因') as HTMLTextAreaElement).value).toBe('')
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '基于新版本再批' } })
    fireEvent.click(screen.getByRole('button', { name: '预览确认' }))
    const preview = await screen.findByRole('region', { name: '操作确认预览' })
    expect(within(preview).getByText(/版本：4/)).toBeTruthy()
  })

  it('does not offer retry when BLOCKED retains UNKNOWN execution reservation', async () => {
    const api = mockApi({
      task: vi.fn(async () => detailFixture({
        ticket: baseTicket({
          lifecycle: {
            ...baseTicket().lifecycle!,
            status: 'BLOCKED',
            version: 8,
          },
        }),
        executions: [executionFixture({
          executionId: 'exec-unknown',
          state: 'UNKNOWN',
          exitCode: undefined,
        })],
      })),
    })

    render(wrap(<TaskPage api={api} ticketId="task-1" />))
    expect(await screen.findByText(/UNKNOWN 仍占用资源/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: '重试' })).toBeNull()
    expect(screen.getByRole('button', { name: '请求取消' })).toBeTruthy()
  })

  it('gates review approve on terminal success, exit 0 and verification, and binds current artifact', async () => {
    const blocked = detailFixture({
      ticket: baseTicket({
        lifecycle: {
          ...baseTicket().lifecycle!,
          status: 'REVIEW',
          version: 5,
          result: {
            executionId: 'exec-1',
            assignmentId: 'asg-1',
            artifactRevision: 'art-1',
            exitCode: 1,
            terminal: 'error',
            summary: 'failed run',
            verification: 'failed',
          },
        },
      }),
      executions: [executionFixture()],
    })

    const apiBlocked = mockApi({ task: vi.fn(async () => blocked) })
    const first = render(wrap(<TaskPage api={apiBlocked} ticketId="task-1" />))
    expect((await screen.findByRole('button', { name: '审核通过' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByRole('link', { name: 'exec-1' }).getAttribute('href')).toBe('#/executions/exec-1')
    expect(screen.getByText(/检查结果与最终人工审核分别记录/)).toBeTruthy()
    expect(screen.queryByText(/伪造/)).toBeNull()
    first.unmount()

    const commands: LocalTaskCommand[] = []
    const ready = detailFixture({
      ticket: baseTicket({
        lifecycle: {
          ...baseTicket().lifecycle!,
          status: 'REVIEW',
          version: 6,
          result: {
            executionId: 'exec-2',
            assignmentId: 'asg-2',
            artifactRevision: 'art-2',
            exitCode: 0,
            terminal: 'success',
            summary: 'ok',
            verification: 'passed',
          },
        },
      }),
    })
    const apiReady = mockApi({
      task: vi.fn(async () => ready),
      command: vi.fn(async (_key, command) => {
        commands.push(command)
        return { ticket: ready.ticket, replayed: true }
      }),
    })
    render(wrap(<TaskPage api={apiReady} ticketId="task-1" />))
    expect((await screen.findByRole('button', { name: '审核通过' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: '审核通过' }))
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '验收通过' } })
    fireEvent.click(screen.getByRole('button', { name: '预览确认' }))
    const preview = await screen.findByRole('region', { name: '操作确认预览' })
    expect(within(preview).getByText(/执行：exec-2/)).toBeTruthy()
    expect(within(preview).getByText(/产物修订：art-2/)).toBeTruthy()
    fireEvent.click(await screen.findByRole('button', { name: '确认提交' }))
    await waitFor(() => expect(commands).toHaveLength(1))
    expect(commands[0]).toEqual({
      kind: 'review',
      ticketId: 'task-1',
      expectedVersion: 6,
      executionId: 'exec-2',
      artifactRevision: 'art-2',
      approved: true,
      reason: '验收通过',
    })
    expect(await screen.findByText(/命令已按幂等键重放/)).toBeTruthy()
  })

  it('loads logs only after explicit toggle and clarifies cancel request semantics', async () => {
    const logs = vi.fn(async () => ({
      ticketId: 'task-1',
      executions: [{
        executionId: 'exec-9',
        state: 'RUNNING',
        stdout: 'hello-out',
        stderr: 'hello-err',
        stdoutTruncated: false,
        stderrTruncated: false,
      }],
    }))
    const api = mockApi({
      logs,
      task: vi.fn(async () => detailFixture({
        ticket: baseTicket({
          lifecycle: {
            ...baseTicket().lifecycle!,
            status: 'RUNNING',
            version: 2,
          },
          assignments: [{
            id: 'asg-9',
            state: 'running',
            createdAt: '2026-01-01T00:00:00.000Z',
            agentId: 'emp-9',
            runtime: 'claude',
          }],
        }),
        history: [{
          id: 'hist-1',
          ticketId: 'task-1',
          at: '2026-01-01T00:00:00.000Z',
          actor: 'owner-1',
          reason: 'started',
          kind: 'transition',
          from: 'ASSIGNED',
          to: 'RUNNING',
          policyVersion: 'policy-1',
        }],
        historyTruncated: true,
      })),
    })

    render(wrap(<TaskPage api={api} ticketId="task-1" />))
    expect(await screen.findByText(/历史已截断/)).toBeTruthy()
    expect(logs).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '读取日志' }))
    expect((await screen.findByLabelText('exec-9 stdout')).textContent).toContain('hello-out')
    expect(logs).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: '请求取消' }))
    expect(screen.getByText(/需等待执行侧确认退出/)).toBeTruthy()
  })
})
