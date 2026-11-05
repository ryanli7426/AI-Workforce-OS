/**
 * Durable verification job repository. Schema installation is explicit; reads never initialize.
 * No process launch, network, PID signaling, or Task mutation occurs here.
 */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import {
  LAUNCHED_ACTIVE_VERIFICATION_JOB_STATES,
  TERMINAL_VERIFICATION_JOB_STATES,
  VERIFICATION_JOB_STATES,
  type VerificationJob,
  type VerificationJobAuditEntry,
  type VerificationJobCancelRequest,
  type VerificationJobEvent,
  type VerificationJobReceipt,
  type VerificationJobRequest,
  type VerificationJobState,
} from '../verification/model.ts'
import type { VerificationCheckRequest } from '../verification/local-checks.ts'
import { parseVerificationRequest } from '../verification/request.ts'

export const VERIFICATION_SCHEMA_KEY = 'verification-schema'
export const VERIFICATION_SCHEMA_VERSION = 1 as const

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const REASON_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const RECEIPT_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/

const MAX_REASON_BYTES = 4_096
const MAX_RECEIPT_JSON_BYTES = 64 * 1024
const MAX_HISTORY = 100
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200

const STATES = new Set<string>(VERIFICATION_JOB_STATES)
const TERMINAL_STATES = new Set<string>(TERMINAL_VERIFICATION_JOB_STATES)
const LAUNCHED_ACTIVE = new Set<string>(LAUNCHED_ACTIVE_VERIFICATION_JOB_STATES)
const EVENT_STATUSES = new Set<string>(
  VERIFICATION_JOB_STATES.filter(state => state !== 'QUEUED' && state !== 'UNKNOWN'),
)

const EVENT_FIELDS = [
  'verificationId',
  'sequence',
  'runnerId',
  'runnerPid',
  'status',
  'at',
  'processId',
  'outcome',
  'reportSha256',
  'terminalConfirmed',
  'failureCode',
] as const

const JOB_RECORD_FIELDS = [
  'request',
  'status',
  'version',
  'lastSequence',
  'runnerId',
  'runnerPid',
  'processId',
  'outcome',
  'reportSha256',
  'application',
  'cancelRequested',
  'createdAt',
  'updatedAt',
  'finishedAt',
  'failureCode',
] as const

const CANCEL_REQUEST_FIELDS = ['actorId', 'reason', 'at'] as const

const LIST_QUERY_FIELDS = [
  'ownerId',
  'workspaceId',
  'statuses',
  'limit',
  'beforeRowid',
  'ticketId',
] as const

const FORBIDDEN_REQUEST_KEYS = new Set([
  'env',
  'environment',
  'credentials',
  'credential',
  'authorized',
  'authorization',
  'secret',
  'secrets',
  'token',
  'tokens',
  'password',
  'apiKey',
  'api_key',
])

const TRANSITIONS: Readonly<Record<VerificationJobState, ReadonlySet<VerificationJobState>>> = {
  QUEUED: new Set(),
  STARTING: new Set(['STARTING', 'RUNNING', 'STOPPING', 'COMPLETED', 'FAILED', 'CANCELLED']),
  RUNNING: new Set(['RUNNING', 'STOPPING', 'COMPLETED', 'FAILED', 'CANCELLED']),
  STOPPING: new Set(['STOPPING', 'COMPLETED', 'FAILED', 'CANCELLED']),
  UNKNOWN: new Set(['STARTING', 'RUNNING', 'STOPPING', 'COMPLETED', 'FAILED', 'CANCELLED']),
  COMPLETED: new Set(),
  FAILED: new Set(),
  CANCELLED: new Set(),
}

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

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

function schemaVersion(db: DatabaseSync): number | undefined {
  if (!tableExists(db, 'kv')) return undefined
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(VERIFICATION_SCHEMA_KEY)
  if (!row) return undefined
  let value: unknown
  try { value = JSON.parse(String(row.value)) } catch {
    throw new Error('Invalid verification schema metadata')
  }
  if (!Number.isSafeInteger(value)) throw new Error('Invalid verification schema metadata')
  return value as number
}

function ownsVerificationTables(db: DatabaseSync): boolean {
  return tableExists(db, 'verification_job')
    || tableExists(db, 'verification_job_event')
    || tableExists(db, 'verification_job_audit')
    || tableExists(db, 'verification_job_receipt')
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`Invalid ${label}`)
  }
}

function assertAllowedKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const permitted = new Set(allowed)
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_REQUEST_KEYS.has(key)) throw new Error(`Invalid ${label}: forbidden field`)
    if (!permitted.has(key)) throw new Error(`Invalid ${label}`)
  }
}

function requireSafeId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || value === '.' || value === '..') {
    throw new Error(`Invalid ${field}`)
  }
}

function requireSha256(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new Error(`Invalid ${field}`)
}

function requireReasonCode(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !REASON_CODE.test(value)) throw new Error(`Invalid ${field}`)
}

function requireTimestamp(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string'
    || !value.trim()
    || value.includes('\0')
    || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new Error(`Invalid ${field}`)
  }
}

function requireSafeInt(value: unknown, field: string, min: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min) throw new Error(`Invalid ${field}`)
  return Number(value)
}

