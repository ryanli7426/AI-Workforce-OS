import { isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  EXECUTION_STATES,
  TERMINAL_EXECUTION_STATES,
  type ExecutionEvent,
  type ExecutionRecord,
  type ExecutionSpec,
  type ExecutionState,
} from './model.ts'

const SCHEMA_KEY = 'execution-schema'
const SCHEMA_VERSION = 1
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const STATES = new Set<ExecutionState>(EXECUTION_STATES)
const TERMINAL_STATES = new Set<ExecutionState>(TERMINAL_EXECUTION_STATES)
const SPEC_FIELDS = [
  'executionId', 'assignmentId', 'ticketId', 'agentId', 'runtime', 'runtimeRevision', 'generation', 'cwd', 'inputRevision', 'policyVersion',
] as const
const EVENT_FIELDS = [
  'executionId', 'generation', 'sequence', 'at', 'state', 'runnerId', 'runnerPid', 'processId', 'sessionId',
  'exitCode', 'signal', 'reason',
] as const

let savepointSequence = 0

function savepoint<T>(db: DatabaseSync, prefix: string, operation: () => T): T {
  const name = `${prefix}_${savepointSequence++}`
  db.exec(`SAVEPOINT ${name}`)
  try {
    const result = operation()
    db.exec(`RELEASE ${name}`)
    return result
  } catch (error) {
    try { db.exec(`ROLLBACK TO ${name}`) } finally { db.exec(`RELEASE ${name}`) }
    throw error
  }
}

