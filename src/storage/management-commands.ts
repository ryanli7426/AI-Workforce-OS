/** Durable management command receipts and audits. Schema installation is explicit; reads never initialize storage. */
import type { DatabaseSync } from 'node:sqlite'
import { LAO_SCHEMA_VERSION } from './store.ts'

export const MANAGEMENT_SCHEMA_KEY = 'management-schema'
export const MANAGEMENT_SCHEMA_VERSION = 1 as const

export interface ManagementReceiptRow {
  command_hash: string
  result_json: string
}

export interface ManagementAuditRow {
  id: string
  actor_id: string
  workspace_id: string
  kind: string
  resource_id: string
  action: string
  reason: string
  before_version: number | null
  after_version: number
  created_at: string
}

let savepointSequence = 0

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

function schemaVersion(db: DatabaseSync, key: string): number | undefined {
  if (!tableExists(db, 'kv')) return undefined
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
  if (!row) return undefined
  let value: unknown
  try { value = JSON.parse(String(row.value)) } catch { throw new Error('Invalid management schema metadata') }
  if (!Number.isSafeInteger(value)) throw new Error('Invalid management schema metadata')
  return value as number
}

/** Called only by an explicit initialization/migration composition. */
export function initializeManagementSchema(db: DatabaseSync): void {
  if (schemaVersion(db, 'schema') !== LAO_SCHEMA_VERSION) {
    throw new Error(`Management schema requires initialized main schema ${LAO_SCHEMA_VERSION}`)
  }
  const version = schemaVersion(db, MANAGEMENT_SCHEMA_KEY)
  if (version !== undefined && version !== MANAGEMENT_SCHEMA_VERSION) {
    throw new Error('Unsupported management schema')
  }
  if (version === undefined && (tableExists(db, 'management_command_receipt') || tableExists(db, 'management_audit'))) {
    throw new Error('Unversioned management schema; refusing implicit migration')
  }
  const point = `management_schema_${savepointSequence++}`
  db.exec(`SAVEPOINT ${point}`)
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS management_command_receipt (
        workspace_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        command_key TEXT NOT NULL,
        command_hash TEXT NOT NULL,
        result_json TEXT NOT NULL CHECK (json_valid(result_json)),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace_id, owner_id, command_key)
      );
      CREATE INDEX IF NOT EXISTS management_command_receipt_scope
        ON management_command_receipt (workspace_id, owner_id);
      CREATE TABLE IF NOT EXISTS management_audit (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('employee', 'project')),
        resource_id TEXT NOT NULL,
        action TEXT NOT NULL,
        reason TEXT NOT NULL,
        before_version INTEGER,
        after_version INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS management_audit_resource
        ON management_audit (workspace_id, actor_id, kind, resource_id);
    `)
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(MANAGEMENT_SCHEMA_KEY, JSON.stringify(MANAGEMENT_SCHEMA_VERSION))
    db.exec(`RELEASE ${point}`)
  } catch (error) {
    try { db.exec(`ROLLBACK TO ${point}`) } finally { db.exec(`RELEASE ${point}`) }
    throw error
  }
}

/** Preflight only; also checks actual columns when metadata alone appears valid. */
export function requireManagementSchema(db: DatabaseSync): void {
  if (schemaVersion(db, 'schema') !== LAO_SCHEMA_VERSION) {
    throw new Error('Unsupported main schema for management commands')
  }
  const version = schemaVersion(db, MANAGEMENT_SCHEMA_KEY)
  if (version === undefined) throw new Error('Management schema is not initialized')
  if (version !== MANAGEMENT_SCHEMA_VERSION) throw new Error('Unsupported management schema')
  try {
    db.prepare(`SELECT workspace_id, owner_id, command_key, command_hash, result_json, created_at
      FROM management_command_receipt LIMIT 0`).all()
    db.prepare(`SELECT id, actor_id, workspace_id, kind, resource_id, action, reason,
      before_version, after_version, created_at FROM management_audit LIMIT 0`).all()
  } catch {
    throw new Error('Management schema is corrupt')
  }
}

export function loadManagementReceipt(
  db: DatabaseSync,
  workspaceId: string,
  ownerId: string,
  key: string,
): ManagementReceiptRow | undefined {
  return db.prepare(`SELECT command_hash, result_json FROM management_command_receipt
    WHERE workspace_id = ? AND owner_id = ? AND command_key = ?`)
    .get(workspaceId, ownerId, key) as ManagementReceiptRow | undefined
}

export function insertManagementReceipt(
  db: DatabaseSync,
  workspaceId: string,
  ownerId: string,
  key: string,
  hash: string,
  result: unknown,
  createdAt: string,
): void {
  db.prepare(`INSERT INTO management_command_receipt
    (workspace_id, owner_id, command_key, command_hash, result_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(workspaceId, ownerId, key, hash, JSON.stringify(result), createdAt)
}

export function insertManagementAudit(db: DatabaseSync, row: ManagementAuditRow): void {
  db.prepare(`INSERT INTO management_audit
    (id, actor_id, workspace_id, kind, resource_id, action, reason, before_version, after_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      row.id,
      row.actor_id,
      row.workspace_id,
      row.kind,
      row.resource_id,
      row.action,
      row.reason,
      row.before_version,
      row.after_version,
      row.created_at,
    )
}

/** Newest-first, bounded to 100 rows for one owner-scoped resource. */
export function listManagementAudits(
  db: DatabaseSync,
  workspaceId: string,
  actorId: string,
  kind: 'employee' | 'project',
  resourceId: string,
  limit = 100,
): ManagementAuditRow[] {
  const bound = Math.min(Math.max(1, limit), 100)
  return db.prepare(`SELECT id, actor_id, workspace_id, kind, resource_id, action, reason,
      before_version, after_version, created_at
    FROM management_audit
    WHERE workspace_id = ? AND actor_id = ? AND kind = ? AND resource_id = ?
    ORDER BY rowid DESC
    LIMIT ?`)
    .all(workspaceId, actorId, kind, resourceId, bound) as unknown as ManagementAuditRow[]
}
