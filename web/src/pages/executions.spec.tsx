import { QueryClient,QueryClientProvider } from '@tanstack/react-query'
import { fireEvent,render,screen,waitFor } from '@testing-library/react'
import { describe,expect,it,vi } from 'vitest'
import type { ApiClient, ExecutionRecord } from '../api.ts'
import { ExecutionsPage } from './executions.tsx'
function fixture(){
 const record:ExecutionRecord={executionId:'exec-1',assignmentId:'assignment-1',ticketId:'task-1',agentId:'writer',runtime:'claude-code',generation:1,cwd:'/worktrees/exec-1',inputRevision:'input',policyVersion:'policy',state:'UNKNOWN',createdAt:'2026-11-05T00:00:00Z',updatedAt:'2026-11-05T00:00:00Z',lastSequence:0}
 const executions=vi.fn().mockResolvedValue({items:[record],nextCursor:10})
 const api={executions,projects:vi.fn().mockResolvedValue([]),employees:vi.fn().mockResolvedValue([])} as unknown as ApiClient
 const client=new QueryClient({defaultOptions:{queries:{retry:false}}})
 return {api,executions,client}
}
describe('Execution list',()=>{
 it('shows actual unknown status and scoped task/execution links without unsafe runtime actions',async()=>{
  window.location.hash='#/executions';const {api,client}=fixture();render(<QueryClientProvider client={client}><ExecutionsPage api={api}/></QueryClientProvider>)
  expect((await screen.findByRole('link',{name:'exec-1'})).getAttribute('href')).toBe('#/executions/exec-1')
  expect(screen.getByRole('link',{name:'task-1'}).getAttribute('href')).toBe('#/tasks/task-1');expect(screen.getByText('UNKNOWN',{selector:'.badge'})).toBeDefined()
  expect(screen.queryByRole('button',{name:'重试'})).toBeNull()
 })
 it('resets pagination on filter changes and sends the caller AbortSignal',async()=>{
  window.location.hash='#/executions';const {api,client,executions}=fixture();render(<QueryClientProvider client={client}><ExecutionsPage api={api}/></QueryClientProvider>)
  await screen.findByRole('link',{name:'exec-1'});fireEvent.click(screen.getByRole('button',{name:'下一页'}))
  await waitFor(()=>expect(executions).toHaveBeenLastCalledWith(expect.objectContaining({beforeRowid:10}),expect.any(AbortSignal)))
  fireEvent.change(screen.getByLabelText('执行状态筛选'),{target:{value:'UNKNOWN'}})
  await waitFor(()=>expect(executions).toHaveBeenLastCalledWith({limit:50,states:['UNKNOWN']},expect.any(AbortSignal)))
 })
 it('honors linked task filters and renders service failure',async()=>{
  window.location.hash='#/executions?ticketId=task-1';const {api,client,executions}=fixture();executions.mockRejectedValue(new Error('Fixture unavailable'))
  render(<QueryClientProvider client={client}><ExecutionsPage api={api}/></QueryClientProvider>)
  expect(await screen.findByRole('alert')).toBeDefined();expect(executions).toHaveBeenCalledWith({limit:50,ticketId:'task-1'},expect.any(AbortSignal))
 })
})
