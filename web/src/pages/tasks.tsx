import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ApiClient,
  Employee,
  LocalTaskCommand,
  ProductTaskDetail,
  ProductTaskListOptions,
  Project,
  TaskCommandResult,
} from '../api.ts'
import { AsyncState, PageHeader, StatusBadge, formatTime } from '../shared.tsx'

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const MAX_TITLE = 512
const MAX_DESCRIPTION = 8192
const MAX_REASON = 8192
const PAGE_LIMIT = 50
const REFETCH_MS = 5_000
const TASK_STATE_OPTIONS = [
  'NEW',
  'QUEUED',
  'ASSIGNED',
  'RUNNING',
  'REVIEW',
  'DONE',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
  'WAITING_APPROVAL',
] as const
const APPROVAL_STATES = ['WAITING_APPROVAL', 'REVIEW'] as const
const TERMINAL_TASK_STATES = new Set(['DONE', 'CANCELLED'])
/** Non-terminal executions (incl. UNKNOWN) retain occupancy until reconciled. */
const RESERVATION_EXECUTION_STATES = new Set(['STARTING', 'RUNNING', 'STOPPING', 'UNKNOWN'])

type CreateInput = Extract<LocalTaskCommand, { kind: 'create' }>['input']
type ActionKind = 'approve' | 'reject' | 'cancel' | 'retry' | 'review'
type TaskStateOption = typeof TASK_STATE_OPTIONS[number]

interface TasksPageProps {
  api: ApiClient
  approvals?: boolean
}

interface TaskPageProps {
  api: ApiClient
  ticketId: string
}

interface PendingAction {
  kind: ActionKind
  approved?: boolean
  reason: string
  expectedVersion: number
  executionId?: string
  artifactRevision?: string
  key: string
  fingerprint: string
}

interface HashFilters {
  state: string
  projectId: string
  employeeId: string
}

function isSafeId(value: string): boolean {
  return SAFE_ID.test(value)
}

function isTaskStateOption(value: string): value is TaskStateOption {
  return (TASK_STATE_OPTIONS as readonly string[]).includes(value)
}

/** Read `#/tasks?...` query once; parent remounts on full hash change. Invalid IDs/states ignored. */
function parseHashQueryFilters(): HashFilters {
  const hash = typeof window === 'undefined' ? '' : window.location.hash
  const queryStart = hash.indexOf('?')
  if (queryStart < 0) return { state: '', projectId: '', employeeId: '' }
  const params = new URLSearchParams(hash.slice(queryStart + 1))
  const projectIdRaw = params.get('projectId') ?? ''
  const employeeIdRaw = params.get('employeeId') ?? ''
  const stateRaw = params.get('state') ?? ''
  return {
    projectId: isSafeId(projectIdRaw) ? projectIdRaw : '',
    employeeId: isSafeId(employeeIdRaw) ? employeeIdRaw : '',
    state: isTaskStateOption(stateRaw) ? stateRaw : '',
  }
}

function conflictStatus(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { status?: unknown; code?: unknown }
  if (record.status === 409) return true
  return record.code === 'VERSION_CONFLICT' || record.code === 'STATE_CONFLICT' || record.code === 'IDEMPOTENCY_CONFLICT'
}

function commandFingerprint(command: LocalTaskCommand): string {
  return JSON.stringify(command)
}

function newKey(): string {
  return crypto.randomUUID()
}

function invalidateTaskQueries(queryClient: ReturnType<typeof useQueryClient>, ticketId?: string): void {
  void queryClient.invalidateQueries({ queryKey: ['tasks'] })
  void queryClient.invalidateQueries({ queryKey: ['overview'] })
  if (ticketId) void queryClient.invalidateQueries({ queryKey: ['task', ticketId] })
}

function validateCreateInput(input: CreateInput): string | undefined {
  if (!isSafeId(input.issueId)) return 'issueId 必须是安全标识符'
  if (!isSafeId(input.projectId)) return '请选择有效项目'
  if (!input.title.trim() || input.title.includes('\0') || input.title.length > MAX_TITLE) return '标题不能为空且不超过 512 字符'
  if (!input.description.trim() || input.description.includes('\0') || input.description.length > MAX_DESCRIPTION) {
    return '描述不能为空且不超过 8192 字符'
  }
  if (!isSafeId(input.taskType)) return '请选择允许的任务类型'
  if (input.priority !== undefined && (!Number.isFinite(input.priority) || input.priority < 0)) return '优先级无效'
  return undefined
}

