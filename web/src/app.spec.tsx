import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './app.tsx'
vi.mock('./pages/tasks.tsx', () => ({ TasksPage:()=> <h1>任务中心测试</h1>,TaskPage:()=> <h1>任务详情测试</h1> }))
vi.mock('./pages/overview.tsx', () => ({OverviewPage:()=> <h1>概览测试</h1>,EmployeesPage:()=> <h1>员工测试</h1>,ProjectsPage:()=> <h1>项目测试</h1>,ExecutionPage:()=> <h1>执行测试</h1>}))
vi.mock('./pages/management.tsx', () => ({EmployeesManager:()=> <h1>员工测试</h1>,ProjectsManager:()=> <h1>项目测试</h1>}))
const token='a'.repeat(64)
beforeEach(()=>{window.location.hash='';localStorage.clear();sessionStorage.clear();vi.unstubAllGlobals()})
function submit(value=token) { fireEvent.change(screen.getByLabelText('本地访问凭证'),{target:{value}});fireEvent.click(screen.getByRole('button',{name:'连接工作空间'})) }
describe('Web local Owner connection boundary',()=>{
 it('keeps credentials out of storage/URL and drops session on disconnect',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({ownerId:'local-owner',workspaceId:'local',role:'owner'}),{status:200,headers:{'Content-Type':'application/json'}}));vi.stubGlobal('fetch',fetcher)
  render(<App/>);submit();await screen.findByRole('heading',{name:'概览测试'})
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(JSON.stringify({local:{...localStorage},session:{...sessionStorage},url:window.location.href,cookie:document.cookie}).includes(token)).toBe(false)
  const before=window.location.hash;fireEvent.click(screen.getByRole('link',{name:'跳到主要内容'}));expect(window.location.hash).toBe(before);expect(document.activeElement?.id).toBe('content')
  fireEvent.click(screen.getByRole('button',{name:'切换深色主题'}));await waitFor(()=>expect(document.documentElement.dataset.theme).toBe('dark'))
  fireEvent.click(screen.getByRole('button',{name:'断开连接'}));await screen.findByRole('heading',{name:'连接工作空间'});expect((screen.getByLabelText('本地访问凭证') as HTMLInputElement).value).toBe('')
 })
 it('rejects malformed credential locally and does not surface server error text',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({error:{code:'UNAUTHORIZED',message:token}}),{status:401}));vi.stubGlobal('fetch',fetcher)
  render(<App/>);submit('invalid');expect(fetcher).not.toHaveBeenCalled();expect(screen.getByRole('alert').textContent).toContain('有效')
  submit();await waitFor(()=>expect(screen.getByRole('alert').textContent).toContain('凭证无效'));expect(document.body.textContent?.includes(token)).toBe(false);expect(screen.queryByRole('navigation')).toBeNull()
 })
 it('aborts an in-flight connection when the login component unmounts',async()=>{
  let signal:AbortSignal|undefined
  vi.stubGlobal('fetch',vi.fn((_path:string,init:RequestInit)=>{signal=init.signal as AbortSignal;return new Promise<Response>((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError')),{once:true}))}))
  const rendered=render(<App/>);submit();await waitFor(()=>expect(signal).toBeDefined());rendered.unmount();expect(signal!.aborted).toBe(true)
 })
})
