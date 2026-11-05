import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApiClient, type ManagementCommand, type ManagementResult } from './api.ts'
const token='c'.repeat(64)
const employee={id:'writer',workspaceId:'local',name:'Writer',role:'Developer',responsibilities:['Docs'],capabilities:['documentation'],runtimeId:'claude-local',projectIds:['docs'],maxConcurrency:1,timeoutMs:60_000,enabled:false,version:1}
const project={id:'docs',workspaceId:'local',name:'Docs',ownerId:'owner',repositoryPath:'/local/repo',worktreeRoot:'/local/worktrees',allowedTaskTypes:['documentation'],archived:false,version:1}
function reply(value:unknown,status=200) {return new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}})}
afterEach(()=>vi.unstubAllGlobals())
describe('governed management HTTP client',()=>{
 it('uses actual paths and DTOs for each command without implicit retries or actor fields',async()=>{
  const commands:ManagementCommand[]=[
   {kind:'employee-create',input:{id:employee.id,name:employee.name,role:employee.role,responsibilities:employee.responsibilities,capabilities:employee.capabilities,runtimeId:employee.runtimeId,projectIds:employee.projectIds,maxConcurrency:1,timeoutMs:60_000},reason:'Create writer'},
   {kind:'employee-update',id:'writer',input:{expectedVersion:1,name:'Updated writer'},reason:'Rename'},
   {kind:'employee-enable',id:'writer',input:{expectedVersion:2,enabled:true},reason:'Enable'},
   {kind:'project-create',input:{id:project.id,name:project.name,ownerId:project.ownerId,repositoryPath:project.repositoryPath,worktreeRoot:project.worktreeRoot,allowedTaskTypes:project.allowedTaskTypes},reason:'Create project'},
   {kind:'project-update',id:'docs',input:{expectedVersion:1,name:'Updated Docs'},reason:'Rename'},
   {kind:'project-archive',id:'docs',input:{expectedVersion:2},reason:'Archive'},
  ]
  const paths=['/employees','/employees/writer/update','/employees/writer/enable','/projects','/projects/docs/update','/projects/docs/archive']
  const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher)
  const api=createApiClient(token)
  for(const [index,command] of commands.entries()) {
   const result:ManagementResult=command.kind.startsWith('employee-')?{kind:'employee',employee,replayed:false}:{kind:'project',project,replayed:false}
   fetcher.mockResolvedValueOnce(reply(result,command.kind.endsWith('-create')?201:200))
   expect(await api.manage(`key-${index}`,command)).toEqual(result)
   const [url,options]=fetcher.mock.calls[index] as [string,RequestInit]
   expect(url).toBe(`/api/v1${paths[index]}`);expect(url).not.toContain(token);expect(options.method).toBe('POST')
   expect(JSON.parse(options.body as string)).toEqual({input:command.input,reason:command.reason})
   expect(options.headers).toMatchObject({Authorization:`Bearer ${token}`,'Idempotency-Key':`key-${index}`})
  }
  expect(fetcher).toHaveBeenCalledTimes(6)
 })
 it('rejects invalid resource paths before fetch and validates returned union',async()=>{
  const fetcher=vi.fn().mockResolvedValue(reply({kind:'employee',employee:{id:'missing-fields'},replayed:false}));vi.stubGlobal('fetch',fetcher)
  const api=createApiClient(token)
  await expect(api.manage('valid-key',{kind:'employee-enable',id:'../private',input:{expectedVersion:1,enabled:true},reason:'Test'})).rejects.toMatchObject({code:'INVALID_REQUEST'})
  expect(fetcher).not.toHaveBeenCalled()
  await expect(api.manage('valid-key',{kind:'employee-enable',id:'writer',input:{expectedVersion:1,enabled:true},reason:'Test'})).rejects.toMatchObject({code:'INVALID_RESPONSE'})
 })
 it('loads actual bounded audit DTOs and keeps server errors static',async()=>{
  const row={id:'audit-1',actorId:'owner',workspaceId:'local',kind:'project',resourceId:'docs',action:'project-create',reason:'Configured scope',beforeVersion:null,afterVersion:1,createdAt:'2026-11-05T01:00:00.000Z'}
  const fetcher=vi.fn().mockResolvedValueOnce(reply({items:[row]})).mockResolvedValueOnce(reply({error:{code:'VERSION_CONFLICT',message:token}},409));vi.stubGlobal('fetch',fetcher)
  const api=createApiClient(token)
  expect(await api.managementHistory('project','docs')).toEqual({items:[row]})
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/v1/projects/docs/history')
  await expect(api.manage('same-key',{kind:'project-archive',id:'docs',input:{expectedVersion:1},reason:'Archive'})).rejects.toMatchObject({code:'VERSION_CONFLICT',status:409,message:'版本冲突，请刷新后重试。'})
  expect(fetcher).toHaveBeenCalledTimes(2)
 })
})
