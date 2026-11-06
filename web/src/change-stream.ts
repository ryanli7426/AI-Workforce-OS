import type {
  ChangeConnectionState,
  ChangeMessage,
  ChangeNotice,
  ChangeStreamClient,
  OpenChangeStream,
} from './realtime-model.ts'

const MAX_FRAME_BYTES = 64 * 1024
const DECODE_SLICE_BYTES = 16 * 1024
const MAX_CURSOR_LENGTH = 1024
const SAFE_CURSOR = /^[\x21-\x7e]+$/
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ENTITIES = new Set(['task', 'execution', 'verification', 'employee', 'project'])
const RESET_REASONS = new Set(['initial', 'expired', 'replaced', 'future'])

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000
const DEFAULT_IDLE_TIMEOUT_MS = 35_000
const DEFAULT_RETRY_BASE_MS = 1_000
const DEFAULT_RETRY_MAX_MS = 15_000

type WaitResult<T> =
  | { kind: 'value'; value: T }
  | { kind: 'error' }
  | { kind: 'aborted' }
  | { kind: 'timeout' }

type AttemptResult = 'aborted' | 'unauthorized' | 'retry' | 'offline'

class StreamProtocolError extends Error {
  constructor() {
    super('Invalid change stream')
    this.name = 'StreamProtocolError'
  }
}

function validDuration(value: number | undefined, fallback: number, maximum: number): number {
  const duration = value ?? fallback
  if (!Number.isInteger(duration) || duration < 1 || duration > maximum) {
    throw new Error('Invalid change stream configuration')
  }
  return duration
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key))
    && keys.every((key) => allowed.has(key))
}

function isSafeId(value: unknown): value is string {
  return typeof value === 'string'
    && SAFE_ID.test(value)
    && value !== '.'
    && value !== '..'
}

function isCanonicalIso(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function requireCursor(value: string | undefined): string {
  if (
    value === undefined
    || value.length === 0
    || value.length > MAX_CURSOR_LENGTH
    || !SAFE_CURSOR.test(value)
  ) {
    throw new StreamProtocolError()
  }
  return value
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new StreamProtocolError()
  }
}

function parseNotice(value: unknown): ChangeNotice {
  if (!isRecord(value) || !hasExactKeys(value, ['entity', 'resourceId', 'at'], ['ticketId'])) {
    throw new StreamProtocolError()
  }
  if (!ENTITIES.has(String(value.entity)) || !isSafeId(value.resourceId) || !isCanonicalIso(value.at)) {
    throw new StreamProtocolError()
  }
  if (value.ticketId !== undefined && !isSafeId(value.ticketId)) throw new StreamProtocolError()

  const notice: ChangeNotice = {
    entity: value.entity as ChangeNotice['entity'],
    resourceId: value.resourceId,
    at: value.at,
    ...(value.ticketId === undefined ? {} : { ticketId: value.ticketId }),
  }
  return Object.freeze(notice)
}

function parseMessage(eventType: string, cursorValue: string | undefined, data: string): ChangeMessage {
  const cursor = requireCursor(cursorValue)
  const value = parseJson(data)

  if (eventType === 'ready') {
    if (!isRecord(value) || !hasExactKeys(value, [])) throw new StreamProtocolError()
    return Object.freeze({ type: 'ready', cursor })
  }
  if (eventType === 'reset') {
    if (!isRecord(value) || !hasExactKeys(value, ['reason']) || !RESET_REASONS.has(String(value.reason))) {
      throw new StreamProtocolError()
    }
    return Object.freeze({
      type: 'reset',
      cursor,
      reason: value.reason as Extract<ChangeMessage, { type: 'reset' }>['reason'],
    })
  }
  if (eventType === 'change') {
    return Object.freeze({ type: 'change', cursor, notice: parseNotice(value) })
  }
  throw new StreamProtocolError()
}

class SseParser {
  private readonly encoder = new TextEncoder()
  private pendingLine = ''
  private frameBytes = 0
  private eventType: string | undefined
  private cursor: string | undefined
  private dataLines: string[] = []
  private atStart = true

  async push(text: string, emit: (message: ChangeMessage) => Promise<void>): Promise<void> {
    if (this.atStart) {
      this.atStart = false
      if (text.startsWith('\uFEFF')) text = text.slice(1)
    }
    this.pendingLine += text

    let start = 0
    for (let index = 0; index < this.pendingLine.length; index += 1) {
      const character = this.pendingLine[index]
      if (character !== '\n' && character !== '\r') continue
      if (character === '\r' && index + 1 === this.pendingLine.length) break

      const line = this.pendingLine.slice(start, index)
      if (character === '\r' && this.pendingLine[index + 1] === '\n') index += 1
      await this.processLine(line, emit)
      start = index + 1
    }
    this.pendingLine = this.pendingLine.slice(start)
    if (this.frameBytes + this.encoder.encode(this.pendingLine).byteLength > MAX_FRAME_BYTES) {
      throw new StreamProtocolError()
    }
  }

