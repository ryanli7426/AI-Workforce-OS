import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExecutionRepository, initializeExecutionSchema } from '../src/execution/repository.ts'
import type { ExecutionEvent, ExecutionSpec, ExecutionState } from '../src/execution/model.ts'

let directory: string
const databases: DatabaseSync[] = []

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'execution-repository-')) })
afterEach(() => {
  for (const database of databases.splice(0)) { try { database.close() } catch {} }
  rmSync(directory, { recursive: true, force: true })
})

function open(path = join(directory, 'store.sqlite')): DatabaseSync {
  const database = new DatabaseSync(path)
  database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  databases.push(database)
  return database
}

function close(database: DatabaseSync): void {
  database.close()
  databases.splice(databases.indexOf(database), 1)
}

function spec(overrides: Partial<ExecutionSpec> = {}): ExecutionSpec {
  return {
    executionId: 'execution-1',
    assignmentId: 'assignment-1',
    ticketId: 'ticket-1',
    agentId: 'agent-1',
    runtime: 'local-runner',
    generation: 1,
    cwd: join(directory, 'worktree-1'),
    inputRevision: 'sha256:input-1',
    policyVersion: 'policy-1',
    ...overrides,
  }
}

function event(sequence: number, state: ExecutionState, overrides: Partial<ExecutionEvent> = {}): ExecutionEvent {
  return {
    executionId: 'execution-1',
    generation: 1,
    sequence,
    at: new Date(Date.UTC(2026, 0, 1, 0, 0, sequence)).toISOString(),
    state,
    runnerId: 'runner-1',
    runnerPid: 101,
    ...overrides,
  }
}

describe('execution schema initialization', () => {
  it('is explicit, savepoint-safe, and records its independent schema version', () => {
    const database = open()
    database.exec('BEGIN')
    initializeExecutionSchema(database)
    expect(database.prepare("SELECT value FROM kv WHERE key = 'execution-schema'").get()?.value).toBe('1')
    database.exec('ROLLBACK')

    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'execution'").get()).toBeUndefined()
    expect(database.prepare("SELECT value FROM kv WHERE key = 'execution-schema'").get()).toBeUndefined()

    initializeExecutionSchema(database)
    initializeExecutionSchema(database)
    expect(database.prepare("SELECT value FROM kv WHERE key = 'execution-schema'").get()?.value).toBe('1')
  })

  it('rejects an unknown version before modifying execution schema', () => {
    const database = open()
    database.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('execution-schema', '2')

    expect(() => initializeExecutionSchema(database)).toThrow(/Unknown execution schema version/)
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'execution'").get()).toBeUndefined()
  })
})