function requireBoundedText(value: unknown, field: string, maxBytes: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || Buffer.byteLength(value) > maxBytes) {
    throw new Error(`Invalid ${field}`)
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function cloneCheck(check: VerificationCheckRequest): VerificationCheckRequest {
  return { id: check.id, command: check.command, args: [...check.args], timeoutMs: check.timeoutMs }
}

function cloneRequest(request: VerificationJobRequest): VerificationJobRequest {
  return {
    verificationId: request.verificationId,
    workspaceId: request.workspaceId,
    ownerId: request.ownerId,
    ticketId: request.ticketId,
    expectedTaskVersion: request.expectedTaskVersion,
    policyVersion: request.policyVersion,
    executionId: request.executionId,
    artifactId: request.artifactId,
    artifactRevision: request.artifactRevision,
    plan: {
      id: request.plan.id,
      revision: request.plan.revision,
      checks: request.plan.checks.map(cloneCheck),
    },
    reason: request.reason,
    createdAt: request.createdAt,
  }
}

function cloneJob(job: VerificationJob): VerificationJob {
  const cloned: VerificationJob = {
    request: cloneRequest(job.request),
    status: job.status,
    version: job.version,
    lastSequence: job.lastSequence,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
  if (job.runnerId !== undefined) cloned.runnerId = job.runnerId
  if (job.runnerPid !== undefined) cloned.runnerPid = job.runnerPid
  if (job.processId !== undefined) cloned.processId = job.processId
  if (job.outcome !== undefined) cloned.outcome = job.outcome
  if (job.reportSha256 !== undefined) cloned.reportSha256 = job.reportSha256
  if (job.application !== undefined) cloned.application = job.application
  if (job.cancelRequested !== undefined) {
    cloned.cancelRequested = {
      actorId: job.cancelRequested.actorId,
      reason: job.cancelRequested.reason,
      at: job.cancelRequested.at,
    }
  }
  if (job.finishedAt !== undefined) cloned.finishedAt = job.finishedAt
  if (job.failureCode !== undefined) cloned.failureCode = job.failureCode
  return cloned
}

function cloneEvent(event: VerificationJobEvent): VerificationJobEvent {
  const cloned: VerificationJobEvent = {
    verificationId: event.verificationId,
    sequence: event.sequence,
    runnerId: event.runnerId,
    runnerPid: event.runnerPid,
    status: event.status,
    at: event.at,
  }
  if (event.processId !== undefined) cloned.processId = event.processId
  if (event.outcome !== undefined) cloned.outcome = event.outcome
  if (event.reportSha256 !== undefined) cloned.reportSha256 = event.reportSha256
  if (event.terminalConfirmed !== undefined) cloned.terminalConfirmed = event.terminalConfirmed
  if (event.failureCode !== undefined) cloned.failureCode = event.failureCode
  return cloned
}

function validateRequest(value: unknown): VerificationJobRequest {
  const input = requireObject(value, 'verification request')
  for (const key of Object.keys(input)) {
    if (FORBIDDEN_REQUEST_KEYS.has(key)) throw new Error('Invalid verification request: forbidden field')
  }
  // Parent shared parser owns the immutable request contract; keep local forbidden-field
  // messaging until integration replaces this wrapper.
  try {
    return parseVerificationRequest(value)
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid verification request') throw error
    throw new Error('Invalid verification request')
  }
}

function validateEvent(value: unknown): VerificationJobEvent {
  const input = requireObject(value, 'verification event')
  assertAllowedKeys(input, EVENT_FIELDS, 'verification event')
  for (const required of ['verificationId', 'sequence', 'runnerId', 'runnerPid', 'status', 'at'] as const) {
    if (!(required in input)) throw new Error('Invalid verification event')
  }
  requireSafeId(input.verificationId, 'verificationId')
  if (!Number.isSafeInteger(input.sequence) || Number(input.sequence) < 1) throw new Error('Invalid event sequence')
  requireSafeId(input.runnerId, 'runnerId')
  if (!Number.isSafeInteger(input.runnerPid) || Number(input.runnerPid) < 1) throw new Error('Invalid runnerPid')
  if (typeof input.status !== 'string' || !EVENT_STATUSES.has(input.status)) throw new Error('Invalid event status')
  requireTimestamp(input.at, 'event timestamp')
  if (input.processId !== undefined && (!Number.isSafeInteger(input.processId) || Number(input.processId) < 1)) {
    throw new Error('Invalid processId')
  }
  if (input.outcome !== undefined && input.outcome !== 'passed' && input.outcome !== 'failed') {
    throw new Error('Invalid event outcome')
  }
  if (input.reportSha256 !== undefined) requireSha256(input.reportSha256, 'reportSha256')
  if (input.terminalConfirmed !== undefined && typeof input.terminalConfirmed !== 'boolean') {
    throw new Error('Invalid terminalConfirmed')
  }
  if (input.failureCode !== undefined) requireReasonCode(input.failureCode, 'failureCode')

  const event: VerificationJobEvent = {
    verificationId: input.verificationId,
    sequence: Number(input.sequence),
    runnerId: input.runnerId,
    runnerPid: Number(input.runnerPid),
    status: input.status as VerificationJobEvent['status'],
    at: input.at,
  }
  if (input.processId !== undefined) event.processId = Number(input.processId)
  if (input.outcome !== undefined) event.outcome = input.outcome
  if (input.reportSha256 !== undefined) event.reportSha256 = input.reportSha256
  if (input.terminalConfirmed !== undefined) event.terminalConfirmed = input.terminalConfirmed
  if (input.failureCode !== undefined) event.failureCode = input.failureCode
  return event
}

function lateCancelContiguousEvent(current: VerificationJob, event: VerificationJobEvent): boolean {
  return current.status === 'STOPPING'
    && current.cancelRequested !== undefined
    && (event.status === 'STARTING' || event.status === 'RUNNING')
}

function assertEventSemantics(current: VerificationJob, event: VerificationJobEvent): void {
  const terminal = TERMINAL_STATES.has(event.status)
  if (terminal) {
    if (event.terminalConfirmed !== true) throw new Error('Terminal verification event requires confirmed evidence')
  } else if (event.terminalConfirmed === true) {
    throw new Error('Nonterminal verification event cannot claim terminal confirmation')
  }

  if (event.status === 'COMPLETED') {
    if (event.outcome !== 'passed' && event.outcome !== 'failed') {
      throw new Error('Completed verification requires outcome')
    }
    if (typeof event.reportSha256 !== 'string' || !SHA256.test(event.reportSha256)) {
      throw new Error('Completed verification requires report digest')
    }
    if (event.failureCode !== undefined) throw new Error('Completed verification cannot carry failureCode')
  } else {
    if (event.outcome !== undefined) throw new Error('Only completed verification may carry outcome')
    if (event.status === 'FAILED' && event.failureCode === undefined) {
      throw new Error('Failed verification requires infrastructure failure code')
    }
    if (event.reportSha256 !== undefined) throw new Error('Only completed verification may carry report digest')
  }

  const lateCancel = lateCancelContiguousEvent(current, event)
  if (!lateCancel && !TRANSITIONS[current.status].has(event.status)) {
    throw new Error(`Invalid verification transition ${current.status} -> ${event.status}`)
  }

  if (current.runnerId !== undefined && current.runnerId !== event.runnerId) {
    throw new Error('Event belongs to a different runner')
  }
  if (current.runnerPid !== undefined && current.runnerPid !== event.runnerPid) {
    throw new Error('Event has conflicting runnerPid')
  }
  if (current.processId !== undefined) {
    if (event.processId !== undefined && event.processId !== current.processId) {
      throw new Error('Event has conflicting processId')
    }
  }

  if (current.status === 'UNKNOWN') {
    if (current.runnerId === undefined || current.runnerPid === undefined) {
      // Lost handshake before first runner event: only authentic sequence-1 STARTING may pin.
      if (current.lastSequence !== 0 || event.sequence !== 1 || event.status !== 'STARTING') {
        throw new Error('UNKNOWN verification without pinned runner accepts only first STARTING evidence')
      }
    } else if (event.runnerId !== current.runnerId || event.runnerPid !== current.runnerPid) {
      throw new Error('UNKNOWN verification recovery requires the same authenticated runner')
    }
  }
}

function optionalString(value: unknown): string | undefined {
  return value == null ? undefined : String(value)
}

function optionalNumber(value: unknown): number | undefined {
  return value == null ? undefined : Number(value)
}

function parseCancelRequested(value: unknown): VerificationJobCancelRequest {
  const input = requireObject(value, 'cancelRequested')
  assertExactKeys(input, CANCEL_REQUEST_FIELDS, 'cancelRequested')
  requireSafeId(input.actorId, 'cancelRequested.actorId')
  requireBoundedText(input.reason, 'cancelRequested.reason', MAX_REASON_BYTES)
  requireTimestamp(input.at, 'cancelRequested.at')
  return { actorId: input.actorId, reason: input.reason, at: input.at }
}

function assertJobRecordSemantics(job: VerificationJob): void {
  requireSafeInt(job.version, 'version', 1)
  requireSafeInt(job.lastSequence, 'lastSequence', 0)
  requireTimestamp(job.createdAt, 'createdAt')
  requireTimestamp(job.updatedAt, 'updatedAt')
  if (job.runnerId !== undefined) requireSafeId(job.runnerId, 'runnerId')
  if (job.runnerPid !== undefined) requireSafeInt(job.runnerPid, 'runnerPid', 1)
  if (job.processId !== undefined) requireSafeInt(job.processId, 'processId', 1)
  if (job.failureCode !== undefined) requireReasonCode(job.failureCode, 'failureCode')
  if (job.finishedAt !== undefined) requireTimestamp(job.finishedAt, 'finishedAt')
  if (job.outcome !== undefined && job.outcome !== 'passed' && job.outcome !== 'failed') {
    throw new Error('Verification job record is corrupt')
  }
  if (job.reportSha256 !== undefined) requireSha256(job.reportSha256, 'reportSha256')
  if (job.application !== undefined
    && job.application !== 'pending'
    && job.application !== 'applied'
    && job.application !== 'superseded') {
    throw new Error('Verification job record is corrupt')
  }

  if (TERMINAL_STATES.has(job.status)) {
    if (job.finishedAt === undefined) throw new Error('Verification job record is corrupt')
    if (job.status === 'COMPLETED') {
      if (job.outcome !== 'passed' && job.outcome !== 'failed') {
        throw new Error('Verification job record is corrupt')
      }
      if (typeof job.reportSha256 !== 'string') throw new Error('Verification job record is corrupt')
      if (job.application !== 'pending' && job.application !== 'applied' && job.application !== 'superseded') {
        throw new Error('Verification job record is corrupt')
      }
      if (job.failureCode !== undefined) throw new Error('Verification job record is corrupt')
    } else {
      if (job.reportSha256 !== undefined) throw new Error('Verification job record is corrupt')
      if (job.application !== undefined) throw new Error('Verification job record is corrupt')
      if (job.status === 'CANCELLED' && job.outcome !== undefined) {
        throw new Error('Verification job record is corrupt')
      }
      if (job.status === 'FAILED' && (job.outcome !== undefined || job.failureCode === undefined)) {
        throw new Error('Verification job record is corrupt')
      }
    }
  } else if (job.finishedAt !== undefined || job.application !== undefined || job.outcome !== undefined
    || job.reportSha256 !== undefined) {
    throw new Error('Verification job record is corrupt')
  }

  if ((job.runnerId === undefined) !== (job.runnerPid === undefined)) {
    throw new Error('Verification job record is corrupt')
  }
}

function parseJobRow(row: Record<string, unknown>): VerificationJob {
  let recordRaw: unknown
  let requestRaw: unknown
  try {
    recordRaw = JSON.parse(String(row.record_json))
    requestRaw = JSON.parse(String(row.request_json))
  } catch {
    throw new Error('Verification job record is corrupt')
  }

  const record = requireObject(recordRaw, 'job record')
  assertAllowedKeys(record, JOB_RECORD_FIELDS, 'job record')
  for (const required of ['request', 'status', 'version', 'lastSequence', 'createdAt', 'updatedAt'] as const) {
    if (!(required in record)) throw new Error('Verification job record is corrupt')
  }

  const request = validateRequest(requestRaw)
  // Immutable enqueue payload lives in request_json; record.request must mirror it exactly.
  if (!sameJson(record.request, request)) {
    throw new Error('Verification job record is inconsistent')
  }

  if (typeof record.status !== 'string' || !STATES.has(record.status)) {
    throw new Error('Verification job record is corrupt')
  }

  const job: VerificationJob = {
    request: cloneRequest(request),
    status: record.status as VerificationJobState,
    version: requireSafeInt(record.version, 'version', 1),
    lastSequence: requireSafeInt(record.lastSequence, 'lastSequence', 0),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  }
  if (record.runnerId !== undefined) job.runnerId = String(record.runnerId)
  if (record.runnerPid !== undefined) job.runnerPid = requireSafeInt(record.runnerPid, 'runnerPid', 1)
  if (record.processId !== undefined) job.processId = requireSafeInt(record.processId, 'processId', 1)
  if (record.outcome !== undefined) {
    if (record.outcome !== 'passed' && record.outcome !== 'failed') {
      throw new Error('Verification job record is corrupt')
    }
    job.outcome = record.outcome
  }
  if (record.reportSha256 !== undefined) {
    requireSha256(record.reportSha256, 'reportSha256')
    job.reportSha256 = record.reportSha256
  }
  if (record.application !== undefined) {
    if (record.application !== 'pending' && record.application !== 'applied' && record.application !== 'superseded') {
      throw new Error('Verification job record is corrupt')
    }
    job.application = record.application
  }
  if (record.cancelRequested !== undefined) {
    job.cancelRequested = parseCancelRequested(record.cancelRequested)
  }
  if (record.finishedAt !== undefined) job.finishedAt = String(record.finishedAt)
  if (record.failureCode !== undefined) {
    requireReasonCode(record.failureCode, 'failureCode')
    job.failureCode = record.failureCode
  }

  assertJobRecordSemantics(job)

  if (job.request.verificationId !== String(row.verification_id)
    || job.request.workspaceId !== String(row.workspace_id)
    || job.request.ownerId !== String(row.owner_id)
    || job.request.ticketId !== String(row.ticket_id)
    || job.status !== String(row.status)
    || job.version !== Number(row.version)
    || job.lastSequence !== Number(row.last_sequence)
    || job.createdAt !== String(row.created_at)
    || job.updatedAt !== String(row.updated_at)
    || job.runnerId !== optionalString(row.runner_id)
    || job.runnerPid !== optionalNumber(row.runner_pid)
    || job.processId !== optionalNumber(row.process_id)
    || job.finishedAt !== optionalString(row.finished_at)) {
    throw new Error('Verification job record is inconsistent')
  }

  // Scalar PID columns must remain finite safe integers when present.
  if (row.runner_pid != null && !Number.isSafeInteger(Number(row.runner_pid))) {
    throw new Error('Verification job record is inconsistent')
  }
  if (row.process_id != null && !Number.isSafeInteger(Number(row.process_id))) {
    throw new Error('Verification job record is inconsistent')
  }
  if (!Number.isSafeInteger(Number(row.version)) || !Number.isSafeInteger(Number(row.last_sequence))) {
    throw new Error('Verification job record is inconsistent')
  }

  return cloneJob(job)
}

function jobFromRow(row: Record<string, unknown>): VerificationJob {
  try {
    return parseJobRow(row)
  } catch (error) {
    if (error instanceof Error && error.message === 'Verification job record is inconsistent') {
      throw error
    }
    // Never leak corrupt raw JSON/content through validation exception text.
    throw new Error('Verification job record is corrupt')
  }
}

/** Explicit schema install. Safe inside an existing transaction via savepoint. */
export function initializeVerificationSchema(db: DatabaseSync): void {
  const version = schemaVersion(db)
  if (version !== undefined && version !== VERIFICATION_SCHEMA_VERSION) {
    throw new Error(`Unsupported verification schema version: ${version}`)
  }
  if (version === undefined && ownsVerificationTables(db)) {
    throw new Error('Unversioned verification schema; refusing implicit migration')
  }
  savepoint(db, 'verification_schema', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS verification_job (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        verification_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        ticket_id TEXT NOT NULL,
        status TEXT NOT NULL,
        version INTEGER NOT NULL,
        last_sequence INTEGER NOT NULL,
        runner_id TEXT,
        runner_pid INTEGER,
        process_id INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        finished_at TEXT,
        request_json TEXT NOT NULL CHECK (json_valid(request_json)),
        record_json TEXT NOT NULL CHECK (json_valid(record_json))
      );
      CREATE INDEX IF NOT EXISTS verification_job_scope_rowid
        ON verification_job (workspace_id, owner_id, rowid);
      CREATE INDEX IF NOT EXISTS verification_job_ticket
        ON verification_job (ticket_id, status);
      CREATE UNIQUE INDEX IF NOT EXISTS verification_job_active_ticket
        ON verification_job (ticket_id)
        WHERE status IN ('QUEUED', 'STARTING', 'RUNNING', 'STOPPING', 'UNKNOWN');
      CREATE TABLE IF NOT EXISTS verification_job_event (
        verification_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        at TEXT NOT NULL,
        status TEXT NOT NULL,
        runner_id TEXT NOT NULL,
        runner_pid INTEGER NOT NULL,
        event_json TEXT NOT NULL CHECK (json_valid(event_json)),
        PRIMARY KEY (verification_id, sequence),
        FOREIGN KEY (verification_id) REFERENCES verification_job(verification_id)
      );
      CREATE INDEX IF NOT EXISTS verification_job_event_cursor
        ON verification_job_event (verification_id, sequence);
      CREATE TABLE IF NOT EXISTS verification_job_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        verification_id TEXT NOT NULL,
        action TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT,
        at TEXT NOT NULL,
        actor_id TEXT,
        reason_code TEXT,
        sequence INTEGER,
        FOREIGN KEY (verification_id) REFERENCES verification_job(verification_id)
      );
      CREATE INDEX IF NOT EXISTS verification_job_audit_job
        ON verification_job_audit (verification_id, id);
      CREATE TABLE IF NOT EXISTS verification_job_receipt (
        workspace_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        receipt_key TEXT NOT NULL,
        command_hash TEXT NOT NULL,
        verification_id TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, owner_id, receipt_key),
        FOREIGN KEY (verification_id) REFERENCES verification_job(verification_id)
      );
      CREATE INDEX IF NOT EXISTS verification_job_receipt_scope
        ON verification_job_receipt (workspace_id, owner_id);
    `)
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(VERIFICATION_SCHEMA_KEY, JSON.stringify(VERIFICATION_SCHEMA_VERSION))
  })
}

/** Preflight only; never initializes. Fails closed on missing/future/corrupt schema. */
export function requireVerificationSchema(db: DatabaseSync): void {
  const version = schemaVersion(db)
  if (version === undefined) throw new Error('Verification schema is not initialized')
  if (version !== VERIFICATION_SCHEMA_VERSION) {
    throw new Error(`Unsupported verification schema version: ${version}`)
  }
  if (!ownsVerificationTables(db)) throw new Error('Verification schema is incomplete')
  try {
    db.prepare(`SELECT verification_id, workspace_id, owner_id, ticket_id, status, version, last_sequence,
      runner_id, runner_pid, process_id, created_at, updated_at, finished_at, request_json, record_json
      FROM verification_job LIMIT 0`).all()
    db.prepare(`SELECT verification_id, sequence, at, status, runner_id, runner_pid, event_json
      FROM verification_job_event LIMIT 0`).all()
    db.prepare(`SELECT id, verification_id, action, from_status, to_status, at, actor_id, reason_code, sequence
      FROM verification_job_audit LIMIT 0`).all()
    db.prepare(`SELECT workspace_id, owner_id, receipt_key, command_hash, verification_id, result_json, created_at
      FROM verification_job_receipt LIMIT 0`).all()
  } catch {
    throw new Error('Verification schema is corrupt')
  }
}

export interface VerificationJobListQuery {
  ownerId: string
  workspaceId: string
  statuses?: readonly VerificationJobState[]
  limit?: number
  beforeRowid?: number
  ticketId?: string
}

export interface VerificationJobListResult {
  items: VerificationJob[]
  nextCursor?: number
}

export interface VerificationCancelInput {
  expectedVersion: number
  actorId: string
  reason: string
  at: string
}

export interface VerificationApplicationInput {
  expectedVersion: number
  application: 'applied' | 'superseded'
  reportSha256: string
  at: string
}

export interface VerificationReceiptQuery {
  workspaceId: string
  ownerId: string
  key: string
}

export interface VerificationReceiptInsert {
  workspaceId: string
  ownerId: string
  key: string
  commandHash: string
  verificationId: string
  resultJson: string
  at: string
}

/** Durable verification aggregate store on a caller-owned SQLite connection. */
export class VerificationJobRepository {
  constructor(private readonly db: DatabaseSync) {
    requireVerificationSchema(db)
  }

  private audit(
    verificationId: string,
    action: string,
    at: string,
    fields: {
      from?: VerificationJobState
      to?: VerificationJobState
      actorId?: string
      reasonCode?: string
      sequence?: number
    } = {},
  ): void {
    this.db.prepare(`INSERT INTO verification_job_audit
      (verification_id, action, from_status, to_status, at, actor_id, reason_code, sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      verificationId,
      action,
      fields.from ?? null,
      fields.to ?? null,
      at,
      fields.actorId ?? null,
      fields.reasonCode ?? null,
      fields.sequence ?? null,
    )
  }

  private readRow(verificationId: string): Record<string, unknown> | undefined {
    return this.db.prepare(`SELECT rowid, verification_id, workspace_id, owner_id, ticket_id, status, version,
      last_sequence, runner_id, runner_pid, process_id, created_at, updated_at, finished_at, request_json, record_json
      FROM verification_job WHERE verification_id = ?`).get(verificationId) as Record<string, unknown> | undefined
  }

  private persist(job: VerificationJob): void {
    // request_json is immutable after reserve; mirror it into record_json for consistency checks.
    const row = this.readRow(job.request.verificationId)
    if (!row) throw new Error('Verification job does not exist')
    let request: VerificationJobRequest
    try {
      request = validateRequest(JSON.parse(String(row.request_json)))
    } catch {
      throw new Error('Verification job record is corrupt')
    }
    if (!sameJson(request, job.request)) {
      throw new Error('Verification request is immutable')
    }
    const record = cloneJob({ ...job, request: cloneRequest(request) })
    this.db.prepare(`UPDATE verification_job SET
      status = ?, version = ?, last_sequence = ?, runner_id = ?, runner_pid = ?, process_id = ?,
      updated_at = ?, finished_at = ?, record_json = ?
      WHERE verification_id = ?`).run(
      record.status,
      record.version,
      record.lastSequence,
      record.runnerId ?? null,
      record.runnerPid ?? null,
      record.processId ?? null,
      record.updatedAt,
      record.finishedAt ?? null,
      JSON.stringify(record),
      record.request.verificationId,
    )
  }

  private load(verificationId: string): VerificationJob | undefined {
    const row = this.readRow(verificationId)
    return row ? jobFromRow(row) : undefined
  }

  reserve(request: VerificationJobRequest): VerificationJob {
    const canonical = validateRequest(request)
    return savepoint(this.db, 'verification_reserve', () => {
      const existing = this.readRow(canonical.verificationId)
      if (existing) throw new Error('Verification ID is already reserved')

      // Once used, a trusted plan revision identifies one immutable command set in this scope.
      // Its full content is also bound by the private request hash and signed report digest.
      const priorPlans = this.db.prepare(`SELECT * FROM verification_job
        WHERE workspace_id = ? AND owner_id = ?
        AND json_extract(request_json, '$.plan.id') = ?
        AND json_extract(request_json, '$.plan.revision') = ?`).iterate(
        canonical.workspaceId, canonical.ownerId, canonical.plan.id, canonical.plan.revision)
      for (const row of priorPlans) {
        if (!sameJson(jobFromRow(row).request.plan, canonical.plan)) {
          throw new Error('Conflicting verification plan revision')
        }
      }

      const active = this.db.prepare(`SELECT verification_id FROM verification_job
        WHERE ticket_id = ? AND status IN ('QUEUED', 'STARTING', 'RUNNING', 'STOPPING', 'UNKNOWN')`).get(canonical.ticketId)
      if (active) throw new Error('Ticket already has an active verification job')

      const now = canonical.createdAt
      const job: VerificationJob = {
        request: cloneRequest(canonical),
        status: 'QUEUED',
        version: 1,
        lastSequence: 0,
        createdAt: now,
        updatedAt: now,
      }
      this.db.prepare(`INSERT INTO verification_job (
        verification_id, workspace_id, owner_id, ticket_id, status, version, last_sequence,
        runner_id, runner_pid, process_id, created_at, updated_at, finished_at, request_json, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        canonical.verificationId,
        canonical.workspaceId,
        canonical.ownerId,
        canonical.ticketId,
        job.status,
        job.version,
        job.lastSequence,
        null,
        null,
        null,
        job.createdAt,
        job.updatedAt,
        null,
        JSON.stringify(job.request),
        JSON.stringify(job),
      )
      this.audit(canonical.verificationId, 'reserved', now, { to: 'QUEUED', actorId: canonical.ownerId })
      return cloneJob(job)
    })
  }

  get(id: string): VerificationJob | undefined {
    requireSafeId(id, 'verificationId')
    const job = this.load(id)
    return job ? cloneJob(job) : undefined
  }

  list(query: VerificationJobListQuery): VerificationJobListResult {
    const input = requireObject(query as unknown as Record<string, unknown>, 'verification list query')
    assertAllowedKeys(input, LIST_QUERY_FIELDS, 'verification list query')
    if (!('ownerId' in input) || !('workspaceId' in input)) {
      throw new Error('Invalid verification list query')
    }
    requireSafeId(input.ownerId, 'ownerId')
    requireSafeId(input.workspaceId, 'workspaceId')
    if (input.ticketId !== undefined) requireSafeId(input.ticketId, 'ticketId')
    let limit = DEFAULT_LIST_LIMIT
    if (input.limit !== undefined) {
      if (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > MAX_LIST_LIMIT) {
        throw new Error('Invalid list limit')
      }
      limit = Number(input.limit)
    }
    if (input.beforeRowid !== undefined
      && (!Number.isSafeInteger(input.beforeRowid) || Number(input.beforeRowid) < 1)) {
      throw new Error('Invalid beforeRowid')
    }
    const statuses = input.statuses
    if (statuses !== undefined) {
      if (!Array.isArray(statuses) || statuses.length === 0 || statuses.length > VERIFICATION_JOB_STATES.length) {
        throw new Error('Invalid statuses filter')
      }
      const seen = new Set<string>()
      for (const status of statuses) {
        if (typeof status !== 'string' || !STATES.has(status)) throw new Error('Invalid statuses filter')
        if (seen.has(status)) throw new Error('Duplicate statuses filter')
        seen.add(status)
      }
    }

    const workspaceId = String(input.workspaceId)
    const ownerId = String(input.ownerId)
    const params: SQLInputValue[] = [workspaceId, ownerId]
    let sql = `SELECT rowid, verification_id, workspace_id, owner_id, ticket_id, status, version,
      last_sequence, runner_id, runner_pid, process_id, created_at, updated_at, finished_at, request_json, record_json
      FROM verification_job
      WHERE workspace_id = ? AND owner_id = ?`
    if (input.ticketId !== undefined) {
      sql += ' AND ticket_id = ?'
      params.push(String(input.ticketId))
    }
    if (statuses !== undefined) {
      const statusList = statuses.map(status => String(status))
      sql += ` AND status IN (${statusList.map(() => '?').join(', ')})`
      params.push(...statusList)
    }
    if (input.beforeRowid !== undefined) {
      sql += ' AND rowid < ?'
      params.push(Number(input.beforeRowid))
    }
    sql += ' ORDER BY rowid DESC LIMIT ?'
    params.push(limit + 1)

    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[]
    const page = rows.slice(0, limit)
    const items = page.map(row => cloneJob(jobFromRow(row)))
    const result: VerificationJobListResult = { items }
    if (rows.length > limit) {
      result.nextCursor = Number(page[page.length - 1]!.rowid)
    }
    return result
  }

  beginLaunch(id: string): VerificationJob {
    requireSafeId(id, 'verificationId')
    return savepoint(this.db, 'verification_begin_launch', () => {
      const current = this.load(id)
      if (!current) throw new Error('Verification job does not exist')
      if (current.status !== 'QUEUED') throw new Error('Verification launch can only claim QUEUED jobs')
      const now = new Date().toISOString()
      const next: VerificationJob = {
        ...cloneJob(current),
        status: 'STARTING',
        version: current.version + 1,
        updatedAt: now,
      }
      this.persist(next)
      this.audit(id, 'launch_claimed', now, { from: 'QUEUED', to: 'STARTING' })
      return cloneJob(next)
    })
  }

  apply(event: VerificationJobEvent): VerificationJob {
    const canonical = validateEvent(event)
    return savepoint(this.db, 'verification_apply', () => {
      const current = this.load(canonical.verificationId)
      if (!current) throw new Error('Verification job does not exist')

      // Exact authenticated replay must win over terminal immutability (e.g. after recordApplication).
      const prior = this.db.prepare(`SELECT event_json FROM verification_job_event
        WHERE verification_id = ? AND sequence = ?`).get(canonical.verificationId, canonical.sequence)
      if (prior) {
        let stored: unknown
        try { stored = JSON.parse(String(prior.event_json)) } catch {
          throw new Error('Verification job record is corrupt')
        }
        if (!sameJson(stored, canonical)) throw new Error('Conflicting duplicate verification event')
        return cloneJob(current)
      }
      if (TERMINAL_STATES.has(current.status)) throw new Error('Terminal verification job is immutable')

      if (canonical.sequence !== current.lastSequence + 1) {
        throw new Error('Verification event sequence is not contiguous')
      }
      if (current.status === 'QUEUED') throw new Error('Verification job has not been launched')

      assertEventSemantics(current, canonical)

      const preserveStopping = lateCancelContiguousEvent(current, canonical)
      const nextStatus: VerificationJobState = preserveStopping ? 'STOPPING' : canonical.status

      const next: VerificationJob = {
        ...cloneJob(current),
        status: nextStatus,
        version: current.version + 1,
        lastSequence: canonical.sequence,
        updatedAt: canonical.at,
        runnerId: current.runnerId ?? canonical.runnerId,
        runnerPid: current.runnerPid ?? canonical.runnerPid,
      }
      if (current.processId !== undefined) next.processId = current.processId
      else if (canonical.processId !== undefined) next.processId = canonical.processId
      if (preserveStopping && current.cancelRequested) {
        next.cancelRequested = {
          actorId: current.cancelRequested.actorId,
          reason: current.cancelRequested.reason,
          at: current.cancelRequested.at,
        }
      }

      if (canonical.status === 'COMPLETED') {
        next.outcome = canonical.outcome
        next.reportSha256 = canonical.reportSha256
        next.application = 'pending'
        next.finishedAt = canonical.at
        delete next.failureCode
      } else if (TERMINAL_STATES.has(canonical.status)) {
        next.finishedAt = canonical.at
        if (canonical.failureCode !== undefined) next.failureCode = canonical.failureCode
        if (canonical.outcome !== undefined) next.outcome = canonical.outcome
        delete next.reportSha256
        if (canonical.status === 'CANCELLED' || canonical.status === 'FAILED') {
          delete next.application
        }
      } else {
        delete next.finishedAt
        if (canonical.failureCode !== undefined) next.failureCode = canonical.failureCode
      }

      this.db.prepare(`INSERT INTO verification_job_event
        (verification_id, sequence, at, status, runner_id, runner_pid, event_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        canonical.verificationId,
        canonical.sequence,
        canonical.at,
        canonical.status,
        canonical.runnerId,
        canonical.runnerPid,
        JSON.stringify(cloneEvent(canonical)),
      )
      this.persist(next)
      this.audit(canonical.verificationId, 'event_applied', canonical.at, {
        from: current.status,
        to: next.status,
        sequence: canonical.sequence,
        reasonCode: canonical.failureCode,
      })
      return cloneJob(next)
    })
  }

  markUnknown(id: string, reasonCode: string): VerificationJob {
    requireSafeId(id, 'verificationId')
    requireReasonCode(reasonCode, 'reasonCode')
    return savepoint(this.db, 'verification_mark_unknown', () => {
      const current = this.load(id)
      if (!current) throw new Error('Verification job does not exist')
      if (TERMINAL_STATES.has(current.status)) throw new Error('Terminal verification job is immutable')
      if (!LAUNCHED_ACTIVE.has(current.status) && current.status !== 'UNKNOWN') {
        throw new Error('Only launched active verification jobs can be marked UNKNOWN')
      }
      if (current.status === 'UNKNOWN' && current.failureCode === reasonCode) return cloneJob(current)

      const now = new Date().toISOString()
      const next: VerificationJob = {
        ...cloneJob(current),
        status: 'UNKNOWN',
        version: current.version + 1,
        updatedAt: now,
        failureCode: reasonCode,
      }
      this.persist(next)
      this.audit(id, 'marked_unknown', now, {
        from: current.status,
        to: 'UNKNOWN',
        reasonCode,
      })
      return cloneJob(next)
    })
  }

  requestCancel(id: string, input: VerificationCancelInput): VerificationJob {
    requireSafeId(id, 'verificationId')
    const body = requireObject(input as unknown as Record<string, unknown>, 'cancel request')
    assertExactKeys(body, ['expectedVersion', 'actorId', 'reason', 'at'], 'cancel request')
    if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
      throw new Error('Invalid expectedVersion')
    }
    requireSafeId(body.actorId, 'actorId')
    requireBoundedText(body.reason, 'reason', MAX_REASON_BYTES)
    requireTimestamp(body.at, 'at')

    return savepoint(this.db, 'verification_request_cancel', () => {
      const current = this.load(id)
      if (!current) throw new Error('Verification job does not exist')
      if (TERMINAL_STATES.has(current.status)) throw new Error('Terminal verification job cannot be cancelled')
      if (current.version !== Number(body.expectedVersion)) throw new Error('Verification version conflict')
      if (body.actorId !== current.request.ownerId) throw new Error('Cancel actor must equal ownerId')

      const cancelRequested = {
        actorId: body.actorId as string,
        reason: body.reason as string,
        at: body.at as string,
      }

      if (current.status === 'QUEUED') {
        const next: VerificationJob = {
          ...cloneJob(current),
          status: 'CANCELLED',
          version: current.version + 1,
          updatedAt: cancelRequested.at,
          finishedAt: cancelRequested.at,
          cancelRequested,
          failureCode: 'cancelled_before_launch',
        }
        this.persist(next)
        this.audit(id, 'cancelled', cancelRequested.at, {
          from: 'QUEUED',
          to: 'CANCELLED',
          actorId: cancelRequested.actorId,
          reasonCode: 'cancelled_before_launch',
        })
        return cloneJob(next)
      }

      if (
        current.cancelRequested
        && current.cancelRequested.actorId === cancelRequested.actorId
        && current.cancelRequested.reason === cancelRequested.reason
        && current.cancelRequested.at === cancelRequested.at
        && (current.status === 'STOPPING' || current.status === 'UNKNOWN')
      ) {
        return cloneJob(current)
      }

      let status: VerificationJobState = current.status
      if (current.status === 'STARTING' || current.status === 'RUNNING') status = 'STOPPING'
      // UNKNOWN stays UNKNOWN; STOPPING stays STOPPING. Occupancy is retained until terminal proof.

      const next: VerificationJob = {
        ...cloneJob(current),
        status,
        version: current.version + 1,
        updatedAt: cancelRequested.at,
        cancelRequested,
      }
      this.persist(next)
      this.audit(id, 'cancel_requested', cancelRequested.at, {
        from: current.status,
        to: status,
        actorId: cancelRequested.actorId,
        reasonCode: 'cancel_requested',
      })
      return cloneJob(next)
    })
  }

  recordApplication(id: string, input: VerificationApplicationInput): VerificationJob {
    requireSafeId(id, 'verificationId')
    const body = requireObject(input as unknown as Record<string, unknown>, 'application record')
    assertExactKeys(body, ['expectedVersion', 'application', 'reportSha256', 'at'], 'application record')
    if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 1) {
      throw new Error('Invalid expectedVersion')
    }
    if (body.application !== 'applied' && body.application !== 'superseded') {
      throw new Error('Invalid application outcome')
    }
    const application = body.application
    const expectedVersion = Number(body.expectedVersion)
    requireSha256(body.reportSha256, 'reportSha256')
    requireTimestamp(body.at, 'at')
    const reportSha256 = body.reportSha256
    const at = body.at

    return savepoint(this.db, 'verification_record_application', () => {
      const current = this.load(id)
      if (!current) throw new Error('Verification job does not exist')
      if (current.status !== 'COMPLETED') throw new Error('Only completed verification can record application')
      if (current.reportSha256 !== reportSha256) throw new Error('Application report digest mismatch')

      if (current.application === application) {
        // Exact retry: identical at and the original pre-application expected version.
        const exactRetry = current.updatedAt === at
          && expectedVersion === current.version - 1
        if (exactRetry) return cloneJob(current)
        throw new Error('Verification version conflict')
      }
      if (current.application === 'applied' || current.application === 'superseded') {
        throw new Error('Application outcome cannot be flipped')
      }
      if (current.version !== expectedVersion) throw new Error('Verification version conflict')

      const next: VerificationJob = {
        ...cloneJob(current),
        application,
        version: current.version + 1,
        updatedAt: at,
      }
      this.persist(next)
      this.audit(id, 'application_recorded', at, {
        from: current.status,
        to: current.status,
        reasonCode: application,
      })
      return cloneJob(next)
    })
  }

  history(id: string): VerificationJobAuditEntry[] {
    requireSafeId(id, 'verificationId')
    if (!this.load(id)) throw new Error('Verification job does not exist')
    const rows = this.db.prepare(`SELECT id, verification_id, action, from_status, to_status, at, actor_id, reason_code, sequence
      FROM verification_job_audit WHERE verification_id = ? ORDER BY id ASC LIMIT ?`).all(id, MAX_HISTORY) as Record<string, unknown>[]
    return rows.map(row => {
      const entry: VerificationJobAuditEntry = {
        id: Number(row.id),
        verificationId: String(row.verification_id),
        action: String(row.action),
        at: String(row.at),
      }
      if (row.from_status != null) entry.from = String(row.from_status) as VerificationJobState
      if (row.to_status != null) entry.to = String(row.to_status) as VerificationJobState
      if (row.actor_id != null) entry.actorId = String(row.actor_id)
      if (row.reason_code != null) entry.reasonCode = String(row.reason_code)
      if (row.sequence != null) entry.sequence = Number(row.sequence)
      return entry
    })
  }

  getReceipt(query: VerificationReceiptQuery): VerificationJobReceipt | undefined {
    const input = requireObject(query as unknown as Record<string, unknown>, 'receipt query')
    assertExactKeys(input, ['workspaceId', 'ownerId', 'key'], 'receipt query')
    requireSafeId(input.workspaceId, 'workspaceId')
    requireSafeId(input.ownerId, 'ownerId')
    if (typeof input.key !== 'string' || !RECEIPT_KEY.test(input.key)) throw new Error('Invalid receipt key')

    const row = this.db.prepare(`SELECT workspace_id, owner_id, receipt_key, command_hash, verification_id, result_json, created_at
      FROM verification_job_receipt
      WHERE workspace_id = ? AND owner_id = ? AND receipt_key = ?`)
      .get(input.workspaceId, input.ownerId, input.key) as Record<string, unknown> | undefined
    if (!row) return undefined

    const job = this.load(String(row.verification_id))
    if (!job
      || job.request.workspaceId !== input.workspaceId
      || job.request.ownerId !== input.ownerId) {
      throw new Error('Receipt references a foreign verification job')
    }
    return {
      workspaceId: String(row.workspace_id),
      ownerId: String(row.owner_id),
      key: String(row.receipt_key),
      commandHash: String(row.command_hash),
      verificationId: String(row.verification_id),
      resultJson: String(row.result_json),
      at: String(row.created_at),
    }
  }

  insertReceipt(input: VerificationReceiptInsert): VerificationJobReceipt {
    const body = requireObject(input as unknown as Record<string, unknown>, 'receipt insert')
    assertExactKeys(
      body,
      ['workspaceId', 'ownerId', 'key', 'commandHash', 'verificationId', 'resultJson', 'at'],
      'receipt insert',
    )
    requireSafeId(body.workspaceId, 'workspaceId')
    requireSafeId(body.ownerId, 'ownerId')
    requireSafeId(body.verificationId, 'verificationId')
    if (typeof body.key !== 'string' || !RECEIPT_KEY.test(body.key)) throw new Error('Invalid receipt key')
    requireSha256(body.commandHash, 'commandHash')
    requireTimestamp(body.at, 'at')
    if (typeof body.resultJson !== 'string'
      || body.resultJson.includes('\0')
      || Buffer.byteLength(body.resultJson) > MAX_RECEIPT_JSON_BYTES) {
      throw new Error('Invalid resultJson')
    }
    let parsed: unknown
    try { parsed = JSON.parse(body.resultJson) } catch { throw new Error('Invalid resultJson') }
    if (parsed === undefined) throw new Error('Invalid resultJson')

    const workspaceId = body.workspaceId
    const ownerId = body.ownerId
    const key = body.key
    const commandHash = body.commandHash
    const verificationId = body.verificationId
    const resultJson = body.resultJson
    const at = body.at

    return savepoint(this.db, 'verification_insert_receipt', () => {
      const job = this.load(verificationId)
      if (!job) throw new Error('Verification job does not exist')
      if (job.request.workspaceId !== workspaceId || job.request.ownerId !== ownerId) {
        throw new Error('Receipt scope does not match verification job')
      }

      const existing = this.db.prepare(`SELECT command_hash, verification_id, result_json, created_at
        FROM verification_job_receipt
        WHERE workspace_id = ? AND owner_id = ? AND receipt_key = ?`)
        .get(workspaceId, ownerId, key) as Record<string, unknown> | undefined
      if (existing) {
        if (String(existing.command_hash) !== commandHash
          || String(existing.verification_id) !== verificationId
          || String(existing.result_json) !== resultJson) {
          throw new Error('Conflicting verification receipt')
        }
        return {
          workspaceId,
          ownerId,
          key,
          commandHash,
          verificationId,
          resultJson,
          at: String(existing.created_at),
        }
      }

      this.db.prepare(`INSERT INTO verification_job_receipt
        (workspace_id, owner_id, receipt_key, command_hash, verification_id, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        workspaceId,
        ownerId,
        key,
        commandHash,
        verificationId,
        resultJson,
        at,
      )
      this.audit(verificationId, 'receipt_inserted', at, {
        actorId: ownerId,
        reasonCode: 'receipt',
      })
      return {
        workspaceId,
        ownerId,
        key,
        commandHash,
        verificationId,
        resultJson,
        at,
      }
    })
  }
}
