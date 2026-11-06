/** Authenticated SSE projection of the durable change-feed reader. */
import type { ServerResponse } from 'node:http'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  CHANGE_ENTITIES,
  ChangeFeedInputError,
  type ChangeFeedEvent,
  type ChangeFeedPage,
  type ChangeFeedReader,
  type ChangeNotice,
  type ChangeResetReason,
} from '../events/change-feed.ts'

const DEFAULT_POLL_INTERVAL_MS = 250
const DEFAULT_HEARTBEAT_MS = 10_000
const DEFAULT_MAX_CONNECTIONS = 8
const READ_LIMIT = 100
const MAX_CURSOR_BYTES = 1024
const MAX_ID_BYTES = 128
const MAX_FRAME_BYTES = 64 * 1024
const MAX_QUEUED_BYTES = 128 * 1024
const DRAIN_TIMEOUT_MS = 1_000
const MAX_POLL_INTERVAL_MS = 60_000
const MAX_HEARTBEAT_MS = 300_000
const MAX_CONNECTIONS_LIMIT = 1024
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/
const TEXT_VALUE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const ENTITY_SET = new Set<string>(CHANGE_ENTITIES)
const RESET_REASONS = new Set<string>(['initial', 'expired', 'replaced', 'future'])

interface RegisterChangeStreamOptions {
  reader: ChangeFeedReader
  pollIntervalMs?: number
  heartbeatMs?: number
  maxConnections?: number
}

interface ApiErrorBody {
  error: { code: string; message: string }
}

interface ValidatedReset {
  cursor: string
  reason: ChangeResetReason
}

interface ValidatedPage {
  changes: ChangeFeedEvent[]
  cursor: string
  hasMore: boolean
  reset?: ValidatedReset
}

interface ActiveSession {
  stop(destroy: boolean): void
  done: Promise<void>
}

class InvalidRequest extends Error {}
class InvalidSource extends Error {}
class StreamClosed extends Error {}

function requirePositiveInteger(value: unknown, fallback: number, maximum: number, label: string): number {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    throw new Error(`Invalid ${label}`)
  }
  return value as number
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new InvalidSource()
  return value as Record<string, unknown>
}

function requireOnlyFields(value: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields)
  if (Object.keys(value).some(field => !allowed.has(field))) throw new InvalidSource()
}

function requireCursor(value: unknown): string {
  if (
    typeof value !== 'string'
    || !PRINTABLE_ASCII.test(value)
    || Buffer.byteLength(value, 'ascii') > MAX_CURSOR_BYTES
  ) {
    throw new InvalidSource()
  }
  return value
}

function requireInputCursor(value: unknown): string {
  try {
    return requireCursor(value)
  } catch {
    throw new InvalidRequest()
  }
}

function requireText(value: unknown): string {
  if (
    typeof value !== 'string'
    || !TEXT_VALUE.test(value)
    || Buffer.byteLength(value, 'utf8') > MAX_ID_BYTES
  ) {
    throw new InvalidSource()
  }
  return value
}

function requireTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) throw new InvalidSource()
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new InvalidSource()
  return value
}

function validateNotice(value: unknown): ChangeNotice {
  const raw = requireObject(value)
  const hasTicketId = Object.hasOwn(raw, 'ticketId')
  requireOnlyFields(raw, hasTicketId
    ? ['entity', 'resourceId', 'ticketId', 'at']
    : ['entity', 'resourceId', 'at'])
  if (typeof raw.entity !== 'string' || !ENTITY_SET.has(raw.entity)) throw new InvalidSource()
  const entity = raw.entity as ChangeNotice['entity']
  const resourceId = requireText(raw.resourceId)
  const at = requireTimestamp(raw.at)
  return hasTicketId
    ? { entity, resourceId, ticketId: requireText(raw.ticketId), at }
    : { entity, resourceId, at }
}

function validateEvent(value: unknown): ChangeFeedEvent {
  const raw = requireObject(value)
  requireOnlyFields(raw, ['cursor', 'notice'])
  return { cursor: requireCursor(raw.cursor), notice: validateNotice(raw.notice) }
}

function validateReset(value: unknown): ValidatedReset {
  const raw = requireObject(value)
  requireOnlyFields(raw, ['cursor', 'reason'])
  if (typeof raw.reason !== 'string' || !RESET_REASONS.has(raw.reason)) throw new InvalidSource()
  return { cursor: requireCursor(raw.cursor), reason: raw.reason as ChangeResetReason }
}