function requireObject(value: unknown, description: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${description}`)
  return value as Record<string, unknown>
}

function requireOnlyFields(value: Record<string, unknown>, fields: readonly string[], description: string): void {
  const allowed = new Set(fields)
  if (Object.keys(value).some(field => !allowed.has(field))) throw new Error(`Unknown ${description} field`)
}

function requireSafeId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`Invalid ${field}`)
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`Invalid ${field}`)
}

function validateSpec(value: unknown): asserts value is ExecutionSpec {
  const spec = requireObject(value, 'execution spec')
  requireOnlyFields(spec, SPEC_FIELDS, 'execution spec')
  for (const field of ['executionId', 'assignmentId', 'ticketId', 'agentId'] as const) requireSafeId(spec[field], field)
  for (const field of ['runtime', 'inputRevision', 'policyVersion'] as const) requireText(spec[field], field)
  if (spec.runtimeRevision !== undefined && (typeof spec.runtimeRevision !== 'string' || !/^[a-f0-9]{64}$/.test(spec.runtimeRevision))) throw new Error('Invalid Runtime revision')
  if (!Number.isSafeInteger(spec.generation) || Number(spec.generation) < 1) throw new Error('Invalid generation')
  requireText(spec.cwd, 'cwd')
  if (!isAbsolute(spec.cwd as string)) throw new Error('Execution cwd must be absolute')
}

function canonicalSpec(spec: ExecutionSpec): ExecutionSpec {
  return {
    executionId: spec.executionId,
    assignmentId: spec.assignmentId,
    ticketId: spec.ticketId,
    agentId: spec.agentId,
    runtime: spec.runtime,
    ...(spec.runtimeRevision === undefined ? {} : {runtimeRevision:spec.runtimeRevision}),
    generation: spec.generation,
    cwd: spec.cwd,
    inputRevision: spec.inputRevision,
    policyVersion: spec.policyVersion,
  }
}

function validateEvent(value: unknown): asserts value is ExecutionEvent {
  const event = requireObject(value, 'execution event')
  requireOnlyFields(event, EVENT_FIELDS, 'execution event')
  requireSafeId(event.executionId, 'executionId')
  if (!Number.isSafeInteger(event.generation) || Number(event.generation) < 1) throw new Error('Invalid event generation')
  if (!Number.isSafeInteger(event.sequence) || Number(event.sequence) < 1) throw new Error('Invalid event sequence')
  requireText(event.at, 'event timestamp')
  if (!Number.isFinite(Date.parse(event.at as string))) throw new Error('Invalid event timestamp')
  if (typeof event.state !== 'string' || !STATES.has(event.state as ExecutionState)) throw new Error('Invalid event state')
  requireText(event.runnerId, 'runnerId')
  for (const field of ['runnerPid', 'processId'] as const) {
    const item = event[field]
    if (item !== undefined && (!Number.isSafeInteger(item) || Number(item) < 1)) throw new Error(`Invalid ${field}`)
  }
  if (event.sessionId !== undefined) requireText(event.sessionId, 'sessionId')
  if (event.exitCode !== undefined && event.exitCode !== null && !Number.isSafeInteger(event.exitCode))
    throw new Error('Invalid exitCode')
  if (event.signal !== undefined && event.signal !== null) requireText(event.signal, 'signal')
  if (event.reason !== undefined) requireText(event.reason, 'reason')
}

function canonicalEvent(event: ExecutionEvent): ExecutionEvent {
  return {
    executionId: event.executionId,
    generation: event.generation,
    sequence: event.sequence,
    at: event.at,
    state: event.state,
    runnerId: event.runnerId,
    ...(event.runnerPid === undefined ? {} : { runnerPid: event.runnerPid }),
    ...(event.processId === undefined ? {} : { processId: event.processId }),
    ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
    ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
    ...(event.signal === undefined ? {} : { signal: event.signal }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
  }
}

function rowRecord(row: Record<string, unknown> | undefined): ExecutionRecord | undefined {
  if (!row) return undefined
  return JSON.parse(String(row.state_json)) as ExecutionRecord
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertIdentity(current: ExecutionRecord, event: ExecutionEvent): void {
  if (current.runnerId !== undefined && current.runnerId !== event.runnerId) throw new Error('Event belongs to a different runner')
  for (const field of ['runnerPid', 'processId', 'sessionId'] as const) {
    if (current[field] !== undefined && event[field] !== undefined && current[field] !== event[field])
      throw new Error(`Event has conflicting ${field}`)
  }
}

const TRANSITIONS: Readonly<Record<ExecutionState, ReadonlySet<ExecutionState>>> = {
  STARTING: new Set(['RUNNING', 'FAILED', 'UNKNOWN', 'STOPPING']),
  RUNNING: new Set(['STOPPING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'UNKNOWN']),
  STOPPING: new Set(['CANCELLED', 'TIMED_OUT', 'FAILED', 'UNKNOWN']),
  UNKNOWN: new Set(['RUNNING', 'STOPPING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
  TIMED_OUT: new Set(),
  CANCELLED: new Set(),
}

function assertTransition(current: ExecutionRecord, event: ExecutionEvent): void {
  const initialBinding = (current.state === 'STARTING' || current.state === 'UNKNOWN') && current.lastSequence === 0 && event.sequence === 1 && event.state === 'STARTING'
  if (!initialBinding && !TRANSITIONS[current.state].has(event.state))
    throw new Error(`Invalid execution transition ${current.state} -> ${event.state}`)

  const hasExitCode = Number.isSafeInteger(event.exitCode)
  const hasSignal = typeof event.signal === 'string' && !!event.signal.trim()
  if (!TERMINAL_STATES.has(event.state)) {
    if (event.state !== 'UNKNOWN' && (hasExitCode || hasSignal)) throw new Error('Nonterminal event cannot contain exit proof')
    return
  }
  if (event.state === 'SUCCEEDED') {
    if (event.exitCode !== 0 || hasSignal) throw new Error('Successful execution requires exitCode 0 and no signal')
    return
  }
  const startupFailure = current.state === 'STARTING' && event.state === 'FAILED'
    && current.processId === undefined && event.processId === undefined && !hasExitCode && !hasSignal
  if (startupFailure) {
    if (!event.reason?.trim()) throw new Error('Startup failure requires an explicit reason')
    return
  }
  if (!hasExitCode && !hasSignal) throw new Error('Terminal execution requires exit proof')
}

/** Adds the execution repository schema to an initialized LocalStore connection. */
export function initializeExecutionSchema(db: DatabaseSync): void {
  const kv = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()
  if (!kv) throw new Error('Execution schema requires an initialized kv table')
  const versionRow = db.prepare('SELECT value FROM kv WHERE key = ?').get(SCHEMA_KEY)
  if (versionRow !== undefined) {
    let version: unknown
    try { version = JSON.parse(String(versionRow.value)) } catch { throw new Error('Unknown execution schema version') }
    if (version !== SCHEMA_VERSION) throw new Error(`Unknown execution schema version: ${String(version)}`)
  }

  savepoint(db, 'execution_schema', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS execution (
        execution_id TEXT PRIMARY KEY,
        assignment_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        runtime TEXT NOT NULL,
        generation INTEGER NOT NULL,
        cwd TEXT NOT NULL,
        input_revision TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        state TEXT NOT NULL,
        runner_id TEXT,
        last_sequence INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        spec_json TEXT NOT NULL CHECK (json_valid(spec_json)),
        state_json TEXT NOT NULL CHECK (json_valid(state_json))
      );
      CREATE TABLE IF NOT EXISTS execution_event (
        execution_id TEXT NOT NULL,
        generation INTEGER NOT NULL,
        sequence INTEGER NOT NULL,
        at TEXT NOT NULL,
        state TEXT NOT NULL,
        event_json TEXT NOT NULL CHECK (json_valid(event_json)),
        PRIMARY KEY (execution_id, sequence),
        FOREIGN KEY (execution_id) REFERENCES execution(execution_id)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS execution_active_ticket ON execution(ticket_id)
        WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED');
      CREATE UNIQUE INDEX IF NOT EXISTS execution_active_assignment ON execution(assignment_id)
        WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED');
      CREATE UNIQUE INDEX IF NOT EXISTS execution_active_cwd ON execution(cwd)
        WHERE state NOT IN ('SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED');
      CREATE TABLE IF NOT EXISTS execution_observation (id INTEGER PRIMARY KEY, execution_id TEXT NOT NULL, at TEXT NOT NULL, reason TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS execution_event_cursor ON execution_event(execution_id, sequence);
    `)
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SCHEMA_KEY, JSON.stringify(SCHEMA_VERSION))
  })
}

