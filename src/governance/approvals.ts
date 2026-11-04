/** Scoped approval requests: immutable scope, authorized decide/consume, append-only audit. */
import { DatabaseSync } from 'node:sqlite'

export const APPROVAL_SCHEMA_KEY = 'approval-schema'
export const APPROVAL_SCHEMA_VERSION = 1

export type ApprovalStatus = 'PENDING' | 'APPROVED' | 'REJECTED'
export type ApprovalDecisionKind = 'approved' | 'rejected'
export type ApprovalAuditKind = 'request' | 'decision' | 'consumption'

export interface ApprovalDecision {
  actorId: string
  decision: ApprovalDecisionKind
  reason: string
  at: string
}

export interface Approval {
  id: string
  workspaceId: string
  requesterId: string
  taskId: string
  executionId: string
  action: string
  resource: string
  parametersHash: string
  artifactRevision: string
  policyVersion: string
  expiresAt: string
  createdAt: string
  status: ApprovalStatus
  decision?: ApprovalDecision
  consumedAt?: string
}

export interface CreateApprovalInput {
  id: string
  workspaceId: string
  requesterId: string
  taskId: string
  executionId: string
  action: string
  resource: string
  parametersHash: string
  artifactRevision: string
  policyVersion: string
  expiresAt: string
  createdAt: string
}

export interface DecideApprovalInput {
  actorId: string
  decision: ApprovalDecisionKind
  reason: string
  at: string
  authorized: boolean
}

export interface ConsumeApprovalInput {
  at: string
  action: string
  resource: string
  parametersHash: string
  artifactRevision: string
  policyVersion: string
  executionId: string
  authorized: boolean
}

const CREATE_KEYS = [
  'id', 'workspaceId', 'requesterId', 'taskId', 'executionId', 'action', 'resource',
  'parametersHash', 'artifactRevision', 'policyVersion', 'expiresAt', 'createdAt',
] as const

const DECIDE_KEYS = ['actorId', 'decision', 'reason', 'at', 'authorized'] as const
const CONSUME_KEYS = [
  'at', 'action', 'resource', 'parametersHash', 'artifactRevision', 'policyVersion', 'executionId', 'authorized',
] as const

function savepoint<T>(db: DatabaseSync, name: string, operation: () => T): T {
  db.exec(`SAVEPOINT ${name}`)
  try {
    const value = operation()
    db.exec(`RELEASE ${name}`)
    return value
  } catch (error) {
    try { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`) } catch { /* keep original */ }
    throw error
  }
}

function requireObject(input: unknown, label: string): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error(`Invalid ${label}`)
  return input as Record<string, unknown>
}

function requireExactKeys(input: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(input).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${label}: unexpected or missing fields`)
  }
}

function requireNonemptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Invalid ${field}`)
  return value
}

function requireIsoTimestamp(value: unknown, field: string): string {
  const text = requireNonemptyString(value, field)
  const time = Date.parse(text)
  if (!Number.isFinite(time)) throw new Error(`Invalid ${field}`)
  return text
}

function requireAuthorized(value: unknown): void {
  if (value !== true) throw new Error('Authorization was not granted')
}

function ensureKv(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
}

function readSchemaVersion(db: DatabaseSync): number | undefined {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='kv'").get()) return undefined
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(APPROVAL_SCHEMA_KEY)
  if (!row) return undefined
  let version: unknown
  try { version = JSON.parse(String(row.value)) } catch { throw new Error('Invalid approval schema metadata') }
  if (typeof version !== 'number' || !Number.isInteger(version)) throw new Error('Invalid approval schema metadata')
  return version
}

function assertWritableSchema(db: DatabaseSync): void {
  const version = readSchemaVersion(db)
  if (version === undefined) throw new Error('Approval schema is not initialized')
  if (version !== APPROVAL_SCHEMA_VERSION) throw new Error(`Unsupported approval schema ${version}`)
}

function cloneApproval(value: Approval): Approval {
  return structuredClone(value)
}

function parseApproval(raw: string): Approval {
  return JSON.parse(raw) as Approval
}

function scopeMatches(approval: Approval, input: ConsumeApprovalInput): boolean {
  return approval.action === input.action
    && approval.resource === input.resource
    && approval.parametersHash === input.parametersHash
    && approval.artifactRevision === input.artifactRevision
    && approval.policyVersion === input.policyVersion
    && approval.executionId === input.executionId
}

function assertNotExpired(approval: Approval, at: string, field: string): void {
  requireIsoTimestamp(at, field)
  if (Date.parse(at) < Date.parse(approval.createdAt)) throw new Error('Approval time precedes request')
  if (approval.decision && Date.parse(at) < Date.parse(approval.decision.at)) throw new Error('Approval time precedes decision')
  if (Date.parse(at) >= Date.parse(approval.expiresAt)) throw new Error('Approval has expired')
}

function appendAudit(db: DatabaseSync, approvalId: string, kind: ApprovalAuditKind, at: string, value: Record<string, unknown>): void {
  db.prepare('INSERT INTO approval_audit (approval_id, kind, at, value) VALUES (?, ?, ?, ?)')
    .run(approvalId, kind, at, JSON.stringify(value))
}

function loadApproval(db: DatabaseSync, id: string): Approval | undefined {
  const row = db.prepare('SELECT value FROM approval WHERE id = ?').get(id)
  return row ? parseApproval(String(row.value)) : undefined
}

function writeApproval(db: DatabaseSync, approval: Approval): void {
  db.prepare(`INSERT INTO approval (id, workspace_id, status, consumed_at, value)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      status = excluded.status,
      consumed_at = excluded.consumed_at,
      value = excluded.value`)
    .run(approval.id, approval.workspaceId, approval.status, approval.consumedAt ?? null, JSON.stringify(approval))
}

/** Explicit additive initializer; version is kv `approval-schema` = 1. Rejects future versions before DDL. */
export function initializeApprovalSchema(db: DatabaseSync): void {
  savepoint(db, 'approval_schema_init', () => {
    ensureKv(db)
    const version = readSchemaVersion(db)
    if (version !== undefined && version !== APPROVAL_SCHEMA_VERSION) {
      throw new Error(`Unsupported approval schema ${version}`)
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS approval (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        status TEXT NOT NULL,
        consumed_at TEXT,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approval_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        approval_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        at TEXT NOT NULL,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS approval_audit_approval_id ON approval_audit(approval_id, seq);
    `)
    if (version === undefined) {
      db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(APPROVAL_SCHEMA_KEY, JSON.stringify(APPROVAL_SCHEMA_VERSION))
    }
  })
}

export interface ApprovalRepositoryApi {
  create(input: CreateApprovalInput): Approval
  get(id: string): Approval | undefined
  decide(id: string, input: DecideApprovalInput): Approval
  consume(id: string, input: ConsumeApprovalInput): Approval
}

