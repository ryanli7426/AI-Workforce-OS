import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ApiError, createApiClient, type ApiClient, type Principal } from './api.ts'
import { ExecutionsPage } from './pages/executions.tsx'
import { TasksPage, TaskPage } from './pages/tasks.tsx'
import { EmployeesManager, ProjectsManager } from './pages/management.tsx'
import { OverviewPage, ExecutionPage } from './pages/overview.tsx'
import { RealtimeStatus } from './realtime.tsx'

interface Connection { api: ApiClient; principal: Principal; cache: QueryClient }
const NAVIGATION = [ ['/', '总览', '◈'], ['/tasks', '任务中心', '▤'], ['/approvals', '审批与验收', '◇'], ['/employees', 'AI 员工', '♧'], ['/projects', '项目空间', '▧'], ['/executions', '执行中心', '▷'] ] as const
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
function currentRoute() { return window.location.hash.slice(1) || '/' }
function Login({ onConnect }: { onConnect(api: ApiClient, principal: Principal): void }) {
  const [token, setToken] = useState('')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  async function connect(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    setError('')
    if (!/^[a-f0-9]{64}$/.test(token.trim())) { setError('请输入有效的本地访问凭证。'); return }
    const controller = new AbortController()
    request.current = controller
    setPending(true)
    try {
      const api = createApiClient(token.trim())
      const principal = await api.me(controller.signal)
      if (controller.signal.aborted) return
      setToken('')
      onConnect(api, principal)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof ApiError && cause.status === 401 ? '凭证无效，请检查本地配置后重试。' : '连接失败，请确认本地 API 已启动。')
    } finally { if (!controller.signal.aborted) setPending(false) }
  }
  return <main className="login-layout"><section className="login-story"><div className="brand"><span className="brand-mark">W</span> AI WORKFORCE OS</div><div><p className="eyebrow">YOUR LOCAL WORKFORCE</p><h1>让工作有序发生。<br/><span>让决定始终在人。</span></h1><p>任务、AI 员工与每一次交付，<br/>在一个可追溯的本地工作空间中协作。</p></div><div className="login-principles"><span>本地优先</span><span>独立执行</span><span>人工治理</span></div></section><section className="login-form"><div className="panel"><p className="eyebrow">LOCAL WORKSPACE</p><h2>连接工作空间</h2><p className="muted">使用本机生成的 Owner 访问凭证。</p><form onSubmit={connect}><label className="field">本地访问凭证<input autoComplete="off" spellCheck={false} type="password" aria-label="本地访问凭证" value={token} onChange={e => setToken(e.target.value)} maxLength={128} required disabled={pending}/></label>{error && <p role="alert" className="error-state">{error}</p>}<button className="button" aria-label={pending ? '正在连接' : '连接工作空间'} disabled={pending}>{pending ? '正在连接…' : '连接工作空间 →'}</button></form><p className="connection-help">先运行 <code>api-init</code> 与 <code>api-serve</code>。凭证保存在私有数据目录的 <code>api-auth.json</code>。</p><p className="muted small">凭证只在当前页面内存中使用；刷新或断开后需重新连接。</p></div></section></main>
}
export function App() {
  const [connection, setConnection] = useState<Connection | null>(null)
  const [route, setRoute] = useState(currentRoute)
  const path = route.split('?')[0] || '/'
  const [theme, setTheme] = useState<'light' | 'dark'>('light')
  useEffect(() => { const update = () => setRoute(currentRoute()); window.addEventListener('hashchange', update); return () => window.removeEventListener('hashchange', update) }, [])
  useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
  useEffect(() => { if (connection) document.getElementById('content')?.focus() }, [route, connection])
  useEffect(() => () => { connection?.cache.clear() }, [connection])
  const connect = (api: ApiClient, principal: Principal) => setConnection({ api, principal, cache: new QueryClient({defaultOptions: {queries: {retry: (count, error) => !(error instanceof ApiError && [401,403,404].includes(error.status)) && count < 1, staleTime: 2000}, mutations: {retry: false}}}) })
  const disconnect = useCallback(() => {
    if(connection){void connection.cache.cancelQueries();connection.cache.clear()}
    setConnection(null)
  },[connection])
  if (!connection) return <Login onConnect={connect}/>
  const { api, principal, cache } = connection
  let page
  const parts = path.split('/')
  if (path === '/') page = <OverviewPage api={api}/>
  else if (path === '/tasks') page = <TasksPage api={api}/>
  else if (path === '/approvals') page = <TasksPage api={api} approvals/>
  else if (path === '/employees') page = <EmployeesManager api={api}/>
  else if (path === '/projects') page = <ProjectsManager api={api}/>
  else if (path === '/executions') page = <ExecutionsPage api={api}/>
  else if (parts.length === 3 && parts[1] === 'tasks' && SAFE_ID.test(parts[2] ?? '')) page = <TaskPage api={api} ticketId={parts[2]!}/>
  else if (parts.length === 3 && parts[1] === 'executions' && SAFE_ID.test(parts[2] ?? '')) page = <ExecutionPage api={api} executionId={parts[2]!}/>
  else page = <section className="panel empty-state"><h1>页面不存在</h1><a href="#/">返回总览</a></section>
  return <QueryClientProvider client={cache}><a className="skip-link" href="#content" onClick={event => { event.preventDefault(); document.getElementById('content')?.focus() }}>跳到主要内容</a><div className="app-layout"><aside className="sidebar"><a className="brand" href="#/"><span className="brand-mark">W</span><span>WORKFORCE<span className="brand-subtitle">OPERATING SYSTEM</span></span></a><div className="workspace-label"><span className="workspace-icon">L</span><div><strong>{principal.workspaceId}</strong><small>本地工作空间</small></div></div><p className="nav-label">WORKSPACE</p><nav aria-label="主导航">{NAVIGATION.map(([href,label,icon]) => <a key={href} href={`#${href}`} aria-current={path === href || href === '/tasks' && path.startsWith('/tasks/') ? 'page' : undefined}><span aria-hidden="true">{icon}</span>{label}</a>)}</nav><div className="sidebar-footer"><div className="owner-avatar">O</div><div><strong>本地 Owner</strong><small>{principal.ownerId}</small></div></div></aside><div className="main-layout"><header className="topbar"><div><span className="environment-dot"/> 本地控制平面 <span className="topbar-divider">/</span> 工作空间</div><div className="topbar-actions"><RealtimeStatus stream={api.changes} onUnauthorized={disconnect}/><button className="icon-button" onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')} aria-label={theme === 'light' ? '切换深色主题' : '切换浅色主题'}>{theme === 'light' ? '◐' : '☀'}</button><button className="button secondary small" onClick={disconnect}>断开连接</button></div></header><main id="content" tabIndex={-1} className="page-content" key={route}>{page}</main><footer className="main-footer">AI Workforce OS · 本地优先 · 由人治理<span>执行成功 ≠ 验证通过 ≠ 最终验收</span></footer></div></div></QueryClientProvider>
}
