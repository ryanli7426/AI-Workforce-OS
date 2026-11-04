import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient, Employee, ExecutionRecord, ProductOverview, Project } from '../api.ts'
import type { TaskState } from '../../../src/core/lifecycle-model.ts'
import { AsyncState, PageHeader, StatusBadge, formatTime } from '../shared.tsx'

const REFETCH_MS = 5_000
const ATTENTION_STATES = ['WAITING_APPROVAL', 'BLOCKED', 'FAILED', 'REVIEW'] as const satisfies readonly TaskState[]

function RefreshButton({ onClick, busy }: { onClick: () => void; busy?: boolean }) {
  return (
    <button type="button" className="button secondary" onClick={onClick} disabled={busy} aria-label="刷新">
      刷新
    </button>
  )
}

function configuredEnabledLabel(enabled: boolean): string {
  return enabled ? '已启用' : '未启用'
}

function primaryOverviewCards(data: ProductOverview) {
  return [
    { label: '任务总数', value: data.tasks.total },
    { label: '待审批', value: data.tasks.byStatus.WAITING_APPROVAL },
    { label: '阻塞', value: data.tasks.byStatus.BLOCKED },
    { label: '失败', value: data.tasks.byStatus.FAILED },
    { label: '待复核', value: data.tasks.byStatus.REVIEW },
    { label: '运行中', value: data.tasks.byStatus.RUNNING },
  ] as const
}

function secondaryOverviewDetails(data: ProductOverview) {
  return [
    { label: '已配置员工', value: data.employees.configured },
    { label: '可接单员工', value: data.employees.enabled },
    { label: '忙碌员工', value: data.employees.busy },
    { label: '执行总数', value: data.executions.total },
    { label: '活动执行', value: data.executions.active },
    { label: '未知执行', value: data.executions.unknown },
  ] as const
}

