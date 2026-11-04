import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initializeIntentSchema, IntentRepository, type EnqueueIntent } from '../src/orchestration/intents.ts'

let directory: string
const databases: DatabaseSync[] = []

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'durable-intents-')) })
afterEach(() => {
  for (const db of databases.splice(0)) { try { db.close() } catch {} }
  rmSync(directory, { recursive: true, force: true })
})

function connection(path = join(directory, 'state.sqlite')): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000')
  databases.push(db)
  return db
}

function repository(path = join(directory, 'state.sqlite')): IntentRepository {
  const db = connection(path)
  initializeIntentSchema(db)
  return new IntentRepository(db)
}

function intent(id: string, patch: Partial<EnqueueIntent> = {}): EnqueueIntent {
  return { id, kind: 'launch', key: `assignment:${id}`, generation: 1, payload: { id, nested: { a: 1, b: 2 } },
    dueAt: 100, maxAttempts: 3, ...patch }
}

describe('durable intent schema', () => {
  it('is explicit, nested-transaction safe, and rejects future versions before schema writes', () => {
    const db = connection(join(directory, 'nested.sqlite'))
    db.exec('BEGIN')
    initializeIntentSchema(db)
    expect(db.prepare("SELECT value FROM kv WHERE key = 'intent-schema'").get()?.value).toBe('1')
    db.exec('ROLLBACK')
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'orchestration_intent'").get()).toBeUndefined()

    const future = connection(join(directory, 'future.sqlite'))
    future.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO kv VALUES ('intent-schema', '2')")
    expect(() => initializeIntentSchema(future)).toThrow('Unsupported intent schema 2')
    expect(future.prepare("SELECT name FROM sqlite_master WHERE name = 'orchestration_intent'").get()).toBeUndefined()
  })

  it('requires explicit initialization', () => {
    const db = connection()
    expect(() => new IntentRepository(db)).toThrow('not initialized')
  })
})

describe('enqueue and persistence', () => {
  it('uses canonical JSON for idempotency and rejects identity or payload conflicts', () => {
    const repo = repository()
    const payload = { id: 'one', nested: { b: 2, a: 1 } }
    const first = repo.enqueue(intent('one', { payload }))
    payload.nested.a = 99
    expect(first).toEqual({ ...intent('one'), payload: { id: 'one', nested: { a: 1, b: 2 } }, status: 'PENDING', attempts: 0 })
    expect(repo.enqueue(intent('one', { payload: { nested: { a: 1, b: 2 }, id: 'one' } }))).toEqual(first)
    expect(() => repo.enqueue(intent('one', { payload: { changed: true } }))).toThrow('Conflicting')
    expect(() => repo.enqueue(intent('different-id', { key: 'assignment:one' }))).toThrow('Conflicting')
    expect(repo.get('one')?.payload).toEqual({ id: 'one', nested: { a: 1, b: 2 } })
  })

  it('persists records through reopen and returns defensive payload copies', () => {
    const path = join(directory, 'reopen.sqlite')
    const first = repository(path)
    first.enqueue(intent('persisted'))
    databases.at(-1)!.close()
    const reopened = repository(path)
    const read = reopened.get('persisted')!
    ;(read.payload as { id: string }).id = 'mutated'
    expect(reopened.get('persisted')?.payload).toMatchObject({ id: 'persisted' })
    expect(reopened.list().map(item => item.id)).toEqual(['persisted'])
  })

  it('rolls enqueue back with an outer transaction and performs no external work', () => {
    const db = connection(), repo = (() => { initializeIntentSchema(db); return new IntentRepository(db) })()
    db.exec('BEGIN')
    repo.enqueue(intent('rolled-back'))
    db.exec('ROLLBACK')
    expect(repo.list()).toEqual([])
  })
})

