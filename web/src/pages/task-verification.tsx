import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AsyncState, StatusBadge, formatTime } from '../shared.tsx'
import {
  applicationLabel,
  isActiveVerificationStatus,
  isTerminalApplication,
  type CreateVerificationBody,
  type VerificationApi,
  type VerificationJobView,
  type VerificationPlanMeta,
} from '../verification-api.ts'

const MAX_REASON = 4096
const LIST_LIMIT = 20
const ACTIVE_POLL_MS = 1_000
const IDLE_POLL_MS = 5_000

/** Compact ticket binding — no core imports; parent supplies live ticket snapshot. */
export interface VerificationTicketBinding {
  id: string
  lifecycle?: {
    status: string
    version: number
    result?: {
      executionId: string
      artifactRevision: string
      verification?: string
    }
  }
}

interface TaskVerificationProps {
  api: VerificationApi
  ticket: VerificationTicketBinding
}

interface CreateBinding {
  expectedVersion: number
  executionId: string
  artifactRevision: string
  planId: string
  planRevision: string
  reason: string
}

interface PendingCreate {
  key: string
  fingerprint: string
  binding: CreateBinding
}

interface PendingCancel {
  key: string
  fingerprint: string
  verificationId: string
  expectedVersion: number
  reason: string
}

function newKey(): string {
  return crypto.randomUUID()
}

function conflictStatus(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const record = error as { status?: unknown; code?: unknown }
  if (record.status === 409) return true
  return record.code === 'VERSION_CONFLICT' || record.code === 'STATE_CONFLICT' || record.code === 'IDEMPOTENCY_CONFLICT'
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error && typeof (error as { message: unknown }).message === 'string') {
    const message = (error as { message: string }).message.trim()
    if (message) return message
  }
  return fallback
}

function validateReason(reason: string): string | undefined {
  if (!reason.trim() || reason.includes('\0') || reason.length > MAX_REASON) {
    return '请填写有效原因（非空，最长 4096 字符）。'
  }
  return undefined
}

const PLAN_OPTION_SEP = '::'

function planOptionValue(plan: Pick<VerificationPlanMeta, 'id' | 'revision'>): string {
  return `${plan.id}${PLAN_OPTION_SEP}${plan.revision}`
}

function parsePlanOption(value: string): { planId: string; planRevision: string } | undefined {
  const split = value.indexOf(PLAN_OPTION_SEP)
  if (split <= 0 || split === value.length - PLAN_OPTION_SEP.length) return undefined
  return { planId: value.slice(0, split), planRevision: value.slice(split + PLAN_OPTION_SEP.length) }
}

function createFingerprint(binding: CreateBinding): string {
  return JSON.stringify(binding)
}

function cancelFingerprint(pending: Omit<PendingCancel, 'key' | 'fingerprint'>): string {
  return JSON.stringify(pending)
}

function artifactDisplayId(executionId: string): string {
  return `artifact-${executionId}`
}

function invalidateVerificationQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  ticketId: string,
  verificationId?: string,
): void {
  void queryClient.invalidateQueries({ queryKey: ['verification-plans'] })
  void queryClient.invalidateQueries({ queryKey: ['task-verifications', ticketId] })
  if (verificationId) {
    void queryClient.invalidateQueries({ queryKey: ['verification', verificationId] })
  }
}

function invalidateTicketReviewQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  ticketId: string,
): void {
  void queryClient.invalidateQueries({ queryKey: ['task', ticketId] })
  void queryClient.invalidateQueries({ queryKey: ['tasks'] })
  void queryClient.invalidateQueries({ queryKey: ['overview'] })
}

function terminalApplicationFingerprint(items: readonly VerificationJobView[]): string {
  return items
    .filter(isTerminalApplication)
    .map(job => `${job.request.verificationId}:${job.application}:${job.version}`)
    .sort()
    .join('|')
}

