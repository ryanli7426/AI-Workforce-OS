import { render, screen, waitFor, within } from '@testing-library/react'
import { fireEvent } from '@testing-library/dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement, ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type {
  ApiClient,
  Employee,
  ExecutionLogsResult,
  ExecutionRecord,
  ProductOverview,
  ProductTaskListResult,
  Project,
} from '../api.ts'
import { EmployeesPage, ExecutionPage, OverviewPage, ProjectsPage } from './overview.tsx'

function emptyOverview(): ProductOverview {
  return {
    tasks: {
      total: 0,
      byStatus: {
        NEW: 0,
        QUEUED: 0,
        ASSIGNED: 0,
        RUNNING: 0,
        REVIEW: 0,
        DONE: 0,
        FAILED: 0,
        BLOCKED: 0,
        CANCELLED: 0,
        WAITING_APPROVAL: 0,
      },
    },
    employees: { configured: 0, enabled: 0, busy: 0 },
    executions: { total: 0, active: 0, unknown: 0 },
  }
}

function sampleOverview(): ProductOverview {
  const overview = emptyOverview()
  overview.tasks.total = 4
  overview.tasks.byStatus.WAITING_APPROVAL = 1
  overview.tasks.byStatus.BLOCKED = 1
  overview.tasks.byStatus.FAILED = 1
  overview.tasks.byStatus.REVIEW = 1
  overview.employees = { configured: 2, enabled: 1, busy: 1 }
  overview.executions = { total: 3, active: 1, unknown: 0 }
  return overview
}

function sampleAttention(): ProductTaskListResult {
  return {
    items: [
      {
        id: 'task-wait',
        title: '等待审批任务',
        status: 'WAITING_APPROVAL',
        updatedAt: '2026-11-05T01:00:00.000Z',
        priority: 10,
        source: 'manual:local:proj-1',
        rowid: 4,
        agentId: 'emp-1',
      },
      {
        id: 'task-fail',
        title: '失败任务',
        status: 'FAILED',
        updatedAt: '2026-11-05T02:00:00.000Z',
        priority: 5,
        source: 'manual:local:proj-1',
        rowid: 3,
      },
    ],
  }
}

function sampleEmployee(overrides: Partial<Employee> = {}): Employee {
  return {
    id: 'emp-1',
    workspaceId: 'local',
    name: '文档助手',
    role: 'docs',
    responsibilities: ['写文档'],
    capabilities: ['markdown', 'review'],
    runtimeId: 'runtime-claude',
    projectIds: ['proj-1', 'proj-2'],
    maxConcurrency: 1,
    timeoutMs: 60_000,
    enabled: true,
    version: 3,
    ...overrides,
  }
}

function sampleProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-1',
    workspaceId: 'local',
    name: '控制面',
    ownerId: 'owner-1',
    repositoryPath: '/repos/control',
    worktreeRoot: '/worktrees/control',
    allowedTaskTypes: ['docs', 'code'],
    archived: false,
    version: 2,
    ...overrides,
  }
}

function sampleExecution(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    executionId: 'exec-1',
    assignmentId: 'asg-1',
    ticketId: 'task-1',
    agentId: 'emp-1',
    runtime: 'claude-code',
    generation: 1,
    cwd: '/worktrees/control/exec-1',
    inputRevision: 'rev-1',
    policyVersion: '1',
    state: 'SUCCEEDED',
    createdAt: '2026-11-05T03:00:00.000Z',
    updatedAt: '2026-11-05T03:05:00.000Z',
    startedAt: '2026-11-05T03:01:00.000Z',
    finishedAt: '2026-11-05T03:05:00.000Z',
    exitCode: 0,
    signal: null,
    lastSequence: 2,
    ...overrides,
  }
}

function sampleLogs(): ExecutionLogsResult {
  return {
    ticketId: 'task-1',
    executions: [
      {
        executionId: 'exec-1',
        state: 'SUCCEEDED',
        stdout: 'hello-out',
        stderr: 'hello-err',
        stdoutTruncated: false,
        stderrTruncated: false,
      },
    ],
  }
}

