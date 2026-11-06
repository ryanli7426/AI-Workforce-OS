import { createConnection, type AddressInfo } from 'node:net'
import {
  request as httpRequest,
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
} from 'node:http'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { registerChangeStream } from '../src/api/change-stream.ts'
import {
  ChangeFeedInputError,
  type ChangeFeedEvent,
  type ChangeFeedPage,
  type ChangeFeedReader,
} from '../src/events/change-feed.ts'

const TEST_AUTH_HEADER = 'test-authenticated-owner'
const AT = '2026-11-05T12:00:00.000Z'

interface RunningApp {
  app: FastifyInstance
  port: number
}

interface TestStream {
  response: IncomingMessage
  request: ClientRequest
  nextFrame(timeoutMs?: number): Promise<string>
  closed: Promise<void>
  text(): string
  abort(): void
}

const runningApps = new Set<FastifyInstance>()
const streams = new Set<TestStream>()

afterEach(async () => {
  for (const stream of streams) stream.abort()
  streams.clear()
  await Promise.allSettled([...runningApps].map(app => app.close()))
  runningApps.clear()
})

function initialPage(cursor = 'cursor-0'): ChangeFeedPage {
  return {
    changes: [],
    cursor,
    hasMore: false,
    reset: { cursor, reason: 'initial' },
  }
}

function emptyPage(cursor: string): ChangeFeedPage {
  return { changes: [], cursor, hasMore: false }
}

function event(cursor: string, resourceId: string, ticketId?: string): ChangeFeedEvent {
  return {
    cursor,
    notice: {
      entity: ticketId === undefined ? 'project' : 'execution',
      resourceId,
      ...(ticketId === undefined ? {} : { ticketId }),
      at: AT,
    },
  }
}

function functionReader(
  implementation: (input: { cursor?: string; limit?: number }) => ChangeFeedPage,
): ChangeFeedReader & { calls: Array<{ cursor?: string; limit?: number }> } {
  const calls: Array<{ cursor?: string; limit?: number }> = []
  return {
    calls,
    readPage(input = {}) {
      calls.push({ ...input })
      return implementation(input)
    },
  }
}

async function startApp(
  reader: ChangeFeedReader,
  options: {
    pollIntervalMs?: number
    heartbeatMs?: number
    maxConnections?: number
    beforeRegister?: (app: FastifyInstance) => void
  } = {},
): Promise<RunningApp> {
  const app = Fastify({ logger: false })
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    if (request.headers.authorization !== TEST_AUTH_HEADER) {
      return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
    }
  })
  options.beforeRegister?.(app)
  registerChangeStream(app, {
    reader,
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  runningApps.add(app)
  const address = app.server.address() as AddressInfo
  return { app, port: address.port }
}

function openStream(
  port: number,
  options: { path?: string; authorization?: boolean; lastEventId?: string; rawHeaders?: OutgoingHttpHeaders } = {},
): Promise<TestStream> {
  return new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = options.rawHeaders ?? {
      ...(options.authorization === false ? {} : { authorization: TEST_AUTH_HEADER }),
      ...(options.lastEventId === undefined ? {} : { 'last-event-id': options.lastEventId }),
    }
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: options.path ?? '/api/v1/events',
      headers,
    }, response => {
      let pending = ''
      let completeText = ''
      let ended = false
      const frames: string[] = []
      const waiters: Array<{
        resolve(frame: string): void
        reject(error: Error): void
        timer: NodeJS.Timeout
      }> = []

      const deliver = (): void => {
        while (frames.length > 0 && waiters.length > 0) {
          const waiter = waiters.shift()!
          clearTimeout(waiter.timer)
          waiter.resolve(frames.shift()!)
        }
      }

      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        completeText += chunk
        pending += chunk
        let boundary = pending.indexOf('\n\n')
        while (boundary >= 0) {
          frames.push(pending.slice(0, boundary))
          pending = pending.slice(boundary + 2)
          boundary = pending.indexOf('\n\n')
        }
        deliver()
      })

      let resolveClosed!: () => void
      const closed = new Promise<void>(closedResolve => { resolveClosed = closedResolve })
      const finish = (): void => {
        if (ended) return
        ended = true
        resolveClosed()
        for (const waiter of waiters.splice(0)) {
          clearTimeout(waiter.timer)
          waiter.reject(new Error('stream closed'))
        }
      }
      response.once('end', finish)
      response.once('close', finish)
      response.once('error', finish)

      const stream: TestStream = {
        response,
        request,
        closed,
        text: () => completeText,
        nextFrame(timeoutMs = 1_500) {
          if (frames.length > 0) return Promise.resolve(frames.shift()!)
          if (ended) return Promise.reject(new Error('stream closed'))
          return new Promise<string>((frameResolve, frameReject) => {
            const waiter = {
              resolve: frameResolve,
              reject: frameReject,
              timer: setTimeout(() => {
                const index = waiters.indexOf(waiter)
                if (index >= 0) waiters.splice(index, 1)
                frameReject(new Error('timed out waiting for SSE frame'))
              }, timeoutMs),
            }
            waiters.push(waiter)
          })
        },
        abort() {
          request.destroy()
          response.destroy()
        },
      }
      streams.add(stream)
      resolve(stream)
    })
    request.once('error', reject)
    request.end()
  })
}