describe('claim leases', () => {
  it('claims atomically across connections in due-first stable order', () => {
    const path = join(directory, 'shared.sqlite'), first = repository(path), second = repository(path)
    first.enqueue(intent('later', { dueAt: 20 }))
    first.enqueue(intent('first-tie', { dueAt: 10 }))
    first.enqueue(intent('second-tie', { dueAt: 10 }))
    expect(first.claim({ owner: 'worker-a', now: 10, leaseMs: 50, limit: 2 }).map(item => item.id))
      .toEqual(['first-tie', 'second-tie'])
    expect(first.complete('first-tie', 'worker-a', 11)).toMatchObject({ status: 'DONE', attempts: 1 })
    expect(first.get('first-tie')).not.toHaveProperty('leaseOwner')
    expect(second.claim({ owner: 'worker-b', now: 20, leaseMs: 50, limit: 2 }).map(item => item.id)).toEqual(['later'])
    expect(first.claim({ owner: 'worker-c', now: 20, leaseMs: 50, limit: 1 })).toEqual([])
    expect(() => first.claim({ owner: 'worker', now: 1, leaseMs: 1, limit: 0 })).toThrow('limit')
  })

  it('fences the owner and lease time on completion', () => {
    const repo = repository()
    repo.enqueue(intent('fenced', { dueAt: 0 }))
    repo.claim({ owner: 'current', now: 10, leaseMs: 10, limit: 1 })
    expect(() => repo.complete('fenced', 'stale', 19)).toThrow('this owner')
    expect(() => repo.complete('fenced', 'current', 20)).toThrow('expired')
    expect(repo.get('fenced')?.status).toBe('CLAIMED')
  })

  it('quarantines unsafe expired effects while safely retrying expired stops with audit', () => {
    const db = connection(), repo = (() => { initializeIntentSchema(db); return new IntentRepository(db) })()
    repo.enqueue(intent('launch', { dueAt: 0, kind: 'launch' }))
    repo.enqueue(intent('writeback', { dueAt: 0, kind: 'writeback' }))
    repo.enqueue(intent('stop', { dueAt: 0, kind: 'stop', maxAttempts: 2 }))
    repo.claim({ owner: 'crashed', now: 0, leaseMs: 10, limit: 3 })
    const reclaimed = repo.claim({ owner: 'recovery', now: 10, leaseMs: 10, limit: 3 })
    expect(reclaimed.map(item => item.id)).toEqual(['stop'])
    expect(repo.get('launch')).toMatchObject({ status: 'UNKNOWN', attempts: 1 })
    expect(repo.get('writeback')).toMatchObject({ status: 'UNKNOWN', attempts: 1 })
    expect(repo.get('stop')).toMatchObject({ status: 'CLAIMED', attempts: 2, leaseOwner: 'recovery' })
    expect(db.prepare("SELECT reason FROM orchestration_intent_audit WHERE intent_id = 'stop' AND action = 'lease-expired'").get()?.reason)
      .toContain('safe to retry')
  })
})

describe('failure and reconciliation', () => {
  it('backs off known failures and fails after max attempts', () => {
    const repo = repository()
    repo.enqueue(intent('bounded', { dueAt: 0, maxAttempts: 2 }))
    repo.claim({ owner: 'one', now: 0, leaseMs: 10, limit: 1 })
    expect(repo.fail('bounded', 'one', { now: 1, retryAt: 20, error: 'temporary', uncertain: false }))
      .toMatchObject({ status: 'PENDING', attempts: 1, dueAt: 20 })
    expect(repo.claim({ owner: 'early', now: 19, leaseMs: 10, limit: 1 })).toEqual([])
    repo.claim({ owner: 'two', now: 20, leaseMs: 10, limit: 1 })
    expect(repo.fail('bounded', 'two', { now: 21, retryAt: 30, error: 'permanent', uncertain: false }))
      .toMatchObject({ status: 'FAILED', attempts: 2 })
  })

  it('keeps uncertain attempt counts and reconciles only UNKNOWN with a durable reason', () => {
    const db = connection(), repo = (() => { initializeIntentSchema(db); return new IntentRepository(db) })()
    repo.enqueue(intent('uncertain', { dueAt: 0, maxAttempts: 2 }))
    repo.claim({ owner: 'worker', now: 0, leaseMs: 10, limit: 1 })
    expect(repo.fail('uncertain', 'worker', { now: 1, retryAt: 2, error: 'lost acknowledgement', uncertain: true }))
      .toMatchObject({ status: 'UNKNOWN', attempts: 1 })
    expect(repo.reconcile('uncertain', { decision: 'retry', reason: 'Remote target shows no delivery marker', now: 5 }))
      .toMatchObject({ status: 'PENDING', attempts: 1, dueAt: 5 })
    expect(db.prepare("SELECT reason FROM orchestration_intent_audit WHERE intent_id = 'uncertain' AND action = 'reconciled'").get()?.reason)
      .toBe('Remote target shows no delivery marker')
    expect(repo.claim({ owner: 'authorized-retry', now: 5, leaseMs: 10, limit: 1 })[0])
      .toMatchObject({ status: 'CLAIMED', attempts: 2 })
    expect(() => repo.reconcile('uncertain', { decision: 'done', reason: 'duplicate decision', now: 6 })).toThrow('Only UNKNOWN')
  })

  it('records a reconciled done decision and never executes an effect itself', () => {
    const repo = repository()
    repo.enqueue(intent('done-after-check', { dueAt: 0 }))
    repo.claim({ owner: 'worker', now: 0, leaseMs: 1, limit: 1 })
    repo.claim({ owner: 'sweeper', now: 1, leaseMs: 1, limit: 1 })
    expect(repo.reconcile('done-after-check', { decision: 'done', reason: 'Execution registry proves launch completed', now: 2 }))
      .toMatchObject({ status: 'DONE', attempts: 1 })
  })
})

it('does not bypass attempt limits through uncertain reconciliation', () => {
  const repo = repository()
  repo.enqueue(intent('exhausted-unknown', { dueAt: 0, maxAttempts: 1 }))
  repo.claim({ owner: 'owner', now: 0, leaseMs: 10, limit: 1 })
  repo.fail('exhausted-unknown', 'owner', { now: 1, retryAt: 2, error: 'unknown', uncertain: true })
  expect(() => repo.reconcile('exhausted-unknown', { decision: 'retry', reason: 'retry anyway', now: 2 })).toThrow('Maximum attempts')
  expect(repo.get('exhausted-unknown')?.status).toBe('UNKNOWN')
})