describe('ExecutionRepository', () => {
  it('persists reservations and ordered events across a close and reopen', () => {
    const path = join(directory, 'reopen.sqlite')
    const first = open(path)
    initializeExecutionSchema(first)
    const repository = new ExecutionRepository(first)
    const reserved = repository.reserve(spec())
    expect(reserved).toMatchObject({ state: 'STARTING', lastSequence: 0 })
    repository.apply(event(1, 'STARTING'))
    repository.apply(event(2, 'RUNNING', { processId: 202, sessionId: 'session-1' }))
    close(first)

    const reopened = open(path)
    const recovered = new ExecutionRepository(reopened)
    expect(recovered.get('execution-1')).toMatchObject({
      state: 'RUNNING', runnerId: 'runner-1', runnerPid: 101, processId: 202, sessionId: 'session-1', lastSequence: 2,
    })
    expect(recovered.events('execution-1', 1).map(item => item.sequence)).toEqual([2])
    expect(recovered.list()).toHaveLength(1)
  })

  it('makes reserve idempotent only for an exactly equal spec', () => {
    const database = open()
    initializeExecutionSchema(database)
    const repository = new ExecutionRepository(database)
    const original = spec()

    expect(repository.reserve(original)).toEqual(repository.reserve({ ...original }))
    expect(() => repository.reserve({ ...original, policyVersion: 'policy-2' })).toThrow(/different spec/)
    expect(repository.list()).toHaveLength(1)
  })

  it('enforces active ticket, assignment, and cwd reservations across connections', () => {
    const path = join(directory, 'concurrent.sqlite')
    const firstDatabase = open(path)
    initializeExecutionSchema(firstDatabase)
    const secondDatabase = open(path)
    const first = new ExecutionRepository(firstDatabase)
    const second = new ExecutionRepository(secondDatabase)
    const original = spec()
    first.reserve(original)

    expect(() => second.reserve(spec({ executionId: 'execution-2', assignmentId: 'assignment-2', cwd: join(directory, 'worktree-2') }))).toThrow()
    expect(() => second.reserve(spec({ executionId: 'execution-3', ticketId: 'ticket-3', cwd: join(directory, 'worktree-3') }))).toThrow()
    expect(() => second.reserve(spec({ executionId: 'execution-4', ticketId: 'ticket-4', assignmentId: 'assignment-4' }))).toThrow()
    expect(second.list()).toHaveLength(1)
  })

  it('keeps UNKNOWN active until reconciled to a terminal state', () => {
    const database = open()
    initializeExecutionSchema(database)
    const repository = new ExecutionRepository(database)
    repository.reserve(spec())
    repository.apply(event(1, 'STARTING'))
    repository.apply(event(2, 'UNKNOWN', { reason: 'runner heartbeat was lost' }))

    expect(() => repository.reserve(spec({
      executionId: 'execution-2', assignmentId: 'assignment-2', cwd: join(directory, 'worktree-2'),
    }))).toThrow()

    repository.apply(event(3, 'FAILED', { exitCode: 1, reason: 'process reconciled as failed' }))
    expect(repository.reserve(spec({
      executionId: 'execution-2', assignmentId: 'assignment-2', cwd: join(directory, 'worktree-2'),
    })).state).toBe('STARTING')
  })

  it('rejects stale, noncontiguous, foreign, conflicting, and invalid-transition events', () => {
    const database = open()
    initializeExecutionSchema(database)
    const repository = new ExecutionRepository(database)
    repository.reserve(spec())
    const starting = event(1, 'STARTING')
    const bound = repository.apply(starting)

    expect(repository.apply({ ...starting })).toEqual(bound)
    expect(() => repository.apply({ ...starting, reason: 'changed replay' })).toThrow(/Conflicting duplicate/)
    expect(() => repository.apply(event(2, 'RUNNING', { generation: 2 }))).toThrow(/Stale execution generation/)
    expect(() => repository.apply(event(3, 'RUNNING'))).toThrow(/not contiguous/)
    expect(() => repository.apply(event(2, 'RUNNING', { runnerId: 'runner-2' }))).toThrow(/different runner/)
    expect(() => repository.apply(event(2, 'CANCELLED', { signal: 'SIGTERM' }))).toThrow(/Invalid execution transition/)
    expect(repository.get('execution-1')).toEqual(bound)
    expect(repository.events('execution-1')).toEqual([starting])
  })

  it('rolls back an inserted event when the state update fails, then accepts valid completion', () => {
    const database = open()
    initializeExecutionSchema(database)
    const repository = new ExecutionRepository(database)
    repository.reserve(spec())
    repository.apply(event(1, 'STARTING'))
    database.exec(`CREATE TRIGGER reject_running BEFORE UPDATE ON execution
      WHEN NEW.state = 'RUNNING' BEGIN SELECT RAISE(ABORT, 'injected update failure'); END`)

    expect(() => repository.apply(event(2, 'RUNNING', { processId: 202 }))).toThrow(/injected update failure/)
    expect(repository.get('execution-1')).toMatchObject({ state: 'STARTING', lastSequence: 1 })
    expect(repository.events('execution-1').map(item => item.sequence)).toEqual([1])

    database.exec('DROP TRIGGER reject_running')
    repository.apply(event(2, 'RUNNING', { processId: 202 }))
    const completed = repository.apply(event(3, 'SUCCEEDED', { processId: 202, exitCode: 0, signal: null }))
    expect(completed).toMatchObject({ state: 'SUCCEEDED', exitCode: 0, signal: null, lastSequence: 3 })
    expect(completed.finishedAt).toBe(event(3, 'SUCCEEDED').at)
    expect(repository.events('execution-1').map(item => item.sequence)).toEqual([1, 2, 3])
  })

  it('requires terminal exit proof while permitting an explicit no-child startup failure', () => {
    const database = open()
    initializeExecutionSchema(database)
    const repository = new ExecutionRepository(database)
    repository.reserve(spec())
    repository.apply(event(1, 'STARTING'))

    expect(() => repository.apply(event(2, 'FAILED'))).toThrow(/explicit reason/)
    expect(repository.apply(event(2, 'FAILED', { reason: 'spawn ENOENT' }))).toMatchObject({
      state: 'FAILED', failureReason: 'spawn ENOENT', lastSequence: 2,
    })

    repository.reserve(spec({
      executionId: 'execution-2', ticketId: 'ticket-2', assignmentId: 'assignment-2', cwd: join(directory, 'worktree-2'),
    }))
    expect(() => repository.apply(event(1, 'RUNNING', {
      executionId: 'execution-2', processId: 303,
    }))).not.toThrow()
    expect(() => repository.apply(event(2, 'SUCCEEDED', { executionId: 'execution-2', processId: 303, exitCode: 1 })))
      .toThrow(/exitCode 0/)
    expect(() => repository.apply(event(2, 'FAILED', { executionId: 'execution-2', processId: 303 })))
      .toThrow(/exit proof/)
  })

  it('validates specs, complete event shapes, and event cursors', () => {
    const database = open()
    initializeExecutionSchema(database)
    const repository = new ExecutionRepository(database)

    expect(() => repository.reserve(spec({ executionId: '../escape' }))).toThrow(/executionId/)
    expect(() => repository.reserve(spec({ cwd: 'relative/path' }))).toThrow(/absolute/)
    repository.reserve(spec())
    expect(() => repository.apply({ ...event(1, 'STARTING'), extra: true } as ExecutionEvent)).toThrow(/Unknown execution event field/)
    expect(() => repository.events('execution-1', -1)).toThrow(/cursor/)
  })
})