function requestOnce(
  port: number,
  options: { path?: string; authorization?: boolean; rawHeaders?: OutgoingHttpHeaders } = {},
): Promise<{ statusCode: number; headers: IncomingMessage['headers']; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: OutgoingHttpHeaders = options.rawHeaders ?? {
      ...(options.authorization === false ? {} : { authorization: TEST_AUTH_HEADER }),
    }
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'GET',
      path: options.path ?? '/api/v1/events',
      headers,
    }, response => {
      response.setEncoding('utf8')
      let body = ''
      response.on('data', (chunk: string) => { body += chunk })
      response.once('end', () => resolve({
        statusCode: response.statusCode ?? 0,
        headers: response.headers,
        body,
      }))
    })
    request.once('error', reject)
    request.end()
  })
}

function jsonError(code: string, message: string): string {
  return JSON.stringify({ error: { code, message } })
}

async function waitFor(check: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition timed out')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

describe('registerChangeStream', () => {
  it('runs parent authentication before reading or sending stream data', async () => {
    const reader = functionReader(() => initialPage())
    const { port } = await startApp(reader)

    const unauthorized = await requestOnce(port, { authorization: false })
    expect(unauthorized.statusCode).toBe(401)
    expect(unauthorized.body).toBe(jsonError('UNAUTHORIZED', 'Unauthorized'))
    expect(unauthorized.body).not.toContain('event:')
    expect(reader.calls).toEqual([])

    const stream = await openStream(port)
    expect(stream.response.statusCode).toBe(200)
    expect(stream.response.headers['content-type']).toBe('text/event-stream;charset=utf-8')
    expect(stream.response.headers['cache-control']).toBe('no-store')
    expect(stream.response.headers['x-content-type-options']).toBe('nosniff')
    expect(stream.response.headers['x-accel-buffering']).toBe('no')
    expect(stream.response.headers['content-encoding']).toBe('identity')
    expect(await stream.nextFrame()).toBe('event: reset\nid: cursor-0\ndata: {"reason":"initial"}')
    expect(await stream.nextFrame()).toBe('event: ready\nid: cursor-0\ndata: {}')
    expect(reader.calls[0]).toEqual({ limit: 100 })
    stream.abort()
  })

  it('drains every resumable backlog page in order before announcing ready', async () => {
    const reader = functionReader(input => {
      if (input.cursor === 'cursor-0') {
        return {
          changes: [
            event('cursor-1', 'execution-1', 'ticket-1'),
            event('cursor-2', 'project-1'),
          ],
          cursor: 'cursor-2',
          hasMore: true,
        }
      }
      if (input.cursor === 'cursor-2') {
        return {
          changes: [event('cursor-3', 'execution-2', 'ticket-2')],
          cursor: 'cursor-3',
          hasMore: false,
        }
      }
      return emptyPage(input.cursor ?? 'cursor-3')
    })
    const { port } = await startApp(reader, { pollIntervalMs: 100, heartbeatMs: 500 })
    const stream = await openStream(port, { lastEventId: 'cursor-0' })

    expect(await stream.nextFrame()).toBe(
      `event: change\nid: cursor-1\ndata: ${JSON.stringify(event('cursor-1', 'execution-1', 'ticket-1').notice)}`,
    )
    expect(await stream.nextFrame()).toBe(
      `event: change\nid: cursor-2\ndata: ${JSON.stringify(event('cursor-2', 'project-1').notice)}`,
    )
    expect(await stream.nextFrame()).toBe(
      `event: change\nid: cursor-3\ndata: ${JSON.stringify(event('cursor-3', 'execution-2', 'ticket-2').notice)}`,
    )
    expect(await stream.nextFrame()).toBe('event: ready\nid: cursor-3\ndata: {}')
    expect(reader.calls.slice(0, 2)).toEqual([
      { cursor: 'cursor-0', limit: 100 },
      { cursor: 'cursor-2', limit: 100 },
    ])
    stream.abort()
  })

  it('emits reset then ready at the reset head for an expired resumable cursor', async () => {
    const reader = functionReader(input => input.cursor === 'expired-cursor'
      ? {
          changes: [],
          cursor: 'current-head',
          hasMore: false,
          reset: { cursor: 'current-head', reason: 'expired' },
        }
      : emptyPage(input.cursor ?? 'current-head'))
    const { port } = await startApp(reader)
    const stream = await openStream(port, { lastEventId: 'expired-cursor' })

    expect(await stream.nextFrame()).toBe('event: reset\nid: current-head\ndata: {"reason":"expired"}')
    expect(await stream.nextFrame()).toBe('event: ready\nid: current-head\ndata: {}')
    stream.abort()
  })

  it('returns static HTTP errors before hijack for duplicate, malformed, unknown, and rejected cursors', async () => {
    const reader = functionReader(input => {
      if (input.cursor === 'rejected-cursor') throw new ChangeFeedInputError()
      return initialPage()
    })
    const { port } = await startApp(reader)

    const duplicate = await requestOnce(port, {
      rawHeaders: {
        authorization: TEST_AUTH_HEADER,
        'last-event-id': ['cursor-1', 'cursor-2'],
      },
    })
    expect(duplicate.statusCode).toBe(400)
    expect(duplicate.body).toBe(jsonError('INVALID_REQUEST', 'Invalid request'))

    const malformed = await requestOnce(port, {
      rawHeaders: { authorization: TEST_AUTH_HEADER, 'last-event-id': 'bad cursor' },
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.body).toBe(jsonError('INVALID_REQUEST', 'Invalid request'))

    const unknown = await requestOnce(port, { path: '/api/v1/events?token=secret' })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.body).toBe(jsonError('INVALID_REQUEST', 'Invalid request'))
    expect(unknown.body).not.toContain('secret')

    const rejected = await requestOnce(port, {
      rawHeaders: { authorization: TEST_AUTH_HEADER, 'last-event-id': 'rejected-cursor' },
    })
    expect(rejected.statusCode).toBe(400)
    expect(rejected.body).toBe(jsonError('INVALID_REQUEST', 'Invalid request'))
    expect([duplicate, malformed, unknown, rejected].every(result => result.headers['cache-control'] === 'no-store')).toBe(true)
    expect(reader.calls).toEqual([{ cursor: 'rejected-cursor', limit: 100 }])
  })

  it('sanitizes initial reader failures and disconnects on later reader failures', async () => {
    const secret = 'database path /private/secret and token=abc'
    const initialFailure = functionReader(() => { throw new Error(secret) })
    const initial = await startApp(initialFailure)
    const response = await requestOnce(initial.port)
    expect(response.statusCode).toBe(500)
    expect(response.body).toBe(jsonError('INTERNAL_ERROR', 'Internal server error'))
    expect(response.body).not.toContain(secret)

    let calls = 0
    const laterFailure = functionReader(input => {
      calls += 1
      if (calls === 1) return initialPage('head')
      throw new Error(secret)
    })
    const later = await startApp(laterFailure, { pollIntervalMs: 10, heartbeatMs: 500 })
    const stream = await openStream(later.port)
    expect(await stream.nextFrame()).toContain('event: reset')
    expect(await stream.nextFrame()).toContain('event: ready')
    await stream.closed
    expect(stream.text()).not.toContain(secret)
    expect(stream.text()).not.toContain('event: error')
    expect(laterFailure.calls[1]).toEqual({ cursor: 'head', limit: 100 })
  })

  it('sends idle heartbeats, enforces connection bounds, and releases a slot after client abort', async () => {
    const reader = functionReader(input => input.cursor === undefined
      ? initialPage('head')
      : emptyPage(input.cursor))
    const { port } = await startApp(reader, {
      pollIntervalMs: 100,
      heartbeatMs: 20,
      maxConnections: 1,
    })

    const first = await openStream(port)
    expect(await first.nextFrame()).toContain('event: reset')
    expect(await first.nextFrame()).toContain('event: ready')

    const full = await requestOnce(port)
    expect(full.statusCode).toBe(429)
    expect(full.body).toBe(jsonError('TOO_MANY_REQUESTS', 'Too many requests'))

    expect(await first.nextFrame()).toBe(': heartbeat')
    first.abort()
    await first.closed
    await new Promise(resolve => setTimeout(resolve, 10))

    const replacement = await openStream(port)
    expect(replacement.response.statusCode).toBe(200)
    expect(await replacement.nextFrame()).toContain('event: reset')
    expect(await replacement.nextFrame()).toContain('event: ready')
    replacement.abort()
  })

  it('disconnects a response that remains backpressured and makes its slot reusable', async () => {
    const reader = functionReader(input => input.cursor === undefined
      ? initialPage('head')
      : emptyPage(input.cursor))
    let blockedOnce = false
    const { port } = await startApp(reader, {
      pollIntervalMs: 100,
      heartbeatMs: 100,
      maxConnections: 1,
      beforeRegister(app) {
        app.addHook('preHandler', async (request, reply) => {
          if (request.url !== '/api/v1/events' || blockedOnce) return
          blockedOnce = true
          const raw = reply.raw
          const originalWrite = raw.write.bind(raw)
          Object.defineProperty(raw, 'writableNeedDrain', {
            configurable: true,
            get: () => true,
          })
          raw.write = ((...args: Parameters<typeof raw.write>) => {
            originalWrite(...args)
            return false
          }) as typeof raw.write
        })
      },
    })

    const blocked = createConnection({ host: '127.0.0.1', port })
    blocked.on('error', () => { /* intentional transport teardown */ })
    blocked.write([
      'GET /api/v1/events HTTP/1.1',
      `Host: 127.0.0.1:${port}`,
      'Authorization: test-authenticated-owner',
      'Connection: close',
      '',
      '',
    ].join('\r\n'))
    await waitFor(() => reader.calls.length === 1)
    await new Promise(resolve => setTimeout(resolve, 1_100))

    const replacement = await openStream(port)
    expect(replacement.response.statusCode).toBe(200)
    expect(await replacement.nextFrame()).toContain('event: reset')
    expect(await replacement.nextFrame()).toContain('event: ready')
    expect(reader.calls).toHaveLength(2)
    replacement.abort()
    blocked.destroy()
  }, 5_000)

  it('preClose aborts an open stream and a blocked drain before server shutdown completes', async () => {
    const reader = functionReader(() => initialPage('head'))
    const { app, port } = await startApp(reader, {
      beforeRegister(fastify) {
        fastify.addHook('preHandler', async (request, reply: FastifyReply) => {
          if (request.url !== '/api/v1/events') return
          const raw = reply.raw
          const originalWrite = raw.write.bind(raw)
          Object.defineProperty(raw, 'writableNeedDrain', {
            configurable: true,
            get: () => true,
          })
          raw.write = ((...args: Parameters<typeof raw.write>) => {
            originalWrite(...args)
            return false
          }) as typeof raw.write
        })
      },
    })
    const stream = await openStream(port)
    expect(stream.response.statusCode).toBe(200)

    const closed = app.close()
    await expect(Promise.race([
      closed.then(() => 'closed'),
      new Promise<string>(resolve => setTimeout(() => resolve('timeout'), 500)),
    ])).resolves.toBe('closed')
    runningApps.delete(app)
    await stream.closed
  })

  it('rejects unsafe registration configuration synchronously', () => {
    const app = Fastify({ logger: false })
    runningApps.add(app)
    const reader = functionReader(() => initialPage())

    expect(() => registerChangeStream(app, { reader, pollIntervalMs: 0 })).toThrow('pollIntervalMs')
    expect(() => registerChangeStream(app, { reader, heartbeatMs: 300_001 })).toThrow('heartbeatMs')
    expect(() => registerChangeStream(app, { reader, maxConnections: 0 })).toThrow('maxConnections')
    expect(() => registerChangeStream(app, { reader: {} as ChangeFeedReader })).toThrow('reader')
    expect(reader.calls).toEqual([])
  })
  it('keeps heartbeat deadlines across empty polls and outlives the ordinary socket timeout',async()=>{
    const reader=functionReader(input=>input.cursor===undefined?initialPage('head'):emptyPage(input.cursor))
    const {port}=await startApp(reader,{pollIntervalMs:10,heartbeatMs:40,beforeRegister(app){app.server.setTimeout(20)}})
    const stream=await openStream(port)
    expect(await stream.nextFrame()).toContain('event: reset')
    expect(await stream.nextFrame()).toContain('event: ready')
    expect(await stream.nextFrame(500)).toBe(': heartbeat')
    expect(await stream.nextFrame(500)).toBe(': heartbeat')
    expect(reader.calls.length).toBeGreaterThan(2)
    stream.abort()
  })
  it('does not expose a streaming HEAD route or consume its reader',async()=>{
    const reader=functionReader(()=>initialPage())
    const {port}=await startApp(reader)
    const result=await fetch(`http://127.0.0.1:${port}/api/v1/events`,{method:'HEAD',headers:{Authorization:TEST_AUTH_HEADER},signal:AbortSignal.timeout(1000)})
    expect(result.status).toBe(404)
    expect(await result.text()).toBe('')
    expect(reader.calls).toEqual([])
  })

})
