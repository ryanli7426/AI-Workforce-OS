import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '../api.ts'
import { AsyncState, PageHeader } from '../shared.tsx'

const CAPABILITY_LABELS = [
  ['structuredResult','结构化结果'],
  ['activeInput','执行中追加输入'],
  ['continueSession','恢复 Agent 会话'],
  ['reattachMonitor','重新连接 Agent 监控'],
  ['pause','暂停 Agent'],
  ['filesystemIsolation','文件系统隔离'],
] as const

export function RuntimesPage({api}:{api:ApiClient}) {
  const query=useQuery({queryKey:['runtimes'],queryFn:({signal})=>api.runtimes(signal)})
  return <section className="stack">
    <PageHeader title="Runtime 注册" description="查看当前注册的执行驱动、实例配置和实际支持的能力。">
      <button className="button secondary" onClick={()=>void query.refetch()} disabled={query.isFetching}>刷新</button>
    </PageHeader>
    <AsyncState loading={query.isLoading} error={query.error} empty={query.data?.instances.length===0}>
      {query.data?.instances.map(instance=>{
        const driver=query.data!.drivers.find(item=>item.id===instance.driver)!
        return <article className="panel" key={instance.id}>
          <h2>{driver.displayName}</h2>
          <dl><dt>实例</dt><dd>{instance.id}</dd><dt>驱动</dt><dd>{instance.driver}</dd>
            <dt>协议版本</dt><dd>{driver.protocolVersion}</dd><dt>配置</dt><dd>{instance.configured?'已配置':'未配置'}</dd>
            <dt>健康状态</dt><dd>尚未检查</dd></dl>
          <div className="table-wrap"><table><thead><tr><th scope="col">能力</th><th scope="col">驱动支持</th></tr></thead>
            <tbody>{CAPABILITY_LABELS.map(([key,label])=><tr key={key}><td>{label}</td><td>{driver.capabilities[key]?'支持':'不支持'}</td></tr>)}</tbody></table></div>
        </article>
      })}
    </AsyncState>
    <p className="muted">配置存在不代表 CLI 已安装、已登录或运行健康。刷新只读取配置，不启动进程。Runner 的恢复观察与 Agent 会话恢复分别处理。</p>
    <p className="muted">当前 Claude 驱动使用独立 Worktree 和工具权限约束，尚未提供强文件系统隔离。Runtime 配置目前由本机 CLI 管理。</p>
  </section>
}
