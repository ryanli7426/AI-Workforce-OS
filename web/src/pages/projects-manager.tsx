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

export function ProjectsManager({ api }: { api: ApiClient }) {
  const [mode, setMode] = useState<ProjectMode>('create')
  const [baseProject, setBaseProject] = useState<Project | undefined>()
  const [form, setForm] = useState<ProjectFormState>(emptyProjectForm)
  const [reason, setReason] = useState('')
  const [archiveIntent, setArchiveIntent] = useState(false)

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => api.projects(signal),
    refetchInterval: REFETCH_MS,
  })

  const projects = projectsQuery.data ?? []
  const editingId = mode === 'edit' ? baseProject?.id : undefined
  const liveProject = editingId ? projects.find(item => item.id === editingId) : undefined
  const remoteStale = !!(
    baseProject
    && liveProject
    && liveProject.version !== baseProject.version
  )

  const historyQuery = useQuery({
    queryKey: ['management-history', 'project', editingId],
    queryFn: ({ signal }) => api.managementHistory('project', editingId!, signal),
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
      setArchiveIntent(false)
      const id = baseProject?.id
      const refreshed = await projectsQuery.refetch()
      if (!id) return
      const fresh = refreshed.data?.find(item => item.id === id)
      if (!fresh) {
        setMode('create')
        setBaseProject(undefined)
        setForm(emptyProjectForm())
        return
      }
      setMode('edit')
      setBaseProject(cloneProject(fresh))
      setForm(projectToForm(fresh))
    },
    result => {
      if (result.kind !== 'project') return
      if (mode === 'edit' && baseProject?.id === result.project.id) {
        setBaseProject(cloneProject(result.project))
        setForm(projectToForm(result.project))
        setArchiveIntent(false)
      }
    },
  )

  const busy = mutation.isPending

  function beginCreate(): void {
    if (busy) return
    setMode('create')
    setBaseProject(undefined)
    setForm(emptyProjectForm())
    setReason('')
    setArchiveIntent(false)
    clearPending()
    setActionError(undefined)
    setActionNotice(undefined)
  }

  function beginEdit(project: Project): void {
    if (busy) return
    setMode('edit')
    setBaseProject(cloneProject(project))
    setForm(projectToForm(project))
    setReason('')
    setArchiveIntent(false)
    clearPending()
    setActionError(undefined)
    setActionNotice(undefined)
  }

  function buildCreateCommand(): ManagementCommand | string {
    if (!isSafeId(form.id.trim())) return '项目 ID 必须是安全标识符'
    if (!form.name.trim() || form.name.includes('\0') || form.name.length > MAX_NAME) return '名称不能为空且不超过 256 字符'
    if (!isSafeId(form.ownerId.trim())) return '业务负责人 ID 必须是安全标识符'
    if (!isAbsolutePath(form.repositoryPath.trim())) return '仓库路径必须是绝对路径'
    if (!isAbsolutePath(form.worktreeRoot.trim())) return '工作树根目录必须是绝对路径'
    const allowedTaskTypes = parseStringList(form.allowedTaskTypesText, { unique: true, safeIds: false, field: '允许任务类型' })
    if (typeof allowedTaskTypes === 'string') return allowedTaskTypes
    if (allowedTaskTypes.length === 0) return '请至少填写一种允许的任务类型'
    return {
      kind: 'project-create',
      reason: reason.trim(),
      input: {
        id: form.id.trim(),
        name: form.name.trim(),
        ownerId: form.ownerId.trim(),
        repositoryPath: form.repositoryPath.trim(),
        worktreeRoot: form.worktreeRoot.trim(),
        allowedTaskTypes,
      },
    }
  }

  function buildUpdateCommand(project: Project): ManagementCommand | string {
    if (!form.name.trim() || form.name.includes('\0') || form.name.length > MAX_NAME) return '名称不能为空且不超过 256 字符'
    if (!isSafeId(form.ownerId.trim())) return '业务负责人 ID 必须是安全标识符'
    const allowedTaskTypes = parseStringList(form.allowedTaskTypesText, { unique: true, safeIds: false, field: '允许任务类型' })
    if (typeof allowedTaskTypes === 'string') return allowedTaskTypes
    if (allowedTaskTypes.length === 0) return '请至少填写一种允许的任务类型'
    return {
      kind: 'project-update',
      id: project.id,
      reason: reason.trim(),
      input: {
        expectedVersion: project.version,
        name: form.name.trim(),
        ownerId: form.ownerId.trim(),
        allowedTaskTypes,
      },
    }
  }

  function onPreviewCreateOrUpdate(event: FormEvent): void {
    event.preventDefault()
    if (busy) return
    setActionNotice(undefined)
    setArchiveIntent(false)
    if (mode === 'create') {
      const built = buildCreateCommand()
      if (typeof built === 'string') {
        setActionError(built)
        return
      }
      prepare(built, '创建项目', reason)
      return
    }
    if (!baseProject) {
      setActionError('请先选择项目')
      return
    }
    if (baseProject.archived) {
      setActionError('已归档项目不可再更新配置。')
      return
    }
    const built = buildUpdateCommand(baseProject)
    if (typeof built === 'string') {
      setActionError(built)
      return
    }
    prepare(built, '更新项目配置', reason)
  }

  function onPreviewArchive(): void {
    if (busy || !baseProject || baseProject.archived) return
    setActionNotice(undefined)
    setArchiveIntent(true)
    const reasonError = validateReason(reason)
    if (reasonError) {
      setActionError(reasonError)
      return
    }
    const command: ManagementCommand = {
      kind: 'project-archive',
      id: baseProject.id,
      reason: reason.trim(),
      input: { expectedVersion: baseProject.version },
    }
    prepare(command, '归档项目（阻止未来接入，不影响运行中任务）', reason)
  }

  return (
    <section className="stack">
      <PageHeader
        title="项目管理"
        description="创建与维护项目配置。路径在创建后不可变；归档阻止未来接入，不停止运行中任务。"
      >
        <RefreshButton
          onClick={() => {
            void projectsQuery.refetch()
            if (editingId) void historyQuery.refetch()
          }}
          busy={projectsQuery.isFetching && !projectsQuery.isLoading}
        />
        <button type="button" className="button" disabled={busy} onClick={beginCreate}>新建项目</button>
      </PageHeader>

      <div className="panel">
        <h2>项目列表</h2>
        <AsyncState
          loading={projectsQuery.isLoading}
          error={projectsQuery.error}
          empty={!!projectsQuery.data && projectsQuery.data.length === 0}
        >
          {projects.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">名称</th>
                    <th scope="col">负责人</th>
                    <th scope="col">仓库路径</th>
                    <th scope="col">归档</th>
                    <th scope="col">版本</th>
                    <th scope="col">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map(project => (
                    <tr key={project.id}>
                      <td>{project.name}</td>
                      <td>{project.ownerId}</td>
                      <td>{project.repositoryPath}</td>
                      <td>
                        <StatusBadge status={project.archived ? 'ARCHIVED' : 'ACTIVE'} />
                        <span className="muted"> {project.archived ? '已归档' : '未归档'}</span>
                      </td>
                      <td>{project.version}</td>
                      <td>
                        <button
                          type="button"
                          className="button secondary"
                          disabled={busy}
                          aria-label={`编辑项目 ${project.name}`}
                          onClick={() => beginEdit(project)}
                        >
                          编辑
                        </button>
                        <div><a href={`#/tasks?projectId=${encodeURIComponent(project.id)}`}>按项目筛选任务</a></div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncState>
      </div>

      <div className="panel" aria-label={mode === 'create' ? '创建项目' : '编辑项目'}>
        <h2>{mode === 'create' ? '创建项目' : `编辑项目 ${baseProject?.name ?? ''}`}</h2>
        {mode === 'edit' && (
          <p className="muted">仓库路径与工作树根目录创建后不可修改。</p>
        )}
        {remoteStale && baseProject && liveProject && (
          <StaleEditNotice
            baseVersion={baseProject.version}
            liveVersion={liveProject.version}
            busy={busy}
            onReload={() => beginEdit(liveProject)}
          />
        )}
        <form className="form-grid" onSubmit={onPreviewCreateOrUpdate} noValidate>
          <label className="field">
            <span>项目 ID</span>
            <input
              aria-label="项目 ID"
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
              aria-label="项目名称"
              value={form.name}
              maxLength={MAX_NAME}
              disabled={busy || !!baseProject?.archived}
              onChange={event => {
                if (busy || baseProject?.archived) return
                setForm(current => ({ ...current, name: event.target.value }))
                setConfirming(false)
                pendingRef.current = undefined
              }}
              required
            />
          </label>
          <label className="field">
            <span>业务负责人</span>
            <input
              aria-label="业务负责人"
              value={form.ownerId}
              disabled={busy || !!baseProject?.archived}
              onChange={event => {
                if (busy || baseProject?.archived) return
                setForm(current => ({ ...current, ownerId: event.target.value }))
                setConfirming(false)
                pendingRef.current = undefined
              }}
              required
            />
          </label>
          <label className="field">
            <span>仓库路径（绝对路径）</span>
            <input
              aria-label="仓库路径"
              value={form.repositoryPath}
              disabled={busy || mode === 'edit'}
              onChange={event => {
                if (busy || mode === 'edit') return
                setForm(current => ({ ...current, repositoryPath: event.target.value }))
                setConfirming(false)
                pendingRef.current = undefined
              }}
              required
            />
          </label>
          <label className="field">
            <span>工作树根目录（绝对路径）</span>
            <input
              aria-label="工作树根目录"
              value={form.worktreeRoot}
              disabled={busy || mode === 'edit'}
              onChange={event => {
                if (busy || mode === 'edit') return
                setForm(current => ({ ...current, worktreeRoot: event.target.value }))
                setConfirming(false)
                pendingRef.current = undefined
              }}
              required
            />
          </label>
          <label className="field full-width">
            <span>允许任务类型（每行一项）</span>
            <textarea
              aria-label="允许任务类型"
              value={form.allowedTaskTypesText}
              disabled={busy || !!baseProject?.archived}
              onChange={event => {
                if (busy || baseProject?.archived) return
                setForm(current => ({ ...current, allowedTaskTypesText: event.target.value }))
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
            <button
              type="submit"
              className="button"
              disabled={busy || (mode === 'edit' && (!baseProject || baseProject.archived))}
            >
              {mode === 'create' ? '预览创建' : '预览更新'}
            </button>
            {mode === 'edit' && baseProject && !baseProject.archived && (
              <button type="button" className="button danger" disabled={busy} onClick={onPreviewArchive}>
                预览归档
              </button>
            )}
          </div>
        </form>
        {archiveIntent && (
          <p className="muted" role="status">
            归档后将阻止该项目的未来任务接入；已经运行中的任务与执行不会因此停止。
          </p>
        )}
        {confirming && pendingRef.current && (
          <ConfirmationPreview
            pending={pendingRef.current}
            busy={busy}
            onSubmit={submitConfirmed}
            onCancel={() => {
              if (busy) return
              clearPending()
              setArchiveIntent(false)
            }}
          />
        )}
        {actionError && <p role="alert" className="error-state">{actionError}</p>}
        {actionNotice && <p role="status" className="muted">{actionNotice}</p>}
      </div>

      {editingId && (
        <HistoryPanel
          title="项目变更历史"
          loading={historyQuery.isLoading}
          error={historyQuery.error}
          items={historyQuery.data?.items}
        />
      )}
    </section>
  )
}