  async finish(emit: (message: ChangeMessage) => Promise<void>): Promise<void> {
    if (this.pendingLine.endsWith('\r')) {
      const line = this.pendingLine.slice(0, -1)
      this.pendingLine = ''
      await this.processLine(line, emit)
    }
    // A final unterminated line is deliberately not dispatched.
    this.pendingLine = ''
    this.resetFrame()
  }

  private async processLine(line: string, emit: (message: ChangeMessage) => Promise<void>): Promise<void> {
    this.frameBytes += this.encoder.encode(line).byteLength + 1
    if (this.frameBytes > MAX_FRAME_BYTES) throw new StreamProtocolError()

    if (line.length === 0) {
      const eventType = this.eventType
      const cursor = this.cursor
      const dataLines = this.dataLines
      this.resetFrame()

      if (eventType !== 'change' && eventType !== 'reset' && eventType !== 'ready') return
      if (dataLines.length === 0) throw new StreamProtocolError()
      await emit(parseMessage(eventType, cursor, dataLines.join('\n')))
      return
    }

    if (line.startsWith(':')) return
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'event') this.eventType = value
    else if (field === 'data') this.dataLines.push(value)
    else if (field === 'id' && !value.includes('\0')) this.cursor = value
    // retry and extension fields are parsed as standard SSE fields and ignored.
  }

  private resetFrame(): void {
    this.frameBytes = 0
    this.eventType = undefined
    this.cursor = undefined
    this.dataLines = []
  }
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal, timeoutMs?: number): Promise<WaitResult<T>> {
  return new Promise((resolve) => {
    let settled = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined

    const finish = (result: WaitResult<T>) => {
      if (settled) return
      settled = true
      if (timeoutId !== undefined) clearTimeout(timeoutId)
      signal.removeEventListener('abort', abort)
      resolve(result)
    }
    const abort = () => finish({ kind: 'aborted' })

    if (signal.aborted) {
      finish({ kind: 'aborted' })
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    if (timeoutMs !== undefined) timeoutId = setTimeout(() => finish({ kind: 'timeout' }), timeoutMs)
    promise.then(
      (value) => finish({ kind: 'value', value }),
      () => finish({ kind: 'error' }),
    )
  })
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (completed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      signal.removeEventListener('abort', abort)
      resolve(completed)
    }
    const abort = () => finish(false)
    const timeoutId = setTimeout(() => finish(true), delayMs)
    if (signal.aborted) finish(false)
    else signal.addEventListener('abort', abort, { once: true })
  })
}

function cancelBody(response: Response): void {
  if (response.body === null) return
  try {
    void response.body.cancel().catch(() => undefined)
  } catch {
    // A transport-owned or already locked body still must not escape cleanup.
  }
}

function isEventStream(response: Response): boolean {
  const contentType = response.headers.get('content-type')
  return contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream'
}