/** Low-level scoped approval repository. Trusts application-supplied `authorized`; does not authenticate actors. */
export function ApprovalRepository(db: DatabaseSync): ApprovalRepositoryApi {
  return {
    create(input: CreateApprovalInput): Approval {
      const body = requireObject(input, 'approval create input')
      requireExactKeys(body, CREATE_KEYS, 'approval create input')
      const id = requireNonemptyString(body.id, 'id')
      const workspaceId = requireNonemptyString(body.workspaceId, 'workspaceId')
      const requesterId = requireNonemptyString(body.requesterId, 'requesterId')
      const taskId = requireNonemptyString(body.taskId, 'taskId')
      const executionId = requireNonemptyString(body.executionId, 'executionId')
      const action = requireNonemptyString(body.action, 'action')
      const resource = requireNonemptyString(body.resource, 'resource')
      const parametersHash = requireNonemptyString(body.parametersHash, 'parametersHash')
      const artifactRevision = requireNonemptyString(body.artifactRevision, 'artifactRevision')
      const policyVersion = requireNonemptyString(body.policyVersion, 'policyVersion')
      const createdAt = requireIsoTimestamp(body.createdAt, 'createdAt')
      const expiresAt = requireIsoTimestamp(body.expiresAt, 'expiresAt')
      if (Date.parse(expiresAt) <= Date.parse(createdAt)) throw new Error('expiresAt must be after createdAt')

      return savepoint(db, 'approval_create', () => {
        assertWritableSchema(db)
        if (loadApproval(db, id)) throw new Error('Approval already exists')
        const approval: Approval = {
          id, workspaceId, requesterId, taskId, executionId, action, resource,
          parametersHash, artifactRevision, policyVersion, expiresAt, createdAt,
          status: 'PENDING',
        }
        writeApproval(db, approval)
        appendAudit(db, id, 'request', createdAt, { approval: structuredClone(approval) })
        return cloneApproval(approval)
      })
    },

    get(id: string): Approval | undefined {
      requireNonemptyString(id, 'id')
      assertWritableSchema(db)
      const approval = loadApproval(db, id)
      return approval ? cloneApproval(approval) : undefined
    },

    decide(id: string, input: DecideApprovalInput): Approval {
      requireNonemptyString(id, 'id')
      const body = requireObject(input, 'approval decide input')
      requireExactKeys(body, DECIDE_KEYS, 'approval decide input')
      requireAuthorized(body.authorized)
      const actorId = requireNonemptyString(body.actorId, 'actorId')
      const decision = body.decision
      if (decision !== 'approved' && decision !== 'rejected') throw new Error('Invalid decision')
      const reason = requireNonemptyString(body.reason, 'reason')
      const at = requireIsoTimestamp(body.at, 'at')

      return savepoint(db, 'approval_decide', () => {
        assertWritableSchema(db)
        const approval = loadApproval(db, id)
        if (!approval) throw new Error('Approval not found')
        if (actorId === approval.requesterId) throw new Error('Self-approval is not allowed')
        assertNotExpired(approval, at, 'at')

        if (approval.consumedAt !== undefined) throw new Error('Approval already consumed')

        const nextDecision: ApprovalDecision = { actorId, decision, reason, at }
        if (approval.decision) {
          const same = approval.decision.actorId === nextDecision.actorId
            && approval.decision.decision === nextDecision.decision
            && approval.decision.reason === nextDecision.reason
            && approval.decision.at === nextDecision.at
          if (!same) throw new Error('Conflicting approval decision')
          return cloneApproval(approval)
        }

        if (approval.status !== 'PENDING') throw new Error('Approval is not pending')

        approval.decision = nextDecision
        approval.status = decision === 'approved' ? 'APPROVED' : 'REJECTED'
        writeApproval(db, approval)
        appendAudit(db, id, 'decision', at, { decision: structuredClone(nextDecision) })
        return cloneApproval(approval)
      })
    },

    consume(id: string, input: ConsumeApprovalInput): Approval {
      requireNonemptyString(id, 'id')
      const body = requireObject(input, 'approval consume input')
      requireExactKeys(body, CONSUME_KEYS, 'approval consume input')
      requireAuthorized(body.authorized)
      const at = requireIsoTimestamp(body.at, 'at')
      const action = requireNonemptyString(body.action, 'action')
      const resource = requireNonemptyString(body.resource, 'resource')
      const parametersHash = requireNonemptyString(body.parametersHash, 'parametersHash')
      const artifactRevision = requireNonemptyString(body.artifactRevision, 'artifactRevision')
      const policyVersion = requireNonemptyString(body.policyVersion, 'policyVersion')
      const executionId = requireNonemptyString(body.executionId, 'executionId')
      const scope: ConsumeApprovalInput = {
        at, action, resource, parametersHash, artifactRevision, policyVersion, executionId, authorized: true,
      }

      return savepoint(db, 'approval_consume', () => {
        assertWritableSchema(db)
        const approval = loadApproval(db, id)
        if (!approval) throw new Error('Approval not found')
        if (!scopeMatches(approval, scope)) throw new Error('Approval scope does not match')
        assertNotExpired(approval, at, 'at')

        if (approval.consumedAt !== undefined) {
          throw new Error('Approval already consumed')
        }
        if (approval.status !== 'APPROVED' || !approval.decision || approval.decision.decision !== 'approved') {
          throw new Error('Approval is not approved')
        }

        approval.consumedAt = at
        const updated = db.prepare(`UPDATE approval
          SET consumed_at = ?, value = ?
          WHERE id = ? AND status = 'APPROVED' AND consumed_at IS NULL`)
          .run(at, JSON.stringify(approval), id)
        if (!Number(updated.changes)) throw new Error('Approval already consumed')
        appendAudit(db, id, 'consumption', at, {
          at, action, resource, parametersHash, artifactRevision, policyVersion, executionId,
        })
        return cloneApproval(approval)
      })
    },
  }
}