function validatePage(value: unknown): ValidatedPage {
  const raw = requireObject(value)
  const hasReset = Object.hasOwn(raw, 'reset')
  requireOnlyFields(raw, hasReset ? ['changes', 'cursor', 'hasMore', 'reset'] : ['changes', 'cursor', 'hasMore'])
  if (!Array.isArray(raw.changes) || raw.changes.length > READ_LIMIT) throw new InvalidSource()
  if (typeof raw.hasMore !== 'boolean') throw new InvalidSource()
  const page: ValidatedPage = {
    changes: raw.changes.map(validateEvent),
    cursor: requireCursor(raw.cursor),
    hasMore: raw.hasMore,
  }
  if (new Set(page.changes.map(change => change.cursor)).size !== page.changes.length
    || (page.hasMore && (page.changes.length === 0 || page.cursor !== page.changes.at(-1)!.cursor))) {
    throw new InvalidSource()
  }
  if (hasReset) {
    const reset = validateReset(raw.reset)
    if (page.changes.length !== 0 || page.hasMore || page.cursor !== reset.cursor) throw new InvalidSource()
    page.reset = reset
  }
  return page
}

function headerCount(rawHeaders: readonly string[], name: string): number {
  const expected = name.toLowerCase()
  let count = 0
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if ((rawHeaders[index] ?? '').toLowerCase() === expected) count += 1
  }
  return count
}

function readRequestedCursor(request: FastifyRequest): string | undefined {
  const count = headerCount(request.raw.rawHeaders, 'last-event-id')
  const value = request.headers['last-event-id']
  if (count > 1 || Array.isArray(value) || (count === 0 && value !== undefined)) throw new InvalidRequest()
  if (value === undefined) return undefined
  if (count !== 1) throw new InvalidRequest()
  return requireInputCursor(value)
}

function hasQueryParameters(url: string): boolean {
  const question = url.indexOf('?')
  return question >= 0 && url.slice(question + 1).split('#', 1)[0] !== ''
}

function sendError(reply: FastifyReply, statusCode: number, code: string, message: string): FastifyReply {
  reply.header('Cache-Control', 'no-store')
  reply.header('X-Content-Type-Options', 'nosniff')
  const body: ApiErrorBody = { error: { code, message } }
  return reply.status(statusCode).send(body)
}

function resetFrame(reset: ValidatedReset): string {
  return `event: reset\nid: ${reset.cursor}\ndata: ${JSON.stringify({ reason: reset.reason })}\n\n`
}

function readyFrame(cursor: string): string {
  return `event: ready\nid: ${cursor}\ndata: {}\n\n`
}

function changeFrame(change: ChangeFeedEvent): string {
  return `event: change\nid: ${change.cursor}\ndata: ${JSON.stringify(change.notice)}\n\n`
}

function frameBuffer(frame: string): Buffer {
  const bytes = Buffer.from(frame, 'utf8')
  if (bytes.byteLength > MAX_FRAME_BYTES) throw new InvalidSource()
  return bytes
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new StreamClosed())
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onAbort = (): void => finish(new StreamClosed())
    const timer = setTimeout(() => finish(), ms)
    timer.unref()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function writeChunk(raw: ServerResponse, data: Buffer, signal: AbortSignal): Promise<void> {
  if (signal.aborted || raw.destroyed || raw.writableEnded) throw new StreamClosed()
  if (raw.writableLength + data.byteLength > MAX_QUEUED_BYTES) throw new StreamClosed()

  const accepted = raw.write(data)
  if (raw.writableLength > MAX_QUEUED_BYTES) throw new StreamClosed()
  if (accepted) return

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      raw.off('drain', onDrain)
      raw.off('close', onClose)
      raw.off('error', onError)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onDrain = (): void => finish()
    const onClose = (): void => finish(new StreamClosed())
    const onError = (): void => finish(new StreamClosed())
    const onAbort = (): void => finish(new StreamClosed())
    const timer = setTimeout(() => finish(new StreamClosed()), DRAIN_TIMEOUT_MS)
    timer.unref()
    raw.once('drain', onDrain)
    raw.once('close', onClose)
    raw.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
    if (!raw.writableNeedDrain) finish()
  })
}

function setStreamHeaders(raw: ServerResponse): void {
  raw.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Encoding': 'identity',
    'Content-Type': 'text/event-stream;charset=utf-8',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  })
  raw.flushHeaders()
}

/**
 * Register the authenticated durable-change SSE endpoint on its parent Fastify application.
 * The parent owns authentication and the reader/storage lifecycle.
 */
