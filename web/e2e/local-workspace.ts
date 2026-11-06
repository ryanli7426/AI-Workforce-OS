/** Owned local browser fixture. No Runtime/model launch or business data access. */
import { spawn, execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createLocalApiCredentials } from '../../src/api/auth.ts'
import { createSettings, defaultSettings } from '../../src/config/settings.ts'
import { initializeApplicationSchema } from '../../src/storage/application-store.ts'
import { LocalStore } from '../../src/storage/store.ts'
export async function localWorkspace(prepare?: (fixture: {root:string;dataDir:string;repositoryPath:string}) => void | Promise<void>) {
 const root=realpathSync(mkdtempSync(join(tmpdir(),'workforce-managed-browser-')));chmodSync(root,0o700)
 const dataDir=join(root,'data');mkdirSync(dataDir,{mode:0o700})
 const repositoryPath=join(root,'repository');mkdirSync(repositoryPath,{mode:0o700})
 const env={PATH:process.env.PATH,HOME:root,LANG:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}
 for(const args of [['init'],['config','user.name','Management Test'],['config','user.email','browser@example.invalid']]) execFileSync('git',args,{cwd:repositoryPath,env,stdio:'ignore',timeout:10_000})
 writeFileSync(join(repositoryPath,'README.md'),'Management browser fixture\n')
 for(const args of [['add','README.md'],['commit','-m','fixture']]) execFileSync('git',args,{cwd:repositoryPath,env,stdio:'ignore',timeout:10_000})
 const store=new LocalStore(join(dataDir,'workforce.sqlite'))
 try {initializeApplicationSchema(store)} finally {store.close()}
 createSettings(join(dataDir,'settings.json'),defaultSettings({ownerId:'browser-owner',claudeCommand:'/usr/bin/true'}))
 createLocalApiCredentials(dataDir)
 await prepare?.({root,dataDir,repositoryPath})
 const token=(JSON.parse(readFileSync(join(dataDir,'api-auth.json'),'utf8')) as {token:string}).token
 let stdout='',stderr='',startupOutput=''
 const launch=(port:string)=>{
  const processHandle=spawn(process.execPath,[resolve('dist/cli/index.js'),'api-serve','--data-dir',dataDir,'--port',port,'--web-root',resolve('web/dist')],{cwd:root,env:{PATH:process.env.PATH,HOME:root,LANG:'C'},stdio:['ignore','pipe','pipe']})
  processHandle.stdout.on('data',data=>{const value=String(data);stdout+=value;startupOutput+=value})
  processHandle.stderr.on('data',data=>{stderr+=String(data)})
  return processHandle
 }
 let child=launch('0')
 const stop=async(options:{preserveData?:boolean}={})=>{
  if(child.exitCode===null&&child.signalCode===null){
   const exited=once(child,'exit');child.kill('SIGTERM');let timer:ReturnType<typeof setTimeout>|undefined
   try{await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned API did not stop')),8_000)})])}finally{clearTimeout(timer)}
  }
  if(!options.preserveData)rmSync(root,{recursive:true,force:true})
 }
 const waitAddress=async()=>{
  const deadline=Date.now()+12_000
  while(Date.now()<deadline&&child.exitCode===null&&child.signalCode===null){
   for(const line of startupOutput.split('\n')){try{const row=JSON.parse(line) as {listening?:boolean;address?:string};if(row.listening&&row.address)return row.address}catch{/* incomplete bounded startup line */}}
   await new Promise(resolve=>setTimeout(resolve,25))
  }
  throw new Error('Owned management API did not start')
 }
 let address:string
 try{address=await waitAddress()}catch(error){await stop();throw error}
 const restart=async()=>{
  if(child.exitCode===null&&child.signalCode===null)throw new Error('Stop the owned API before restart')
  startupOutput='';child=launch(new URL(address).port)
  const resumed=await waitAddress()
  if(resumed!==address)throw new Error('Owned API changed its listening address')
 }
 const request=async(path:string)=>{
  const response=await fetch(`${address}/api/v1${path}`,{headers:{Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(5_000)})
  if(response.status!==200)throw new Error('Owned fixture query failed')
  return await response.json() as unknown
 }
 return {address,token,dataDir,repositoryPath,worktreeRoot:join(root,'worktrees'),request,stop,restart,credentialAbsentFromOutput:()=>!(stdout+stderr).includes(token)}
}