function createApi(partial: Partial<ApiClient> = {}): ApiClient {
  const unexpected = (name: string) => vi.fn(async () => {
    throw new Error(`unexpected call: ${name}`)
  })
  return {
    executions: vi.fn().mockResolvedValue({items:[]}),
    manage: vi.fn().mockRejectedValue(new Error('Unused management command')),
    managementHistory: vi.fn().mockResolvedValue({items:[]}),
    me: unexpected('me'),
    overview: unexpected('overview'),
    employees: unexpected('employees'),
    projects: unexpected('projects'),
    tasks: unexpected('tasks'),
    task: unexpected('task'),
    execution: unexpected('execution'),
    logs: unexpected('logs'),
    command: unexpected('command'),
    ...partial,
  }
}

function renderPage(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, gcTime: 0 },
      mutations: { retry: false },
    },
  })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return render(ui, { wrapper: Wrapper })
}

describe('OverviewPage', () => {
  it('renders primary task counts, secondary details, and attention tasks with task links', async () => {
    const overview = vi.fn(async (_signal?: AbortSignal) => sampleOverview())
    const tasks = vi.fn(async (_options?: unknown, _signal?: AbortSignal) => sampleAttention())
    const api = createApi({ overview, tasks })

    renderPage(<OverviewPage api={api} />)

    expect(await screen.findByText('任务总数')).toBeTruthy()
    expect(screen.getByText('掌握任务进度，处理需要你决策的工作。')).toBeTruthy()
    expect(screen.getByText('4')).toBeTruthy()
    expect(screen.getByText('待审批')).toBeTruthy()
    expect(screen.getByText('运行中')).toBeTruthy()

    const primary = screen.getByLabelText('概览计数')
    expect(within(primary).getByText('任务总数')).toBeTruthy()
    expect(within(primary).getByText('待审批')).toBeTruthy()
    expect(within(primary).getByText('阻塞')).toBeTruthy()
    expect(within(primary).getByText('失败')).toBeTruthy()
    expect(within(primary).getByText('待复核')).toBeTruthy()
    expect(within(primary).getByText('运行中')).toBeTruthy()
    expect(within(primary).queryByText('已配置员工')).toBeNull()
    expect(within(primary).queryByText('执行总数')).toBeNull()
    expect(primary.querySelectorAll('.stat-card').length).toBe(6)

    const secondary = screen.getByLabelText('配置与执行明细')
    expect(within(secondary).getByText('已配置员工')).toBeTruthy()
    expect(within(secondary).getByText('可接单员工')).toBeTruthy()
    expect(within(secondary).getByText('忙碌员工')).toBeTruthy()
    expect(within(secondary).getByText('执行总数')).toBeTruthy()
    expect(within(secondary).getByText('活动执行')).toBeTruthy()
    expect(within(secondary).getByText('未知执行')).toBeTruthy()
    expect(within(secondary).getByText('2')).toBeTruthy()
    expect(within(secondary).getByText('3')).toBeTruthy()

    expect(screen.queryByText(/不含成本|健康度|在线推断|Web 切片|伪变更/)).toBeNull()
    expect(screen.queryByText('在线')).toBeNull()
    expect(screen.queryByText('健康')).toBeNull()

    const waitLink = await screen.findByRole('link', { name: '等待审批任务' })
    expect(waitLink.getAttribute('href')).toBe('#/tasks/task-wait')
    expect(screen.getByRole('link', { name: '失败任务' })).toBeTruthy()
    expect(screen.getByText('WAITING_APPROVAL')).toBeTruthy()

    await waitFor(() => expect(overview).toHaveBeenCalled())
    expect(overview.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal)
    await waitFor(() => expect(tasks).toHaveBeenCalled())
    expect(tasks.mock.calls[0]?.[0]).toEqual({
      states: ['WAITING_APPROVAL', 'BLOCKED', 'FAILED', 'REVIEW'],
      limit: 50,
    })
    expect(tasks.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
    expect(api.command).not.toHaveBeenCalled()
    expect(api.me).not.toHaveBeenCalled()
  })

  it('shows empty attention and error states', async () => {
    const apiEmpty = createApi({
      overview: vi.fn(async () => emptyOverview()),
      tasks: vi.fn(async () => ({ items: [] })),
    })
    const { unmount } = renderPage(<OverviewPage api={apiEmpty} />)
    expect(await screen.findByText('暂无记录')).toBeTruthy()
    unmount()

    const apiError = createApi({
      overview: vi.fn(async () => {
        throw new Error('boom')
      }),
      tasks: vi.fn(async () => ({ items: [] })),
    })
    renderPage(<OverviewPage api={apiError} />)
    expect((await screen.findByRole('alert')).textContent).toContain('暂时无法获取数据')
  })

  it('refresh control refetches overview and attention', async () => {
    const overview = vi.fn(async () => sampleOverview())
    const tasks = vi.fn(async () => sampleAttention())
    renderPage(<OverviewPage api={createApi({ overview, tasks })} />)
    await screen.findByRole('link', { name: '等待审批任务' })
    const beforeOverview = overview.mock.calls.length
    const beforeTasks = tasks.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: '刷新' }))
    await waitFor(() => {
      expect(overview.mock.calls.length).toBeGreaterThan(beforeOverview)
      expect(tasks.mock.calls.length).toBeGreaterThan(beforeTasks)
    })
  })
})