/** Durable execution state and ordered runner evidence on a caller-owned SQLite connection. */
export class ExecutionRepository {
  constructor(private readonly db: DatabaseSync) {}

  reserve(value: ExecutionSpec): ExecutionRecord {
    validateSpec(value)
    const spec = canonicalSpec(value)
    return savepoint(this.db, 'execution_reserve', () => {
      const existingRow = this.db.prepare('SELECT spec_json, state_json FROM execution WHERE execution_id = ?').get(spec.executionId)
      if (existingRow) {
        const existingSpec = JSON.parse(String(existingRow.spec_json)) as ExecutionSpec
        if (!sameJson(existingSpec, spec)) throw new Error('Execution ID is already reserved with a different spec')
        return JSON.parse(String(existingRow.state_json)) as ExecutionRecord
      }

      const now = new Date().toISOString()
      const record: ExecutionRecord = { ...spec, state: 'STARTING', createdAt: now, updatedAt: now, lastSequence: 0 }
      this.db.prepare(`INSERT INTO execution (
        execution_id, assignment_id, ticket_id, agent_id, runtime, generation, cwd, input_revision, policy_version,
        state, runner_id, last_sequence, created_at, updated_at, spec_json, state_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        spec.executionId, spec.assignmentId, spec.ticketId, spec.agentId, spec.runtime, spec.generation, spec.cwd,
        spec.inputRevision, spec.policyVersion, record.state, null, record.lastSequence, now, now,
        JSON.stringify(spec), JSON.stringify(record),
      )
      return record
    })
  }

  get(executionId: string): ExecutionRecord | undefined {
    requireSafeId(executionId, 'executionId')
    return rowRecord(this.db.prepare('SELECT state_json FROM execution WHERE execution_id = ?').get(executionId))
  }

  list(): ExecutionRecord[] {
    return this.db.prepare('SELECT state_json FROM execution ORDER BY rowid').all()
      .map(row => JSON.parse(String(row.state_json)) as ExecutionRecord)
  }

  events(executionId: string, afterSequence = 0): ExecutionEvent[] {
    requireSafeId(executionId, 'executionId')
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Invalid event cursor')
    return this.db.prepare('SELECT event_json FROM execution_event WHERE execution_id = ? AND sequence > ? ORDER BY sequence')
      .all(executionId, afterSequence).map(row => JSON.parse(String(row.event_json)) as ExecutionEvent)
  }

  /** Local loss of observation retains resource locks without forging Runner sequence events. */
  markUnknown(executionId: string, reason: string): ExecutionRecord {
    requireSafeId(executionId, 'executionId'); requireText(reason, 'observation reason')
    return savepoint(this.db, 'execution_observe', () => {
      const current = this.get(executionId)
      if (!current) throw new Error('Execution does not exist')
      if (TERMINAL_STATES.has(current.state)) return current
      if (current.state === 'UNKNOWN' && current.failureReason === reason) return current
      const now = new Date().toISOString()
      const next: ExecutionRecord = { ...current, state: 'UNKNOWN', updatedAt: now, failureReason: reason }
      this.db.prepare('INSERT INTO execution_observation (execution_id, at, reason) VALUES (?, ?, ?)').run(executionId, now, reason)
      this.db.prepare('UPDATE execution SET state = ?, updated_at = ?, state_json = ? WHERE execution_id = ?')
        .run(next.state, now, JSON.stringify(next), executionId)
      return next
    })
  }

  apply(value: ExecutionEvent): ExecutionRecord {
    validateEvent(value)
    const event = canonicalEvent(value)
    return savepoint(this.db, 'execution_apply', () => {
      const current = rowRecord(this.db.prepare('SELECT state_json FROM execution WHERE execution_id = ?').get(event.executionId))
      if (!current) throw new Error('Execution does not exist')
      if (event.generation !== current.generation) throw new Error('Stale execution generation')

      const prior = this.db.prepare('SELECT event_json FROM execution_event WHERE execution_id = ? AND sequence = ?')
        .get(event.executionId, event.sequence)
      if (prior) {
        const stored = JSON.parse(String(prior.event_json)) as ExecutionEvent
        if (!sameJson(stored, event)) throw new Error('Conflicting duplicate execution event')
        return current
      }
      if (event.sequence !== current.lastSequence + 1) throw new Error('Execution event sequence is not contiguous')
      if (TERMINAL_STATES.has(current.state)) throw new Error('Terminal execution cannot be replaced')

      assertIdentity(current, event)
      assertTransition(current, event)

      const next: ExecutionRecord = {
        ...current,
        state: event.state,
        updatedAt: event.at,
        lastSequence: event.sequence,
        runnerId: current.runnerId ?? event.runnerId,
        ...(current.runnerPid !== undefined ? { runnerPid: current.runnerPid } : event.runnerPid === undefined ? {} : { runnerPid: event.runnerPid }),
        ...(current.processId !== undefined ? { processId: current.processId } : event.processId === undefined ? {} : { processId: event.processId }),
        ...(current.sessionId !== undefined ? { sessionId: current.sessionId } : event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
        ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
        ...(event.signal === undefined ? {} : { signal: event.signal }),
        ...(event.reason === undefined ? {} : { failureReason: event.reason }),
        ...(event.state === 'RUNNING' && current.startedAt === undefined ? { startedAt: event.at } : {}),
        ...(TERMINAL_STATES.has(event.state) ? { finishedAt: event.at } : {}),
      }

      this.db.prepare(`INSERT INTO execution_event
        (execution_id, generation, sequence, at, state, event_json) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(event.executionId, event.generation, event.sequence, event.at, event.state, JSON.stringify(event))
      this.db.prepare(`UPDATE execution SET state = ?, runner_id = ?, last_sequence = ?, updated_at = ?, state_json = ?
        WHERE execution_id = ?`).run(next.state, next.runnerId ?? null, next.lastSequence, next.updatedAt, JSON.stringify(next), next.executionId)
      return next
    })
  }
}
