import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  CreateVerificationBody,
  VerificationApi,
  VerificationCommandResult,
  VerificationJobList,
  VerificationJobView,
  VerificationPlanMeta,
} from '../verification-api.ts'
import { TaskVerification, type VerificationTicketBinding } from './task-verification.tsx'

const ARTIFACT_REV = 'ab'.repeat(32)
const REPORT_SHA = 'cd'.repeat(32)

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

function planFixture(overrides: Partial<VerificationPlanMeta> = {}): VerificationPlanMeta {
  return {
    id: 'plan-default',
    revision: 'rev-1',
    checks: [{ id: 'lint', timeoutMs: 10_000 }],
    ...overrides,
  }
}

function reviewTicket(overrides: Partial<VerificationTicketBinding> = {}): VerificationTicketBinding {
  return {
    id: 'task-1',
    lifecycle: {
      status: 'REVIEW',
      version: 5,
      result: {
        executionId: 'exec-1',
        artifactRevision: ARTIFACT_REV,
        verification: 'unknown',
      },
    },
    ...overrides,
  }
}

function jobFixture(overrides: Partial<VerificationJobView> = {}): VerificationJobView {
  return {
    request: {
      verificationId: 'ver-1',
      workspaceId: 'local',
      ownerId: 'owner-1',
      ticketId: 'task-1',
      expectedTaskVersion: 5,
      policyVersion: 'policy-1',
      executionId: 'exec-1',
      artifactId: 'artifact-exec-1',
      artifactRevision: ARTIFACT_REV,
      plan: planFixture(),
      reason: 'run checks',
      createdAt: '2026-11-05T01:00:00.000Z',
    },
    status: 'QUEUED',
    version: 1,
    lastSequence: 0,
    createdAt: '2026-11-05T01:00:00.000Z',
    updatedAt: '2026-11-05T01:00:00.000Z',
    ...overrides,
  }
}

function completedFixture(overrides: Partial<VerificationJobView> = {}): VerificationJobView {
  return jobFixture({
    status: 'COMPLETED',
    outcome: 'passed',
    reportSha256: REPORT_SHA,
    application: 'applied',
    finishedAt: '2026-11-05T02:00:00.000Z',
    ...overrides,
  })
}

function mockApi(partial: Partial<VerificationApi> = {}): VerificationApi {
  return {
    plans: vi.fn(async () => ({ items: [planFixture()] })),
    list: vi.fn(async () => ({ items: [] })),
    get: vi.fn(),
    create: vi.fn(),
    cancel: vi.fn(),
    ...partial,
  }
}

class ConflictError extends Error {
  readonly status = 409
  readonly code = 'VERSION_CONFLICT'
  constructor() {
    super('版本冲突，请刷新后重试。')
    this.name = 'ConflictError'
  }
}

class NetworkError extends Error {
  readonly code = 'NETWORK'
  readonly status = 0
  constructor() {
    super('网络异常，请稍后重试。')
    this.name = 'NetworkError'
  }
}

function selectPlan(): void {
  fireEvent.change(screen.getByLabelText('可信验证计划'), {
    target: { value: 'plan-default::rev-1' },
  })
}

