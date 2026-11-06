import { once } from 'node:events'
import { createConnection, type AddressInfo } from 'node:net'
import Fastify,{type FastifyInstance} from 'fastify'
import {afterEach,expect,it} from 'vitest'
import {registerIdleConnectionCleanup} from '../src/api/idle-connections.ts'

const opened:FastifyInstance[]=[]
afterEach(async()=>{for(const app of opened.splice(0)){app.server.closeAllConnections();await app.close()}})
async function start(){const app=Fastify({logger:false});opened.push(app);registerIdleConnectionCleanup(app);return app}
async function bounded<T>(promise:Promise<T>):Promise<T>{let timer:NodeJS.Timeout|undefined;try{return await Promise.race([promise,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned API did not close')),1000)})])}finally{clearTimeout(timer)}}

it('closes an accepted TCP connection that never sent HTTP headers',async()=>{
  const app=await start();await app.listen({host:'127.0.0.1',port:0})
  const accepted=once(app.server,'connection')
  const client=createConnection({host:'127.0.0.1',port:(app.server.address() as AddressInfo).port})
  client.on('error',()=>{/* server closes its own unused connection */})
  const clientClosed=new Promise<void>(resolve=>client.once('close',()=>resolve()))
  try{await Promise.all([once(client,'connect'),accepted]);await bounded(app.close());await bounded(clientClosed)}
  finally{client.destroy()}
})

it('allows an already active HTTP handler to finish during graceful shutdown',async()=>{
  const app=await start();let enter!:()=>void,release!:()=>void
  const entered=new Promise<void>(resolve=>{enter=resolve}),released=new Promise<void>(resolve=>{release=resolve})
  app.get('/active',async()=>{enter();await released;return {completed:true}})
  await app.listen({host:'127.0.0.1',port:0})
  const response=fetch(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/active`,{signal:AbortSignal.timeout(3000)})
  await bounded(entered)
  const closing=app.close()
  release()
  expect(await (await response).json()).toEqual({completed:true})
  await bounded(closing)
})