export function createChangeStreamClient(options: {
  open: OpenChangeStream
  handshakeTimeoutMs?: number
  idleTimeoutMs?: number
  retryBaseMs?: number
  retryMaxMs?: number
}): ChangeStreamClient {
  if (typeof options.open !== 'function') throw new Error('Invalid change stream configuration')
  const handshakeTimeoutMs = validDuration(
    options.handshakeTimeoutMs,
    DEFAULT_HANDSHAKE_TIMEOUT_MS,
    DEFAULT_HANDSHAKE_TIMEOUT_MS,
  )
  const idleTimeoutMs = validDuration(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS)
  const retryBaseMs = validDuration(options.retryBaseMs, DEFAULT_RETRY_BASE_MS, DEFAULT_RETRY_MAX_MS)
  const retryMaxMs = validDuration(options.retryMaxMs, DEFAULT_RETRY_MAX_MS, DEFAULT_RETRY_MAX_MS)
  if (retryBaseMs > retryMaxMs) throw new Error('Invalid change stream configuration')

  let queue: Promise<void> = Promise.resolve()

  const runOnce = async ({
    signal,
    onEvent,
    onState,
  }: Parameters<ChangeStreamClient['run']>[0]): Promise<void> => {
    if (signal.aborted) return

    let acknowledgedCursor: string | undefined
    let retryDelay = retryBaseMs
    let lastState: ChangeConnectionState | undefined

    const setState = (state: ChangeConnectionState) => {
      if (state === lastState || signal.aborted) return
      lastState = state
      try {
        onState(state)
      } catch {
        // UI observer failures must not expose transport details or break cleanup.
      }
    }

    const attempt = async (): Promise<AttemptResult> => {
      const attemptController = new AbortController()
      const abortAttempt = () => attemptController.abort()
      signal.addEventListener('abort', abortAttempt, { once: true })
      if (signal.aborted) attemptController.abort()

      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      const startedAt = Date.now()
      let ready = false

      try {
        const openPromise = Promise.resolve().then(() => options.open({
          ...(acknowledgedCursor === undefined ? {} : { cursor: acknowledgedCursor }),
          signal: attemptController.signal,
        }))
        void openPromise.then((lateResponse) => {
          if (attemptController.signal.aborted && reader === undefined) cancelBody(lateResponse)
        }).catch(() => undefined)

        const opened = await waitFor(openPromise, attemptController.signal, handshakeTimeoutMs)
        if (opened.kind === 'aborted') return 'aborted'
        if (opened.kind === 'timeout' || opened.kind === 'error') {
          attemptController.abort()
          return 'retry'
        }

        const response = opened.value
        if (signal.aborted) {
          cancelBody(response)
          return 'aborted'
        }
        if (response.status === 401 || response.status === 403) {
          cancelBody(response)
          return 'unauthorized'
        }
        if (response.status === 404 || response.status === 503) {
          cancelBody(response)
          return 'offline'
        }
        if (response.status !== 200 || response.body === null || !isEventStream(response)) {
          cancelBody(response)
          return 'retry'
        }

        reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8', { fatal: true })
        const parser = new SseParser()
        let idleDeadline = Date.now() + idleTimeoutMs

        const emit = async (message: ChangeMessage) => {
          const handled = await waitFor(
            Promise.resolve().then(() => onEvent(message)),
            attemptController.signal,
            idleTimeoutMs,
          )
          if (handled.kind === 'aborted') throw new StreamProtocolError()
          if (handled.kind !== 'value') throw new StreamProtocolError()

          acknowledgedCursor = message.cursor
          if (message.type === 'ready') {
            ready = true
            retryDelay = retryBaseMs
            setState('live')
          }
        }

        while (!signal.aborted) {
          const timeout = ready
            ? idleDeadline - Date.now()
            : handshakeTimeoutMs - (Date.now() - startedAt)
          if (timeout <= 0) {
            attemptController.abort()
            return 'retry'
          }
          const read = await waitFor(reader.read(), attemptController.signal, timeout)
          if (read.kind === 'aborted') return signal.aborted ? 'aborted' : 'retry'
          if (read.kind === 'timeout' || read.kind === 'error') {
            attemptController.abort()
            return 'retry'
          }
          if (read.value.done) {
            const tail = decoder.decode()
            if (tail.length > 0) await parser.push(tail, emit)
            await parser.finish(emit)
            return 'retry'
          }

          const chunk = read.value.value
          for (let offset = 0; offset < chunk.byteLength; offset += DECODE_SLICE_BYTES) {
            const text = decoder.decode(chunk.subarray(offset, offset + DECODE_SLICE_BYTES), { stream: true })
            if (text.length > 0) await parser.push(text, emit)
          }
          if (chunk.byteLength > 0) idleDeadline = Date.now() + idleTimeoutMs
        }
        return 'aborted'
      } catch {
        return signal.aborted ? 'aborted' : 'retry'
      } finally {
        signal.removeEventListener('abort', abortAttempt)
        attemptController.abort()
        if (reader !== undefined) {
          let cancellation: Promise<void>
          try {
            cancellation = reader.cancel()
          } catch {
            cancellation = Promise.resolve()
          }
          void cancellation.catch(() => undefined).finally(() => {
            try {
              reader?.releaseLock()
            } catch {
              // A pending read may retain the lock until cancellation settles.
            }
          })
        }
      }
    }

    setState('connecting')
    while (!signal.aborted) {
      const result = await attempt()
      if (result === 'aborted' || signal.aborted) return
      if (result === 'unauthorized') {
        setState('unauthorized')
        return
      }

      setState(result === 'offline' ? 'offline' : 'reconnecting')
      if (!await waitForDelay(retryDelay, signal)) return
      retryDelay = Math.min(retryMaxMs, retryDelay * 2)
    }
  }

  const client: ChangeStreamClient = {
    run(runOptions) {
      let started = false
      let resolvePublic!: () => void
      const publicResult = new Promise<void>((resolve) => {
        resolvePublic = resolve
      })
      const execute = async () => {
        if (runOptions.signal.aborted) return
        started = true
        await runOnce(runOptions)
      }
      const scheduled = queue.then(execute, execute)
      queue = scheduled.catch(() => undefined)

      const abort = () => {
        if (!started) resolvePublic()
      }
      if (runOptions.signal.aborted) resolvePublic()
      else runOptions.signal.addEventListener('abort', abort, { once: true })
      void scheduled.then(resolvePublic, resolvePublic).finally(() => {
        runOptions.signal.removeEventListener('abort', abort)
      })
      return publicResult
    },
  }
  return Object.freeze(client)
}
