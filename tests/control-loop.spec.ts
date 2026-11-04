import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runControlLoop,
  type ControlLoopEvent,
  type ControlLoopOrchestrator,
} from '../src/application/control-loop.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
  reject: (reason?: unknown) => void
} {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function jsonSafe(event: ControlLoopEvent): void {
  const encoded = JSON.stringify(event)
  expect(encoded).toEqual(JSON.stringify(JSON.parse(encoded)))
  expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(['startup_reconciled', 'startup_failed', 'tick_completed', 'tick_failed', 'shutdown_reconciled', 'shutdown_failed'])
    .toContain(event.kind)
  expect(Number.isSafeInteger(event.ticks)).toBe(true)
  expect(Number.isSafeInteger(event.errors)).toBe(true)
  if (event.error !== undefined) {
    expect(typeof event.error).toBe('string')
    expect(event.error.length).toBeGreaterThan(0)
    expect(event.error.length).toBeLessThanOrEqual(2_048)
  }
}

describe('runControlLoop', () => {
  it('rejects invalid intervalMs and incomplete options before any work', async () => {
    const orchestrator: ControlLoopOrchestrator = {
      tick: async () => {
        throw new Error('tick must not run')
      },
      reconcile: async () => {
        throw new Error('reconcile must not run')
      },
    }
    const onEvent = async () => {
      throw new Error('onEvent must not run')
    }
    const signal = new AbortController().signal

    await expect(runControlLoop({
      orchestrator,
      signal,
      intervalMs: 99,
      onEvent,
    })).rejects.toThrow(/intervalMs/)

    await expect(runControlLoop({
      orchestrator,
      signal,
      intervalMs: 60_001,
      onEvent,
    })).rejects.toThrow(/intervalMs/)

    await expect(runControlLoop({
      orchestrator,
      signal,
      intervalMs: 100.5,
      onEvent,
    })).rejects.toThrow(/intervalMs/)

    await expect(runControlLoop({
      orchestrator: { tick: async () => undefined } as ControlLoopOrchestrator,
      signal,
      intervalMs: 100,
      onEvent,
    })).rejects.toThrow(/orchestrator/)

    await expect(runControlLoop({
      orchestrator,
      signal: { aborted: false } as AbortSignal,
      intervalMs: 100,
      onEvent,
    })).rejects.toThrow(/signal/)
  })

  it('does not launch work when the signal is already aborted', async () => {
    const calls: string[] = []
    const controller = new AbortController()
    controller.abort()
    const result = await runControlLoop({
      orchestrator: {
        async tick() {
          calls.push('tick')
        },
        async reconcile() {
          calls.push('reconcile')
        },
      },
      signal: controller.signal,
      intervalMs: 100,
      onEvent: async () => {
        calls.push('event')
      },
    })
    expect(result).toEqual({ ticks: 0, errors: 0 })
    expect(calls).toEqual([])
  })

  it('fails closed when startup reconciliation fails and never schedules a tick', async () => {
    const calls: string[] = []
    const events: ControlLoopEvent[] = []
    await expect(runControlLoop({
      orchestrator: {
        async tick() {
          calls.push('tick')
        },
        async reconcile() {
          calls.push('reconcile')
          throw new Error('startup reconcile boom api_key=secret-token-value')
        },
      },
      signal: new AbortController().signal,
      intervalMs: 100,
      onEvent: async event => {
        jsonSafe(event)
        events.push(event)
      },
    })).rejects.toThrow(/startup reconcile boom api_key=\[REDACTED\]/)

    expect(calls).toEqual(['reconcile'])
    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe('startup_failed')
    expect(events[0]?.ticks).toBe(0)
    expect(events[0]?.errors).toBe(0)
    expect(events[0]?.error).toMatch(/startup reconcile boom/)
    expect(events[0]?.error).not.toContain('secret-token-value')
    expect(events[0]?.error).toContain('[REDACTED]')
  })

  it('runs sequential ticks with a full interval after each settled tick and never overlaps', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const events: ControlLoopEvent[] = []
    let inFlight = 0
    let maxInFlight = 0
    let ticksStarted = 0
    const tickRelease = [deferred(), deferred()]
    const started = deferred()
    const afterFirstTick = deferred()
    const secondTickStarted = deferred()

    const loop = runControlLoop({
      orchestrator: {
        async reconcile() {
          return { assigned: 0 }
        },
        async tick() {
          ticksStarted += 1
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          const index = ticksStarted - 1
          if (index === 0) started.resolve()
          if (index === 1) secondTickStarted.resolve()
          try {
            await tickRelease[index]!.promise
            return { assigned: 1, raw: { nested: true, secret: 'should-not-appear' } }
          } finally {
            inFlight -= 1
          }
        },
      },
      signal: controller.signal,
      intervalMs: 1_000,
      onEvent: async event => {
        jsonSafe(event)
        events.push(event)
        if (event.kind === 'tick_completed' && event.ticks === 1) afterFirstTick.resolve()
        if (event.kind === 'tick_completed' && event.ticks === 2) controller.abort()
      },
    })

    await started.promise
    expect(maxInFlight).toBe(1)
    expect(ticksStarted).toBe(1)

    tickRelease[0]!.resolve()
    await afterFirstTick.promise
    // Flush microtasks until the post-tick interval timer is armed.
    for (let i = 0; i < 20 && vi.getTimerCount() === 0; i += 1) await Promise.resolve()
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1)
    expect(ticksStarted).toBe(1)

    await vi.advanceTimersByTimeAsync(999)
    expect(ticksStarted).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await secondTickStarted.promise
    expect(ticksStarted).toBe(2)
    expect(maxInFlight).toBe(1)

    tickRelease[1]!.resolve()
    await expect(loop).resolves.toEqual({ ticks: 2, errors: 0 })
    expect(maxInFlight).toBe(1)
    expect(events.map(e => e.kind)).toEqual([
      'startup_reconciled',
      'tick_completed',
      'tick_completed',
      'shutdown_reconciled',
    ])
    for (const event of events) {
      expect(JSON.stringify(event)).not.toContain('should-not-appear')
      expect(Object.keys(event).sort()).toEqual(
        event.error === undefined
          ? ['errors', 'kind', 'ticks', 'timestamp']
          : ['error', 'errors', 'kind', 'ticks', 'timestamp'],
      )
    }
  })

  it('emits redacted tick errors then waits the normal interval before the next tick', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const events: ControlLoopEvent[] = []
    let ticksStarted = 0
    let reconciles = 0
    const afterFailure = deferred()
    const secondTickStarted = deferred()

    const loop = runControlLoop({
      orchestrator: {
        async reconcile() {
          reconciles += 1
        },
        async tick() {
          ticksStarted += 1
          if (ticksStarted === 1) {
            throw new Error('transient failure Bearer sk-ant-api03-SUPERSECRETVALUE')
          }
          secondTickStarted.resolve()
          controller.abort()
          return {}
        },
      },
      signal: controller.signal,
      intervalMs: 500,
      onEvent: async event => {
        jsonSafe(event)
        events.push(event)
        if (event.kind === 'tick_failed') afterFailure.resolve()
      },
    })

    await afterFailure.promise
    for (let i = 0; i < 20 && vi.getTimerCount() === 0; i += 1) await Promise.resolve()
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1)
    expect(ticksStarted).toBe(1)
    const failed = events.find(e => e.kind === 'tick_failed')
    expect(failed?.errors).toBe(1)
    expect(failed?.ticks).toBe(0)
    expect(failed?.error).not.toMatch(/SUPERSECRETVALUE/)
    expect(failed?.error).toContain('[REDACTED]')

    await vi.advanceTimersByTimeAsync(499)
    expect(ticksStarted).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    await secondTickStarted.promise
    await expect(loop).resolves.toEqual({ ticks: 1, errors: 1 })
    expect(ticksStarted).toBe(2)
    expect(reconciles).toBe(2)
    expect(events.map(e => e.kind)).toEqual([
      'startup_reconciled',
      'tick_failed',
      'tick_completed',
      'shutdown_reconciled',
    ])
  })

  it('aborts during the interval wait without starting another tick, then reconciles once', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const events: ControlLoopEvent[] = []
    let ticksStarted = 0
    let reconciles = 0
    const afterFirstTick = deferred()

    const loop = runControlLoop({
      orchestrator: {
        async reconcile() {
          reconciles += 1
        },
        async tick() {
          ticksStarted += 1
          return {}
        },
      },
      signal: controller.signal,
      intervalMs: 2_000,
      onEvent: async event => {
        jsonSafe(event)
        events.push(event)
        if (event.kind === 'tick_completed') afterFirstTick.resolve()
      },
    })

    await afterFirstTick.promise
    for (let i = 0; i < 20 && vi.getTimerCount() === 0; i += 1) await Promise.resolve()
    expect(vi.getTimerCount()).toBeGreaterThanOrEqual(1)
    expect(ticksStarted).toBe(1)
    await vi.advanceTimersByTimeAsync(200)
    expect(ticksStarted).toBe(1)
    controller.abort()
    await expect(loop).resolves.toEqual({ ticks: 1, errors: 0 })
    expect(ticksStarted).toBe(1)
    expect(reconciles).toBe(2)
    expect(events.map(e => e.kind)).toEqual([
      'startup_reconciled',
      'tick_completed',
      'shutdown_reconciled',
    ])
  })

  it('awaits an in-flight tick after abort, then reconciles once without claiming task completion', async () => {
    const controller = new AbortController()
    const events: ControlLoopEvent[] = []
    const tickGate = deferred()
    const tickEntered = deferred()
    let ticksStarted = 0
    let ticksFinished = 0
    let reconciles = 0
    const sideEffects: string[] = []

    const loop = runControlLoop({
      orchestrator: {
        async reconcile() {
          reconciles += 1
        },
        async tick() {
          ticksStarted += 1
          sideEffects.push('tick-enter')
          tickEntered.resolve()
          await tickGate.promise
          ticksFinished += 1
          sideEffects.push('tick-exit')
          // Control loop must not interpret results as Task DONE / Runner cancel.
          return { completedTasks: ['must-not-auto-complete'], cancelRunners: true }
        },
      },
      signal: controller.signal,
      intervalMs: 1_000,
      onEvent: async event => {
        jsonSafe(event)
        events.push(event)
      },
    })

    await tickEntered.promise
    controller.abort()
    await Promise.resolve()
    expect(ticksFinished).toBe(0)
    expect(reconciles).toBe(1)

    tickGate.resolve()
    await expect(loop).resolves.toEqual({ ticks: 1, errors: 0 })
    expect(ticksFinished).toBe(1)
    expect(reconciles).toBe(2)
    expect(sideEffects).toEqual(['tick-enter', 'tick-exit'])
    expect(events.map(e => e.kind)).toEqual([
      'startup_reconciled',
      'tick_completed',
      'shutdown_reconciled',
    ])
    expect(JSON.stringify(events)).not.toContain('must-not-auto-complete')
  })

  it('fails closed when the event sink rejects and leaves no dangling timer work', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    let reconciles = 0
    let ticksStarted = 0

    const loop = runControlLoop({
      orchestrator: {
        async reconcile() {
          reconciles += 1
        },
        async tick() {
          ticksStarted += 1
          return {}
        },
      },
      signal: controller.signal,
      intervalMs: 1_000,
      onEvent: async event => {
        if (event.kind === 'tick_completed') {
          throw new Error('sink rejected')
        }
      },
    })

    await expect(loop).rejects.toThrow(/sink rejected/)
    expect(ticksStarted).toBe(1)
    expect(reconciles).toBe(2)

    const pending = vi.getTimerCount()
    expect(pending).toBe(0)
  })

  it('fails closed when shutdown reconciliation fails after abort', async () => {
    const controller = new AbortController()
    const events: ControlLoopEvent[] = []
    let reconciles = 0

    const loop = runControlLoop({
      orchestrator: {
        async reconcile() {
          reconciles += 1
          if (reconciles === 2) throw new Error('shutdown reconcile failed')
        },
        async tick() {
          controller.abort()
          return {}
        },
      },
      signal: controller.signal,
      intervalMs: 100,
      onEvent: async event => {
        jsonSafe(event)
        events.push(event)
      },
    })

    await expect(loop).rejects.toThrow(/shutdown reconcile failed/)
    expect(events.map(e => e.kind)).toEqual([
      'startup_reconciled',
      'tick_completed',
      'shutdown_failed',
    ])
    expect(events.at(-1)?.error).toMatch(/shutdown reconcile failed/)
  })
})

