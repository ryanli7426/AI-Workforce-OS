import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ApiClient, ProductExecutionListOptions } from '../api.ts'
import type { ExecutionState } from '../../../src/execution/model.ts'
import { AsyncState, PageHeader, StatusBadge, formatTime } from '../shared.tsx'
const STATES:ExecutionState[]=['STARTING','RUNNING','STOPPING','SUCCEEDED','FAILED','TIMED_OUT','CANCELLED','UNKNOWN']
export function ExecutionsPage({api}:{api:ApiClient}) {
 const [state,setState]=useState('')
 const [projectId,setProjectId]=useState('')
 const [employeeId,setEmployeeId]=useState('')
 const [cursors,setCursors]=useState<number[]>([])
 const [ticketId]=useState(()=>{const value=new URLSearchParams(window.location.hash.split('?')[1]??'').get('ticketId');return value&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value)?value:undefined})
 const options:ProductExecutionListOptions={limit:50,...(state?{states:[state as ExecutionState]}:{}),...(projectId?{projectId}:{}),...(employeeId?{employeeId}:{}),...(ticketId?{ticketId}:{}),...(cursors.length?{beforeRowid:cursors.at(-1)}:{})}
 const query=useQuery({queryKey:['executions',options],queryFn:({signal})=>api.executions(options,signal),refetchInterval:5000})
 const projects=useQuery({queryKey:['projects'],queryFn:({signal})=>api.projects(signal)})
 const employees=useQuery({queryKey:['employees'],queryFn:({signal})=>api.employees(signal)})
 const filtersError=projects.error||employees.error
 return <section className="stack"><PageHeader title="执行中心" description="查看每次实际执行、退出结果和交付记录。"><button className="button secondary" onClick={()=>void query.refetch()} disabled={query.isFetching}>刷新</button></PageHeader>
 <div className="panel"><div className="filters"><label>执行状态<select aria-label="执行状态筛选" value={state} onChange={event=>{setState(event.target.value);setCursors([])}}><option value="">全部状态</option>{STATES.map(item=><option key={item}>{item}</option>)}</select></label><label>项目<select aria-label="执行项目筛选" value={projectId} onChange={event=>{setProjectId(event.target.value);setCursors([])}}><option value="">全部项目</option>{projects.data?.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>员工<select aria-label="执行员工筛选" value={employeeId} onChange={event=>{setEmployeeId(event.target.value);setCursors([])}}><option value="">全部员工</option>{employees.data?.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div>{filtersError&&<p role="alert" className="muted">部分筛选选项加载失败，请刷新页面重试。</p>}{ticketId&&<p className="muted">关联任务：<a href={`#/tasks/${ticketId}`}>{ticketId}</a> · <a href="#/executions">查看全部执行</a></p>}</div>
 <div className="panel"><AsyncState loading={query.isLoading} error={query.error} empty={query.data?.items.length===0}><div className="table-wrap"><table className="data-table"><thead><tr><th scope="col">执行</th><th scope="col">任务</th><th scope="col">员工 / Runtime</th><th scope="col">状态</th><th scope="col">开始时间</th><th scope="col">退出结果</th></tr></thead><tbody>{query.data?.items.map(item=><tr key={item.executionId}><td><a href={`#/executions/${item.executionId}`}>{item.executionId}</a></td><td><a href={`#/tasks/${item.ticketId}`}>{item.ticketId}</a></td><td>{item.agentId}<div className="muted">{item.runtime}</div></td><td><StatusBadge status={item.state}/></td><td>{formatTime(item.startedAt??item.createdAt)}</td><td>{item.exitCode===undefined||item.exitCode===null?'—':`退出码 ${item.exitCode}`}{item.signal&&` · ${item.signal}`}{item.failureReason&&<p className="muted">{item.failureReason}</p>}</td></tr>)}</tbody></table></div></AsyncState><div className="pagination"><button className="button secondary" disabled={!cursors.length||query.isFetching} onClick={()=>setCursors(items=>items.slice(0,-1))}>上一页</button><button className="button secondary" disabled={query.data?.nextCursor===undefined||query.isFetching} onClick={()=>{const next=query.data?.nextCursor;if(next!==undefined)setCursors(items=>[...items,next])}}>下一页</button></div><p className="muted small">SUCCEEDED 表示执行结果。独立验证和人工验收仍由关联任务分别记录；UNKNOWN 需要核实原进程，不能直接重跑。</p></div></section>
}
