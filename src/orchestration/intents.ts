import type { DatabaseSync } from 'node:sqlite'

export const INTENT_STATUSES = ['PENDING', 'CLAIMED', 'DONE', 'FAILED', 'UNKNOWN'] as const
export type IntentStatus = typeof INTENT_STATUSES[number]
export type IntentKind = 'launch' | 'stop' | 'writeback'
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue }

export interface IntentAudit {
  at: number
  action: 'enqueued' | 'claimed' | 'completed' | 'failed' | 'uncertain' | 'lease-expired' | 'reconciled'
  from?: IntentStatus
  to: IntentStatus
  owner?: string
  reason?: string
  error?: string
}

export interface Intent {
  id: string
  kind: IntentKind
  key: string
  generation: number
  payload: JsonValue
  dueAt: number
  maxAttempts: number
  status: IntentStatus
  attempts: number
  leaseOwner?: string
  leaseUntil?: number
}

export interface EnqueueIntent {
  id: string
  kind: IntentKind
  key: string
  generation: number
  payload: JsonValue
  dueAt: number
  maxAttempts: number
}

export interface ClaimIntents {
  owner: string
  now: number
  leaseMs: number
  limit: number
}

export interface FailIntent {
  now: number
  retryAt: number
  error: string
  uncertain: boolean
}

export interface ReconcileIntent {
  decision: 'retry' | 'done'
  reason: string
  now: number
}

type Row = Record<string, unknown>

const VERSION_KEY = 'intent-schema'
const VERSION = 1
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const KINDS: readonly IntentKind[] = ['launch', 'stop', 'writeback']
let savepointSequence = 0

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

function readVersion(db: DatabaseSync): number | undefined {
  if (!tableExists(db, 'kv')) return undefined
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(VERSION_KEY)
  if (!row) return undefined
  let value: unknown
  try { value = JSON.parse(String(row.value)) } catch { throw new Error('Invalid intent schema metadata') }
  if (!Number.isInteger(value)) throw new Error('Invalid intent schema metadata')
  return value as number
}

function atomic<T>(db: DatabaseSync, operation: () => T): T {
  const name = `intent_repository_${++savepointSequence}`
  db.exec(`SAVEPOINT ${name}`)
  try {
    const result = operation()
    db.exec(`RELEASE ${name}`)
    return result
  } catch (error) {
    db.exec(`ROLLBACK TO ${name}`)
    db.exec(`RELEASE ${name}`)
    throw error
  }
}

function assertExactKeys(value: object, allowed: readonly string[], label: string): void {
  const keys = Object.keys(value)
  if (keys.some(key => !allowed.includes(key)) || keys.length !== allowed.length || allowed.some(key => !keys.includes(key)))
    throw new Error(`Invalid ${label}`)
}

function assertSafeInteger(value: unknown, label: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`${label} must be a safe integer >= ${minimum}`)
}

function assertText(value: unknown, label: string, maximum: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0')) throw new Error(`Invalid ${label}`)
}

function canonicalJson(value: unknown): string {
  const ancestors = new Set<object>()
  const visit = (item: unknown): JsonValue => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Intent payload must contain only finite JSON values')
      return Object.is(item, -0) ? 0 : item
    }
    if (typeof item !== 'object') throw new Error('Intent payload must be JSON serializable')
    if (ancestors.has(item)) throw new Error('Intent payload must not be cyclic')
    ancestors.add(item)
    try {
      if (Array.isArray(item)) {
        if (Object.keys(item).length !== item.length || Reflect.ownKeys(item).some(key => key !== 'length' && !/^\d+$/.test(String(key))))
          throw new Error('Intent payload arrays must not be sparse or have extra properties')
        return item.map(visit)
      }
      const prototype = Object.getPrototypeOf(item)
      if (prototype !== Object.prototype && prototype !== null) throw new Error('Intent payload objects must be plain objects')
      const descriptors = Object.getOwnPropertyDescriptors(item)
      if (Reflect.ownKeys(item).some(key => typeof key !== 'string')
        || Object.values(descriptors).some(descriptor => !descriptor.enumerable || !('value' in descriptor)))
        throw new Error('Intent payload objects must contain enumerable data properties only')
      const output = Object.create(null) as { [key: string]: JsonValue }
      for (const key of Object.keys(item).sort()) output[key] = visit(descriptors[key]!.value)
      return output
    } finally { ancestors.delete(item) }
  }
  return JSON.stringify(visit(value))
}

