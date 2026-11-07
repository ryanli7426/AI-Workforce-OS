import {spawn} from 'node:child_process'
import {once} from 'node:events'
import {createServer} from 'node:net'
import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {afterEach,beforeEach,expect,it} from 'vitest'
import {RunnerClient} from '../src/runner/client.ts'
import type {LaunchSpec,RunnerSnapshot} from '../src/runner/protocol.ts'
import {TERMINAL_EXECUTION_STATES} from '../src/execution/model.ts'

let root:string,cwd:string,client:RunnerClient
const workerPath=resolve('dist/runner/worker.js')
const libraries=existsSync('/opt/homebrew/Cellar')?['/opt/homebrew/Cellar']:[]
const ids:string[]=[]
const delay=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))
beforeEach(()=>{
  root=realpathSync(mkdtempSync(join(tmpdir(),'contained-runner-')));cwd=join(root,'work');mkdirSync(cwd,{mode:0o700})
  client=new RunnerClient({root:join(root,'runners'),workerPath})
})
async function terminal(id:string):Promise<RunnerSnapshot>{
  const deadline=Date.now()+12000
  while(Date.now()<deadline){const snapshot=await client.status(id);if(TERMINAL_EXECUTION_STATES.includes(snapshot.state))return snapshot;await delay(25)}
  throw new Error('Owned contained Runner did not terminate')
}
afterEach(async()=>{
  for(const id of ids.splice(0)){
    try{const snapshot=await client.status(id);if(!TERMINAL_EXECUTION_STATES.includes(snapshot.state)){await client.stop(id,'Owned fixture cleanup');await terminal(id)}}catch(error){
      // Proof-corruption tests restore the immutable proof before cleanup.
      if(existsSync(join(root,'runners',id,'state.json')))throw error
    }
  }
  rmSync(root,{recursive:true,force:true})
})
function spec(id:string,code:string):LaunchSpec{
  ids.push(id)
  return {executionId:id,assignmentId:'assignment-'+id,ticketId:'ticket-'+id,generation:1,command:process.execPath,args:['-e',code],cwd,timeoutMs:4000,maxOutputBytes:16384,graceMs:1000,
    containment:{version:1,mode:'required',provider:'srt-macos',readOnlyPaths:libraries,allowedDomains:[]}}
}

