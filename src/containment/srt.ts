/** Fixed-version macOS OS boundary. The SRT singleton is owned by one dedicated Runner. */
import {createRequire} from 'node:module'
import {createHash} from 'node:crypto'
import {spawn} from 'node:child_process'
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {dirname,join,resolve,sep} from 'node:path'
import {tmpdir} from 'node:os'
import {cloneContainment,type ContainmentRequirement,type ContainmentEvidence} from './policy.ts'

const SYSTEM_READ_PATHS=['/System','/usr/lib','/usr/bin','/usr/share/locale','/bin','/sbin','/private/var/select/sh']
const DENIALS=['EPERM','EACCES','ENOENT']
const quote=(value:string)=>"'"+value.replaceAll("'","'\\''")+"'"
let active=false
export class ContainmentUncertainError extends Error { readonly code='CONTAINMENT_UNKNOWN'; constructor(){super('Containment helper termination could not be confirmed')} }

export interface PreparedContainment {
  evidence:ContainmentEvidence
  /** Private transient argv (may contain proxy credentials); never persist or log. */
  wrap(command:string,args:string[]):Promise<{command:string;args:string[]}>
  secrets():string[]
  tempDir:string
  assertIdentity():void
  close(preserveTemp?:boolean):Promise<void>
}

async function bounded<T>(promise:Promise<T>,ms:number,signal?:AbortSignal):Promise<T>{
  let timer:NodeJS.Timeout|undefined,abort:(()=>void)|undefined
  try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Containment operation timed out')),ms);abort=()=>reject(new Error('Containment preparation interrupted'));if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true})})])}
  finally{clearTimeout(timer);if(abort)signal?.removeEventListener('abort',abort)}
}

/** Fixed probe processes are always group-owned, bounded, and checked for terminal evidence. */
async function runProbe(command:string,args:string[],cwd:string,env:NodeJS.ProcessEnv,signal?:AbortSignal):Promise<Record<string,unknown>> {
  return await new Promise((resolveResult,reject)=>{
    const child=spawn(command,args,{cwd,env,detached:true,shell:false,stdio:['ignore','pipe','pipe']})
    let output='',bytes=0,failed=false
    const fail=()=>{failed=true;if(child.pid){try{process.kill(-child.pid,'SIGKILL')}catch{/* already exited */}}}
    const onAbort=()=>fail()
    if(signal?.aborted)fail();else signal?.addEventListener('abort',onAbort,{once:true})
    const deadline=setTimeout(fail,5000)
    const hard=setTimeout(()=>{fail();reject(new ContainmentUncertainError())},6500)
    child.stdout.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>32768)fail();else output+=chunk.toString('utf8')})
    child.stderr.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>32768)fail()})
    child.once('error',()=>{signal?.removeEventListener('abort',onAbort);clearTimeout(deadline);clearTimeout(hard);reject(new Error('Containment probe failed to start'))})
    child.once('close',(code,exitSignal)=>{
      signal?.removeEventListener('abort',onAbort);clearTimeout(deadline);clearTimeout(hard)
      if(child.pid){try{process.kill(-child.pid,0);fail();reject(new ContainmentUncertainError());return}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH'){reject(new ContainmentUncertainError());return}}}
      if(failed||code!==0||exitSignal){reject(new Error('Containment negative probe failed'));return}
      try{const result=JSON.parse(output) as Record<string,unknown>;resolveResult(result)}catch{reject(new Error('Containment probe returned invalid evidence'))}
    })
  })
}

