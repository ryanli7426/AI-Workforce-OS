import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChangeStreamClient } from './change-stream.ts'
import type { ChangeConnectionState, ChangeMessage, OpenChangeStream } from './realtime-model.ts'

const encoder = new TextEncoder()
const STREAM_HEADERS = { 'content-type': 'text/event-stream;charset=utf-8' }
const AT = '2026-11-05T01:02:03.000Z'

type ControlledStream = {
  response: Response
  enqueue(value: string | Uint8Array): void
  close(): void
  cancelled: ReturnType<typeof vi.fn>
}

function controlledStream(): ControlledStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const cancelled = vi.fn()
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value
    },
    cancel() {
      cancelled()
    },
  })
  return {
    response: new Response(stream, { status: 200, headers: STREAM_HEADERS }),
    enqueue(value) {
      controller.enqueue(typeof value === 'string' ? encoder.encode(value) : value)
    },
    close() {
      controller.close()
    },
    cancelled,
  }
}

function finiteStream(value: string | Uint8Array): Response {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  }), { status: 200, headers: STREAM_HEADERS })
}

function pendingOpen(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () => reject(new DOMException('Aborted', 'AbortError'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

function ready(cursor = 'cursor-0', newline = '\n'): string {
  return `event: ready${newline}id: ${cursor}${newline}data: {}${newline}${newline}`
}

function change(cursor = 'cursor-1', resourceId = 'task-1'): string {
  return `event: change\nid: ${cursor}\ndata: ${JSON.stringify({
    entity: 'task',
    resourceId,
    ticketId: resourceId,
    at: AT,
  })}\n\n`
}

async function waitForCall(mock: { mock: { calls: unknown[][] } }, count: number): Promise<void> {
  await vi.waitFor(() => expect(mock.mock.calls).toHaveLength(count))
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createChangeStreamClient', () => {
  it('parses split UTF-8, BOM, CRLF, lone CR, comments, extension fields, and multiline data', async () => {
    const source = controlledStream()
    const open = vi.fn<OpenChangeStream>(async () => source.response)
    const messages: ChangeMessage[] = []
    const states: ChangeConnectionState[] = []
    const controller = new AbortController()
    const client = createChangeStreamClient({ open })
    const running = client.run({
      signal: controller.signal,
      onEvent(message) {
        messages.push(message)
      },
      onState(state) {
        states.push(state)
      },
    })

    await waitForCall(open, 1)
    const wire = encoder.encode(
      `\uFEFF: 心跳\r\nevent: ready\rid: cursor-0\rdata: {}\r\r`
      + `note: 雪\nevent: change\nid: cursor-1\n`
      + `data: {"entity":"task",\n`
      + `data: "resourceId":"task-1","ticketId":"task-1","at":"${AT}"}\n\n`,
    )
    for (const byte of wire) source.enqueue(Uint8Array.of(byte))

    await vi.waitFor(() => expect(messages).toHaveLength(2))
    expect(messages).toEqual([
      { type: 'ready', cursor: 'cursor-0' },
      {
        type: 'change',
        cursor: 'cursor-1',
        notice: { entity: 'task', resourceId: 'task-1', ticketId: 'task-1', at: AT },
      },
    ])
    expect(Object.isFrozen(client)).toBe(true)
    expect(Object.isFrozen(messages[1])).toBe(true)
    expect(Object.isFrozen((messages[1] as Extract<ChangeMessage, { type: 'change' }>).notice)).toBe(true)
    expect(states).toEqual(['connecting', 'live'])

    controller.abort()
    await running
    await vi.waitFor(() => expect(source.cancelled).toHaveBeenCalledOnce())
  })

  it('reconnects from the last delivered cursor and ignores unknown IDs and a partial EOF frame', async () => {
    vi.useFakeTimers()
    const inputs: Array<{ cursor?: string; signal: AbortSignal }> = []
    const first = finiteStream(
      ready()
      + change()
      + 'event: extension\nid: must-not-ack\ndata: {}\n\n'
      + 'event: change\nid: cursor-2\ndata: {"entity":"task"}',
    )
    const open = vi.fn<OpenChangeStream>((input) => {
      inputs.push(input)
      return inputs.length === 1 ? Promise.resolve(first) : pendingOpen(input.signal)
    })
    const onEvent = vi.fn()
    const controller = new AbortController()
    const running = createChangeStreamClient({ open, retryBaseMs: 1, retryMaxMs: 1 }).run({
      signal: controller.signal,
      onEvent,
      onState: vi.fn(),
    })

    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2))
    await vi.advanceTimersByTimeAsync(1)
    expect(inputs).toHaveLength(2)
    expect(inputs[1]?.cursor).toBe('cursor-1')
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ cursor: 'must-not-ack' }))
    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({ cursor: 'cursor-2' }))

    controller.abort()
    await running
  })

  it('retains the previous cursor when a sequential handler rejects', async () => {
    vi.useFakeTimers()
    const inputs: Array<{ cursor?: string; signal: AbortSignal }> = []
    const open = vi.fn<OpenChangeStream>((input) => {
      inputs.push(input)
      if (inputs.length === 1) return Promise.resolve(finiteStream(ready() + change()))
      return pendingOpen(input.signal)
    })
    const delivered: string[] = []
    const controller = new AbortController()
    const running = createChangeStreamClient({ open, retryBaseMs: 1, retryMaxMs: 1 }).run({
      signal: controller.signal,
      async onEvent(message) {
        delivered.push(message.cursor)
        if (message.type === 'change') throw new Error('sensitive fixture text')
      },
      onState: vi.fn(),
    })

    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(delivered).toEqual(['cursor-0', 'cursor-1']))
    await vi.advanceTimersByTimeAsync(1)
    expect(inputs[1]?.cursor).toBe('cursor-0')

    controller.abort()
    await running
  })

  it('rejects oversized frames and malformed UTF-8 without delivering or acknowledging them', async () => {
    vi.useFakeTimers()
    const inputs: Array<{ cursor?: string; signal: AbortSignal }> = []
    const oversized = `event: change\nid: cursor-large\ndata: ${'x'.repeat(64 * 1024)}\n\n`
    const invalidUtf8 = new Uint8Array([0x65, 0x76, 0x65, 0x6e, 0x74, 0x3a, 0x20, 0xc3])
    const open = vi.fn<OpenChangeStream>((input) => {
      inputs.push(input)
      if (inputs.length === 1) return Promise.resolve(finiteStream(oversized))
      if (inputs.length === 2) return Promise.resolve(finiteStream(invalidUtf8))
      return Promise.resolve(new Response(null, { status: 401 }))
    })
    const onEvent = vi.fn()
    const states: ChangeConnectionState[] = []
    const running = createChangeStreamClient({ open, retryBaseMs: 1, retryMaxMs: 1 }).run({
      signal: new AbortController().signal,
      onEvent,
      onState(state) {
        states.push(state)
      },
    })

    await vi.advanceTimersByTimeAsync(1)
    await vi.advanceTimersByTimeAsync(1)
    await running
    expect(inputs).toHaveLength(3)
    expect(inputs.every((input) => input.cursor === undefined)).toBe(true)
    expect(onEvent).not.toHaveBeenCalled()
    expect(states).toContain('reconnecting')
    expect(states.at(-1)).toBe('unauthorized')
  })

  it('delivers reset DTOs exactly and reconnects when a known DTO has extra keys', async () => {
    vi.useFakeTimers()
    const inputs: Array<{ cursor?: string; signal: AbortSignal }> = []
    const first = finiteStream(
      'event: reset\nid: reset-head\ndata: {"reason":"expired"}\n\n'
      + 'event: ready\nid: reset-head\ndata: {}\n\n'
      + 'event: change\nid: bad\ndata: {"entity":"task","resourceId":"task-1",'
      + `"at":"${AT}","payload":"forbidden"}\n\n`,
    )
    const open = vi.fn<OpenChangeStream>((input) => {
      inputs.push(input)
      return inputs.length === 1 ? Promise.resolve(first) : pendingOpen(input.signal)
    })
    const messages: ChangeMessage[] = []
    const controller = new AbortController()
    const running = createChangeStreamClient({ open, retryBaseMs: 1, retryMaxMs: 1 }).run({
      signal: controller.signal,
      onEvent(message) {
        messages.push(message)
      },
      onState: vi.fn(),
    })

    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => expect(messages).toHaveLength(2))
    await vi.advanceTimersByTimeAsync(1)
    expect(messages).toEqual([
      { type: 'reset', cursor: 'reset-head', reason: 'expired' },
      { type: 'ready', cursor: 'reset-head' },
    ])
    expect(inputs[1]?.cursor).toBe('reset-head')

    controller.abort()
    await running
  })

  it('treats authorization as terminal and unsupported endpoints as offline with bounded retry', async () => {
    vi.useFakeTimers()
    const states: ChangeConnectionState[] = []
    const open = vi.fn<OpenChangeStream>()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 403 }))
    const running = createChangeStreamClient({ open, retryBaseMs: 2, retryMaxMs: 2 }).run({
      signal: new AbortController().signal,
      onEvent: vi.fn(),
      onState(state) {
        states.push(state)
      },
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(states).toEqual(['connecting', 'offline'])
    expect(open).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(2)
    await running
    expect(open).toHaveBeenCalledTimes(2)
    expect(states).toEqual(['connecting', 'offline', 'unauthorized'])
  })

  it('resets the idle watchdog on heartbeat comments', async () => {
    vi.useFakeTimers()
    const first = controlledStream()
    const inputs: Array<{ cursor?: string; signal: AbortSignal }> = []
    const open = vi.fn<OpenChangeStream>((input) => {
      inputs.push(input)
      return inputs.length === 1 ? Promise.resolve(first.response) : pendingOpen(input.signal)
    })
    const states: ChangeConnectionState[] = []
    const controller = new AbortController()
    const running = createChangeStreamClient({
      open,
      idleTimeoutMs: 30,
      retryBaseMs: 1,
      retryMaxMs: 1,
    }).run({
      signal: controller.signal,
      onEvent: vi.fn(),
      onState(state) {
        states.push(state)
      },
    })

    await vi.advanceTimersByTimeAsync(0)
    first.enqueue(ready())
    await vi.advanceTimersByTimeAsync(0)
    expect(states).toContain('live')
    await vi.advanceTimersByTimeAsync(20)
    first.enqueue(': heartbeat\n\n')
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(20)
    expect(open).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(10)
    expect(states).toContain('reconnecting')
    await vi.advanceTimersByTimeAsync(1)
    expect(open).toHaveBeenCalledTimes(2)

    controller.abort()
    await running
  })

  it('cleans up promptly when aborted during open, read, retry, or a handler', async () => {
    const duringOpen = new AbortController()
    const openNever = vi.fn<OpenChangeStream>(() => new Promise(() => undefined))
    const opening = createChangeStreamClient({ open: openNever }).run({
      signal: duringOpen.signal,
      onEvent: vi.fn(),
      onState: vi.fn(),
    })
    await waitForCall(openNever, 1)
    duringOpen.abort()
    await opening

    const readSource = controlledStream()
    const duringRead = new AbortController()
    const reading = createChangeStreamClient({ open: async () => readSource.response }).run({
      signal: duringRead.signal,
      onEvent: vi.fn(),
      onState: vi.fn(),
    })
    await vi.waitFor(() => expect(readSource.response.body?.locked).toBe(true))
    duringRead.abort()
    await reading
    await vi.waitFor(() => expect(readSource.cancelled).toHaveBeenCalledOnce())

    vi.useFakeTimers()
    const retryOpen = vi.fn<OpenChangeStream>(async () => finiteStream(''))
    const duringRetry = new AbortController()
    const retrying = createChangeStreamClient({ open: retryOpen, retryBaseMs: 20, retryMaxMs: 20 }).run({
      signal: duringRetry.signal,
      onEvent: vi.fn(),
      onState: vi.fn(),
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(retryOpen).toHaveBeenCalledOnce()
    duringRetry.abort()
    await retrying
    await vi.advanceTimersByTimeAsync(100)
    expect(retryOpen).toHaveBeenCalledOnce()
    vi.useRealTimers()

    const handlerSource = controlledStream()
    const duringHandler = new AbortController()
    let handlerStarted!: () => void
    const started = new Promise<void>((resolve) => {
      handlerStarted = resolve
    })
    const handling = createChangeStreamClient({ open: async () => handlerSource.response }).run({
      signal: duringHandler.signal,
      onEvent: async () => {
        handlerStarted()
        await new Promise(() => undefined)
      },
      onState: vi.fn(),
    })
    handlerSource.enqueue(ready())
    await started
    duringHandler.abort()
    await handling
    await vi.waitFor(() => expect(handlerSource.cancelled).toHaveBeenCalledOnce())
  })

  it('serializes repeated run calls and keeps acknowledged cursors private and memory-only', async () => {
    const firstSource = controlledStream()
    const open = vi.fn<OpenChangeStream>(async () => firstSource.response)
    const client = createChangeStreamClient({ open }) as ReturnType<typeof createChangeStreamClient> & {
      cursor?: string
    }
    const firstAbort = new AbortController()
    const secondAbort = new AbortController()
    const first = client.run({ signal: firstAbort.signal, onEvent: vi.fn(), onState: vi.fn() })
    const second = client.run({ signal: secondAbort.signal, onEvent: vi.fn(), onState: vi.fn() })

    await waitForCall(open, 1)
    expect(client.cursor).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(client, 'cursor')).toBe(false)
    secondAbort.abort()
    await second
    expect(open).toHaveBeenCalledOnce()
    firstAbort.abort()
    await first
    await Promise.resolve()
    expect(open).toHaveBeenCalledOnce()
  })
  it('bounds a stalled handler and resumes from the previous acknowledged cursor', async () => {
    vi.useFakeTimers()
    const inputs:Array<{cursor?:string;signal:AbortSignal}>=[]
    const open=vi.fn<OpenChangeStream>(input=>{inputs.push(input);return inputs.length===1?Promise.resolve(finiteStream(ready()+change())):pendingOpen(input.signal)})
    const controller=new AbortController()
    const run=createChangeStreamClient({open,idleTimeoutMs:5,retryBaseMs:1,retryMaxMs:1}).run({
      signal:controller.signal,onState:vi.fn(),onEvent:message=>message.type==='change'?new Promise<void>(()=>{}):undefined,
    })
    await vi.advanceTimersByTimeAsync(6)
    expect(inputs).toHaveLength(2)
    expect(inputs[1]?.cursor).toBe('cursor-0')
    expect(inputs[0]?.signal.aborted).toBe(true)
    controller.abort();await run
  })

})