export function TaskVerification({ api, ticket }: TaskVerificationProps) {
  const queryClient = useQueryClient()
  const ticketId = ticket.id
  const lifecycle = ticket.lifecycle
  const result = lifecycle?.result
  const status = lifecycle?.status
  const liveVersion = lifecycle?.version

  const reviewReady = status === 'REVIEW' && !!result && typeof liveVersion === 'number'
  const staleTask = !reviewReady

  const [planValue, setPlanValue] = useState('')
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [previewBinding, setPreviewBinding] = useState<CreateBinding | undefined>()
  const [actionError, setActionError] = useState<string | undefined>()
  const [actionNotice, setActionNotice] = useState<string | undefined>()
  const [cancelTarget, setCancelTarget] = useState<VerificationJobView | undefined>()
  const [cancelReason, setCancelReason] = useState('')
  const [cancelConfirming, setCancelConfirming] = useState(false)
  const [cancelPreview, setCancelPreview] = useState<PendingCancel | undefined>()
  const [nextCursor, setNextCursor] = useState<number | undefined>(undefined)
  const [olderItems, setOlderItems] = useState<VerificationJobView[]>([])

  const pendingCreateRef = useRef<PendingCreate | undefined>(undefined)
  const pendingCancelRef = useRef<PendingCancel | undefined>(undefined)
  /** Frozen create binding survives parent ticket polling until conflict/clear. */
  const frozenCreateRef = useRef<CreateBinding | undefined>(undefined)
  /** Prior terminal-application observation; only invalidate review queries on change. */
  const seenTerminalAppsRef = useRef<string>('')

  const plansQuery = useQuery({
    queryKey: ['verification-plans'],
    queryFn: ({ signal }) => api.plans(signal),
    refetchInterval: IDLE_POLL_MS,
  })

  const listQuery = useQuery({
    queryKey: ['task-verifications', ticketId],
    queryFn: ({ signal }) => api.list(ticketId, { limit: LIST_LIMIT }, signal),
    refetchInterval: (query) => {
      const items = query.state.data?.items ?? []
      return items.some(job => isActiveVerificationStatus(job.status)) ? ACTIVE_POLL_MS : IDLE_POLL_MS
    },
  })

  const pageItems = useMemo(() => {
    const newest = listQuery.data?.items ?? []
    if (olderItems.length === 0) return newest
    const seen = new Set(newest.map(job => job.request.verificationId))
    return [...newest, ...olderItems.filter(job => !seen.has(job.request.verificationId))]
  }, [listQuery.data?.items, olderItems])

  const hasActive = pageItems.some(job => isActiveVerificationStatus(job.status))
  const plans = plansQuery.data?.items ?? []
  const selectedPlan = useMemo(() => {
    const parsed = parsePlanOption(planValue)
    if (!parsed) return undefined
    return plans.find(plan => plan.id === parsed.planId && plan.revision === parsed.planRevision)
  }, [planValue, plans])

  useEffect(() => {
    setOlderItems([])
    setNextCursor(undefined)
    seenTerminalAppsRef.current = ''
  }, [ticketId])

  useEffect(() => {
    if (olderItems.length === 0) {
      setNextCursor(listQuery.data?.nextCursor)
    }
  }, [listQuery.data?.nextCursor, olderItems.length])

  useEffect(() => {
    const fingerprint = terminalApplicationFingerprint(pageItems)
    if (fingerprint === seenTerminalAppsRef.current) return
    const previous = seenTerminalAppsRef.current
    seenTerminalAppsRef.current = fingerprint
    // Invalidate when observation gains a new applied/superseded application (not on identical re-poll).
    if (fingerprint && fingerprint !== previous) {
      invalidateTicketReviewQueries(queryClient, ticketId)
    }
  }, [pageItems, queryClient, ticketId])

  const createMutation = useMutation({
    mutationFn: async ({ key, binding }: { key: string; binding: CreateBinding }) => {
      const body: CreateVerificationBody = {
        expectedVersion: binding.expectedVersion,
        executionId: binding.executionId,
        artifactRevision: binding.artifactRevision,
        planId: binding.planId,
        planRevision: binding.planRevision,
        reason: binding.reason,
      }
      return api.create(ticketId, key, body)
    },
    onSuccess: (commandResult) => {
      pendingCreateRef.current = undefined
      frozenCreateRef.current = undefined
      setConfirming(false)
      setPreviewBinding(undefined)
      setReason('')
      setActionError(undefined)
      setActionNotice(
        commandResult.replayed
          ? '已恢复原验证请求，可在下方查看进度。'
          : '验证作业已入队，可在下方查看进度。',
      )
      invalidateVerificationQueries(queryClient, ticketId, commandResult.verificationId)
    },
    onError: async (error: unknown) => {
      if (conflictStatus(error)) {
        // Clear confirm UI so user must re-preview; frozen key/binding drop for a new key on reconfirm.
        pendingCreateRef.current = undefined
        frozenCreateRef.current = undefined
        setConfirming(false)
        setPreviewBinding(undefined)
        setActionError('版本或状态冲突（409）。已要求重新确认；请基于最新任务绑定再次预览。')
        invalidateVerificationQueries(queryClient, ticketId)
        invalidateTicketReviewQueries(queryClient, ticketId)
        return
      }
      // Network / non-conflict: keep frozen binding + idempotency key for retry.
      setActionError('入队失败。若意图未变，可再次确认以复用同一幂等键。')
    },
  })

  const cancelMutation = useMutation({
    mutationFn: async ({ key, verificationId, expectedVersion, reason: cancelBodyReason }: PendingCancel) => {
      return api.cancel(verificationId, key, { expectedVersion, reason: cancelBodyReason })
    },
    onSuccess: (commandResult) => {
      pendingCancelRef.current = undefined
      setCancelConfirming(false)
      setCancelPreview(undefined)
      setCancelTarget(undefined)
      setCancelReason('')
      setActionError(undefined)
      setActionNotice(
        commandResult.replayed
          ? '取消请求已按幂等键重放。取消意图已记录，不代表作业已停止。'
          : '已请求取消，正在等待检查进程确认停止。',
      )
      invalidateVerificationQueries(queryClient, ticketId, commandResult.verificationId)
    },
    onError: async (error: unknown) => {
      if (conflictStatus(error)) {
        pendingCancelRef.current = undefined
        setCancelConfirming(false)
        setCancelPreview(undefined)
        setActionError('取消冲突（409）。请刷新作业后基于最新版本重新填写原因并确认。')
        invalidateVerificationQueries(queryClient, ticketId, cancelTarget?.request.verificationId)
        return
      }
      // Network / non-conflict: keep pending cancel key for retry with same intent.
      setActionError(
        errorMessage(error, '取消请求失败。若意图未变，可再次确认以复用同一幂等键。'),
      )
    },
  })

  const busy = createMutation.isPending || cancelMutation.isPending
  const formDisabled = staleTask || busy || plans.length === 0

  function clearCreatePending(): void {
    pendingCreateRef.current = undefined
    frozenCreateRef.current = undefined
    setConfirming(false)
    setPreviewBinding(undefined)
  }

  function onPreviewCreate(event: FormEvent): void {
    event.preventDefault()
    if (formDisabled || !reviewReady || !result || liveVersion === undefined) return
    setActionNotice(undefined)
    const reasonError = validateReason(reason)
    if (reasonError) {
      setActionError(reasonError)
      return
    }
    if (!selectedPlan) {
      setActionError('请选择已注册的可信验证计划。')
      return
    }

    const base = frozenCreateRef.current ?? {
      expectedVersion: liveVersion,
      executionId: result.executionId,
      artifactRevision: result.artifactRevision,
      planId: selectedPlan.id,
      planRevision: selectedPlan.revision,
      reason: reason.trim(),
    }

    // Freeze ticket binding at first preview so parent polling cannot rewrite it.
    const frozen: CreateBinding = {
      expectedVersion: base.expectedVersion,
      executionId: base.executionId,
      artifactRevision: base.artifactRevision,
      planId: selectedPlan.id,
      planRevision: selectedPlan.revision,
      reason: reason.trim(),
    }
    frozenCreateRef.current = frozen
    const fingerprint = createFingerprint(frozen)
    const existing = pendingCreateRef.current
    const key = existing && existing.fingerprint === fingerprint ? existing.key : newKey()
    pendingCreateRef.current = { key, fingerprint, binding: frozen }
    setPreviewBinding(frozen)
    setConfirming(true)
    setActionError(undefined)
  }

  function submitCreate(): void {
    if (busy) return
    const pending = pendingCreateRef.current
    if (!pending) return
    createMutation.mutate({ key: pending.key, binding: pending.binding })
  }

  function beginCancel(job: VerificationJobView): void {
    if (busy) return
    if (!isActiveVerificationStatus(job.status)) return
    pendingCancelRef.current = undefined
    setCancelPreview(undefined)
    setCancelTarget(job)
    setCancelReason('')
    setCancelConfirming(false)
    setActionError(undefined)
    setActionNotice(undefined)
  }

  function onPreviewCancel(event: FormEvent): void {
    event.preventDefault()
    if (busy || !cancelTarget) return
    const reasonError = validateReason(cancelReason)
    if (reasonError) {
      setActionError(reasonError)
      return
    }
    const draft = {
      verificationId: cancelTarget.request.verificationId,
      expectedVersion: cancelTarget.version,
      reason: cancelReason.trim(),
    }
    const fingerprint = cancelFingerprint(draft)
    const existing = pendingCancelRef.current
    const key = existing && existing.fingerprint === fingerprint ? existing.key : newKey()
    const pending = { ...draft, key, fingerprint }
    pendingCancelRef.current = pending
    setCancelPreview(pending)
    setCancelConfirming(true)
    setActionError(undefined)
  }

  function submitCancel(): void {
    if (busy) return
    const pending = pendingCancelRef.current
    if (!pending) return
    cancelMutation.mutate(pending)
  }

  async function loadOlder(): Promise<void> {
    if (nextCursor === undefined || busy) return
    try {
      const page = await api.list(ticketId, { limit: LIST_LIMIT, beforeRowid: nextCursor })
      setOlderItems(current => {
        const seen = new Set(current.map(job => job.request.verificationId))
        const merged = [...current]
        for (const job of page.items) {
          if (!seen.has(job.request.verificationId)) {
            seen.add(job.request.verificationId)
            merged.push(job)
          }
        }
        return merged
      })
      setNextCursor(page.nextCursor)
      setActionError(undefined)
    } catch (error) {
      setActionError(errorMessage(error, '无法加载更早的验证历史。'))
    }
  }

  return (
    <section className="panel stack" aria-label="异步验证">
      <h2>异步验证</h2>
      <p className="muted">
        选择可信计划检查当前交付产物。检查通过后，继续完成最终人工审核。
      </p>

      {staleTask && (
        <p role="status" className="muted">
          当前任务不在 REVIEW 或缺执行证据，验证入队已禁用。请等待任务进入 REVIEW 且绑定当前执行/产物后再试。
        </p>
      )}

      <AsyncState loading={plansQuery.isLoading} error={plansQuery.error}>
        {plans.length === 0 ? (
          <p role="status" className="empty-state">
            尚未注册可信验证计划。请在本机通过显式 CLI/配置注册验证计划后再刷新；Web 不能提交任意命令。
          </p>
        ) : (
          <form className="form-grid verification-form" onSubmit={onPreviewCreate} aria-label="验证入队表单">
            <label className="field">
              <span>可信验证计划</span>
              <select
                aria-label="可信验证计划"
                value={planValue}
                disabled={formDisabled}
                onChange={event => {
                  if (busy) return
                  setPlanValue(event.target.value)
                  clearCreatePending()
                  setActionError(undefined)
                }}
              >
                <option value="">请选择计划</option>
                {plans.map(plan => (
                  <option key={planOptionValue(plan)} value={planOptionValue(plan)}>
                    {plan.id} @ {plan.revision}（{plan.checks.length} 项检查）
                  </option>
                ))}
              </select>
            </label>

            {reviewReady && result && liveVersion !== undefined && (
              <p className="muted">
                将绑定任务版本 {previewBinding?.expectedVersion ?? liveVersion}
                {' '}· 执行 {previewBinding?.executionId ?? result.executionId}
                {' '}· 产物 {artifactDisplayId(previewBinding?.executionId ?? result.executionId)}
                {' '}· 修订 {(previewBinding?.artifactRevision ?? result.artifactRevision).slice(0, 12)}…
              </p>
            )}

            <label className="field">
              <span>原因</span>
              <textarea
                aria-label="验证原因"
                value={reason}
                maxLength={MAX_REASON}
                disabled={formDisabled}
                onChange={event => {
                  if (busy) return
                  setReason(event.target.value)
                  if (confirming) {
                    // Keep frozen ticket binding; reason change requires a fresh preview.
                    setConfirming(false)
                    setPreviewBinding(undefined)
                    pendingCreateRef.current = undefined
                  }
                }}
              />
            </label>

            {!confirming ? (
              <button type="submit" className="button" disabled={formDisabled}>
                预览确认
              </button>
            ) : previewBinding && (
              <div className="stack" role="region" aria-label="验证入队确认预览">
                <p>请确认本次检查的计划与交付产物：</p>
                <ul>
                  <li>任务：{ticketId}</li>
                  <li>生命周期版本：{previewBinding.expectedVersion}</li>
                  <li>执行：{previewBinding.executionId}</li>
                  <li>产物：{artifactDisplayId(previewBinding.executionId)}</li>
                  <li>产物修订：{previewBinding.artifactRevision}</li>
                  <li>计划：{previewBinding.planId} @ {previewBinding.planRevision}</li>
                  <li>原因：{previewBinding.reason}</li>
                </ul>
                {liveVersion !== undefined && liveVersion !== previewBinding.expectedVersion && (
                  <p role="status" className="muted">
                    任务版本已变为 {liveVersion}；本次确认的是版本 {previewBinding.expectedVersion}。请重新确认最新产物。
                  </p>
                )}
                <div className="page-actions">
                  <button type="button" className="button" disabled={busy} onClick={submitCreate}>
                    {busy && createMutation.isPending ? '提交中…' : '确认入队'}
                  </button>
                  <button
                    type="button"
                    className="button secondary"
                    disabled={busy}
                    onClick={() => {
                      if (busy) return
                      clearCreatePending()
                    }}
                  >
                    返回修改
                  </button>
                </div>
              </div>
            )}
          </form>
        )}
      </AsyncState>

      {actionError && <p role="alert" className="error-state">{actionError}</p>}
      {actionNotice && <p role="status" className="muted">{actionNotice}</p>}

      <section className="stack" aria-label="验证作业历史">
        <h3>作业历史 {hasActive ? '· 活跃作业每秒刷新' : ''}</h3>
        <AsyncState
          loading={listQuery.isLoading}
          error={listQuery.error}
          empty={!listQuery.isLoading && !listQuery.error && pageItems.length === 0}
        >
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">作业</th>
                  <th scope="col">状态</th>
                  <th scope="col">结果</th>
                  <th scope="col">应用</th>
                  <th scope="col">更新</th>
                  <th scope="col">操作</th>
                </tr>
              </thead>
              <tbody>
                {pageItems.map(job => {
                  const applied = applicationLabel(job)
                  return (
                    <tr key={job.request.verificationId}>
                      <td>
                        <div>{job.request.verificationId}</div>
                        <div className="muted">
                          {job.request.plan.id}@{job.request.plan.revision}
                          {' '}· v{job.request.expectedTaskVersion}
                        </div>
                        {job.cancelRequested && (
                          <div role="status" className="muted">
                            已记录取消意图（{job.cancelRequested.reason}），不等于已停止。
                          </div>
                        )}
                      </td>
                      <td><StatusBadge status={job.status} /></td>
                      <td>{job.outcome ?? '—'}</td>
                      <td>
                        {applied === 'applied' && '已应用'}
                        {applied === 'superseded' && '已过时'}
                        {applied === 'unknown' && '未知/待定'}
                      </td>
                      <td>{formatTime(job.updatedAt)}</td>
                      <td>
                        {isActiveVerificationStatus(job.status) && (
                          <button
                            type="button"
                            className="button danger"
                            disabled={busy}
                            onClick={() => beginCancel(job)}
                          >
                            请求取消
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          {nextCursor !== undefined && (
            <button type="button" className="button secondary" disabled={busy} onClick={() => void loadOlder()}>
              加载更早记录
            </button>
          )}
        </AsyncState>
      </section>

      {cancelTarget && (
        <form className="form-grid verification-form" onSubmit={onPreviewCancel} aria-label="取消验证表单">
          <h3>取消验证 {cancelTarget.request.verificationId}</h3>
          <p className="muted">提交后仅持久化取消意图，不代表作业已停止。</p>
          <p className="muted">期望作业版本：{cancelTarget.version}</p>
          <label className="field">
            <span>取消原因</span>
            <textarea
              aria-label="取消原因"
              value={cancelReason}
              maxLength={MAX_REASON}
              disabled={busy}
              onChange={event => {
                if (busy) return
                setCancelReason(event.target.value)
                setCancelConfirming(false)
                setCancelPreview(undefined)
                pendingCancelRef.current = undefined
              }}
            />
          </label>
          {!cancelConfirming ? (
            <div className="page-actions">
              <button type="submit" className="button danger" disabled={busy}>预览取消确认</button>
              <button
                type="button"
                className="button secondary"
                disabled={busy}
                onClick={() => {
                  if (busy) return
                  setCancelTarget(undefined)
                  setCancelConfirming(false)
                  setCancelPreview(undefined)
                  pendingCancelRef.current = undefined
                }}
              >
                关闭
              </button>
            </div>
          ) : cancelPreview && (
            <div className="stack" role="region" aria-label="取消验证确认预览">
              <p>请确认取消意图：</p>
              <ul>
                <li>作业：{cancelPreview.verificationId}</li>
                <li>期望版本：{cancelPreview.expectedVersion}</li>
                <li>原因：{cancelPreview.reason}</li>
              </ul>
              <div className="page-actions">
                <button type="button" className="button danger" disabled={busy} onClick={submitCancel}>
                  {busy && cancelMutation.isPending ? '提交中…' : '确认取消意图'}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={busy}
                  onClick={() => {
                    if (busy) return
                    setCancelConfirming(false)
                    setCancelPreview(undefined)
                    pendingCancelRef.current = undefined
                  }}
                >
                  返回修改
                </button>
              </div>
            </div>
          )}
        </form>
      )}
    </section>
  )
}
