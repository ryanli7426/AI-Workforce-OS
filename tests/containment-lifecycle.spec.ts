/** Provider fault injection only; real OS containment acceptance lives in the other suites. */
import {lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {afterEach,expect,it,vi} from 'vitest'
import {runWorker} from '../src/runner/worker.ts'

vi.mock('../src/containment/srt.ts',()=>({
  prepareContainment:vi.fn(async(cwd:string)=>({
    evidence:{version:1,provider:'srt-macos',providerVersion:'0.0.81',policySha256:'0'.repeat(64),worktreeDevice:lstatSync(cwd).dev,worktreeInode:lstatSync(cwd).ino,verifiedAt:new Date().toISOString(),checks:'passed'},
    tempDir:cwd,secrets:()=>[],assertIdentity:()=>{},
    // The fake only tests terminal lifecycle ordering, never establishes a real boundary.
    wrap:async(command:string,args:string[])=>({command,args}),
    close:async()=>{throw new Error('Owned provider cleanup fault')},
  })),
}))
let root:string|undefined
afterEach(()=>{if(root)rmSync(root,{recursive:true,force:true})})

it('retains UNKNOWN if provider cleanup fails after an actual fixture target exits successfully',async()=>{
  root=realpathSync(mkdtempSync(join(tmpdir(),'containment-cleanup-fault-')))
  const cwd=join(root,'work'),dir=join(root,'runners','cleanup-fault');mkdirSync(cwd,{mode:0o700});mkdirSync(dir,{recursive:true,mode:0o700})
  const spec={executionId:'cleanup-fault',assignmentId:'a1',ticketId:'t1',generation:1,command:process.execPath,args:['-e',"require('node:fs').writeFileSync('TARGET_EXITED','owned fixture');process.stdout.write('fixture')"],cwd,timeoutMs:2000,maxOutputBytes:4096,graceMs:1000,containment:{version:1,mode:'required',provider:'srt-macos',readOnlyPaths:[],allowedDomains:[]}}
  const request=join(dir,'request.json');writeFileSync(request,JSON.stringify({version:2,token:'a'.repeat(64),spec}),{mode:0o600})
  await runWorker(request)
  const state=JSON.parse(readFileSync(join(dir,'state.json'),'utf8'))
  expect(state.state).toBe('UNKNOWN');expect(state.exitCode).toBe(0)
  expect(state.finishedAt).toBeUndefined();expect(state.reason).toContain('helper termination could not be confirmed')
  expect(readFileSync(join(cwd,'TARGET_EXITED'),'utf8')).toBe('owned fixture')
  const states=readFileSync(join(dir,'events.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line).state)
  expect(states).toContain('RUNNING');expect(states).not.toContain('SUCCEEDED')
})
