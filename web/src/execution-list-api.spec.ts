import { afterEach,describe,expect,it,vi } from 'vitest'
import { createApiClient,type ExecutionRecord } from './api.ts'
const token='e'.repeat(64)
afterEach(()=>vi.unstubAllGlobals())
describe('execution list browser transport',()=>{
 it('sends scoped filters and cursor and validates actual execution DTO',async()=>{
  const record:ExecutionRecord={executionId:'execution-1',assignmentId:'assignment-1',ticketId:'ticket-1',agentId:'writer',runtime:'claude-code',generation:1,cwd:'/worktrees/execution-1',inputRevision:'input-1',policyVersion:'policy-1',state:'UNKNOWN',createdAt:'2026-11-05T00:00:00Z',updatedAt:'2026-11-05T00:00:00Z',lastSequence:0}
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({items:[record],nextCursor:10}),{status:200}));vi.stubGlobal('fetch',fetcher)
  const signal=new AbortController().signal
  expect(await createApiClient(token).executions({limit:20,beforeRowid:50,states:['UNKNOWN'],projectId:'docs',employeeId:'writer',ticketId:'ticket-1'},signal)).toEqual({items:[record],nextCursor:10})
  const [path,options]=fetcher.mock.calls[0] as [string,RequestInit]
  const query=new URL(path,'http://localhost').searchParams
  expect(path.split('?')[0]).toBe('/api/v1/executions');expect(Object.fromEntries(query)).toEqual({limit:'20',beforeRowid:'50',states:'UNKNOWN',projectId:'docs',employeeId:'writer',ticketId:'ticket-1'})
  expect(options.headers).toMatchObject({Authorization:`Bearer ${token}`});expect(path).not.toContain(token)
 })
 it('rejects malformed filters before request and malformed execution response',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({items:[{id:'wrong-key'}]}),{status:200}));vi.stubGlobal('fetch',fetcher)
  const api=createApiClient(token)
  for(const options of [{limit:201},{states:['UNKNOWN','UNKNOWN']},{ownerId:'foreign'},{ticketId:'../private'}]) await expect(api.executions(options as never)).rejects.toMatchObject({code:'INVALID_REQUEST'})
  expect(fetcher).not.toHaveBeenCalled()
  await expect(api.executions()).rejects.toMatchObject({code:'INVALID_RESPONSE'})
 })
})