export async function prepareContainment(cwd:string,input:ContainmentRequirement,signal?:AbortSignal):Promise<PreparedContainment> {
  const requirement=cloneContainment(input)
  if(signal?.aborted)throw new Error('Containment preparation interrupted')
  if(process.platform!=='darwin')throw new Error('Required containment provider is unavailable on this platform')
  if(active)throw new Error('Containment requires a dedicated Runner process')
  if(realpathSync(cwd)!==cwd)throw new Error('Containment working directory must be canonical')
  const identity=lstatSync(cwd)
  if(!identity.isDirectory()||identity.isSymbolicLink())throw new Error('Invalid containment working directory')
  const readPaths=requirement.readOnlyPaths.map(path=>realpathSync(path))
  // Never turn the execution's parent/root into a broad read exception.
  if(readPaths.some(path=>path==='/'||cwd===path||cwd.startsWith(path+sep)))throw new Error('Containment read exception overlaps the execution boundary')
  active=true
  let manager:typeof import('@anthropic-ai/sandbox-runtime')['SandboxManager']|undefined
  let closed=false
  let initialization:Promise<void>|undefined
  let inside='',sibling='',outside='',tempDir=''
  const assertIdentity=()=>{
    const now=lstatSync(cwd)
    if(realpathSync(cwd)!==cwd||!now.isDirectory()||now.isSymbolicLink()||now.dev!==identity.dev||now.ino!==identity.ino)throw new Error('Containment working directory identity changed')
  }
  const close=async(preserveTemp=false)=>{
    if(closed)return
    closed=true
    let confirmed=false
    try{
      if(initialization)await bounded(initialization.catch(()=>undefined),1000)
      if(manager)await bounded(manager.reset(),1500)
      confirmed=true
    }catch{throw new ContainmentUncertainError()}finally{
      active=!confirmed
      if(confirmed&&!preserveTemp)for(const path of [inside,sibling,outside,tempDir].filter(Boolean))rmSync(path,{recursive:true,force:true})
    }
  }
  try{
    inside=mkdtempSync(join(cwd,'.workforce-probe-'));sibling=mkdtempSync(join(dirname(cwd),'.workforce-probe-sibling-'))
    outside=realpathSync(mkdtempSync(join(tmpdir(),'workforce-probe-outside-')));tempDir=mkdtempSync(join(cwd,'.workforce-runtime-temp-'))
    const installed=JSON.parse(readFileSync(createRequire(import.meta.url).resolve('@anthropic-ai/sandbox-runtime/package.json'),'utf8')) as {version?:unknown}
    if(installed.version!=='0.0.81')throw new Error('Unsupported containment provider version')
    const library=await import('@anthropic-ai/sandbox-runtime')
    manager=library.SandboxManager
    const safeDevices=new Set(['/dev/stdout','/dev/stderr','/dev/null'])
    const defaultWriteDenies=library.getDefaultWritePaths().filter(path=>!safeDevices.has(path)).map(path=>({path,literal:true as const}))
    const policy={network:{allowedDomains:[...requirement.allowedDomains],deniedDomains:[],strictAllowlist:true,allowLocalBinding:false,deniedResolvedAddresses:['0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16','224.0.0.0/4','::/128','::1/128','fc00::/7','fe80::/10','ff00::/8']},filesystem:{denyRead:[{path:'/',literal:true as const}],allowRead:[cwd,...SYSTEM_READ_PATHS,...readPaths,realpathSync(process.execPath)].map(path=>({path,literal:true as const})),allowWrite:[{path:cwd,literal:true as const}],denyWrite:defaultWriteDenies}}
    // No user SRT config, no logging monitor, no interactive approval callback.
    initialization=manager.initialize(policy,undefined,false)
    await bounded(initialization,8000,signal)
    const wrap=async(command:string,args:string[])=>{
      if(closed)throw new Error('Containment session is closed')
      assertIdentity()
      const result=await bounded(manager!.wrapWithSandboxArgv(['/usr/bin/env','TMPDIR='+tempDir,'TMP='+tempDir,'TEMP='+tempDir,command,...args].map(quote).join(' '),'/bin/sh',undefined,signal,cwd),3000,signal)
      // result.env is process.env on macOS. Never forward it: it contains the private Runner channel.
      if(result.argv[0]!=='/bin/sh'||result.argv[1]!=='-c'||result.argv.length!==3)throw new Error('Unexpected containment launcher')
      return {command:result.argv[0],args:result.argv.slice(1)}
    }
    for(const path of [sibling,outside])writeFileSync(join(path,'sentinel'),'owned probe sentinel',{mode:0o600})
    symlinkSync(outside,join(inside,'outside-link'))
    const code=`const fs=require('node:fs'),cp=require('node:child_process');const p=JSON.parse(process.argv[1]);const denied=fn=>{try{fn();return false}catch(e){return ${JSON.stringify(DENIALS)}.includes(e.code)}};const r={};fs.writeFileSync(p.inside+'/positive','positive');r.inside=fs.readFileSync(p.inside+'/positive','utf8')==='positive';for(const [name,path] of [['outside',p.outside],['sibling',p.sibling],['symlink',p.inside+'/outside-link']]){r[name+'Read']=denied(()=>fs.readFileSync(path+'/sentinel'));r[name+'Write']=denied(()=>fs.writeFileSync(path+'/sentinel','modified'));r[name+'Create']=denied(()=>fs.writeFileSync(path+'/new','modified'))};const child=cp.spawnSync(process.execPath,['-e',"try{require('node:fs').readFileSync("+JSON.stringify(p.outside+'/sentinel')+");process.exit(7)}catch(e){process.exit("+JSON.stringify(${JSON.stringify(DENIALS)})+".includes(e.code)?0:8)}"],{timeout:1500});r.descendant=child.status===0;process.stdout.write(JSON.stringify(r));`
    const wrapped=await wrap(process.execPath,['-e',code,JSON.stringify({inside,outside,sibling})])
    const report=await runProbe(wrapped.command,wrapped.args,cwd,{PATH:'/usr/bin:/bin',HOME:outside,TMPDIR:tempDir,LANG:'C'},signal)
    const expected=['inside','outsideRead','outsideWrite','outsideCreate','siblingRead','siblingWrite','siblingCreate','symlinkRead','symlinkWrite','symlinkCreate','descendant']
    if(Object.keys(report).length!==expected.length||expected.some(key=>report[key]!==true)
      ||[outside,sibling].some(path=>readFileSync(join(path,'sentinel'),'utf8')!=='owned probe sentinel'||existsSync(join(path,'new'))))throw new Error('Containment negative probe did not establish the required boundary')
    assertIdentity()
    for(const path of [inside,sibling,outside])rmSync(path,{recursive:true,force:true})
    const evidence:ContainmentEvidence=Object.freeze({version:1,provider:'srt-macos',providerVersion:'0.0.81',policySha256:createHash('sha256').update(JSON.stringify({requested:policy,effectiveRead:manager.getFsReadConfig(),effectiveWrite:manager.getFsWriteConfig()})).digest('hex'),worktreeDevice:identity.dev,worktreeInode:identity.ino,verifiedAt:new Date().toISOString(),checks:'passed'})
    return {evidence,wrap,tempDir,assertIdentity,secrets:()=>{const token=manager!.getProxyAuthToken();return token?[token]:[]},close}
  }catch(error){
    await close(error instanceof ContainmentUncertainError)
    if(error instanceof ContainmentUncertainError)throw error
    throw new Error('Required containment could not be established; target was not launched')
  }
}
