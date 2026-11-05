import { useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  ApiClient,
  Employee,
  ManagementAudit,
  ManagementCommand,
  ManagementResult,
  Project,
} from '../api.ts'
import { AsyncState, PageHeader, StatusBadge, formatTime } from '../shared.tsx'

export const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
export const MAX_REASON = 4096
export const MAX_NAME = 256
export const MAX_ROLE = 256
export const MAX_LIST_ITEMS = 256
export const MAX_ITEM_LENGTH = 512
export const MAX_CONCURRENCY = 1024
export const MAX_TIMEOUT_MS = 86_400_000
export const REFETCH_MS = 5_000
export const CONFIGURED_RUNTIME_ID = 'claude-local'

export type EmployeeMode = 'create' | 'edit'
export type ProjectMode = 'create' | 'edit'

export interface PendingMutation {
  key: string
  fingerprint: string
  command: ManagementCommand
  label: string
}

export interface EmployeeFormState {
  id: string
  name: string
  role: string
  responsibilitiesText: string
  capabilitiesText: string
  runtimeId: string
  projectIds: string[]
  maxConcurrency: string
  timeoutMs: string
}

export interface ProjectFormState {
  id: string
  name: string
  ownerId: string
  repositoryPath: string
  worktreeRoot: string
  allowedTaskTypesText: string
}

export function isSafeId(value: string): boolean {
  return SAFE_ID.test(value)
}

export function conflictStatus(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { status?: unknown; code?: unknown }
  if (record.status === 409) return true
  return record.code === 'VERSION_CONFLICT' || record.code === 'STATE_CONFLICT' || record.code === 'IDEMPOTENCY_CONFLICT'
}

export function commandFingerprint(command: ManagementCommand): string {
  return JSON.stringify(command)
}

export function newKey(): string {
  return crypto.randomUUID()
}

export function cloneEmployee(employee: Employee): Employee {
  return {
    ...employee,
    responsibilities: [...employee.responsibilities],
    capabilities: [...employee.capabilities],
    projectIds: [...employee.projectIds],
  }
}

export function cloneProject(project: Project): Project {
  return {
    ...project,
    allowedTaskTypes: [...project.allowedTaskTypes],
  }
}

export function invalidateManagementQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  kind?: 'employee' | 'project',
  id?: string,
): void {
  void queryClient.invalidateQueries({ queryKey: ['employees'] })
  void queryClient.invalidateQueries({ queryKey: ['projects'] })
  void queryClient.invalidateQueries({ queryKey: ['overview'] })
  void queryClient.invalidateQueries({ queryKey: ['tasks'] })
  if (kind && id) {
    void queryClient.invalidateQueries({ queryKey: ['management-history', kind, id] })
  } else {
    void queryClient.invalidateQueries({ queryKey: ['management-history'] })
  }
}

export function validateReason(reason: string): string | undefined {
  if (!reason.trim() || reason.includes('\0') || reason.length > MAX_REASON) {
    return '请填写有效原因（非空，最长 4096 字符）。'
  }
  return undefined
}

export function parseStringList(text: string, options: { unique: boolean; safeIds: boolean; field: string }): string[] | string {
  const raw = text
    .split(/[\n,]/)
    .map(item => item.trim())
    .filter(item => item.length > 0)
  if (raw.length > MAX_LIST_ITEMS) return `${options.field} 最多 ${MAX_LIST_ITEMS} 项`
  const result: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (item.includes('\0') || item.length > MAX_ITEM_LENGTH) return `${options.field} 含无效项`
    if (options.safeIds && !isSafeId(item)) return `${options.field} 必须是安全标识符`
    if (options.unique) {
      if (seen.has(item)) continue
      seen.add(item)
    }
    result.push(item)
  }
  return result
}

export function isAbsolutePath(value: string): boolean {
  return value.startsWith('/') && !value.includes('\0')
}

export function configuredEnabledLabel(enabled: boolean): string {
  return enabled ? '已启用' : '未启用'
}

export function formatReadableList(items: readonly string[]): string {
  return items.length === 0 ? '（空）' : items.join('、')
}

export function emptyEmployeeForm(): EmployeeFormState {
  return {
    id: '',
    name: '',
    role: '',
    responsibilitiesText: '',
    capabilitiesText: '',
    runtimeId: CONFIGURED_RUNTIME_ID,
    projectIds: [],
    maxConcurrency: '1',
    timeoutMs: '60000',
  }
}

export function employeeToForm(employee: Employee): EmployeeFormState {
  return {
    id: employee.id,
    name: employee.name,
    role: employee.role,
    responsibilitiesText: employee.responsibilities.join('\n'),
    capabilitiesText: employee.capabilities.join('\n'),
    runtimeId: employee.runtimeId,
    projectIds: [...employee.projectIds],
    maxConcurrency: String(employee.maxConcurrency),
    timeoutMs: String(employee.timeoutMs),
  }
}