export function registerChangeStream(
  app: FastifyInstance,
  options: RegisterChangeStreamOptions,
): void {
  if (!app || typeof app.get !== 'function' || typeof app.addHook !== 'function') {
    throw new Error('Invalid Fastify application')
  }
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Invalid change stream options')
  }
  const reader = options.reader
  if (!reader || typeof reader.readPage !== 'function') throw new Error('Invalid change feed reader')
  const readPage = reader.readPage.bind(reader)
  const pollIntervalMs = requirePositiveInteger(
    options.pollIntervalMs,
    DEFAULT_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
    'pollIntervalMs',
  )
  const heartbeatMs = requirePositiveInteger(
    options.heartbeatMs,
    DEFAULT_HEARTBEAT_MS,
    MAX_HEARTBEAT_MS,
    'heartbeatMs',
  )
  const maxConnections = requirePositiveInteger(
    options.maxConnections,
    DEFAULT_MAX_CONNECTIONS,
    MAX_CONNECTIONS_LIMIT,
    'maxConnections',
  )

  const active = new Set<ActiveSession>()
  let connectionCount = 0
  let closing = false

  const read = (cursor: string | undefined): ValidatedPage => {
    if(closing)throw new StreamClosed()
    return validatePage(readPage({...(cursor === undefined ? {} : {cursor}),limit:READ_LIMIT}) satisfies ChangeFeedPage)
  }

  app.addHook('preClose', async () => {
    closing = true
    const sessions = [...active]
    for (const session of sessions) session.stop(true)
    await Promise.allSettled(sessions.map(session => session.done))
  })

  app.get('/api/v1/events', { exposeHeadRoute: false }, async (request, reply) => {
    if (hasQueryParameters(request.url)) {
      return sendError(reply, 400, 'INVALID_REQUEST', 'Invalid request')
    }

    let requestedCursor: string | undefined
    try {
      requestedCursor = readRequestedCursor(request)
    } catch {
      return sendError(reply, 400, 'INVALID_REQUEST', 'Invalid request')
    }

    if (closing) return sendError(reply, 503, 'UNAVAILABLE', 'Service unavailable')
    if (connectionCount >= maxConnections) {
      return sendError(reply, 429, 'TOO_MANY_REQUESTS', 'Too many requests')
    }

    connectionCount += 1
    let firstPage: ValidatedPage
    try {
      firstPage = read(requestedCursor)
      if (requestedCursor === undefined) {
        if (firstPage.reset?.reason !== 'initial') throw new InvalidSource()
      } else if (firstPage.reset?.reason === 'initial') {
        throw new InvalidSource()
      }
    } catch (error) {
      connectionCount -= 1
      if (error instanceof ChangeFeedInputError || error instanceof InvalidRequest) {
        return sendError(reply, 400, 'INVALID_REQUEST', 'Invalid request')
      }
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Internal server error')
    }

    reply.hijack()
    const raw = reply.raw
    const socket = raw.socket
    const ordinarySocketTimeout = socket?.timeout
    // This response is intentionally long-lived; heartbeats and the drain deadline own liveness.
    socket?.setTimeout(0)
    const controller = new AbortController()
    let released = false
    let settleDone!: () => void
    const done = new Promise<void>(resolve => { settleDone = resolve })
    let session!: ActiveSession

    const release = (): void => {
      if (released) return
      released = true
      connectionCount -= 1
    }

    const stop = (destroy: boolean): void => {
      if (!controller.signal.aborted) controller.abort()
      release()
      if (!raw.writableEnded && !raw.destroyed) raw.end()
      if (destroy && !raw.destroyed) raw.destroy()
    }

    session = { stop, done }
    active.add(session)

    const onResponseClose = (): void => stop(false)
    const onResponseError = (): void => stop(true)
    const onRequestAborted = (): void => stop(true)
    raw.once('close', onResponseClose)
    raw.once('error', onResponseError)
    request.raw.once('aborted', onRequestAborted)

    const writeFrame = async (frame: string): Promise<void> => {
      await writeChunk(raw, frameBuffer(frame), controller.signal)
    }

    const run = async (): Promise<void> => {
      try {
        setStreamHeaders(raw)
        let cursor = requestedCursor ?? firstPage.cursor
        let page: ValidatedPage | undefined = firstPage
        let needsReady = true

        let nextPoll = Date.now()
        let nextHeartbeat = Date.now() + heartbeatMs
        while (!controller.signal.aborted) {
          if (page !== undefined) {
            if (page.reset) {
              await writeFrame(resetFrame(page.reset))
              cursor = page.reset.cursor
              needsReady = true
            } else {
              const pageStart = cursor
              for (const change of page.changes) {
                await writeFrame(changeFrame(change))
                cursor = change.cursor
                nextHeartbeat = Date.now() + heartbeatMs
              }
              cursor = page.cursor
              if (page.hasMore) {
                if (cursor === pageStart) throw new InvalidSource()
                page = read(cursor)
                continue
              }
            }
            if(needsReady){
              await writeFrame(readyFrame(cursor))
              nextHeartbeat = Date.now() + heartbeatMs
              needsReady = false
            }
            page = undefined
            nextPoll = Date.now() + pollIntervalMs
          }

          const now = Date.now()
          await abortableDelay(Math.max(0, Math.min(nextPoll, nextHeartbeat) - now), controller.signal)
          const current = Date.now()
          if (current >= nextHeartbeat) {
            await writeFrame(': heartbeat\n\n')
            nextHeartbeat = Date.now() + heartbeatMs
          }
          if (current >= nextPoll) {
            page = read(cursor)
            nextPoll = Date.now() + pollIntervalMs
          }
        }
      } catch {
        stop(true)
      } finally {
        raw.off('close', onResponseClose)
        raw.off('error', onResponseError)
        request.raw.off('aborted', onRequestAborted)
        if(socket && !socket.destroyed && ordinarySocketTimeout !== undefined) socket.setTimeout(ordinarySocketTimeout)
        stop(false)
        active.delete(session)
        settleDone()
      }
    }

    void run()
    return reply
  })
}
