/** Real compiled API process, default heartbeat window, durable CLI writes and graceful SIGTERM. */
import {spawn,execFileSync,type ChildProcess} from 'node:child_process'
import {once} from 'node:events'
import {mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {request,type ClientRequest,type IncomingMessage} from 'node:http'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {afterEach,beforeEach,expect,it} from 'vitest'

const CLI=resolve('dist/cli/index.js')
let root:string,dataDir:string,token:string
const children=new Set<ChildProcess>()
const connections=new Set<Stream>()
async function bounded<T>(promise:Promise<T>,ms=8000):Promise<T>{let timer:NodeJS.Timeout|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned API process timed out')),ms)})])}finally{clearTimeout(timer)}}
function cli(args:string[]):unknown {
  const output=execFileSync(process.execPath,[CLI,...args],{cwd:root,encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:root,LANG:'C'}})
  return JSON.parse(output)
}
beforeEach(()=>{
  root=realpathSync(mkdtempSync(join(tmpdir(),'compiled-change-stream-')));dataDir=join(root,'data')
  cli(['init','--data-dir',dataDir]);cli(['configure','--data-dir',dataDir,'--claude-command','/usr/bin/true']);cli(['api-init','--data-dir',dataDir])
  token=(JSON.parse(readFileSync(join(dataDir,'api-auth.json'),'utf8')) as {token:string}).token
})
async function stop(child:ChildProcess):Promise<void>{
  if(child.exitCode!==null||child.signalCode!==null)return
  const exited=once(child,'exit');child.kill('SIGTERM')
  try{await bounded(exited)}catch{child.kill('SIGKILL');await bounded(exited);throw new Error('Owned API required forced cleanup')}
}
afterEach(async()=>{
  for(const stream of connections)stream.close();connections.clear()
  for(const child of children){await stop(child)}children.clear()
  rmSync(root,{recursive:true,force:true})
})
async function start(){
  const child=spawn(process.execPath,[CLI,'api-serve','--data-dir',dataDir,'--port','0'],{cwd:root,stdio:['ignore','pipe','pipe'],env:{PATH:process.env.PATH,HOME:root,LANG:'C'}})
  children.add(child)
  let output='',errors=''
  child.stderr!.on('data',chunk=>{errors+=String(chunk)})
  const address=await bounded(new Promise<string>((resolveAddress,reject)=>{
    child.stdout!.on('data',chunk=>{
      output+=String(chunk)
      if(output.length>65536){reject(new Error('Owned API output exceeded bound'));return}
      for(const line of output.split('\n')){try{const row=JSON.parse(line) as {listening?:boolean;address?:string};if(row.listening&&row.address)resolveAddress(row.address)}catch{/* incomplete bounded startup line */}}
    })
    child.once('error',()=>reject(new Error('Owned API failed to launch')))
    child.once('exit',()=>reject(new Error('Owned API exited before readiness')))
  }))
  return {child,address,credentialsAbsent:()=>!(output+errors).includes(token)}
}
class Stream {
  private pending=''
  private readonly frames:string[]=[]
  private readonly waiters:Array<{resolve:(value:string)=>void;reject:()=>void;timer:NodeJS.Timeout}>=[]
  private ended=false
  private constructor(private readonly req:ClientRequest,private readonly response:IncomingMessage){
    response.setEncoding('utf8')
    response.on('data',(chunk:string)=>{
      this.pending+=chunk
      if(Buffer.byteLength(this.pending)>65536){this.close();return}
      for(let boundary=this.pending.indexOf('\n\n');boundary>=0;boundary=this.pending.indexOf('\n\n')){
        const frame=this.pending.slice(0,boundary);this.pending=this.pending.slice(boundary+2)
        const waiter=this.waiters.shift();if(waiter){clearTimeout(waiter.timer);waiter.resolve(frame)}else this.frames.push(frame)
      }
    })
    const finish=()=>{this.ended=true;for(const waiter of this.waiters.splice(0)){clearTimeout(waiter.timer);waiter.reject()}}
    response.once('close',finish);response.once('error',finish);req.once('error',finish)
  }
  static async open(address:string,cursor?:string):Promise<Stream>{
    return bounded(new Promise<Stream>((resolveStream,reject)=>{
      const headers=new Headers();headers.set('Authorization','Bearer '+token)
      if(cursor)headers.set('Last-Event-ID',cursor)
      const req=request(address+'/api/v1/events',{headers:Object.fromEntries(headers)},response=>{
        if(response.statusCode!==200){response.resume();reject(new Error('Owned API rejected stream'));return}
        const stream=new Stream(req,response);connections.add(stream);resolveStream(stream)
      });req.once('error',()=>reject(new Error('Owned stream did not connect')));req.end()
    }))
  }
  next(ms=3000):Promise<string>{
    const frame=this.frames.shift();if(frame!==undefined)return Promise.resolve(frame)
    if(this.ended)return Promise.reject(new Error('Owned stream ended'))
    return new Promise((resolveFrame,reject)=>{
      const waiter={resolve:resolveFrame,reject:()=>reject(new Error('Owned stream ended')),timer:setTimeout(()=>{
        const index=this.waiters.indexOf(waiter);if(index>=0)this.waiters.splice(index,1)
        reject(new Error('Owned stream frame timed out'))
      },ms)}
      this.waiters.push(waiter)
    })
  }
  close(){this.req.destroy();this.response.destroy();connections.delete(this)}
}

it('keeps default SSE alive across the normal socket timeout and exits gracefully with the stream open',async()=>{
  const api=await start(),stream=await Stream.open(api.address)
  expect(await stream.next()).toContain('event: reset')
  expect(await stream.next()).toContain('event: ready')
  // The ordinary API socket timeout and the default heartbeat interval are both 10s.
  expect(await stream.next(14000)).toBe(': heartbeat')
  const exited=once(api.child,'exit'),started=Date.now();api.child.kill('SIGTERM');await bounded(exited)
  expect(Date.now()-started).toBeLessThan(1400)
  expect(api.child.exitCode).toBe(0);expect(api.child.signalCode).toBeNull();expect(api.credentialsAbsent()).toBe(true)
},25000)

it('replays an external compiled CLI commit after an API process restart',async()=>{
  const first=await start(),original=await Stream.open(first.address)
  await original.next();const ready=await original.next()
  const cursor=ready.split('\n').find(line=>line.startsWith('id: '))!.slice(4)
  await stop(first.child)
  const file=join(root,'employee.json');writeFileSync(file,JSON.stringify({id:'external-cli-employee',name:'External CLI',role:'writer',responsibilities:['Docs'],capabilities:['documentation'],runtimeId:'claude-local',projectIds:[],maxConcurrency:1,timeoutMs:60000}),{mode:0o600})
  cli(['employee-create','--data-dir',dataDir,'--file',file])
  const second=await start(),resumed=await Stream.open(second.address,cursor)
  expect(await resumed.next()).toContain('"resourceId":"external-cli-employee"')
  expect(await resumed.next()).toContain('event: ready')
  expect(first.credentialsAbsent()&&second.credentialsAbsent()).toBe(true)
})