function validateEnqueue(input: EnqueueIntent): { payload: string; request: string } {
  if (!input || typeof input !== 'object') throw new Error('Invalid intent')
  assertExactKeys(input, ['id', 'kind', 'key', 'generation', 'payload', 'dueAt', 'maxAttempts'], 'intent')
  if (typeof input.id !== 'string' || !ID.test(input.id)) throw new Error('Invalid intent id')
  if (!KINDS.includes(input.kind)) throw new Error('Invalid intent kind')
  assertText(input.key, 'intent key', 512)
  assertSafeInteger(input.generation, 'generation', 1)
  assertSafeInteger(input.dueAt, 'dueAt')
  assertSafeInteger(input.maxAttempts, 'maxAttempts', 1)
  const payload = canonicalJson(input.payload)
  const request = canonicalJson({ id: input.id, kind: input.kind, key: input.key, generation: input.generation,
    payload: JSON.parse(payload) as JsonValue, dueAt: input.dueAt, maxAttempts: input.maxAttempts })
  return { payload, request }
}

function status(value: unknown): IntentStatus {
  if (typeof value !== 'string' || !INTENT_STATUSES.includes(value as IntentStatus)) throw new Error('Invalid stored intent status')
  return value as IntentStatus
}

/** Explicitly installs version 1 of the durable-intent schema. Safe inside an existing transaction. */
export function initializeIntentSchema(db: DatabaseSync): void {
  const existing = readVersion(db)
  const ownsTables = tableExists(db, 'orchestration_intent') || tableExists(db, 'orchestration_intent_audit')
  if (existing !== undefined && existing !== VERSION) throw new Error(`Unsupported intent schema ${existing}`)
  if (existing === undefined && ownsTables) throw new Error('Unversioned intent schema; refusing implicit migration')
  atomic(db, () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orchestration_intent (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('launch', 'stop', 'writeback')),
        intent_key TEXT NOT NULL,
        generation INTEGER NOT NULL CHECK (generation > 0),
        payload TEXT NOT NULL,
        request TEXT NOT NULL,
        initial_due_at INTEGER NOT NULL,
        due_at INTEGER NOT NULL,
        max_attempts INTEGER NOT NULL CHECK (max_attempts > 0),
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'CLAIMED', 'DONE', 'FAILED', 'UNKNOWN')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        lease_owner TEXT,
        lease_until INTEGER,
        last_error TEXT,
        UNIQUE (intent_key, kind, generation),
        CHECK ((status = 'CLAIMED' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
          OR (status <> 'CLAIMED' AND lease_owner IS NULL AND lease_until IS NULL))
      );
      CREATE INDEX IF NOT EXISTS orchestration_intent_due
        ON orchestration_intent (status, due_at, sequence);
      CREATE TABLE IF NOT EXISTS orchestration_intent_audit (
        event_id INTEGER PRIMARY KEY AUTOINCREMENT,
        intent_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        action TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        owner TEXT,
        reason TEXT,
        error TEXT,
        FOREIGN KEY (intent_id) REFERENCES orchestration_intent(id)
      );
      CREATE INDEX IF NOT EXISTS orchestration_intent_audit_intent
        ON orchestration_intent_audit (intent_id, event_id);
    `)
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(VERSION_KEY, JSON.stringify(VERSION))
  })
}

/** SQLite-backed queue for durable launch, stop, and writeback effects. It performs no external effects. */
export class IntentRepository {
  constructor(private readonly db: DatabaseSync) {
    const version = readVersion(db)
    if (version !== VERSION) throw new Error(version === undefined ? 'Intent schema is not initialized' : `Unsupported intent schema ${version}`)
    if (!tableExists(db, 'orchestration_intent') || !tableExists(db, 'orchestration_intent_audit'))
      throw new Error('Intent schema is incomplete')
  }

  get inTransaction(): boolean { return this.db.isTransaction }

  private audit(id: string, event: IntentAudit): void {
    this.db.prepare(`INSERT INTO orchestration_intent_audit
      (intent_id, at, action, from_status, to_status, owner, reason, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, event.at, event.action, event.from ?? null, event.to, event.owner ?? null, event.reason ?? null, event.error ?? null)
  }

  private history(id: string): IntentAudit[] {
    return this.db.prepare(`SELECT at, action, from_status, to_status, owner, reason, error
      FROM orchestration_intent_audit WHERE intent_id = ? ORDER BY event_id`).all(id).map(row => ({
      at: Number(row.at), action: String(row.action) as IntentAudit['action'],
      ...(row.from_status === null ? {} : { from: status(row.from_status) }), to: status(row.to_status),
      ...(row.owner === null ? {} : { owner: String(row.owner) }),
      ...(row.reason === null ? {} : { reason: String(row.reason) }),
      ...(row.error === null ? {} : { error: String(row.error) }),
    }))
  }

  private intent(row: Row): Intent {
    const payload = JSON.parse(String(row.payload)) as JsonValue
    const result: Intent = {
      id: String(row.id), kind: String(row.kind) as IntentKind, key: String(row.intent_key), generation: Number(row.generation),
      payload, dueAt: Number(row.due_at), maxAttempts: Number(row.max_attempts), status: status(row.status),
      attempts: Number(row.attempts),
    }
    if (row.lease_owner !== null) result.leaseOwner = String(row.lease_owner)
    if (row.lease_until !== null) result.leaseUntil = Number(row.lease_until)
    return result
  }

  private row(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM orchestration_intent WHERE id = ?').get(id)
  }

  private requireClaim(id: string, owner: string, now: number): Row {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid intent id')
    assertText(owner, 'lease owner', 256)
    assertSafeInteger(now, 'now')
    const row = this.row(id)
    if (!row) throw new Error(`Unknown intent: ${id}`)
    if (row.status !== 'CLAIMED' || row.lease_owner !== owner) throw new Error('Intent is not claimed by this owner')
    if (Number(row.lease_until) <= now) throw new Error('Intent lease has expired')
    return row
  }

  enqueue(input: EnqueueIntent): Intent {
    const canonical = validateEnqueue(input)
    return atomic(this.db, () => {
      this.db.prepare(`INSERT OR IGNORE INTO orchestration_intent
        (id, kind, intent_key, generation, payload, request, initial_due_at, due_at, max_attempts, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')`)
        .run(input.id, input.kind, input.key, input.generation, canonical.payload, canonical.request, input.dueAt, input.dueAt, input.maxAttempts)
      const byId = this.row(input.id)
      const byIdentity = this.db.prepare('SELECT * FROM orchestration_intent WHERE intent_key = ? AND kind = ? AND generation = ?')
        .get(input.key, input.kind, input.generation)
      if (!byId || !byIdentity || byId.id !== byIdentity.id || byId.request !== canonical.request)
        throw new Error('Conflicting intent identity or payload')
      if (!this.db.prepare('SELECT 1 FROM orchestration_intent_audit WHERE intent_id = ? LIMIT 1').get(input.id))
        this.audit(input.id, { at: Date.now(), action: 'enqueued', to: 'PENDING' })
      return this.intent(byId)
    })
  }

  get(id: string): Intent | undefined {
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid intent id')
    const row = this.row(id)
    return row ? this.intent(row) : undefined
  }

  list(): Intent[] {
    return this.db.prepare('SELECT * FROM orchestration_intent ORDER BY sequence').all().map(row => this.intent(row))
  }

  claim(input: ClaimIntents): Intent[] {
    if (!input || typeof input !== 'object') throw new Error('Invalid claim')
    assertExactKeys(input, ['owner', 'now', 'leaseMs', 'limit'], 'claim')
    assertText(input.owner, 'lease owner', 256)
    assertSafeInteger(input.now, 'now')
    assertSafeInteger(input.leaseMs, 'leaseMs', 1)
    assertSafeInteger(input.limit, 'limit', 1)
    const leaseUntil = input.now + input.leaseMs
    if (!Number.isSafeInteger(leaseUntil)) throw new Error('leaseUntil exceeds the safe integer range')
    return atomic(this.db, () => {
      const unsafe = this.db.prepare(`UPDATE orchestration_intent
        SET status = 'UNKNOWN', lease_owner = NULL, lease_until = NULL
        WHERE status = 'CLAIMED' AND lease_until <= ? AND kind IN ('launch', 'writeback') RETURNING *`).all(input.now)
      for (const row of unsafe) this.audit(String(row.id), { at: input.now, action: 'lease-expired', from: 'CLAIMED', to: 'UNKNOWN',
        reason: 'Lease expired; effect outcome requires reconciliation' })

      const exhaustedStops = this.db.prepare(`UPDATE orchestration_intent
        SET status = 'FAILED', lease_owner = NULL, lease_until = NULL
        WHERE status = 'CLAIMED' AND lease_until <= ? AND kind = 'stop' AND attempts >= max_attempts RETURNING *`).all(input.now)
      for (const row of exhaustedStops) this.audit(String(row.id), { at: input.now, action: 'lease-expired', from: 'CLAIMED', to: 'FAILED',
        reason: 'Stop lease expired after maximum attempts' })

      const retryStops = this.db.prepare(`UPDATE orchestration_intent
        SET status = 'PENDING', due_at = ?, lease_owner = NULL, lease_until = NULL
        WHERE status = 'CLAIMED' AND lease_until <= ? AND kind = 'stop' AND attempts < max_attempts RETURNING *`).all(input.now, input.now)
      for (const row of retryStops) this.audit(String(row.id), { at: input.now, action: 'lease-expired', from: 'CLAIMED', to: 'PENDING',
        reason: 'Expired stop is safe to retry' })

      const claimed = this.db.prepare(`UPDATE orchestration_intent
        SET status = 'CLAIMED', attempts = attempts + 1, lease_owner = ?, lease_until = ?
        WHERE sequence IN (SELECT sequence FROM orchestration_intent
          WHERE status = 'PENDING' AND due_at <= ?
          ORDER BY due_at, sequence LIMIT ?)
        RETURNING *`).all(input.owner, leaseUntil, input.now, input.limit)
      claimed.sort((left, right) => Number(left.due_at) - Number(right.due_at) || Number(left.sequence) - Number(right.sequence))
      for (const row of claimed) this.audit(String(row.id), { at: input.now, action: 'claimed', from: 'PENDING', to: 'CLAIMED', owner: input.owner })
      return claimed.map(row => this.intent(row))
    })
  }

  complete(id: string, owner: string, now = Date.now()): Intent {
    return atomic(this.db, () => {
      this.requireClaim(id, owner, now)
      const row = this.db.prepare(`UPDATE orchestration_intent SET status = 'DONE', lease_owner = NULL, lease_until = NULL
        WHERE id = ? AND status = 'CLAIMED' AND lease_owner = ? AND lease_until > ? RETURNING *`).get(id, owner, now)
      if (!row) throw new Error('Intent claim changed before completion')
      this.audit(id, { at: now, action: 'completed', from: 'CLAIMED', to: 'DONE', owner })
      return this.intent(row)
    })
  }

  fail(id: string, owner: string, input: FailIntent): Intent {
    if (!input || typeof input !== 'object') throw new Error('Invalid failure')
    assertExactKeys(input, ['now', 'retryAt', 'error', 'uncertain'], 'failure')
    assertSafeInteger(input.now, 'now')
    assertSafeInteger(input.retryAt, 'retryAt')
    assertText(input.error, 'failure error', 8192)
    if (typeof input.uncertain !== 'boolean') throw new Error('Invalid uncertain flag')
    return atomic(this.db, () => {
      const before = this.requireClaim(id, owner, input.now)
      let next: IntentStatus
      let dueAt = Number(before.due_at)
      if (input.uncertain) next = 'UNKNOWN'
      else if (Number(before.attempts) >= Number(before.max_attempts)) next = 'FAILED'
      else {
        if (input.retryAt < input.now) throw new Error('retryAt must not be earlier than now')
        next = 'PENDING'
        dueAt = input.retryAt
      }
      const row = this.db.prepare(`UPDATE orchestration_intent
        SET status = ?, due_at = ?, lease_owner = NULL, lease_until = NULL, last_error = ?
        WHERE id = ? AND status = 'CLAIMED' AND lease_owner = ? AND lease_until > ? RETURNING *`)
        .get(next, dueAt, input.error, id, owner, input.now)
      if (!row) throw new Error('Intent claim changed before failure was recorded')
      this.audit(id, { at: input.now, action: input.uncertain ? 'uncertain' : 'failed', from: 'CLAIMED', to: next,
        owner, error: input.error, reason: input.uncertain ? 'Effect outcome is uncertain' : next === 'FAILED' ? 'Maximum attempts exhausted' : 'Known failure scheduled for retry' })
      return this.intent(row)
    })
  }

  reconcile(id: string, input: ReconcileIntent): Intent {
    if (!input || typeof input !== 'object') throw new Error('Invalid reconciliation')
    assertExactKeys(input, ['decision', 'reason', 'now'], 'reconciliation')
    if (input.decision !== 'retry' && input.decision !== 'done') throw new Error('Invalid reconciliation decision')
    assertText(input.reason, 'reconciliation reason', 8192)
    assertSafeInteger(input.now, 'now')
    if (typeof id !== 'string' || !ID.test(id)) throw new Error('Invalid intent id')
    return atomic(this.db, () => {
      const before = this.row(id)
      if (!before) throw new Error(`Unknown intent: ${id}`)
      if (before.status !== 'UNKNOWN') throw new Error('Only UNKNOWN intents can be reconciled')
      if (input.decision === 'retry' && Number(before.attempts) >= Number(before.max_attempts)) throw new Error('Maximum attempts exhausted; explicit policy change required')
      // Authorization belongs to the application. Reconciliation is the explicit, audited path by which an
      // authorized human/system may retry uncertain work; attempts are retained and the next claim increments them.
      const next: IntentStatus = input.decision === 'done' ? 'DONE' : 'PENDING'
      const row = this.db.prepare(`UPDATE orchestration_intent
        SET status = ?, due_at = ?, lease_owner = NULL, lease_until = NULL
        WHERE id = ? AND status = 'UNKNOWN' RETURNING *`).get(next, input.now, id)
      if (!row) throw new Error('Intent changed before reconciliation')
      this.audit(id, { at: input.now, action: 'reconciled', from: 'UNKNOWN', to: next, reason: input.reason })
      return this.intent(row)
    })
  }
}
