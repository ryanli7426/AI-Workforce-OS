import type { ReactNode } from 'react'
export function StatusBadge({ status }: { status: string }) { return <span className={`badge status-${status.toLowerCase()}`}>{status}</span> }
export function PageHeader({ title, description, children }: {title: string; description?: string; children?: ReactNode}) { return <header className="page-header"><div><h1>{title}</h1>{description && <p>{description}</p>}</div><div className="page-actions">{children}</div></header> }
export function AsyncState({ loading, error, empty, children }: {loading?: boolean; error?: unknown; empty?: boolean; children?: ReactNode}) {
  if (loading) return <div role="status" className="empty-state">正在加载…</div>
  if (error) {
    const status = typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined
    return <div role="alert" className="error-state">{status === 401 || status === 403 ? '访问权限已失效，请断开后重新连接。' : status === 404 ? '记录不存在或不在当前工作空间中。' : '暂时无法获取数据，请刷新重试。权限失效时请重新连接。'}</div>
  }
  if (empty) return <div className="empty-state">暂无记录</div>
  return <>{children}</>
}
export function formatTime(value?: string) { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.valueOf()) ? '—' : date.toLocaleString('zh-CN') }