function fillReason(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label), { target: { value } })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('TaskVerification', () => {
  it('selects plan, requires reason, previews exact binding, and enqueues 202 with verificationId receipt', async () => {
    const creates: Array<{ key: string; body: CreateVerificationBody }> = []
    const api = mockApi({
      create: vi.fn(async (ticketId, key, body) => {
        expect(ticketId).toBe('task-1')
        creates.push({ key, body })
        return {
          verificationId: 'ver-created-1',
          replayed: false,
        } satisfies VerificationCommandResult
      }),
    })

    render(wrap(<TaskVerification api={api} ticket={reviewTicket()} />))
    expect(await screen.findByLabelText('可信验证计划')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '预览确认' }))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('请填写有效原因')

    selectPlan()
    fillReason('验证原因', '核对登录修复')
    fireEvent.click(screen.getByRole('button', { name: '预览确认' }))

    const preview = await screen.findByRole('region', { name: '验证入队确认预览' })
    expect(within(preview).getByText(/生命周期版本：5/)).toBeTruthy()
    expect(within(preview).getByText(/执行：exec-1/)).toBeTruthy()
    expect(within(preview).getByText(new RegExp(`产物修订：${ARTIFACT_REV}`))).toBeTruthy()
    expect(within(preview).getByText(/计划：plan-default @ rev-1/)).toBeTruthy()
    expect(within(preview).getByText(/原因：核对登录修复/)).toBeTruthy()

    fireEvent.click(within(preview).getByRole('button', { name: '确认入队' }))
    await waitFor(() => expect(creates).toHaveLength(1))
    expect(creates[0]?.body).toEqual({
      expectedVersion: 5,
      executionId: 'exec-1',
      artifactRevision: ARTIFACT_REV,
      planId: 'plan-default',
      planRevision: 'rev-1',
      reason: '核对登录修复',
    })
    expect(await screen.findByText(/验证作业已入队，可在下方查看进度/)).toBeTruthy()
  })

  it('reuses stable idempotency key after network failure and requires reconfirm after 409', async () => {
    const creates: Array<{ key: string; body: CreateVerificationBody }> = []
    let attempt = 0
    const api = mockApi({
      create: vi.fn(async (_ticketId, key, body) => {
        creates.push({ key, body })
        attempt += 1
        if (attempt === 1) throw new NetworkError()
        if (attempt === 2) throw new ConflictError()
        return { verificationId: 'ver-1', replayed: false }
      }),
    })

    render(wrap(<TaskVerification api={api} ticket={reviewTicket()} />))
    await screen.findByLabelText('可信验证计划')
    selectPlan()
    fillReason('验证原因', 'stable-key')
    fireEvent.click(screen.getByRole('button', { name: '预览确认' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认入队' }))
    expect(await screen.findByText(/入队失败/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '确认入队' }))
    await waitFor(() => expect(creates).toHaveLength(2))
    expect(creates[1]?.key).toBe(creates[0]?.key)
    expect(await screen.findByText(/409/)).toBeTruthy()
    expect(screen.queryByRole('region', { name: '验证入队确认预览' })).toBeNull()

    selectPlan()
    fillReason('验证原因', 'stable-key')
    fireEvent.click(screen.getByRole('button', { name: '预览确认' }))
    fireEvent.click(await screen.findByRole('button', { name: '确认入队' }))
    await waitFor(() => expect(creates).toHaveLength(3))
    expect(creates[2]?.key).not.toBe(creates[0]?.key)
  })

  it('freezes ticket binding across parent polling until conflict clears it', async () => {
    const creates: Array<CreateVerificationBody> = []
    const api = mockApi({
      create: vi.fn(async (_id, _key, body) => {
        creates.push(body)
        return { verificationId: 'ver-1', replayed: false }
      }),
    })

    function Harness() {
      const [ticket, setTicket] = useState(reviewTicket())
      return (
        <div>
          <button
            type="button"
            onClick={() => setTicket(reviewTicket({
              lifecycle: {
                status: 'REVIEW',
                version: 9,
                result: {
                  executionId: 'exec-newer',
                  artifactRevision: 'cd'.repeat(32),
                  verification: 'unknown',
                },
              },
            }))}
          >
            parent-poll
          </button>
          <TaskVerification api={api} ticket={ticket} />
        </div>
      )
    }

    render(wrap(<Harness />))
    await screen.findByLabelText('可信验证计划')
    selectPlan()
    fillReason('验证原因', 'frozen')
    fireEvent.click(screen.getByRole('button', { name: '预览确认' }))
    expect(await screen.findByText(/生命周期版本：5/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'parent-poll' }))
    const preview = screen.getByRole('region', { name: '验证入队确认预览' })
    expect(within(preview).getByText(/生命周期版本：5/)).toBeTruthy()
    expect(within(preview).getByText(/执行：exec-1/)).toBeTruthy()
    expect(screen.getByText(/任务版本已变为 9/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '确认入队' }))
    await waitFor(() => expect(creates).toHaveLength(1))
    expect(creates[0]).toMatchObject({
      expectedVersion: 5,
      executionId: 'exec-1',
      artifactRevision: ARTIFACT_REV,
    })
  })

  it('cancels with reason/version preview and reports persisted intent not immediate success', async () => {
    const cancels: Array<{ key: string; id: string; expectedVersion: number; reason: string }> = []
    const api = mockApi({
      list: vi.fn(async () => ({ items: [jobFixture({ status: 'RUNNING', version: 3 })] })),
      cancel: vi.fn(async (id, key, body) => {
        cancels.push({ key, id, expectedVersion: body.expectedVersion, reason: body.reason })
        return { verificationId: id, replayed: false }
      }),
    })

    render(wrap(<TaskVerification api={api} ticket={reviewTicket()} />))
    fireEvent.click(await screen.findByRole('button', { name: '请求取消' }))
    fillReason('取消原因', '停止检查')
    fireEvent.click(screen.getByRole('button', { name: '预览取消确认' }))
    const preview = await screen.findByRole('region', { name: '取消验证确认预览' })
    expect(within(preview).getByText(/期望版本：3/)).toBeTruthy()
    expect(within(preview).getByText(/原因：停止检查/)).toBeTruthy()
    fireEvent.click(within(preview).getByRole('button', { name: '确认取消意图' }))
    await waitFor(() => expect(cancels).toHaveLength(1))
    expect(cancels[0]).toMatchObject({ id: 'ver-1', expectedVersion: 3, reason: '停止检查' })
    expect(await screen.findByText(/已请求取消，正在等待检查进程确认停止/)).toBeTruthy()
    expect(screen.queryByText('已取消成功')).toBeNull()
  })

  it('never exposes DONE shortcut or waiver and disables stale non-REVIEW tasks', async () => {
    const api = mockApi()
    const { rerender } = render(wrap(
      <TaskVerification
        api={api}
        ticket={reviewTicket({
          lifecycle: {
            status: 'DONE',
            version: 8,
            result: { executionId: 'exec-1', artifactRevision: ARTIFACT_REV, verification: 'passed' },
          },
        })}
      />,
    ))
    expect(await screen.findByText(/验证入队已禁用/)).toBeTruthy()
    expect(await screen.findByLabelText('可信验证计划')).toBeTruthy()
    expect((screen.getByLabelText('可信验证计划') as HTMLSelectElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: /豁免|waiver|标记通过|set passed/i })).toBeNull()
    expect(screen.getByText(/检查通过后，继续完成最终人工审核/)).toBeTruthy()

    rerender(wrap(<TaskVerification api={api} ticket={reviewTicket()} />))
    await waitFor(() => {
      expect((screen.getByLabelText('可信验证计划') as HTMLSelectElement).disabled).toBe(false)
    })
  })

  it('shows empty-plan CLI registration guidance and visible server errors', async () => {
    const api = mockApi({
      plans: vi.fn(async () => ({ items: [] })),
      list: vi.fn(async () => {
        throw Object.assign(new Error('服务暂时不可用。'), { code: 'INTERNAL_ERROR', status: 500 })
      }),
    })
    render(wrap(<TaskVerification api={api} ticket={reviewTicket()} />))
    expect(await screen.findByText(/显式 CLI\/配置注册验证计划/)).toBeTruthy()
    expect(await screen.findByText(/暂时无法获取数据/)).toBeTruthy()
  })

  it('lists job progress with applied/superseded/unknown distinction and pagination', async () => {
    const pages: VerificationJobList[] = [
      {
        items: [
          jobFixture({
            status: 'RUNNING',
            request: { ...jobFixture().request, verificationId: 'ver-active' },
          }),
          completedFixture({
            application: 'applied',
            request: { ...jobFixture().request, verificationId: 'ver-applied' },
          }),
          completedFixture({
            application: 'superseded',
            request: { ...jobFixture().request, verificationId: 'ver-superseded' },
          }),
          completedFixture({
            outcome: 'failed',
            application: 'pending',
            request: { ...jobFixture().request, verificationId: 'ver-unknown-app' },
          }),
        ],
        nextCursor: 40,
      },
      {
        items: [
          jobFixture({
            status: 'CANCELLED',
            finishedAt: '2026-11-05T01:30:00.000Z',
            request: { ...jobFixture().request, verificationId: 'ver-old' },
          }),
        ],
      },
    ]
    const api = mockApi({
      list: vi.fn(async (_ticketId, options) => {
        if (options?.beforeRowid === 40) return pages[1]!
        return pages[0]!
      }),
    })

    render(wrap(<TaskVerification api={api} ticket={reviewTicket()} />))
    expect(await screen.findByText('ver-active')).toBeTruthy()
    expect(screen.getByText('已应用')).toBeTruthy()
    expect(screen.getByText('已过时')).toBeTruthy()
    expect(screen.getAllByText('未知/待定').length).toBeGreaterThan(0)
    expect(screen.getByText(/活跃作业每秒刷新/)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '加载更早记录' }))
    expect(await screen.findByText('ver-old')).toBeTruthy()
    expect(api.list).toHaveBeenCalledWith('task-1', { limit: 20, beforeRowid: 40 })
  })

  it('shows progress cancel intent on listed jobs without claiming DONE', async () => {
    const api = mockApi({
      list: vi.fn(async () => ({
        items: [
          jobFixture({
            status: 'STOPPING',
            cancelRequested: { actorId: 'owner-1', reason: 'abort', at: '2026-11-05T01:04:00.000Z' },
          }),
        ],
      })),
    })
    render(wrap(<TaskVerification api={api} ticket={reviewTicket()} />))
    expect(await screen.findByText(/已记录取消意图/)).toBeTruthy()
    expect(screen.queryByText('DONE')).toBeNull()
  })

  it('invalidates task/tasks/overview when observation shows a new terminal application', async () => {
    let listItems: VerificationJobView[] = [
      jobFixture({ status: 'RUNNING', request: { ...jobFixture().request, verificationId: 'ver-live' } }),
    ]
    const api = mockApi({
      list: vi.fn(async () => ({ items: listItems })),
    })
    const client = createQueryClient()
    const taskSpy = vi.spyOn(client, 'invalidateQueries')

    render(wrap(<TaskVerification api={api} ticket={reviewTicket()} />, client))
    expect(await screen.findByText('ver-live')).toBeTruthy()

    listItems = [
      completedFixture({
        application: 'applied',
        request: { ...jobFixture().request, verificationId: 'ver-live' },
      }),
    ]
    await client.refetchQueries({ queryKey: ['task-verifications', 'task-1'] })
    expect(await screen.findByText('已应用')).toBeTruthy()

    await waitFor(() => {
      const keys = taskSpy.mock.calls.map(call => JSON.stringify(call[0]?.queryKey))
      expect(keys.some(key => key.includes('["task","task-1"]'))).toBe(true)
      expect(keys.some(key => key.includes('["tasks"]'))).toBe(true)
      expect(keys.some(key => key.includes('["overview"]'))).toBe(true)
    })
  })
})
