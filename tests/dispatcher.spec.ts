import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IntentDispatcher, NotAppliedError } from '../src/orchestration/dispatcher.ts'
import { initializeIntentSchema, IntentRepository, type EnqueueIntent, type Intent } from '../src/orchestration/intents.ts'

let directory: string
const databases: DatabaseSync[] = []

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'intent-dispatcher-')) })
afterEach(() => {
  for (const db of databases.splice(0)) { try { db.close() } catch { /* ignore */ } }
  rmSync(directory, { recursive: true, force: true })
})

function connection(path = join(directory, 'state.sqlite')): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000')
  databases.push(db)
  return db
}

function setup(path = join(directory, 'state.sqlite')): { db: DatabaseSync; repository: IntentRepository } {
  const db = connection(path)
  initializeIntentSchema(db)
  return { db, repository: new IntentRepository(db) }
}

function intent(id: string, patch: Partial<EnqueueIntent> = {}): EnqueueIntent {
  return {
    id, kind: 'launch', key: `assignment:${id}`, generation: 1,
    payload: { id }, dueAt: 0, maxAttempts: 3, ...patch,
  }
}

describe('IntentDispatcher', () => {
  it('runs handlers outside a DB transaction and completes without repeating side effects', async () => {
    const { db, repository } = setup()
    repository.enqueue(intent('once'))
    let sideEffects = 0
    let sawTransaction: boolean | undefined
    const dispatcher = IntentDispatcher({
      repository,
      leaseMs: 1_000,
      now: () => 10,
      handlers: {
        async launch(item) {
          sawTransaction = db.isTransaction
          expect(item.id).toBe('once')
          sideEffects += 1
        },
      },
    })

    await expect(dispatcher.dispatchOnce()).resolves.toEqual({ claimed: 1, done: 1, unknown: 0, failed: 0 })
    expect(sawTransaction).toBe(false)
    expect(sideEffects).toBe(1)
    expect(repository.get('once')).toMatchObject({ status: 'DONE', attempts: 1 })

    await expect(dispatcher.dispatchOnce()).resolves.toEqual({ claimed: 0, done: 0, unknown: 0, failed: 0 })
    expect(sideEffects).toBe(1)
  })

  it('treats launch/writeback NotAppliedError as known bounded retry and generic throws as UNKNOWN', async () => {
    const { repository } = setup()
    repository.enqueue(intent('known', { maxAttempts: 2 }))
    repository.enqueue(intent('uncertain', { kind: 'writeback', key: 'wb:uncertain', maxAttempts: 2 }))
    let clock = 0
    const dispatcher = IntentDispatcher({
      repository,
      leaseMs: 50,
      retryDelayMs: 20,
      now: () => clock,
      handlers: {
        async launch() { throw new NotAppliedError('precondition failed') },
        async writeback() { throw new Error('lost ack') },
      },
    })

    clock = 0
    await expect(dispatcher.dispatchOnce({ limit: 2 })).resolves.toEqual({
      claimed: 2, done: 0, unknown: 1, failed: 1,
    })
    expect(repository.get('known')).toMatchObject({ status: 'PENDING', attempts: 1, dueAt: 20 })
    expect(repository.get('uncertain')).toMatchObject({ status: 'UNKNOWN', attempts: 1 })

    clock = 20
    await expect(dispatcher.dispatchOnce()).resolves.toEqual({ claimed: 1, done: 0, unknown: 0, failed: 1 })
    expect(repository.get('known')).toMatchObject({ status: 'FAILED', attempts: 2 })
    expect(repository.get('uncertain')?.status).toBe('UNKNOWN')
  })

  it('retries stop failures as known-safe and never auto-reconciles UNKNOWN effects', async () => {
    const { repository } = setup()
    repository.enqueue(intent('stop-me', { kind: 'stop', key: 'stop:1', maxAttempts: 2 }))
    repository.enqueue(intent('launch-me', { maxAttempts: 2 }))
    let clock = 0
    const dispatcher = IntentDispatcher({
      repository,
      leaseMs: 50,
      retryDelayMs: 5,
      now: () => clock,
      handlers: {
        async stop() { throw new Error('process still shutting down') },
        async launch() { throw new Error('maybe launched') },
      },
    })

    clock = 0
    const first = await dispatcher.dispatchOnce({ limit: 2 })
    expect(first).toEqual({ claimed: 2, done: 0, unknown: 1, failed: 1 })
    expect(repository.get('stop-me')).toMatchObject({ status: 'PENDING', attempts: 1, dueAt: 5 })
    expect(repository.get('launch-me')).toMatchObject({ status: 'UNKNOWN', attempts: 1 })

    clock = 5
    await expect(dispatcher.dispatchOnce()).resolves.toEqual({ claimed: 1, done: 0, unknown: 0, failed: 1 })
    expect(repository.get('stop-me')).toMatchObject({ status: 'FAILED', attempts: 2 })
    expect(repository.get('launch-me')?.status).toBe('UNKNOWN')
    expect(() => repository.reconcile('launch-me', {
      decision: 'retry', reason: 'dispatcher must not have reconciled', now: 6,
    })).not.toThrow()
    expect(repository.get('launch-me')).toMatchObject({ status: 'PENDING', attempts: 1 })
  })

  it('records missing handlers as NotAppliedError and exhausts max attempts', async () => {
    const { repository } = setup()
    repository.enqueue(intent('no-handler', { maxAttempts: 1 }))
    const dispatcher = IntentDispatcher({
      repository,
      leaseMs: 100,
      retryDelayMs: 1,
      now: () => 1,
      handlers: {},
    })

    await expect(dispatcher.dispatchOnce()).resolves.toEqual({ claimed: 1, done: 0, unknown: 0, failed: 1 })
    expect(repository.get('no-handler')).toMatchObject({ status: 'FAILED', attempts: 1 })
  })

  it('cannot complete after lease expiry; claim sweep quarantines launch and safely retries stop', async () => {
    const { repository } = setup()
    repository.enqueue(intent('slow-launch'))
    repository.enqueue(intent('slow-stop', { kind: 'stop', key: 'stop:slow', maxAttempts: 3 }))

    let clock = 0
    const release = new Map<string, () => void>()
    const blockers = new Map<string, Promise<void>>()
    for (const id of ['slow-launch', 'slow-stop']) {
      blockers.set(id, new Promise<void>(resolve => { release.set(id, resolve) }))
    }

    const dispatcher = IntentDispatcher({
      repository,
      leaseMs: 10,
      retryDelayMs: 1,
      now: () => clock,
      handlers: {
        async launch(item: Intent) { await blockers.get(item.id) },
        async stop(item: Intent) { await blockers.get(item.id) },
      },
    })

    clock = 0
    const running = dispatcher.dispatchOnce({ limit: 2 })
    clock = 10
    for (const unlock of release.values()) unlock()
    const result = await running
    expect(result.claimed).toBe(2)
    expect(result.done).toBe(0)
    expect(result.unknown + result.failed).toBe(2)
    expect(repository.get('slow-launch')?.status).toBe('CLAIMED')
    expect(repository.get('slow-stop')?.status).toBe('CLAIMED')

    clock = 10
    const swept = await dispatcher.dispatchOnce({ limit: 2 })
    expect(repository.get('slow-launch')).toMatchObject({ status: 'UNKNOWN', attempts: 1 })
    // Expired stop is safely requeued by claim sweep and may complete on the retry claim.
    expect(repository.get('slow-stop')).toMatchObject({ status: 'DONE', attempts: 2 })
    expect(swept).toEqual({ claimed: 1, done: 1, unknown: 0, failed: 0 })
  })

  it('dispatches up to the requested limit in parallel with a stable claim timestamp', async () => {
    const { db, repository } = setup()
    repository.enqueue(intent('a', { dueAt: 1 }))
    repository.enqueue(intent('b', { dueAt: 2 }))
    repository.enqueue(intent('c', { dueAt: 3 }))

    let claimReads = 0
    const originalClaim = repository.claim.bind(repository)
    repository.claim = ((input) => {
      claimReads += 1
      expect(input.now).toBe(100)
      expect(input.limit).toBe(3)
      return originalClaim(input)
    }) as IntentRepository['claim']

    let inFlight = 0
    let maxInFlight = 0
    const started: string[] = []
    const dispatcher = IntentDispatcher({
      repository,
      leaseMs: 1_000,
      now: () => 100,
      handlers: {
        async launch(item) {
          expect(db.isTransaction).toBe(false)
          started.push(item.id)
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise(resolve => setTimeout(resolve, 20))
          inFlight -= 1
        },
      },
    })

    await expect(dispatcher.dispatchOnce({ limit: 3 })).resolves.toEqual({
      claimed: 3, done: 3, unknown: 0, failed: 0,
    })
    expect(claimReads).toBe(1)
    expect(started).toEqual(['a', 'b', 'c'])
    expect(maxInFlight).toBeGreaterThan(1)
    expect(repository.list().every(item => item.status === 'DONE')).toBe(true)
  })

  it('uses post-execution now for complete/fail and never counts UNKNOWN as done', async () => {
    const { repository } = setup()
    repository.enqueue(intent('timed'))
    const stamps: number[] = []
    let clock = 5
    const dispatcher = IntentDispatcher({
      repository,
      leaseMs: 100,
      now: () => {
        stamps.push(clock)
        return clock
      },
      handlers: {
        async launch() { clock = 40 },
      },
    })

    await expect(dispatcher.dispatchOnce()).resolves.toEqual({ claimed: 1, done: 1, unknown: 0, failed: 0 })
    expect(stamps[0]).toBe(5)
    expect(stamps.at(-1)).toBe(40)
    expect(repository.get('timed')).toMatchObject({ status: 'DONE' })

    repository.enqueue(intent('boom', { key: 'assignment:boom' }))
    clock = 50
    const failing = IntentDispatcher({
      repository,
      leaseMs: 100,
      retryDelayMs: 7,
      now: () => clock,
      handlers: {
        async launch() {
          clock = 60
          throw new Error('uncertain')
        },
      },
    })
    await expect(failing.dispatchOnce()).resolves.toEqual({ claimed: 1, done: 0, unknown: 1, failed: 0 })
    expect(repository.get('boom')).toMatchObject({ status: 'UNKNOWN', attempts: 1 })
  })
})


it('refuses dispatch when an outer caller transaction remains active', async () => {
  const { db, repository } = setup()
  repository.enqueue(intent('outer-tx'))
  let effects = 0
  const dispatcher = IntentDispatcher({ repository, handlers: { launch: async () => { effects++ } } })
  db.exec('SAVEPOINT caller')
  try { await expect(dispatcher.dispatchOnce()).rejects.toThrow('inside a database transaction') }
  finally { db.exec('ROLLBACK TO caller; RELEASE caller') }
  expect(effects).toBe(0)
  expect(repository.get('outer-tx')?.status).toBe('PENDING')
})
