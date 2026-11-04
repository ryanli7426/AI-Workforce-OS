/** Sequential control-plane poll loop: reconcile → tick → wait; abort-safe, fail-closed. */
import { redact } from '../security/redaction.ts'

const MIN_INTERVAL_MS = 100
const MAX_INTERVAL_MS = 60_000
const ERROR_MESSAGE_LIMIT = 2_048

export type ControlLoopEventKind =
  | 'startup_reconciled'
  | 'startup_failed'
  | 'tick_completed'
  | 'tick_failed'
  | 'shutdown_reconciled'
  | 'shutdown_failed'

/** Stable, JSON-safe loop telemetry. Never embeds raw orchestrator results. */
export interface ControlLoopEvent {
  readonly timestamp: string
  readonly kind: ControlLoopEventKind
  readonly ticks: number
  readonly errors: number
  readonly error?: string
}

export interface ControlLoopOrchestrator {
  tick(): Promise<unknown>
  reconcile(): Promise<unknown>
}

export interface ControlLoopOptions {
  orchestrator: ControlLoopOrchestrator
  signal: AbortSignal
  intervalMs: number
  onEvent: (event: ControlLoopEvent) => void | Promise<void>
}

export interface ControlLoopResult {
  readonly ticks: number
  readonly errors: number
}

function requireOptions(options: ControlLoopOptions): void {
  if (!options || typeof options !== 'object') throw new Error('Invalid control loop options')
  const { orchestrator, signal, intervalMs, onEvent } = options
  if (!orchestrator || typeof orchestrator !== 'object') throw new Error('Invalid orchestrator')
  if (typeof orchestrator.tick !== 'function' || typeof orchestrator.reconcile !== 'function') {
    throw new Error('Invalid orchestrator')
  }
  if (typeof AbortSignal === 'undefined' || !(signal instanceof AbortSignal)) {
    throw new Error('Invalid signal')
  }
  if (typeof onEvent !== 'function') throw new Error('Invalid onEvent')
  if (!Number.isSafeInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
    throw new Error(`intervalMs must be an integer between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS}`)
  }
}

function sanitizeError(error: unknown): string {
  let text: string
  if (error instanceof Error && typeof error.message === 'string' && error.message.trim()) {
    text = error.message
  } else if (typeof error === 'string') {
    text = error
  } else {
    try {
      text = String(error)
    } catch {
      text = 'Unknown error'
    }
  }
  if (!text.trim()) text = 'Unknown error'
  const bounded = text.length > ERROR_MESSAGE_LIMIT ? text.slice(0, ERROR_MESSAGE_LIMIT) : text
  return redact(bounded).slice(0, ERROR_MESSAGE_LIMIT)
}

function event(
  kind: ControlLoopEventKind,
  ticks: number,
  errors: number,
  error?: string,
): ControlLoopEvent {
  const base: ControlLoopEvent = {
    timestamp: new Date().toISOString(),
    kind,
    ticks,
    errors,
  }
  if (error !== undefined) {
    return { ...base, error }
  }
  return base
}

async function emit(
  onEvent: ControlLoopOptions['onEvent'],
  payload: ControlLoopEvent,
): Promise<void> {
  await onEvent(payload)
}

/** Abortable interval wait. Resolves early on abort; never rejects for abort. */
function waitInterval(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    const onAbort = (): void => {
      finish()
    }
    signal.addEventListener('abort', onAbort)
    if (signal.aborted) finish()
  })
}

/**
 * Runs the control loop until `signal` aborts.
 * Initial reconcile must succeed before any tick. Shutdown awaits an in-flight tick,
 * then reconciles once; it does not cancel Runners or mark Tasks completed.
 */
export async function runControlLoop(options: ControlLoopOptions): Promise<ControlLoopResult> {
  requireOptions(options)
  const { orchestrator, signal, intervalMs, onEvent } = options

  if (signal.aborted) {
    return { ticks: 0, errors: 0 }
  }

  let ticks = 0
  let errors = 0
  let startupSucceeded = false

  try {
    try {
      await orchestrator.reconcile()
    } catch (error) {
      const sanitized = sanitizeError(error)
      await emit(onEvent, event('startup_failed', ticks, errors, sanitized))
      throw new Error(sanitized)
    }
    await emit(onEvent, event('startup_reconciled', ticks, errors))
    startupSucceeded = true

    while (!signal.aborted) {
      let tickFailed = false
      try {
        await orchestrator.tick()
        ticks += 1
      } catch (error) {
        tickFailed = true
        errors += 1
        const sanitized = sanitizeError(error)
        // Sink rejection here fails closed (propagates); it is not a transient tick error.
        await emit(onEvent, event('tick_failed', ticks, errors, sanitized))
      }
      if (!tickFailed) {
        await emit(onEvent, event('tick_completed', ticks, errors))
      }

      if (signal.aborted) break
      await waitInterval(intervalMs, signal)
    }
  } finally {
    if (startupSucceeded) {
      try {
        await orchestrator.reconcile()
        await emit(onEvent, event('shutdown_reconciled', ticks, errors))
      } catch (error) {
        const sanitized = sanitizeError(error)
        try {
          await emit(onEvent, event('shutdown_failed', ticks, errors, sanitized))
        } catch {
          // Prefer the reconcile failure; sink failure during shutdown still fail-closed via throw below.
        }
        throw new Error(sanitized)
      }
    }
  }

  return { ticks, errors }
}