export function emptyProjectForm(): ProjectFormState {
  return {
    id: '',
    name: '',
    ownerId: '',
    repositoryPath: '',
    worktreeRoot: '',
    allowedTaskTypesText: '',
  }
}

export function projectToForm(project: Project): ProjectFormState {
  return {
    id: project.id,
    name: project.name,
    ownerId: project.ownerId,
    repositoryPath: project.repositoryPath,
    worktreeRoot: project.worktreeRoot,
    allowedTaskTypesText: project.allowedTaskTypes.join('\n'),
  }
}

export function RefreshButton({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  return (
    <button type="button" className="button secondary" onClick={onClick} disabled={busy} aria-label="刷新">
      刷新
    </button>
  )
}

export function PreviewRows({ rows }: { rows: ReadonlyArray<{ label: string; value: string }> }) {
  return (
    <ul>
      {rows.map(row => (
        <li key={row.label}>{row.label}：{row.value}</li>
      ))}
    </ul>
  )
}

export function commandPreviewRows(command: ManagementCommand): Array<{ label: string; value: string }> {
  switch (command.kind) {
    case 'employee-create':
      return [
        { label: '员工 ID', value: command.input.id },
        { label: '名称', value: command.input.name },
        { label: '岗位', value: command.input.role },
        { label: '职责', value: formatReadableList(command.input.responsibilities) },
        { label: '能力', value: formatReadableList(command.input.capabilities) },
        { label: 'Runtime', value: command.input.runtimeId },
        { label: '项目成员', value: formatReadableList(command.input.projectIds) },
        { label: '最大并发', value: String(command.input.maxConcurrency) },
        { label: '超时（毫秒）', value: String(command.input.timeoutMs) },
        { label: '启用状态', value: '未启用（创建后需单独启用）' },
      ]
    case 'employee-update': {
      const rows: Array<{ label: string; value: string }> = [
        { label: '期望版本', value: String(command.input.expectedVersion) },
      ]
      if (command.input.name !== undefined) rows.push({ label: '名称', value: command.input.name })
      if (command.input.role !== undefined) rows.push({ label: '岗位', value: command.input.role })
      if (command.input.responsibilities !== undefined) {
        rows.push({ label: '职责', value: formatReadableList(command.input.responsibilities) })
      }
      if (command.input.capabilities !== undefined) {
        rows.push({ label: '能力', value: formatReadableList(command.input.capabilities) })
      }
      if (command.input.runtimeId !== undefined) rows.push({ label: 'Runtime', value: command.input.runtimeId })
      if (command.input.projectIds !== undefined) {
        rows.push({ label: '项目成员', value: formatReadableList(command.input.projectIds) })
      }
      if (command.input.maxConcurrency !== undefined) {
        rows.push({ label: '最大并发', value: String(command.input.maxConcurrency) })
      }
      if (command.input.timeoutMs !== undefined) {
        rows.push({ label: '超时（毫秒）', value: String(command.input.timeoutMs) })
      }
      return rows
    }
    case 'employee-enable':
      return [
        { label: '期望版本', value: String(command.input.expectedVersion) },
        { label: '启用状态', value: command.input.enabled ? '启用' : '停用' },
      ]
    case 'project-create':
      return [
        { label: '项目 ID', value: command.input.id },
        { label: '名称', value: command.input.name },
        { label: '业务负责人', value: command.input.ownerId },
        { label: '仓库路径', value: command.input.repositoryPath },
        { label: '工作树根目录', value: command.input.worktreeRoot },
        { label: '允许任务类型', value: formatReadableList(command.input.allowedTaskTypes) },
      ]
    case 'project-update': {
      const rows: Array<{ label: string; value: string }> = [
        { label: '期望版本', value: String(command.input.expectedVersion) },
      ]
      if (command.input.name !== undefined) rows.push({ label: '名称', value: command.input.name })
      if (command.input.ownerId !== undefined) rows.push({ label: '业务负责人', value: command.input.ownerId })
      if (command.input.allowedTaskTypes !== undefined) {
        rows.push({ label: '允许任务类型', value: formatReadableList(command.input.allowedTaskTypes) })
      }
      return rows
    }
    case 'project-archive':
      return [
        { label: '期望版本', value: String(command.input.expectedVersion) },
        { label: '归档状态', value: '归档（阻止未来接入，不影响运行中任务）' },
      ]
  }
}

export function ConfirmationPreview({
  pending,
  busy,
  onSubmit,
  onCancel,
}: {
  pending: PendingMutation
  busy: boolean
  onSubmit: () => void
  onCancel: () => void
}) {
  const fieldRows = commandPreviewRows(pending.command)
  return (
    <div className="stack" role="region" aria-label="操作确认预览">
      <p>请确认以下内容后提交：</p>
      <ul>
        <li>操作：{pending.label}</li>
        <li>命令：{pending.command.kind}</li>
        <li>原因：{pending.command.reason}</li>
        {'id' in pending.command && <li>资源：{pending.command.id}</li>}
      </ul>
      <p>将提交的配置：</p>
      <PreviewRows rows={fieldRows} />
      <div className="page-actions">
        <button type="button" className="button" disabled={busy} onClick={onSubmit}>
          {busy ? '提交中…' : '确认提交'}
        </button>
        <button type="button" className="button secondary" disabled={busy} onClick={onCancel}>
          返回修改
        </button>
      </div>
    </div>
  )
}

export function HistoryPanel({
  title,
  loading,
  error,
  items,
}: {
  title: string
  loading: boolean
  error: unknown
  items: ManagementAudit[] | undefined
}) {
  return (
    <section className="panel" aria-label={title}>
      <h2>{title}</h2>
      <AsyncState loading={loading} error={error} empty={!loading && !error && (items?.length ?? 0) === 0}>
        {items && items.length > 0 && (
          <ul className="stack">
            {items.map(item => (
              <li key={item.id}>
                <span className="muted">{formatTime(item.createdAt)}</span>
                {' '}操作者 {item.actorId} · {item.action} · 版本 {item.beforeVersion ?? '—'} → {item.afterVersion}
                <div className="muted">原因：{item.reason}</div>
              </li>
            ))}
          </ul>
        )}
      </AsyncState>
    </section>
  )
}

export function StaleEditNotice({
  baseVersion,
  liveVersion,
  onReload,
  busy,
}: {
  baseVersion: number
  liveVersion: number
  onReload: () => void
  busy: boolean
}): ReactNode {
  return (
    <p role="status" className="muted">
      远端记录已变更（基准版本 {baseVersion} → 当前 {liveVersion}）。草稿与期望版本仍保留；提交将使用原基准版本。
      若要放弃草稿并加载最新快照，请
      {' '}
      <button type="button" className="button secondary" disabled={busy} onClick={onReload}>
        重新打开
      </button>
      。
    </p>
  )
}

export function useManagementMutation(
  api: ApiClient,
  onConflict: () => void | Promise<void>,
  onApplied: (result: ManagementResult) => void,
) {
  const queryClient = useQueryClient()
  const onConflictRef = useRef(onConflict)
  const onAppliedRef = useRef(onApplied)
  onConflictRef.current = onConflict
  onAppliedRef.current = onApplied
  const [actionError, setActionError] = useState<string | undefined>()
  const [actionNotice, setActionNotice] = useState<string | undefined>()
  const [confirming, setConfirming] = useState(false)
  const pendingRef = useRef<PendingMutation | undefined>(undefined)

  const mutation = useMutation({
    mutationFn: async ({ key, command }: { key: string; command: ManagementCommand }) => api.manage(key, command),
    onSuccess: (result: ManagementResult) => {
      const pending = pendingRef.current
      pendingRef.current = undefined
      setConfirming(false)
      setActionError(undefined)
      setActionNotice(result.replayed ? '命令已按幂等键重放，未重复变更。' : '命令已生效。')
      const kind = result.kind
      const id = kind === 'employee' ? result.employee.id : result.project.id
      invalidateManagementQueries(queryClient, kind, id)
      if (pending && 'id' in pending.command) {
        invalidateManagementQueries(queryClient, kind, pending.command.id)
      }
      onAppliedRef.current(result)
    },
    onError: async (error: unknown) => {
      if (conflictStatus(error)) {
        pendingRef.current = undefined
        setConfirming(false)
        setActionError('版本或状态冲突（409）。列表已刷新，请基于最新版本重新填写原因并再次确认。')
        await onConflictRef.current()
        invalidateManagementQueries(queryClient)
        return
      }
      setActionError('命令失败。若意图未变，可再次确认以复用同一幂等键。')
    },
  })

  function clearPending(): void {
    pendingRef.current = undefined
    setConfirming(false)
  }

  function prepare(command: ManagementCommand, label: string, reason: string): boolean {
    if (mutation.isPending) return false
    const reasonError = validateReason(reason)
    if (reasonError) {
      setActionError(reasonError)
      return false
    }
    const fingerprint = commandFingerprint(command)
    const existing = pendingRef.current
    const key = existing && existing.fingerprint === fingerprint ? existing.key : newKey()
    pendingRef.current = { key, fingerprint, command, label }
    setConfirming(true)
    setActionError(undefined)
    setActionNotice(undefined)
    return true
  }

  function submitConfirmed(): void {
    if (mutation.isPending) return
    const pending = pendingRef.current
    if (!pending) return
    mutation.mutate({ key: pending.key, command: pending.command })
  }

  return {
    mutation,
    actionError,
    actionNotice,
    setActionError,
    setActionNotice,
    confirming,
    setConfirming,
    pendingRef,
    clearPending,
    prepare,
    submitConfirmed,
  }
}