describe('EmployeesPage', () => {
  it('renders configured fields, enabled label, and task filter links', async () => {
    const employees = vi.fn(async (signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return [sampleEmployee(), sampleEmployee({ id: 'emp-2', name: '关闭员工', enabled: false, projectIds: [], version: 1 })]
    })
    const api = createApi({ employees })
    renderPage(<EmployeesPage api={api} />)

    expect(await screen.findByText('文档助手')).toBeTruthy()
    expect(screen.getByText('员工配置暂由本地 CLI 管理。启用状态表示可接单配置。')).toBeTruthy()
    expect(screen.getAllByText('docs').length).toBeGreaterThan(0)
    expect(screen.getAllByText('markdown、review').length).toBeGreaterThan(0)
    expect(screen.getAllByText('runtime-claude').length).toBeGreaterThan(0)
    expect(screen.getByText('已启用')).toBeTruthy()
    expect(screen.getByText('未启用')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
    expect(screen.queryByText('在线')).toBeNull()
    expect(screen.queryByText(/伪变更|Web 切片|不代表在线/)).toBeNull()

    expect(screen.getAllByRole('link', { name: '按员工筛选任务' })[0]?.getAttribute('href')).toBe('#/tasks?employeeId=emp-1')
    expect(screen.getByRole('link', { name: '项目 proj-1' }).getAttribute('href')).toBe('#/tasks?projectId=proj-1')
    expect(screen.getByRole('link', { name: '项目 proj-2' }).getAttribute('href')).toBe('#/tasks?projectId=proj-2')
    expect(api.command).not.toHaveBeenCalled()
    expect(api.overview).not.toHaveBeenCalled()
  })

  it('shows empty and error states', async () => {
    const { unmount } = renderPage(<EmployeesPage api={createApi({ employees: vi.fn(async () => []) })} />)
    expect(await screen.findByText('暂无记录')).toBeTruthy()
    unmount()
    renderPage(<EmployeesPage api={createApi({
      employees: vi.fn(async () => {
        throw new Error('denied')
      }),
    })} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('ProjectsPage', () => {
  it('renders project config fields and project task filter link', async () => {
    const projects = vi.fn(async (signal?: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal)
      return [sampleProject(), sampleProject({ id: 'proj-2', name: '归档项目', archived: true, version: 9 })]
    })
    const api = createApi({ projects })
    renderPage(<ProjectsPage api={api} />)

    expect(await screen.findByText('控制面')).toBeTruthy()
    expect(screen.getByText('项目配置暂由本地 CLI 管理。')).toBeTruthy()
    expect(screen.getAllByText('owner-1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('/repos/control').length).toBeGreaterThan(0)
    expect(screen.getAllByText('/worktrees/control').length).toBeGreaterThan(0)
    expect(screen.getAllByText('docs、code').length).toBeGreaterThan(0)
    expect(screen.getByText('未归档')).toBeTruthy()
    expect(screen.getByText('已归档')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(screen.queryByText('健康')).toBeNull()
    expect(screen.queryByText('在线')).toBeNull()
    expect(screen.queryByText(/不代表可达或健康|伪变更|Web 切片/)).toBeNull()

    const links = screen.getAllByRole('link', { name: '按项目筛选任务' })
    expect(links[0]?.getAttribute('href')).toBe('#/tasks?projectId=proj-1')
    expect(api.command).not.toHaveBeenCalled()
    expect(api.employees).not.toHaveBeenCalled()
  })

  it('shows empty and error states', async () => {
    const { unmount } = renderPage(<ProjectsPage api={createApi({ projects: vi.fn(async () => []) })} />)
    expect(await screen.findByText('暂无记录')).toBeTruthy()
    unmount()
    renderPage(<ProjectsPage api={createApi({
      projects: vi.fn(async () => {
        throw new Error('missing')
      }),
    })} />)
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('ExecutionPage', () => {
  it('renders execution facts, task link, SUCCEEDED clarification once, and logs only after explicit toggle', async () => {
    const execution = vi.fn(async (id: string, signal?: AbortSignal) => {
      expect(id).toBe('exec-1')
      expect(signal).toBeInstanceOf(AbortSignal)
      return sampleExecution()
    })
    const logs = vi.fn(async (ticketId: string, options?: { executionId?: string }, signal?: AbortSignal) => {
      expect(ticketId).toBe('task-1')
      expect(options).toEqual({ executionId: 'exec-1' })
      expect(signal).toBeInstanceOf(AbortSignal)
      return sampleLogs()
    })
    const api = createApi({ execution, logs })
    renderPage(<ExecutionPage api={api} executionId="exec-1" />)

    expect(await screen.findByText('exec-1')).toBeTruthy()
    expect(screen.getByText('执行结果与最终任务验收分别记录。')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'task-1' }).getAttribute('href')).toBe('#/tasks/task-1')
    expect(screen.getByRole('status').textContent).toContain('不等于任务已验收完成')
    expect(screen.getByText('0')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /暂停|恢复|投递/ })).toBeNull()
    expect(screen.queryByText(/控制令牌|伪变更|Web 切片/)).toBeNull()
    expect(screen.queryByText(/hello-out/)).toBeNull()
    expect(logs).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '读取日志' }))
    expect(await screen.findByText('hello-out')).toBeTruthy()
    expect(screen.getByText('hello-err')).toBeTruthy()
    expect(logs).toHaveBeenCalledTimes(1)
    expect(api.command).not.toHaveBeenCalled()
    expect(api.task).not.toHaveBeenCalled()
  })

  it('shows execution error and does not dump unsupported controls', async () => {
    renderPage(<ExecutionPage api={createApi({
      execution: vi.fn(async () => {
        throw new Error('gone')
      }),
    })} executionId="missing" />)
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /暂停|恢复|投递/ })).toBeNull()
  })

  it('loads logs empty state after toggle when endpoint returns no entries', async () => {
    renderPage(<ExecutionPage api={createApi({
      execution: vi.fn(async () => sampleExecution({ state: 'FAILED', exitCode: 2, failureReason: 'boom' })),
      logs: vi.fn(async () => ({ ticketId: 'task-1', executions: [] })),
    })} executionId="exec-1" />)
    expect(await screen.findByText('boom')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '读取日志' }))
    expect(await screen.findByText('暂无记录')).toBeTruthy()
  })
})

describe('supported query surface', () => {
  it('only uses documented read queries for these pages', async () => {
    const api = createApi({
      overview: vi.fn(async () => emptyOverview()),
      tasks: vi.fn(async () => ({ items: [] })),
      employees: vi.fn(async () => []),
      projects: vi.fn(async () => []),
      execution: vi.fn(async () => sampleExecution()),
      logs: vi.fn(async () => sampleLogs()),
    })

    const first = renderPage(<OverviewPage api={api} />)
    await screen.findByText('任务总数')
    first.unmount()

    const second = renderPage(<EmployeesPage api={api} />)
    await screen.findByText('暂无记录')
    second.unmount()

    const third = renderPage(<ProjectsPage api={api} />)
    await screen.findByText('暂无记录')
    third.unmount()

    renderPage(<ExecutionPage api={api} executionId="exec-1" />)
    await screen.findByText('exec-1')
    fireEvent.click(screen.getByRole('button', { name: '读取日志' }))
    await screen.findByText('hello-out')

    expect(api.me).not.toHaveBeenCalled()
    expect(api.task).not.toHaveBeenCalled()
    expect(api.command).not.toHaveBeenCalled()
    expect(within(document.body).queryByText(/JSON\.stringify|control-token/)).toBeNull()
  })
})