export function OverviewPage({ api }: { api: ApiClient }) {
  const overview = useQuery({
    queryKey: ['overview'],
    queryFn: ({ signal }) => api.overview(signal),
    refetchInterval: REFETCH_MS,
  })
  const attention = useQuery({
    queryKey: ['tasks', 'attention', [...ATTENTION_STATES]],
    queryFn: ({ signal }) => api.tasks({ states: [...ATTENTION_STATES], limit: 50 }, signal),
    refetchInterval: REFETCH_MS,
  })

  const refreshing = overview.isFetching || attention.isFetching
  const refresh = () => {
    void overview.refetch()
    void attention.refetch()
  }

  return (
    <section className="stack">
      <PageHeader title="概览" description="掌握任务进度，处理需要你决策的工作。">
        <RefreshButton onClick={refresh} busy={refreshing && !overview.isLoading && !attention.isLoading} />
      </PageHeader>

      <div className="panel">
        <AsyncState loading={overview.isLoading} error={overview.error}>
          {overview.data && (
            <div className="stack">
              <div className="card-grid overview-grid" aria-label="概览计数">
                {primaryOverviewCards(overview.data).map(card => (
                  <div key={card.label} className="stat-card">
                    <div className="muted">{card.label}</div>
                    <strong>{card.value}</strong>
                  </div>
                ))}
              </div>
              <div className="overview-secondary" aria-label="配置与执行明细">
                {secondaryOverviewDetails(overview.data).map(row => (
                  <div key={row.label}>
                    <div className="muted">{row.label}</div>
                    <div>{row.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </AsyncState>
      </div>

      <div className="panel">
        <h2>需要关注</h2>
        <p className="muted">等待审批、阻塞、失败与待复核的任务。</p>
        <AsyncState
          loading={attention.isLoading}
          error={attention.error}
          empty={!!attention.data && attention.data.items.length === 0}
        >
          {attention.data && attention.data.items.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">任务</th>
                    <th scope="col">状态</th>
                    <th scope="col">优先级</th>
                    <th scope="col">员工</th>
                    <th scope="col">更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {attention.data.items.map(item => (
                    <tr key={item.id}>
                      <td>
                        <a href={`#/tasks/${encodeURIComponent(item.id)}`}>{item.title}</a>
                      </td>
                      <td><StatusBadge status={item.status} /></td>
                      <td>{item.priority}</td>
                      <td>{item.agentId ?? '—'}</td>
                      <td>{formatTime(item.updatedAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncState>
      </div>
    </section>
  )
}

export function EmployeesPage({ api }: { api: ApiClient }) {
  const query = useQuery({
    queryKey: ['employees'],
    queryFn: ({ signal }) => api.employees(signal),
    refetchInterval: REFETCH_MS,
  })

  return (
    <section className="stack">
      <PageHeader
        title="AI 员工"
        description="员工配置暂由本地 CLI 管理。启用状态表示可接单配置。"
      >
        <RefreshButton onClick={() => { void query.refetch() }} busy={query.isFetching && !query.isLoading} />
      </PageHeader>
      <div className="panel">
        <AsyncState loading={query.isLoading} error={query.error} empty={!!query.data && query.data.length === 0}>
          {query.data && query.data.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">名称</th>
                    <th scope="col">岗位</th>
                    <th scope="col">能力</th>
                    <th scope="col">Runtime</th>
                    <th scope="col">启用</th>
                    <th scope="col">配置版本</th>
                    <th scope="col">项目任务</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.map((employee: Employee) => (
                    <tr key={employee.id}>
                      <td>{employee.name}</td>
                      <td>{employee.role}</td>
                      <td>{employee.capabilities.length ? employee.capabilities.join('、') : '—'}</td>
                      <td>{employee.runtimeId}</td>
                      <td>{configuredEnabledLabel(employee.enabled)}</td>
                      <td>{employee.version}</td>
                      <td>
                        <div className="stack">
                          <a href={`#/tasks?employeeId=${encodeURIComponent(employee.id)}`}>按员工筛选任务</a>
                          {employee.projectIds.map(projectId => (
                            <a key={projectId} href={`#/tasks?projectId=${encodeURIComponent(projectId)}`}>
                              项目 {projectId}
                            </a>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncState>
      </div>
    </section>
  )
}

export function ProjectsPage({ api }: { api: ApiClient }) {
  const query = useQuery({
    queryKey: ['projects'],
    queryFn: ({ signal }) => api.projects(signal),
    refetchInterval: REFETCH_MS,
  })

  return (
    <section className="stack">
      <PageHeader
        title="项目"
        description="项目配置暂由本地 CLI 管理。"
      >
        <RefreshButton onClick={() => { void query.refetch() }} busy={query.isFetching && !query.isLoading} />
      </PageHeader>
      <div className="panel">
        <AsyncState loading={query.isLoading} error={query.error} empty={!!query.data && query.data.length === 0}>
          {query.data && query.data.length > 0 && (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">名称</th>
                    <th scope="col">负责人</th>
                    <th scope="col">仓库路径</th>
                    <th scope="col">工作树</th>
                    <th scope="col">允许类型</th>
                    <th scope="col">归档</th>
                    <th scope="col">配置版本</th>
                    <th scope="col">任务</th>
                  </tr>
                </thead>
                <tbody>
                  {query.data.map((project: Project) => (
                    <tr key={project.id}>
                      <td>{project.name}</td>
                      <td>{project.ownerId}</td>
                      <td>{project.repositoryPath}</td>
                      <td>{project.worktreeRoot}</td>
                      <td>{project.allowedTaskTypes.join('、')}</td>
                      <td>{project.archived ? '已归档' : '未归档'}</td>
                      <td>{project.version}</td>
                      <td>
                        <a href={`#/tasks?projectId=${encodeURIComponent(project.id)}`}>按项目筛选任务</a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </AsyncState>
      </div>
    </section>
  )
}

function executionDetailRows(record: ExecutionRecord) {
  return [
    { label: '执行 ID', value: record.executionId },
    { label: '任务', value: <a href={`#/tasks/${encodeURIComponent(record.ticketId)}`}>{record.ticketId}</a> },
    { label: '分配', value: record.assignmentId },
    { label: '员工', value: record.agentId },
    { label: 'Runtime', value: record.runtime },
    { label: '状态', value: <StatusBadge status={record.state} /> },
    { label: '创建时间', value: formatTime(record.createdAt) },
    { label: '更新时间', value: formatTime(record.updatedAt) },
    { label: '开始时间', value: formatTime(record.startedAt) },
    { label: '结束时间', value: formatTime(record.finishedAt) },
    { label: '退出码', value: record.exitCode === undefined || record.exitCode === null ? '—' : String(record.exitCode) },
    { label: '信号', value: record.signal ?? '—' },
    { label: '错误', value: record.failureReason ?? '—' },
  ] as const
}

export function ExecutionPage({ api, executionId }: { api: ApiClient; executionId: string }) {
  const [logsOpen, setLogsOpen] = useState(false)
  const execution = useQuery({
    queryKey: ['execution', executionId],
    queryFn: ({ signal }) => api.execution(executionId, signal),
    refetchInterval: REFETCH_MS,
  })
  const ticketId = execution.data?.ticketId
  const logs = useQuery({
    queryKey: ['logs', ticketId, executionId],
    queryFn: ({ signal }) => api.logs(ticketId!, { executionId }, signal),
    enabled: logsOpen && !!ticketId,
    refetchInterval: REFETCH_MS,
  })

  return (
    <section className="stack">
      <PageHeader
        title="执行详情"
        description="执行结果与最终任务验收分别记录。"
      >
        <RefreshButton onClick={() => { void execution.refetch() }} busy={execution.isFetching && !execution.isLoading} />
      </PageHeader>
      <div className="panel">
        <AsyncState loading={execution.isLoading} error={execution.error} empty={false}>
          {execution.data && (
            <>
              {execution.data.state === 'SUCCEEDED' && (
                <p className="muted" role="status">
                  SUCCEEDED 表示进程执行成功，不等于任务已验收完成。
                </p>
              )}
              <div className="detail-grid" aria-label="执行记录">
                {executionDetailRows(execution.data).map(row => (
                  <div key={row.label}>
                    <div className="muted">{row.label}</div>
                    <div>{row.value}</div>
                  </div>
                ))}
              </div>
              <div className="stack">
                <button
                  type="button"
                  className="button secondary"
                  aria-expanded={logsOpen}
                  onClick={() => setLogsOpen(open => !open)}
                >
                  {logsOpen ? '隐藏日志' : '读取日志'}
                </button>
                {logsOpen && (
                  <AsyncState loading={logs.isLoading} error={logs.error} empty={!!logs.data && logs.data.executions.length === 0}>
                    {logs.data && logs.data.executions.length > 0 && (
                      <div className="stack" aria-label="执行日志">
                        {logs.data.executions.map(entry => (
                          <div key={entry.executionId} className="panel">
                            <div className="muted">执行 {entry.executionId} · <StatusBadge status={entry.state} /></div>
                            <h3>stdout{entry.stdoutTruncated ? '（已截断）' : ''}</h3>
                            <pre>{entry.stdout || '（空）'}</pre>
                            <h3>stderr{entry.stderrTruncated ? '（已截断）' : ''}</h3>
                            <pre>{entry.stderr || '（空）'}</pre>
                          </div>
                        ))}
                      </div>
                    )}
                  </AsyncState>
                )}
              </div>
            </>
          )}
        </AsyncState>
      </div>
    </section>
  )
}
