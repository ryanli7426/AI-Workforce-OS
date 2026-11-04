import { redact } from '../security/redaction.ts'
import { randomUUID } from 'node:crypto'
import type { Intent, IntentKind, IntentRepository } from './intents.ts'

const DEFAULT_LEASE_MS = 30_000
const DEFAULT_RETRY_DELAY_MS = 1_000

/** Known-not-applied failure: the effect did not start. Safe for bounded repository retry. */
export class NotAppliedError extends Error {
  override readonly name = 'NotAppliedError'

  constructor(message: string) {
    super(message)
  }
}

export type IntentHandler = (intent: Intent) => Promise<void>

export interface IntentHandlers {
  launch?: IntentHandler
  stop?: IntentHandler
  writeback?: IntentHandler
}

export interface IntentDispatcherOptions {
  repository: IntentRepository
  handlers: IntentHandlers
  leaseMs?: number
  retryDelayMs?: number
  now?: () => number
}

export interface DispatchOnceOptions {
  limit?: number
}

export interface DispatchOnceResult {
  claimed: number
  done: number
  unknown: number
  failed: number
}

export interface IntentDispatcherApi {
  dispatchOnce(options?: DispatchOnceOptions): Promise<DispatchOnceResult>
}

type Outcome = 'done' | 'unknown' | 'failed'

function assertSafeInteger(value: unknown, label: string, minimum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be a safe integer >= ${minimum}`)
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.length > 8192 ? error.message.slice(0, 8192) : error.message
  }
  const text = String(error)
  if (!text.trim()) return 'Intent handler failed'
  return text.length > 8192 ? text.slice(0, 8192) : text
}

function isNotApplied(error: unknown): boolean {
  return error instanceof NotAppliedError
}

/** Launch/writeback throws are uncertain unless NotAppliedError. Stop failures are always known-safe retries. */
function isUncertainFailure(kind: IntentKind, error: unknown): boolean {
  if (kind === 'stop') return false
  return !isNotApplied(error)
}

/**
 * Claims due intents and runs registered handlers outside any DB transaction.
 * Does not spawn processes, call external CLIs, or reconcile UNKNOWN intents.
 */
export function IntentDispatcher(options: IntentDispatcherOptions): IntentDispatcherApi {
  if (!options || typeof options !== 'object') throw new Error('Invalid IntentDispatcher options')
  const { repository } = options
  const handlers = { ...options.handlers }
  if (!repository || typeof repository.claim !== 'function') throw new Error('IntentDispatcher requires a repository')
  if (!handlers || typeof handlers !== 'object') throw new Error('IntentDispatcher requires handlers')

  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const clock = options.now ?? Date.now
  assertSafeInteger(leaseMs, 'leaseMs', 1)
  assertSafeInteger(retryDelayMs, 'retryDelayMs', 0)

  async function execute(intent: Intent, owner: string): Promise<Outcome> {
    const handler = handlers[intent.kind]
    try {
      if (!handler) throw new NotAppliedError(`No handler registered for intent kind '${intent.kind}'`)
      await handler(intent)
      const completeNow = clock()
      try {
        repository.complete(intent.id, owner, completeNow)
        return 'done'
      } catch {
        // Lease expired or claim fenced: effect may already have applied; do not hide as done.
        return 'unknown'
      }
    } catch (error) {
      const uncertain = isUncertainFailure(intent.kind, error)
      const failNow = clock()
      const retryAt = failNow + retryDelayMs
      if (!Number.isSafeInteger(retryAt)) {
        return uncertain ? 'unknown' : 'failed'
      }
      try {
        const recorded = repository.fail(intent.id, owner, {
          now: failNow,
          retryAt,
          error: redact(errorMessage(error)),
          uncertain,
        })
        if (recorded.status === 'UNKNOWN' || uncertain) return 'unknown'
        return 'failed'
      } catch {
        // Cannot record failure after lease expiry; claim sweep / reconcile handles durability later.
        return uncertain ? 'unknown' : 'failed'
      }
    }
  }

  return {
    async dispatchOnce({ limit = 1 }: DispatchOnceOptions = {}): Promise<DispatchOnceResult> {
      assertSafeInteger(limit, 'limit', 1)
      if (repository.inTransaction) throw new Error('Cannot dispatch external effects inside a database transaction')
      const claimNow = clock()
      const owner = randomUUID()
      const claimed = repository.claim({ owner, now: claimNow, leaseMs, limit })
      const counts: DispatchOnceResult = { claimed: claimed.length, done: 0, unknown: 0, failed: 0 }
      if (claimed.length === 0) return counts

      const outcomes = await Promise.all(claimed.map(intent => execute(intent, owner)))
      for (const outcome of outcomes) counts[outcome] += 1
      return counts
    },
  }
}
