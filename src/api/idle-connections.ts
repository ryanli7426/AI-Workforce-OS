/** Close this server's unused TCP preconnections during shutdown, preserving active HTTP work. */
import type { FastifyInstance } from 'fastify'
import type { Socket } from 'node:net'
import type { IncomingMessage } from 'node:http'

export function registerIdleConnectionCleanup(app:FastifyInstance):void {
  const pending=new Set<Socket>()
  let closing=false
  const onConnection=(socket:Socket):void=>{
    if(closing){socket.destroy();return}
    pending.add(socket)
    socket.once('close',()=>pending.delete(socket))
  }
  const onRequest=(request:IncomingMessage):void=>{pending.delete(request.socket)}
  // Mark accepted sockets before the HTTP parser can deliver their first request.
  app.server.prependListener('connection',onConnection)
  app.server.prependListener('request',onRequest)
  app.addHook('preClose',async()=>{
    closing=true
    for(const socket of pending)socket.destroy()
    pending.clear()
  })
  app.addHook('onClose',async()=>{
    app.server.off('connection',onConnection)
    app.server.off('request',onRequest)
  })
}