if(process.platform==='darwin'){
  it('persists authenticated request-v2 proof, enforces files and direct network denial, and replays without launch',async()=>{
    let connections=0
    const server=createServer(socket=>{connections++;socket.destroy()});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    const port=(server.address() as {port:number}).port
    const secret=['owned','fixture','runtime','redaction'].join('-')
    client=new RunnerClient({root:join(root,'runners'),workerPath,runtimeEnvironment:{ANTHROPIC_API_KEY:secret}})
    const sentinel=join(root,'sentinel');writeFileSync(sentinel,'owned outside bytes')
    const code=`const fs=require('node:fs'),net=require('node:net');if(process.env.WORKFORCE_RUNTIME_ENV_JSON)process.exit(5);fs.appendFileSync('launch-count','once\\n');fs.writeFileSync('RESULT','inside');try{fs.writeFileSync(${JSON.stringify(sentinel)},'changed');process.exit(9)}catch(e){if(!['EPERM','EACCES','ENOENT'].includes(e.code))process.exit(8)};const socket=net.connect(${port},'127.0.0.1');socket.once('connect',()=>process.exit(7));socket.once('error',()=>{process.stdout.write('contained-target '+process.env.ANTHROPIC_API_KEY+' '+process.env.HTTP_PROXY);process.exit(0)});setTimeout(()=>process.exit(6),1000);`
    const input=spec('actual-boundary',code)
    try{
      await client.start(input)
      const result=await terminal(input.executionId)
      expect(result.version).toBe(2);expect(result.state).toBe('SUCCEEDED');expect(result.containment?.checks).toBe('passed')
      const output=readFileSync(join(root,'runners',input.executionId,'stdout.log'),'utf8')
      expect(output).not.toContain(secret);expect(output.match(/\[REDACTED\]/g)!.length).toBeGreaterThanOrEqual(2)
      expect(connections).toBe(0);expect(readFileSync(sentinel,'utf8')).toBe('owned outside bytes')
      expect(readFileSync(join(cwd,'RESULT'),'utf8')).toBe('inside')
      const request=JSON.parse(readFileSync(join(root,'runners',input.executionId,'request.json'),'utf8'))
      expect(request.version).toBe(2);expect(JSON.stringify(request)).not.toContain(secret)
      const proofPath=join(root,'runners',input.executionId,'containment.json'),original=readFileSync(proofPath,'utf8')
      const corrupt=JSON.parse(original);corrupt.evidence.policySha256='0'.repeat(64)
      writeFileSync(proofPath,JSON.stringify(corrupt),{mode:0o600})
      await expect(client.status(input.executionId)).rejects.toThrow('UNKNOWN')
      writeFileSync(proofPath,original,{mode:0o600})
      const observer=new RunnerClient({root:join(root,'runners'),workerPath})
      expect((await observer.start(input)).state).toBe('SUCCEEDED')
      expect(readFileSync(join(cwd,'launch-count'),'utf8')).toBe('once\n')
      expect((await observer.events(input.executionId)).some(event=>event.state==='RUNNING'&&event.containment?.checks==='passed')).toBe(true)
      const changed={...input,containment:{...input.containment!,allowedDomains:['example.com']}}
      await expect(observer.start(changed)).rejects.toThrow('conflicts')
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
  },20000)

  it('denies the library implicit shared temporary write roots using only owned sentinels',async()=>{
    const sharedRoot='/private/tmp/claude'
    mkdirSync(sharedRoot,{recursive:true,mode:0o700})
    expect(realpathSync(sharedRoot)).toBe(sharedRoot)
    const shared=realpathSync(mkdtempSync(join(sharedRoot,'workforce-owned-regression-')))
    const sentinel=join(shared,'sentinel');writeFileSync(sentinel,'owned shared sentinel')
    const code=`const fs=require('node:fs');let denied=0;for(const path of ${JSON.stringify([sentinel,join(shared,'new')])}){try{fs.writeFileSync(path,'modified')}catch(e){if(['EPERM','EACCES','ENOENT'].includes(e.code))denied++}};fs.writeFileSync('INSIDE_OK','ok');process.exit(denied===2?0:9)`
    const input=spec('shared-temp',code)
    try{
      await client.start(input)
      expect((await terminal(input.executionId)).state).toBe('SUCCEEDED')
      expect(readFileSync(sentinel,'utf8')).toBe('owned shared sentinel')
      expect(existsSync(join(shared,'new'))).toBe(false)
      expect(readFileSync(join(cwd,'INSIDE_OK'),'utf8')).toBe('ok')
    }finally{rmSync(shared,{recursive:true,force:true})}
  })

  it('rejects a private Runner root nested in the writable worktree in both client and worker',async()=>{
    const nestedRoot=join(cwd,'.runners'),nested=new RunnerClient({root:nestedRoot,workerPath})
    const input=spec('nested-root',"require('node:fs').writeFileSync('TARGET_WAS_LAUNCHED','bad')")
    await expect(nested.start(input)).rejects.toThrow('must be disjoint')
    const dir=join(nestedRoot,input.executionId);mkdirSync(dir,{recursive:true,mode:0o700})
    writeFileSync(join(dir,'request.json'),JSON.stringify({version:2,token:'b'.repeat(64),spec:input}),{mode:0o600})
    const child=spawn(process.execPath,[workerPath,'--request',join(dir,'request.json')],{stdio:'ignore',env:{PATH:process.env.PATH,HOME:root,LANG:'C'}})
    let timer:NodeJS.Timeout|undefined
    try{
      const exited=once(child,'exit')
      await Promise.race([exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Owned nested Worker did not stop'))},10000)})])
      expect(child.exitCode).toBe(0)
      const result=await nested.status(input.executionId)
      expect(result.state).toBe('FAILED');expect(result.processId).toBeUndefined()
      expect(existsSync(join(cwd,'TARGET_WAS_LAUNCHED'))).toBe(false)
    }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited}}
  },15000)

  it('records deterministic pre-target failure rather than running outside a broken required policy',async()=>{
    const input=spec('bad-policy',"require('node:fs').writeFileSync('TARGET_WAS_LAUNCHED','bad')")
    input.containment!.readOnlyPaths=[...libraries,root]
    await client.start(input)
    const result=await terminal(input.executionId)
    expect(result.state).toBe('FAILED');expect(result.processId).toBeUndefined();expect(result.containment).toBeUndefined()
    expect(existsSync(join(cwd,'TARGET_WAS_LAUNCHED'))).toBe(false)
    expect(result.reason).toContain('target was not launched')
  })

  it('rejects read exceptions that expose current or neighboring private Runner controls',async()=>{
    const other=join(root,'runners','other-execution');mkdirSync(other,{recursive:true,mode:0o700})
    for(const [index,path] of [join(root,'runners'),other].entries()){
      const input=spec('private-controls-'+index,"require('node:fs').writeFileSync('TARGET_WAS_LAUNCHED','bad')")
      input.containment!.readOnlyPaths=[...libraries,path]
      await client.start(input)
      const result=await terminal(input.executionId)
      expect(result.state).toBe('FAILED');expect(result.processId).toBeUndefined()
      expect(existsSync(join(cwd,'TARGET_WAS_LAUNCHED'))).toBe(false)
    }
  })

  it('honors a durable stop already present during preflight without launching the target',async()=>{
    const input=spec('preflight-stop',"require('node:fs').writeFileSync('TARGET_WAS_LAUNCHED','bad')")
    const dir=join(root,'runners',input.executionId);mkdirSync(dir,{recursive:true,mode:0o700})
    const token='a'.repeat(64)
    writeFileSync(join(dir,'request.json'),JSON.stringify({version:2,token,spec:input}),{mode:0o600})
    writeFileSync(join(dir,'stop.json'),JSON.stringify({version:1,token,reason:'Owned preflight cancellation'}),{mode:0o600})
    const child=spawn(process.execPath,[workerPath,'--request',join(dir,'request.json')],{stdio:'ignore',env:{PATH:process.env.PATH,HOME:root,LANG:'C'}})
    let timer:NodeJS.Timeout|undefined
    try{
      const exited=once(child,'exit')
      await Promise.race([exited,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Owned preflight worker did not exit'))},10000)})])
      expect(child.exitCode).toBe(0)
      const result=await client.status(input.executionId)
      expect(result.state).toBe('FAILED');expect(result.processId).toBeUndefined()
      expect(result.reason).toContain('interrupted before target launch')
      expect(existsSync(join(cwd,'TARGET_WAS_LAUNCHED'))).toBe(false)
    }finally{clearTimeout(timer);if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited}}
  },15000)

  it('keeps required containment proof across real target timeout and cancellation',async()=>{
    const input=spec('timeout',"setInterval(()=>{},100)");input.timeoutMs=200
    await client.start(input)
    const result=await terminal(input.executionId)
    expect(result.state).toBe('TIMED_OUT');expect(result.containment?.checks).toBe('passed')
    const cancel=spec('cancel',"setInterval(()=>{},100)")
    await client.start(cancel)
    const deadline=Date.now()+5000
    while(Date.now()<deadline&&(await client.status(cancel.executionId)).state!=='RUNNING')await delay(20)
    expect((await client.stop(cancel.executionId,'Owned cancellation')).accepted).toBe(true)
    expect((await terminal(cancel.executionId)).state).toBe('CANCELLED')
  },20000)
}else{
  it('does not launch a target when a required provider is unavailable',async()=>{
    const input=spec('unsupported',"require('node:fs').writeFileSync('TARGET_WAS_LAUNCHED','bad')")
    await client.start(input);expect((await terminal(input.executionId)).state).toBe('FAILED')
    expect(existsSync(join(cwd,'TARGET_WAS_LAUNCHED'))).toBe(false)
  })
}

it('preserves uncontained legacy-v1 observation and rejects silently upgrading its request',async()=>{
  const legacy=spec('legacy',"process.stdout.write('legacy')");delete legacy.containment
  await client.start(legacy);expect((await terminal(legacy.executionId)).version).toBe(1)
  const upgraded={...legacy,containment:{version:1 as const,mode:'required' as const,provider:'srt-macos' as const,readOnlyPaths:libraries,allowedDomains:[]}}
  await expect(client.start(upgraded)).rejects.toThrow('conflicts')
  expect((await client.status(legacy.executionId)).containment).toBeUndefined()
})
