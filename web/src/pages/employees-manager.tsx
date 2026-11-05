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

import { SAFE_ID, MAX_REASON, MAX_NAME, MAX_ROLE, MAX_LIST_ITEMS, MAX_ITEM_LENGTH, MAX_CONCURRENCY, MAX_TIMEOUT_MS, REFETCH_MS, CONFIGURED_RUNTIME_ID, isSafeId, conflictStatus, commandFingerprint, newKey, cloneEmployee, cloneProject, invalidateManagementQueries, validateReason, parseStringList, isAbsolutePath, configuredEnabledLabel, formatReadableList, emptyEmployeeForm, employeeToForm, emptyProjectForm, projectToForm, RefreshButton, PreviewRows, commandPreviewRows, ConfirmationPreview, HistoryPanel, StaleEditNotice, useManagementMutation } from './management-ui.tsx'
import type { EmployeeMode, ProjectMode, PendingMutation, EmployeeFormState, ProjectFormState } from './management-ui.tsx'

export function EmployeesManager({ api }: { api: ApiClient }) {
  const [mode, setMode] = useState<EmployeeMode>('create')
  const [baseEmployee, setBaseEmployee] = useState<Employee | undefined>()
  const [form, setForm] = useState<EmployeeFormState>(emptyEmployeeForm)
  const [reason, setReason] = useState('')
  const [enableIntent, setEnableIntent] = useState<boolean | undefined>()

  const employeesQuery = useQuery({
    queryKey: ['employees'],
    queryFn: ({ signal }) => api.employees(signal),
    refetchInterval: REFETCH_MS,
  })
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => api.projects(signal),
    refetchInterval: REFETCH_MS,
  })

  const employees = employeesQuery.data ?? []
  const projects = projectsQuery.data ?? []
  const unarchivedProjects = projects.filter(project => !project.archived)
  const bindingOptions = mode === 'edit' ? projects.filter(project => !project.archived || baseEmployee?.projectIds.includes(project.id)) : unarchivedProjects
  const missingBindingIds = mode === 'edit' ? (baseEmployee?.projectIds ?? []).filter(id => !projects.some(project => project.id === id)) : []
  const editingId = mode === 'edit' ? baseEmployee?.id : undefined
  const liveEmployee = editingId ? employees.find(item => item.id === editingId) : undefined
  const remoteStale = !!(
    baseEmployee
    && liveEmployee
    && liveEmployee.version !== baseEmployee.version
  )
  const sensitiveLocked = mode === 'edit' && !!baseEmployee?.enabled

  const historyQuery = useQuery({
    queryKey: ['management-history', 'employee', editingId],
    queryFn: ({ signal }) => api.managementHistory('employee', editingId!, signal),
    enabled: !!editingId,
    refetchInterval: REFETCH_MS,
  })

  const {
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
  } = useManagementMutation(
    api,
    async () => {
      setReason('')
      setEnableIntent(undefined)
      const id = baseEmployee?.id
      const refreshed = await employeesQuery.refetch()
      if (!id) return
      const fresh = refreshed.data?.find(item => item.id === id)
      if (!fresh) {
        setMode('create')
        setBaseEmployee(undefined)
        setForm(emptyEmployeeForm())
        return
      }
      setMode('edit')
      setBaseEmployee(cloneEmployee(fresh))
      setForm(employeeToForm(fresh))
    },
    result => {
      if (result.kind !== 'employee') return
      if (mode === 'edit' && baseEmployee?.id === result.employee.id) {
        setBaseEmployee(cloneEmployee(result.employee))
        setForm(employeeToForm(result.employee))
        setEnableIntent(undefined)
      }
    },
  )

  const busy = mutation.isPending

  function beginCreate(): void {
    if (busy) return
    setMode('create')
    setBaseEmployee(undefined)
    setForm(emptyEmployeeForm())
    setReason('')
    setEnableIntent(undefined)
    clearPending()
    setActionError(undefined)
    setActionNotice(undefined)
  }

  function beginEdit(employee: Employee): void {
    if (busy) return
    setMode('edit')
    setBaseEmployee(cloneEmployee(employee))
    setForm(employeeToForm(employee))
    setReason('')
    setEnableIntent(undefined)
    clearPending()
    setActionError(undefined)
    setActionNotice(undefined)
  }

  function toggleProjectId(projectId: string): void {
    if (busy || sensitiveLocked) return
    setForm(current => {
      const exists = current.projectIds.includes(projectId)
      return {
        ...current,
        projectIds: exists
          ? current.projectIds.filter(id => id !== projectId)
          : [...current.projectIds, projectId],
      }
    })
    setConfirming(false)
    pendingRef.current = undefined
  }

  function buildCreateCommand(): ManagementCommand | string {
    if (!isSafeId(form.id.trim())) return '员工 ID 必须是安全标识符'
    if (!form.name.trim() || form.name.includes('\0') || form.name.length > MAX_NAME) return '名称不能为空且不超过 256 字符'
    if (!form.role.trim() || form.role.includes('\0') || form.role.length > MAX_ROLE) return '岗位不能为空且不超过 256 字符'
    if (form.runtimeId !== CONFIGURED_RUNTIME_ID) return 'Runtime 仅支持已配置的 claude-local'
    const responsibilities = parseStringList(form.responsibilitiesText, { unique: false, safeIds: false, field: '职责' })
    if (typeof responsibilities === 'string') return responsibilities
    const capabilities = parseStringList(form.capabilitiesText, { unique: true, safeIds: false, field: '能力' })
    if (typeof capabilities === 'string') return capabilities
    if (form.projectIds.length > MAX_LIST_ITEMS) return '项目绑定过多'
    for (const projectId of form.projectIds) {
      if (!isSafeId(projectId)) return '项目绑定无效'
      if (!unarchivedProjects.some(project => project.id === projectId)) return '只能绑定未归档项目'
    }
    const maxConcurrency = Number(form.maxConcurrency)
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > MAX_CONCURRENCY) {
      return '最大并发无效'
    }
    const timeoutMs = Number(form.timeoutMs)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
      return '超时无效'
    }
    return {
      kind: 'employee-create',
      reason: reason.trim(),
      input: {
        id: form.id.trim(),
        name: form.name.trim(),
        role: form.role.trim(),
        responsibilities,
        capabilities,
        runtimeId: CONFIGURED_RUNTIME_ID,
        projectIds: [...form.projectIds],
        maxConcurrency,
        timeoutMs,
      },
    }
  }

  function buildUpdateCommand(employee: Employee): ManagementCommand | string {
    if (!form.name.trim() || form.name.includes('\0') || form.name.length > MAX_NAME) return '名称不能为空且不超过 256 字符'
    if (!form.role.trim() || form.role.includes('\0') || form.role.length > MAX_ROLE) return '岗位不能为空且不超过 256 字符'
    const input: Extract<ManagementCommand, { kind: 'employee-update' }>['input'] = {
      expectedVersion: employee.version,
      name: form.name.trim(),
      role: form.role.trim(),
    }
    if (!employee.enabled) {
      if (form.runtimeId !== employee.runtimeId && form.runtimeId !== CONFIGURED_RUNTIME_ID) return 'Runtime 仅支持已配置的 claude-local'
      const responsibilities = parseStringList(form.responsibilitiesText, { unique: false, safeIds: false, field: '职责' })
      if (typeof responsibilities === 'string') return responsibilities
      const capabilities = parseStringList(form.capabilitiesText, { unique: true, safeIds: false, field: '能力' })
      if (typeof capabilities === 'string') return capabilities
      if (form.projectIds.length > MAX_LIST_ITEMS) return '项目绑定过多'
      for (const projectId of form.projectIds) {
        if (!isSafeId(projectId)) return '项目绑定无效'
        if (JSON.stringify(form.projectIds) !== JSON.stringify(employee.projectIds) && !unarchivedProjects.some(project => project.id === projectId)) return '新配置只能绑定未归档项目，请移除失效的绑定'
      }
      const maxConcurrency = Number(form.maxConcurrency)
      if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > MAX_CONCURRENCY) {
        return '最大并发无效'
      }
      const timeoutMs = Number(form.timeoutMs)
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
        return '超时无效'
      }
      if (JSON.stringify(responsibilities) !== JSON.stringify(employee.responsibilities)) input.responsibilities = responsibilities
      if (JSON.stringify(capabilities) !== JSON.stringify(employee.capabilities)) input.capabilities = capabilities
      if (form.runtimeId !== employee.runtimeId) input.runtimeId = form.runtimeId
      if (JSON.stringify(form.projectIds) !== JSON.stringify(employee.projectIds)) input.projectIds = [...form.projectIds]
      if (maxConcurrency !== employee.maxConcurrency) input.maxConcurrency = maxConcurrency
      if (timeoutMs !== employee.timeoutMs) input.timeoutMs = timeoutMs
    }
    return {
      kind: 'employee-update',
      id: employee.id,
      reason: reason.trim(),
      input,
    }
  }

  function onPreviewCreateOrUpdate(event: FormEvent): void {
    event.preventDefault()
    if (busy) return
    setActionNotice(undefined)
    setEnableIntent(undefined)
    if (mode === 'create') {
      const built = buildCreateCommand()
      if (typeof built === 'string') {
        setActionError(built)
        return
      }
      prepare(built, '创建员工（创建后为未启用）', reason)
      return
    }
    if (!baseEmployee) {
      setActionError('请先选择员工')
      return
    }
    const built = buildUpdateCommand(baseEmployee)
    if (typeof built === 'string') {
      setActionError(built)
      return
    }
    prepare(built, '更新员工配置', reason)
  }

  function onPreviewEnable(enabled: boolean): void {
    if (busy || !baseEmployee) return
    setActionNotice(undefined)
    setEnableIntent(enabled)
    const reasonError = validateReason(reason)
    if (reasonError) {
      setActionError(reasonError)
      return
    }
    const command: ManagementCommand = {
      kind: 'employee-enable',
      id: baseEmployee.id,
      reason: reason.trim(),
      input: {
        expectedVersion: baseEmployee.version,
        enabled,
      },
    }
    prepare(command, enabled ? '启用员工（可接单配置）' : '停用员工（仅配置，不停止进行中任务）', reason)
  }

  const refreshing = employeesQuery.isFetching || projectsQuery.isFetching

  return (
    <section className="stack">
      <PageHeader
        title="AI 员工管理"
        description="创建、编辑与启停员工配置。启用表示可接单配置，不代表在线或 Runtime 健康。"
      >
        <RefreshButton
          onClick={() => {
            void employeesQuery.refetch()
            void projectsQuery.refetch()
            if (editingId) void historyQuery.refetch()
          }}
          busy={refreshing && !employeesQuery.isLoading}
        />
        <button type="button" className="button" disabled={busy} onClick={beginCreate}>新建员工</button>
      </PageHeader>

      <div className="panel">
        <h2>员工列表</h2>
        <AsyncState
          loading={employeesQuery.isLoading}
          error={employeesQuery.error}
          empty={!!employeesQuery.data && employeesQuery.data.length === 0}
        >
          {employees.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">名称</th>
                    <th scope="col">岗位</th>
                    <th scope="col">Runtime</th>
                    <th scope="col">启用</th>
                    <th scope="col">版本</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map(employee => (
                    <tr key={employee.id}>
                      <td>{employee.name}</td>
                      <td>{employee.role}</td>
                      <td>{employee.runtimeId}</td>
                      <td>
                        <StatusBadge status={employee.enabled ? 'ENABLED' : 'DISABLED'} />
                        <span className="muted"> {configuredEnabledLabel(employee.enabled)}</span>
                      </td>
                      <td>{employee.version}</td>
                      <td>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={busy}
                          aria-label={`编辑员工 ${employee.name}`}
                          onClick={() => beginEdit(employee)}
                        >
                          编辑
                        </button>
                        <div><a href={`#/tasks?employeeId=${encodeURIComponent(employee.id)}`}>按员工筛选任务</a></div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncState>
      </div>

      <div className="panel" aria-label={mode === 'create' ? '创建员工' : '编辑员工'}>
        <h2>{mode === 'create' ? '创建员工' : `编辑员工 ${baseEmployee?.name ?? ''}`}</h2>
        {mode === 'create' && (
          <p className="muted">创建后的员工始终为未启用；需要单独确认启用意图后才会变为可接单配置。</p>
        )}
        {sensitiveLocked && (
          <p role="status" className="muted">
            员工已启用：敏感字段（Runtime、项目、能力、职责、并发、超时）已锁定。请先停用后再修改这些配置；名称与岗位仍可更新。
          </p>
        )}
        {remoteStale && baseEmployee && liveEmployee && (
          <StaleEditNotice
            baseVersion={baseEmployee.version}
            liveVersion={liveEmployee.version}
            busy={busy}
            onReload={() => beginEdit(liveEmployee)}
          />
        )}
        <form className="form-grid" onSubmit={onPreviewCreateOrUpdate} noValidate>
          <label className="field">
            <span>员工 ID</span>
            <input
              aria-label="员工 ID"
              value={form.id}
              disabled={busy || mode === 'edit'}
              onChange={event => {
                if (busy || mode === 'edit') return
                setForm(current => ({ ...current, id: event.target.value }))
                setConfirming(false)
                pendingRef.current = undefined
              }}
              required
            />
          </label>
          <label className="field">
            <span>名称</span>
            <input
              aria-label="员工名称"
              value={form.name}
              maxLength={MAX_NAME}
              disabled={busy}
              onChange={event => {
                if (busy) return
                setForm(current => ({ ...current, name: event.target.value }))
                setConfirming(false)
                pendingRef.current = undefined
              }}
              required
            />
          </label>
          <label className="field">
            <span>岗位</span>
            <input
              aria-label="员工岗位"
              value={form.role}
              maxLength={MAX_ROLE}
              disabled={busy}
              onChange={event => {
                if (busy) return
                setForm(current => ({ ...current, role: event.target.value }))
                setConfirming(false)
                pendingRef.current = undefined
              }}
              required
            />
          </label>
          <label className="field">
            <span>Runtime</span>
            <select
              aria-label="Runtime"
              value={form.runtimeId}
              disabled={busy || sensitiveLocked}
              onChange={event => {
                if (busy || sensitiveLocked) return
                setForm(current => ({ ...current, runtimeId: event.target.value }))
                setConfirming(false)
                pendingRef.current = undefined
              }}
            >
              <option value={CONFIGURED_RUNTIME_ID}>claude-local（已配置，非在线状态）</option>
            </select>
          </label>
          <label className="field full-width">
            <span>职责（每行一项）</span>
            <textarea
              aria-label="职责"
              value={form.responsibilitiesText}
              disabled={busy || sensitiveLocked}
              onChange={event => {
                if (busy || sensitiveLocked) return
                setForm(current => ({ ...current, responsibilitiesText: event.target.value }))
                setConfirming(false)
                pendingRef.current = undefined
              }}
            />
          </label>
          <label className="field full-width">
            <span>能力（每行一项）</span>
            <textarea
              aria-label="能力"
              value={form.capabilitiesText}
              disabled={busy || sensitiveLocked}
              onChange={event => {
                if (busy || sensitiveLocked) return
                setForm(current => ({ ...current, capabilitiesText: event.target.value }))
                setConfirming(false)
                pendingRef.current = undefined
              }}
            />
          </label>
          <fieldset className="full-width" disabled={busy || sensitiveLocked}>
            <legend>绑定项目</legend>
            <div className="stack" role="group" aria-label="绑定项目">
              {bindingOptions.length === 0 && missingBindingIds.length === 0 ? (
                <p className="muted">暂无未归档项目可选。</p>
              ) : (
                bindingOptions.map(project => (
                  <label key={project.id}>
                    <input
                      type="checkbox"
                      checked={form.projectIds.includes(project.id)}
                      disabled={busy || sensitiveLocked}
                      onChange={() => toggleProjectId(project.id)}
                      aria-label={`绑定项目 ${project.name}`}
                    />
                    {' '}{project.name} ({project.id}){project.archived ? ' · 已归档' : ''}
                  </label>
                ))
              )}
              {missingBindingIds.map(id => <label key={id}><input type="checkbox" aria-label={`移除失效项目 ${id}`} checked={form.projectIds.includes(id)} disabled={busy || sensitiveLocked} onChange={() => toggleProjectId(id)}/> {id} · 配置不可用</label>)}
            </div>
          </fieldset>
          <label className="field">
            <span>最大并发</span>
            <input
              aria-label="最大并发"
              type="number"
              min={1}
              max={MAX_CONCURRENCY}
              step={1}
              value={form.maxConcurrency}
              disabled={busy || sensitiveLocked}
              onChange={event => {
                if (busy || sensitiveLocked) return
                setForm(current => ({ ...current, maxConcurrency: event.target.value }))
                setConfirming(false)
                pendingRef.current = undefined
              }}
              required
            />
          </label>
          <label className="field">
            <span>超时（毫秒）</span>
            <input
              aria-label="超时毫秒"
              type="number"
              min={1}
              max={MAX_TIMEOUT_MS}
              step={1}
              value={form.timeoutMs}
              disabled={busy || sensitiveLocked}
              onChange={event => {
                if (busy || sensitiveLocked) return
                setForm(current => ({ ...current, timeoutMs: event.target.value }))
                setConfirming(false)
                pendingRef.current = undefined
              }}
              required
            />
          </label>
          <label className="field full-width">
            <span>原因</span>
            <textarea
              aria-label="操作原因"
              value={reason}
              maxLength={MAX_REASON}
              disabled={busy}
              onChange={event => {
                if (busy) return
                setReason(event.target.value)
                setConfirming(false)
                pendingRef.current = undefined
              }}
              required
            />
          </label>
          <div className="page-actions full-width">
            <button type="submit" className="button" disabled={busy || (mode === 'edit' && !baseEmployee)}>
              {mode === 'create' ? '预览创建' : '预览更新'}
            </button>
            {mode === 'edit' && baseEmployee && !baseEmployee.enabled && (
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() => onPreviewEnable(true)}
              >
                预览启用
              </button>
            )}
            {mode === 'edit' && baseEmployee?.enabled && (
              <button
                type="button"
                className="button danger"
                disabled={busy}
                onClick={() => onPreviewEnable(false)}
              >
                预览停用
              </button>
            )}
          </div>
        </form>
        {enableIntent === true && (
          <p className="muted" role="status">启用仅切换可接单配置，不启动进程，也不表示 Runtime 在线。</p>
        )}
        {enableIntent === false && (
          <p className="muted" role="status">停用不会停止进行中的任务或进程；仅阻止新的接单配置。</p>
        )}
        {confirming && pendingRef.current && (
          <ConfirmationPreview
            pending={pendingRef.current}
            busy={busy}
            onSubmit={submitConfirmed}
            onCancel={() => {
              if (busy) return
              clearPending()
              setEnableIntent(undefined)
            }}
          />
        )}
        {actionError && <p role="alert" className="error-state">{actionError}</p>}
        {actionNotice && <p role="status" className="muted">{actionNotice}</p>}
      </div>

      {editingId && (
        <HistoryPanel
          title="员工变更历史"
          loading={historyQuery.isLoading}
          error={historyQuery.error}
          items={historyQuery.data?.items}
        />
      )}
    </section>
  )
}