function validateReason(reason: string): string | undefined {
  if (!reason.trim() || reason.includes('\0') || reason.length > MAX_REASON) return '请填写有效原因'
  return undefined
}

function canApproveReview(detail: ProductTaskDetail): boolean {
  const result = detail.ticket.lifecycle?.result
  if (!result) return false
  return result.terminal === 'success'
    && result.exitCode === 0
    && (result.verification === 'passed' || result.verification === 'not_required')
}

function executionRetainsReservation(detail: ProductTaskDetail): boolean {
  return detail.executions.some(execution => RESERVATION_EXECUTION_STATES.has(execution.state))
}

function actionLabel(kind: ActionKind, approved?: boolean): string {
  switch (kind) {
    case 'approve': return '批准执行'
    case 'reject': return '拒绝执行'
    case 'cancel': return '请求取消'
    case 'retry': return '重试'
    case 'review': return approved ? '审核通过' : '审核驳回'
  }
}

export function TasksPage({ api, approvals = false }: TasksPageProps) {
  const queryClient = useQueryClient()
  const [hashFilters] = useState(parseHashQueryFilters)
  const [stateFilter, setStateFilter] = useState(hashFilters.state)
  const [projectFilter, setProjectFilter] = useState(hashFilters.projectId)
  const [employeeFilter, setEmployeeFilter] = useState(hashFilters.employeeId)
  const [cursorStack, setCursorStack] = useState<number[]>([])
  const [createdTicketId, setCreatedTicketId] = useState<string | undefined>()
  const [createError, setCreateError] = useState<string | undefined>()
  const [replayedNotice, setReplayedNotice] = useState(false)
  const [form, setForm] = useState({
    projectId: '',
    taskType: '',
    title: '',
    description: '',
    priority: '0',
    issueId: '',
  })
  const createKeyRef = useRef<{ fingerprint: string; key: string } | undefined>(undefined)

  useEffect(() => {
    setCursorStack([])
  }, [stateFilter, projectFilter, employeeFilter, approvals])

  const listOptions = useMemo((): ProductTaskListOptions => {
    const options: ProductTaskListOptions = { limit: PAGE_LIMIT }
    const beforeRowid = cursorStack.at(-1)
    if (beforeRowid !== undefined) options.beforeRowid = beforeRowid
    if (approvals) {
      options.states = [...APPROVAL_STATES]
    } else if (stateFilter) {
      options.states = [stateFilter as TaskStateOption]
    }
    if (projectFilter) options.projectId = projectFilter
    if (employeeFilter) options.employeeId = employeeFilter
    return options
  }, [approvals, stateFilter, projectFilter, employeeFilter, cursorStack])

  const tasksQuery = useQuery({
    queryKey: ['tasks', listOptions],
    queryFn: ({ signal }) => api.tasks(listOptions, signal),
    refetchInterval: REFETCH_MS,
  })

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => api.projects(signal),
    refetchInterval: REFETCH_MS,
  })

  const employeesQuery = useQuery({
    queryKey: ['employees'],
    queryFn: ({ signal }) => api.employees(signal),
    refetchInterval: REFETCH_MS,
  })

  const projects = projectsQuery.data ?? []
  const employees = employeesQuery.data ?? []
  const selectedProject: Project | undefined = projects.find(item => item.id === form.projectId)

  useEffect(() => {
    if (!selectedProject) return
    if (!selectedProject.allowedTaskTypes.includes(form.taskType)) {
      setForm(current => ({ ...current, taskType: selectedProject.allowedTaskTypes[0] ?? '' }))
    }
  }, [selectedProject, form.taskType])

  const createMutation = useMutation({
    mutationFn: async ({ key, command }: { key: string; command: LocalTaskCommand }) => api.command(key, command),
    onSuccess: (result: TaskCommandResult) => {
      createKeyRef.current = undefined
      setCreatedTicketId(result.ticket.id)
      setReplayedNotice(result.replayed)
      setCreateError(undefined)
      invalidateTaskQueries(queryClient, result.ticket.id)
    },
    onError: (error: unknown) => {
      if (conflictStatus(error)) {
        createKeyRef.current = undefined
        setCreateError('请求冲突，请核对表单后重新提交（将使用新的幂等键）。')
        return
      }
      setCreateError('提交失败，可在内容不变时重试同一意图。')
    },
  })

  function buildCreateInput(): CreateInput | undefined {
    const priorityRaw = form.priority.trim()
    const priority = priorityRaw === '' ? undefined : Number(priorityRaw)
    const input: CreateInput = {
      issueId: form.issueId.trim(),
      projectId: form.projectId.trim(),
      title: form.title,
      description: form.description,
      taskType: form.taskType.trim(),
    }
    if (priority !== undefined) input.priority = priority
    return input
  }

  function onCreateSubmit(event: FormEvent): void {
    event.preventDefault()
    setCreatedTicketId(undefined)
    setReplayedNotice(false)
    const input = buildCreateInput()
    if (!input) return
    const validation = validateCreateInput(input)
    if (validation) {
      setCreateError(validation)
      return
    }
    if (selectedProject && !selectedProject.allowedTaskTypes.includes(input.taskType)) {
      setCreateError('任务类型不在该项目允许列表中')
      return
    }
    const command: LocalTaskCommand = { kind: 'create', input }
    const fingerprint = commandFingerprint(command)
    let key = createKeyRef.current?.key
    if (!key || createKeyRef.current?.fingerprint !== fingerprint) {
      key = newKey()
      createKeyRef.current = { key, fingerprint }
    }
    setCreateError(undefined)
    createMutation.mutate({ key, command })
  }

  const items = tasksQuery.data?.items ?? []
  const nextCursor = tasksQuery.data?.nextCursor

  return (
    <div className="stack">
      <PageHeader
        title={approvals ? '审批与审核' : '任务'}
        description={approvals
          ? '仅展示等待批准执行与待人工审核的任务。'
          : '浏览、筛选并创建本地任务；创建不会自动完成。'}
      />

      <section className="panel" aria-label="任务筛选">
        <div className="form-grid">
          {!approvals && (
            <label className="field">
              <span>状态</span>
              <select
                aria-label="状态筛选"
                value={stateFilter}
                onChange={event => setStateFilter(event.target.value)}
              >
                <option value="">全部状态</option>
                {TASK_STATE_OPTIONS.map(state => (
                  <option key={state} value={state}>{state}</option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>项目</span>
            <select
              aria-label="项目筛选"
              value={projectFilter}
              onChange={event => setProjectFilter(event.target.value)}
            >
              <option value="">全部项目</option>
              {projects.map(project => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
              {projectFilter && !projects.some(item => item.id === projectFilter) && (
                <option value={projectFilter}>{projectFilter}</option>
              )}
            </select>
          </label>
          <label className="field">
            <span>员工</span>
            <select
              aria-label="员工筛选"
              value={employeeFilter}
              onChange={event => setEmployeeFilter(event.target.value)}
            >
              <option value="">全部员工</option>
              {employees.map((employee: Employee) => (
                <option key={employee.id} value={employee.id}>{employee.name}</option>
              ))}
              {employeeFilter && !employees.some(item => item.id === employeeFilter) && (
                <option value={employeeFilter}>{employeeFilter}</option>
              )}
            </select>
          </label>
        </div>
        {approvals && <p className="muted">审批视图固定筛选 WAITING_APPROVAL 与 REVIEW。</p>}
      </section>

      {!approvals && (
        <section className="panel" aria-label="创建任务">
          <h2>创建任务</h2>
          <form className="form-grid" onSubmit={onCreateSubmit} noValidate>
            <label className="field">
              <span>项目</span>
              <select
                aria-label="创建项目"
                value={form.projectId}
                onChange={event => setForm(current => ({ ...current, projectId: event.target.value }))}
                required
              >
                <option value="">选择项目</option>
                {projects.filter(project => !project.archived).map(project => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>任务类型</span>
              <select
                aria-label="任务类型"
                value={form.taskType}
                onChange={event => setForm(current => ({ ...current, taskType: event.target.value }))}
                required
                disabled={!selectedProject}
              >
                <option value="">选择类型</option>
                {(selectedProject?.allowedTaskTypes ?? []).map(type => (
                  <option key={type} value={type}>{type}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>标题</span>
              <input
                aria-label="任务标题"
                value={form.title}
                maxLength={MAX_TITLE}
                onChange={event => setForm(current => ({ ...current, title: event.target.value }))}
                required
              />
            </label>
            <label className="field">
              <span>描述</span>
              <textarea
                aria-label="任务描述"
                value={form.description}
                maxLength={MAX_DESCRIPTION}
                onChange={event => setForm(current => ({ ...current, description: event.target.value }))}
                required
              />
            </label>
            <label className="field">
              <span>优先级</span>
              <input
                aria-label="优先级"
                type="number"
                min={0}
                step={1}
                value={form.priority}
                onChange={event => setForm(current => ({ ...current, priority: event.target.value }))}
              />
            </label>
            <label className="field">
              <span>issueId</span>
              <input
                aria-label="issueId"
                value={form.issueId}
                onChange={event => setForm(current => ({ ...current, issueId: event.target.value }))}
                required
              />
            </label>
            <div className="page-actions">
              <button type="submit" className="button" disabled={createMutation.isPending}>
                {createMutation.isPending ? '提交中…' : '创建任务'}
              </button>
            </div>
          </form>
          {createError && <p role="alert" className="error-state">{createError}</p>}
          {createdTicketId && (
            <p role="status" className="muted">
              {replayedNotice ? '已重放先前创建回执：' : '已创建：'}
              <a href={`#/tasks/${createdTicketId}`}>打开任务 {createdTicketId}</a>
            </p>
          )}
        </section>
      )}

      <section className="panel" aria-label="任务列表">
        <AsyncState
          loading={tasksQuery.isLoading}
          error={tasksQuery.error}
          empty={!tasksQuery.isLoading && !tasksQuery.error && items.length === 0}
        >
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">标题</th>
                  <th scope="col">状态</th>
                  <th scope="col">优先级</th>
                  <th scope="col">更新时间</th>
                  <th scope="col">员工</th>
                </tr>
              </thead>
              <tbody>
                {items.map(item => (
                  <tr key={item.id}>
                    <td><a href={`#/tasks/${item.id}`}>{item.title}</a></td>
                    <td><StatusBadge status={item.status} /></td>
                    <td>{item.priority}</td>
                    <td>{formatTime(item.updatedAt)}</td>
                    <td>{item.agentId ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </AsyncState>
        <div className="page-actions">
          <button
            type="button"
            className="button secondary"
            disabled={cursorStack.length === 0 || tasksQuery.isFetching}
            onClick={() => setCursorStack(stack => stack.slice(0, -1))}
          >
            上一页
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={nextCursor === undefined || tasksQuery.isFetching}
            onClick={() => {
              if (nextCursor === undefined) return
              setCursorStack(stack => [...stack, nextCursor])
            }}
          >
            下一页
          </button>
        </div>
      </section>
    </div>
  )
}

export function TaskPage({ api, ticketId }: TaskPageProps) {
  const queryClient = useQueryClient()
  const [logsOpen, setLogsOpen] = useState(false)
  const [draftKind, setDraftKind] = useState<ActionKind | undefined>()
  const [draftApproved, setDraftApproved] = useState(false)
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [actionError, setActionError] = useState<string | undefined>()
  const [actionNotice, setActionNotice] = useState<string | undefined>()
  const pendingRef = useRef<PendingAction | undefined>(undefined)

  const safeTicket = isSafeId(ticketId)

  const detailQuery = useQuery({
    queryKey: ['task', ticketId],
    queryFn: ({ signal }) => api.task(ticketId, signal),
    enabled: safeTicket,
    refetchInterval: REFETCH_MS,
  })

  const logsQuery = useQuery({
    queryKey: ['task-logs', ticketId],
    queryFn: ({ signal }) => api.logs(ticketId, undefined, signal),
    enabled: safeTicket && logsOpen,
  })

  const actionMutation = useMutation({
    mutationFn: async ({ key, command }: { key: string; command: LocalTaskCommand }) => api.command(key, command),
    onSuccess: (result: TaskCommandResult) => {
      pendingRef.current = undefined
      setConfirming(false)
      setDraftKind(undefined)
      setReason('')
      setActionError(undefined)
      setActionNotice(result.replayed ? '命令已按幂等键重放，未重复变更。' : '命令已生效。')
      invalidateTaskQueries(queryClient, result.ticket.id)
    },
    onError: async (error: unknown) => {
      if (conflictStatus(error)) {
        pendingRef.current = undefined
        setConfirming(false)
        setDraftKind(undefined)
        setReason('')
        setActionError('版本或状态冲突（409）。详情已刷新，请基于最新状态重新填写原因并再次确认。')
        await detailQuery.refetch()
        invalidateTaskQueries(queryClient, ticketId)
        return
      }
      setActionError('命令失败。若意图未变，可再次确认以复用同一幂等键。')
    },
  })

  const actionBusy = actionMutation.isPending
  const detail = detailQuery.data
  const lifecycle = detail?.ticket.lifecycle
  const status = lifecycle?.status
  const result = lifecycle?.result

  function beginAction(kind: ActionKind, approved = false): void {
    if (actionBusy) return
    setDraftKind(kind)
    setDraftApproved(approved)
    setConfirming(false)
    setActionError(undefined)
    setActionNotice(undefined)
    setReason('')
    pendingRef.current = undefined
  }

  function buildCommand(pending: PendingAction): LocalTaskCommand {
    switch (pending.kind) {
      case 'approve':
      case 'reject':
      case 'cancel':
      case 'retry':
        return {
          kind: pending.kind,
          ticketId,
          expectedVersion: pending.expectedVersion,
          reason: pending.reason,
        }
      case 'review':
        return {
          kind: 'review',
          ticketId,
          expectedVersion: pending.expectedVersion,
          executionId: pending.executionId!,
          artifactRevision: pending.artifactRevision!,
          approved: pending.approved === true,
          reason: pending.reason,
        }
    }
  }

  function prepareConfirmation(): void {
    if (actionBusy || !lifecycle || !draftKind) return
    const reasonError = validateReason(reason)
    if (reasonError) {
      setActionError(reasonError)
      return
    }
    if (draftKind === 'review') {
      if (!result?.executionId || !result.artifactRevision) {
        setActionError('缺少当前执行证据，无法审核。')
        return
      }
      if (draftApproved && !canApproveReview(detail!)) {
        setActionError('仅当执行已成功结束、退出码为 0 且验证为通过或不需要时，才可审核通过。')
        return
      }
    }
    const draft: PendingAction = {
      kind: draftKind,
      approved: draftKind === 'review' ? draftApproved : undefined,
      reason: reason.trim(),
      expectedVersion: lifecycle.version,
      executionId: draftKind === 'review' ? result?.executionId : undefined,
      artifactRevision: draftKind === 'review' ? result?.artifactRevision : undefined,
      key: '',
      fingerprint: '',
    }
    const command = buildCommand(draft)
    const fingerprint = commandFingerprint(command)
    const existing = pendingRef.current
    const key = existing && existing.fingerprint === fingerprint ? existing.key : newKey()
    pendingRef.current = { ...draft, key, fingerprint }
    setConfirming(true)
    setActionError(undefined)
  }

  function submitConfirmed(): void {
    if (actionBusy) return
    const pending = pendingRef.current
    if (!pending) return
    const command = buildCommand(pending)
    actionMutation.mutate({ key: pending.key, command })
  }

  if (!safeTicket) {
    return (
      <div className="stack">
        <PageHeader title="任务详情" description="无效的任务标识。" />
        <div role="alert" className="error-state">任务 ID 无效。</div>
      </div>
    )
  }

  const showApprove = status === 'WAITING_APPROVAL'
  const showCancel = status !== undefined && !TERMINAL_TASK_STATES.has(status)
  const showRetry = (status === 'FAILED' || status === 'BLOCKED')
    && !!detail
    && !executionRetainsReservation(detail)
  const showReview = status === 'REVIEW' && !!result

  return (
    <div className="stack">
      <PageHeader
        title={detail?.ticket.title ?? '任务详情'}
        description={safeTicket ? `任务 ${ticketId}` : undefined}
      >
        <a className="button secondary" href="#/tasks">返回列表</a>
      </PageHeader>

      <AsyncState loading={detailQuery.isLoading} error={detailQuery.error} empty={!detailQuery.isLoading && !detailQuery.error && !detail}>
        {detail && lifecycle && (
          <>
            <section className="panel detail-grid" aria-label="任务概要">
              <div>
                <h2>生命周期</h2>
                <p><StatusBadge status={lifecycle.status} /> · 版本 {lifecycle.version}</p>
                <p className="muted">类型 {lifecycle.taskType} · 策略 {lifecycle.policyVersion}</p>
                <p className="muted">尝试次数 {lifecycle.attempts} / 上限 {lifecycle.policy.retryLimit + 1}</p>
                {status === 'QUEUED' && (
                  <p className="muted">已入队不等于控制器正在运行；调度与 Runtime 启动是后续独立步骤。</p>
                )}
                {lifecycle.cancelRequested && (
                  <p role="status" className="muted">
                    已记录取消请求（{lifecycle.cancelRequested.reason}），这不代表进程已停止；需等待执行侧确认退出。
                  </p>
                )}
              </div>
              <div>
                <h2>议题</h2>
                <p>{lifecycle.issue.description}</p>
                <p className="muted">来源 {lifecycle.issue.source} · issueId {lifecycle.issue.issueId}</p>
                <p className="muted">优先级 {lifecycle.issue.priority} · 更新 {formatTime(lifecycle.issue.updatedAt)}</p>
              </div>
            </section>

            <section className="panel" aria-label="分配">
              <h2>分配记录</h2>
              {detail.ticket.assignments.length === 0 ? (
                <p className="empty-state">暂无分配</p>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">分配 ID</th>
                        <th scope="col">状态</th>
                        <th scope="col">员工</th>
                        <th scope="col">Runtime</th>
                        <th scope="col">创建时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.ticket.assignments.map(assignment => (
                        <tr key={assignment.id}>
                          <td>{assignment.id}</td>
                          <td>{assignment.state}</td>
                          <td>{assignment.agentId ?? '—'}</td>
                          <td>{assignment.runtime ?? '—'}</td>
                          <td>{formatTime(assignment.createdAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="panel" aria-label="执行与证据">
              <h2>执行记录</h2>
              {detail.executionsTruncated && <p className="muted">执行列表已截断，仅显示最近部分记录。</p>}
              {detail.executions.length === 0 ? (
                <p className="empty-state">暂无执行</p>
              ) : (
                <div className="table-wrap">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th scope="col">执行</th>
                        <th scope="col">状态</th>
                        <th scope="col">退出码</th>
                        <th scope="col">更新时间</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.executions.map(execution => (
                        <tr key={execution.executionId}>
                          <td>
                            <a href={`#/executions/${execution.executionId}`}>{execution.executionId}</a>
                            {execution.state === 'UNKNOWN' && (
                              <span className="muted"> · UNKNOWN 仍占用资源，需等待核对</span>
                            )}
                          </td>
                          <td><StatusBadge status={execution.state} /></td>
                          <td>{execution.exitCode ?? '—'}</td>
                          <td>{formatTime(execution.updatedAt)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {result && (
                <div className="stack">
                  <h3>当前证据 / 验证</h3>
                  <p>
                    执行 {result.executionId} · 产物修订 {result.artifactRevision} · 终端 {result.terminal}
                    · exit {result.exitCode} · 验证 {result.verification}
                  </p>
                  <p className="muted">{result.summary}</p>
                  <p className="muted">
                    验证需独立完成（当前由 CLI 执行）；本界面仅展示结果。
                  </p>
                </div>
              )}
            </section>

            <section className="panel" aria-label="历史">
              <h2>历史</h2>
              {detail.historyTruncated && <p role="status" className="muted">历史已截断，仅显示最近部分事件。</p>}
              {detail.history.length === 0 ? (
                <p className="empty-state">暂无历史</p>
              ) : (
                <ul className="stack">
                  {detail.history.map(item => (
                    <li key={item.id}>
                      <span className="muted">{formatTime(item.at)}</span>
                      {' '}{item.kind} · {item.actor} · {item.reason}
                      {item.from && item.to ? ` (${item.from} → ${item.to})` : ''}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="panel" aria-label="日志">
              <h2>执行日志</h2>
              <button
                type="button"
                className="button secondary"
                aria-pressed={logsOpen}
                onClick={() => setLogsOpen(open => !open)}
              >
                {logsOpen ? '隐藏日志' : '读取日志'}
              </button>
              {logsOpen && (
                <AsyncState loading={logsQuery.isLoading} error={logsQuery.error} empty={!logsQuery.isLoading && (logsQuery.data?.executions.length ?? 0) === 0}>
                  <div className="stack">
                    {(logsQuery.data?.executions ?? []).map(entry => (
                      <div key={entry.executionId} className="panel">
                        <h3>{entry.executionId} · {entry.state}</h3>
                        <pre aria-label={`${entry.executionId} stdout`}>{entry.stdout || '（无 stdout）'}</pre>
                        <pre aria-label={`${entry.executionId} stderr`}>{entry.stderr || '（无 stderr）'}</pre>
                        {(entry.stdoutTruncated || entry.stderrTruncated) && (
                          <p className="muted">日志输出已截断。</p>
                        )}
                      </div>
                    ))}
                  </div>
                </AsyncState>
              )}
            </section>

            <section className="panel" aria-label="任务操作">
              <h2>操作</h2>
              <div className="page-actions">
                {showApprove && (
                  <>
                    <button type="button" className="button" disabled={actionBusy} onClick={() => beginAction('approve')}>批准</button>
                    <button type="button" className="button danger" disabled={actionBusy} onClick={() => beginAction('reject')}>拒绝</button>
                  </>
                )}
                {showReview && (
                  <>
                    <button
                      type="button"
                      className="button"
                      disabled={actionBusy || !canApproveReview(detail)}
                      title={!canApproveReview(detail) ? '需终端成功、exit 0 且验证通过/不需要' : undefined}
                      onClick={() => beginAction('review', true)}
                    >
                      审核通过
                    </button>
                    <button type="button" className="button danger" disabled={actionBusy} onClick={() => beginAction('review', false)}>审核驳回</button>
                  </>
                )}
                {showRetry && (
                  <button type="button" className="button secondary" disabled={actionBusy} onClick={() => beginAction('retry')}>重试</button>
                )}
                {showCancel && (
                  <button type="button" className="button danger" disabled={actionBusy} onClick={() => beginAction('cancel')}>请求取消</button>
                )}
              </div>
              <p className="muted">取消需等待进程退出确认；入队不代表控制器已在运行。</p>

              {draftKind && (
                <div className="form-grid">
                  <p>
                    准备操作：<strong>{actionLabel(draftKind, draftApproved)}</strong>
                    {' '}· 版本 {lifecycle.version}
                  </p>
                  {draftKind === 'review' && result && (
                    <p className="muted">
                      针对当前执行 {result.executionId} / 产物修订 {result.artifactRevision}
                    </p>
                  )}
                  {draftKind === 'cancel' && (
                    <p className="muted">提交后仅记录取消请求；若进程仍在运行，需等待执行侧确认退出。</p>
                  )}
                  <label className="field">
                    <span>原因</span>
                    <textarea
                      aria-label="操作原因"
                      value={reason}
                      maxLength={MAX_REASON}
                      disabled={actionBusy}
                      onChange={event => {
                        if (actionBusy) return
                        setReason(event.target.value)
                        setConfirming(false)
                      }}
                      required
                    />
                  </label>
                  {!confirming ? (
                    <button type="button" className="button" disabled={actionBusy} onClick={prepareConfirmation}>预览确认</button>
                  ) : pendingRef.current && (
                    <div className="stack" role="region" aria-label="操作确认预览">
                      <p>请确认以下内容后提交：</p>
                      <ul>
                        <li>操作：{actionLabel(pendingRef.current.kind, pendingRef.current.approved)}</li>
                        <li>任务：{ticketId}</li>
                        <li>版本：{pendingRef.current.expectedVersion}</li>
                        <li>原因：{pendingRef.current.reason}</li>
                        {pendingRef.current.executionId && <li>执行：{pendingRef.current.executionId}</li>}
                        {pendingRef.current.artifactRevision && <li>产物修订：{pendingRef.current.artifactRevision}</li>}
                        {pendingRef.current.kind === 'review' && (
                          <li>审核结果：{pendingRef.current.approved ? '通过' : '驳回'}</li>
                        )}
                      </ul>
                      <div className="page-actions">
                        <button
                          type="button"
                          className="button"
                          disabled={actionBusy}
                          onClick={submitConfirmed}
                        >
                          {actionBusy ? '提交中…' : '确认提交'}
                        </button>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={actionBusy}
                          onClick={() => {
                            if (actionBusy) return
                            setConfirming(false)
                            pendingRef.current = undefined
                          }}
                        >
                          返回修改
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {actionError && <p role="alert" className="error-state">{actionError}</p>}
              {actionNotice && <p role="status" className="muted">{actionNotice}</p>}
            </section>
          </>
        )}
      </AsyncState>
    </div>
  )
}
