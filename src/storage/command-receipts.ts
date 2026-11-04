/** Durable command receipts. Schema installation is explicit; reads never initialize storage. */
import type { DatabaseSync } from 'node:sqlite'
import type { Ticket } from '../core/model.ts'
import { LAO_SCHEMA_VERSION } from './store.ts'

export const COMMAND_SCHEMA_KEY = 'command-schema'
export const COMMAND_SCHEMA_VERSION = 1 as const
export interface CommandReceiptRow { command_hash: string; result_json: string }
let savepointSequence = 0

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

function schemaVersion(db: DatabaseSync, key: string): number | undefined {
  if (!tableExists(db, 'kv')) return undefined
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
  if (!row) return undefined
  let value: unknown
  try { value = JSON.parse(String(row.value)) } catch { throw new Error('Invalid command schema metadata') }
  if (!Number.isSafeInteger(value)) throw new Error('Invalid command schema metadata')
  return value as number
}

/** Called only by an explicit initialization/migration composition. */
export function initializeCommandSchema(db: DatabaseSync): void {
  if (schemaVersion(db, 'schema') !== LAO_SCHEMA_VERSION)
    throw new Error(`Command schema requires initialized main schema ${LAO_SCHEMA_VERSION}`)
  const version = schemaVersion(db, COMMAND_SCHEMA_KEY)
  if (version !== undefined && version !== COMMAND_SCHEMA_VERSION) throw new Error('Unsupported command schema')
  if (version === undefined && tableExists(db, 'task_command_receipt'))
    throw new Error('Unversioned command schema; refusing implicit migration')
  const point = `command_schema_${savepointSequence++}`
  db.exec(`SAVEPOINT ${point}`)
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS task_command_receipt (
      workspace_id TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      command_key TEXT NOT NULL,
      command_hash TEXT NOT NULL,
      result_json TEXT NOT NULL CHECK (json_valid(result_json)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, owner_id, command_key)
    );
    CREATE INDEX IF NOT EXISTS task_command_receipt_scope ON task_command_receipt (workspace_id, owner_id);`)
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(COMMAND_SCHEMA_KEY, JSON.stringify(COMMAND_SCHEMA_VERSION))
    db.exec(`RELEASE ${point}`)
  } catch (error) {
    try { db.exec(`ROLLBACK TO ${point}`) } finally { db.exec(`RELEASE ${point}`) }
    throw error
  }
}

/** Preflight only; also checks actual columns when metadata alone appears valid. */
export function requireCommandSchema(db: DatabaseSync): void {
  if (schemaVersion(db, 'schema') !== LAO_SCHEMA_VERSION) throw new Error('Unsupported main schema for command receipts')
  const version = schemaVersion(db, COMMAND_SCHEMA_KEY)
  if (version === undefined) throw new Error('Command schema is not initialized')
  if (version !== COMMAND_SCHEMA_VERSION) throw new Error('Unsupported command schema')
  try {
    db.prepare(`SELECT workspace_id, owner_id, command_key, command_hash, result_json, created_at
      FROM task_command_receipt LIMIT 0`).all()
  } catch { throw new Error('Command receipt schema is corrupt') }
}

export function loadReceipt(db: DatabaseSync, workspaceId: string, ownerId: string, key: string): CommandReceiptRow | undefined {
  return db.prepare(`SELECT command_hash, result_json FROM task_command_receipt
    WHERE workspace_id = ? AND owner_id = ? AND command_key = ?`)
    .get(workspaceId, ownerId, key) as CommandReceiptRow | undefined
}

export function insertReceipt(db: DatabaseSync, workspaceId: string, ownerId: string, key: string,
  hash: string, ticket: Ticket, createdAt: string): void {
  db.prepare(`INSERT INTO task_command_receipt
    (workspace_id, owner_id, command_key, command_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(workspaceId, ownerId, key, hash, JSON.stringify(ticket), createdAt)
}
