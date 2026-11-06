/** Durable, scope-projected invalidation journal. Schema installation is always explicit. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import {
  CHANGE_ENTITIES,
  ChangeFeedInputError,
  type ChangeEntity,
  type ChangeFeedPage,
  type ChangeFeedReader,
} from '../events/change-feed.ts'
import { LAO_SCHEMA_VERSION } from './store.ts'
import { VERIFICATION_SCHEMA_KEY, VERIFICATION_SCHEMA_VERSION, requireVerificationSchema } from './verification-jobs.ts'

export const CHANGE_FEED_SCHEMA_KEY = 'change-feed-schema'
export const CHANGE_FEED_SCHEMA_VERSION = 1 as const

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const JOURNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const HEX_128 = /^[a-f0-9]{32}$/
const SHA256 = /^[a-f0-9]{64}$/
const CURSOR_ASCII = /^[A-Za-z0-9_-]{1,256}$/
const DEFAULT_LIMIT = 100
const MAX_LIMIT = 200
const MAX_KEEP = 1_000_000
const META_ID = 1
const ENTITIES = new Set<string>(CHANGE_ENTITIES)

const TRIGGERS = [
  'change_feed_ticket_insert', 'change_feed_ticket_update', 'change_feed_ticket_delete',
  'change_feed_execution_insert', 'change_feed_execution_update', 'change_feed_execution_delete',
  'change_feed_verification_insert', 'change_feed_verification_update', 'change_feed_verification_delete',
  'change_feed_employee_insert', 'change_feed_employee_update', 'change_feed_employee_delete',
  'change_feed_project_insert', 'change_feed_project_update', 'change_feed_project_delete',
] as const

type CursorValue = { epoch: string; scope: string; sequence: number }
type Meta = { epoch: string; prunedThrough: number }

let savepointSequence = 0
let expectedTriggers: Map<string,string> | undefined
function normalizeSql(sql:string):string {return sql.replace(/\s+/g,' ').trim().replace(/;$/,'')}
function requireTriggerDefinitions(db:DatabaseSync):void {
  expectedTriggers ??= new Map([...triggerSql().matchAll(/CREATE TRIGGER\s+(\w+)\b[\s\S]*?\bEND;/g)]
    .map(match=>[match[1]!,normalizeSql(match[0])]))
  const rows=db.prepare(`SELECT name,sql FROM sqlite_master WHERE type='trigger'
    AND name IN (${TRIGGERS.map(()=>'?').join(',')})`).all(...TRIGGERS)
  const actual=new Map(rows.map(row=>[String(row.name),normalizeSql(String(row.sql))]))
  if(TRIGGERS.some(name=>actual.get(name)!==expectedTriggers!.get(name)))throw new Error('Change feed trigger definitions are corrupt')
}

function savepoint<T>(db: DatabaseSync, prefix: string, operation: () => T): T {
  const name = `${prefix}_${savepointSequence++}`
  db.exec(`SAVEPOINT ${name}`)
  try {
    const value = operation()
    db.exec(`RELEASE ${name}`)
    return value
  } catch (error) {
    try { db.exec(`ROLLBACK TO ${name}`) } finally { db.exec(`RELEASE ${name}`) }
    throw error
  }
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined
}

function triggerExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name) !== undefined
}

function indexExists(db: DatabaseSync, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name) !== undefined
}

function readVersion(db: DatabaseSync, key: string, label: string): number | undefined {
  if (!tableExists(db, 'kv')) return undefined
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
  if (!row) return undefined
  let value: unknown
  try { value = JSON.parse(String(row.value)) } catch { throw new Error(`Invalid ${label} schema metadata`) }
  if (!Number.isSafeInteger(value)) throw new Error(`Invalid ${label} schema metadata`)
  return Number(value)
}

function requireDependencySchema(db: DatabaseSync): void {
  const expected: Readonly<Record<string, number>> = {
    schema: LAO_SCHEMA_VERSION,
    'execution-schema': 1,
    'employee-schema': 1,
    'project-schema': 1,
    [VERIFICATION_SCHEMA_KEY]: VERIFICATION_SCHEMA_VERSION,
  }
  for (const [key, wanted] of Object.entries(expected)) {
    const value = readVersion(db, key, key)
    if (value !== wanted) throw new Error(`Change feed requires current schema: ${key}`)
  }
  try {
    db.prepare('SELECT id, value FROM ticket LIMIT 0').all()
    db.prepare(`SELECT execution_id, ticket_id, updated_at, spec_json, state_json FROM execution LIMIT 0`).all()
    db.prepare('SELECT verification_id, workspace_id, owner_id, ticket_id, updated_at FROM verification_job LIMIT 0').all()
    db.prepare('SELECT id, workspace_id, config_json FROM employee LIMIT 0').all()
    db.prepare('SELECT id, workspace_id, config_json FROM project LIMIT 0').all()
    requireVerificationSchema(db)
  } catch {
    throw new Error('Change feed dependency schema is incomplete or corrupt')
  }
}

function ownsChangeFeedObjects(db: DatabaseSync): boolean {
  return tableExists(db, 'change_feed')
    || tableExists(db, 'change_feed_meta')
    || TRIGGERS.some(name => triggerExists(db, name))
}

function readMeta(db: DatabaseSync): Meta {
  const rows = db.prepare('SELECT id, epoch, pruned_through FROM change_feed_meta').all() as Record<string, unknown>[]
  if (rows.length !== 1) throw new Error('Change feed schema is corrupt')
  const row = rows[0]!
  const id = Number(row.id)
  const epoch = row.epoch
  const prunedThrough = Number(row.pruned_through)
  if (id !== META_ID || typeof epoch !== 'string' || !HEX_128.test(epoch)
    || !Number.isSafeInteger(prunedThrough) || prunedThrough < 0) {
    throw new Error('Change feed schema is corrupt')
  }
  return { epoch, prunedThrough }
}

/** Read-only validation. It never creates, repairs, or migrates feed state. */
export function requireChangeFeedSchema(db: DatabaseSync): void {
  requireDependencySchema(db)
  const version = readVersion(db, CHANGE_FEED_SCHEMA_KEY, 'change feed')
  if (version === undefined) throw new Error('Change feed schema is not initialized')
  if (version !== CHANGE_FEED_SCHEMA_VERSION) throw new Error(`Unsupported change feed schema version: ${version}`)
  if (!tableExists(db, 'change_feed') || !tableExists(db, 'change_feed_meta')
    || !indexExists(db, 'change_feed_scope_sequence')
    || TRIGGERS.some(name => !triggerExists(db, name))) {
    throw new Error('Change feed schema is incomplete')
  }
  try {
    requireTriggerDefinitions(db)
    db.prepare(`SELECT sequence, workspace_id, owner_id, entity, resource_id, ticket_id, at
      FROM change_feed LIMIT 0`).all()
    const tableSql = String(db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'change_feed'").get()?.sql ?? '')
    if (!/sequence\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/i.test(tableSql)) {
      throw new Error('Change feed schema is corrupt')
    }
    readMeta(db)
  } catch (error) {
    if (error instanceof Error && /^Change feed schema/.test(error.message)) throw error
    throw new Error('Change feed schema is corrupt')
  }
}

const TICKET_SCOPE = (alias: string) => `
  JOIN project AS p
    ON ${alias}.value ->> '$.lifecycle.issue.source' = 'manual:' || p.workspace_id || ':' || p.id
  WHERE ${alias}.value ->> '$.mandate.actor.source' = ${alias}.value ->> '$.lifecycle.issue.source'
    AND typeof(${alias}.value ->> '$.mandate.actor.id') = 'text'
    AND length(${alias}.value ->> '$.mandate.actor.id') > 0`

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

function triggerSql(): string {
  return `
    CREATE TRIGGER change_feed_ticket_insert AFTER INSERT ON ticket BEGIN
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        SELECT p.workspace_id, NEW.value ->> '$.mandate.actor.id', 'task', NEW.id, NULL, ${NOW}
        FROM (SELECT 1) ${TICKET_SCOPE('NEW')};
    END;
    CREATE TRIGGER change_feed_ticket_update AFTER UPDATE ON ticket
    WHEN OLD.id IS NOT NEW.id OR OLD.value IS NOT NEW.value BEGIN
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        SELECT p.workspace_id, OLD.value ->> '$.mandate.actor.id', 'task', OLD.id, NULL, ${NOW}
        FROM (SELECT 1) ${TICKET_SCOPE('OLD')}
          AND NOT EXISTS (
            SELECT 1 FROM project AS np
            WHERE NEW.value ->> '$.lifecycle.issue.source' = 'manual:' || np.workspace_id || ':' || np.id
              AND NEW.value ->> '$.mandate.actor.source' = NEW.value ->> '$.lifecycle.issue.source'
              AND np.workspace_id = p.workspace_id
              AND NEW.value ->> '$.mandate.actor.id' = OLD.value ->> '$.mandate.actor.id'
              AND NEW.id = OLD.id
          );
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        SELECT p.workspace_id, NEW.value ->> '$.mandate.actor.id', 'task', NEW.id, NULL, ${NOW}
        FROM (SELECT 1) ${TICKET_SCOPE('NEW')};
    END;
    CREATE TRIGGER change_feed_ticket_delete AFTER DELETE ON ticket BEGIN
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        SELECT p.workspace_id, OLD.value ->> '$.mandate.actor.id', 'task', OLD.id, NULL, ${NOW}
        FROM (SELECT 1) ${TICKET_SCOPE('OLD')};
    END;

    CREATE TRIGGER change_feed_execution_insert AFTER INSERT ON execution BEGIN
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        SELECT p.workspace_id, t.value ->> '$.mandate.actor.id', 'execution', NEW.execution_id, NEW.ticket_id, ${NOW}
        FROM ticket AS t ${TICKET_SCOPE('t')} AND t.id = NEW.ticket_id;
    END;
    CREATE TRIGGER change_feed_execution_update AFTER UPDATE ON execution
    WHEN OLD.execution_id IS NOT NEW.execution_id OR OLD.assignment_id IS NOT NEW.assignment_id
      OR OLD.ticket_id IS NOT NEW.ticket_id OR OLD.agent_id IS NOT NEW.agent_id OR OLD.runtime IS NOT NEW.runtime
      OR OLD.generation IS NOT NEW.generation OR OLD.cwd IS NOT NEW.cwd OR OLD.input_revision IS NOT NEW.input_revision
      OR OLD.policy_version IS NOT NEW.policy_version OR OLD.state IS NOT NEW.state OR OLD.runner_id IS NOT NEW.runner_id
      OR OLD.last_sequence IS NOT NEW.last_sequence OR OLD.created_at IS NOT NEW.created_at
      OR OLD.updated_at IS NOT NEW.updated_at OR OLD.spec_json IS NOT NEW.spec_json OR OLD.state_json IS NOT NEW.state_json BEGIN
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        SELECT p.workspace_id, t.value ->> '$.mandate.actor.id', 'execution', OLD.execution_id, OLD.ticket_id, ${NOW}
        FROM ticket AS t ${TICKET_SCOPE('t')} AND t.id = OLD.ticket_id
          AND NOT EXISTS (
            SELECT 1 FROM ticket AS nt JOIN project AS np
              ON nt.value ->> '$.lifecycle.issue.source' = 'manual:' || np.workspace_id || ':' || np.id
            WHERE nt.id = NEW.ticket_id
              AND nt.value ->> '$.mandate.actor.source' = nt.value ->> '$.lifecycle.issue.source'
              AND np.workspace_id = p.workspace_id
              AND nt.value ->> '$.mandate.actor.id' = t.value ->> '$.mandate.actor.id'
              AND NEW.execution_id = OLD.execution_id
          );
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        SELECT p.workspace_id, t.value ->> '$.mandate.actor.id', 'execution', NEW.execution_id, NEW.ticket_id, ${NOW}
        FROM ticket AS t ${TICKET_SCOPE('t')} AND t.id = NEW.ticket_id;
    END;
    CREATE TRIGGER change_feed_execution_delete AFTER DELETE ON execution BEGIN
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        SELECT p.workspace_id, t.value ->> '$.mandate.actor.id', 'execution', OLD.execution_id, OLD.ticket_id, ${NOW}
        FROM ticket AS t ${TICKET_SCOPE('t')} AND t.id = OLD.ticket_id;
    END;

    CREATE TRIGGER change_feed_verification_insert AFTER INSERT ON verification_job BEGIN
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        SELECT p.workspace_id, t.value ->> '$.mandate.actor.id', 'verification', NEW.verification_id, NEW.ticket_id, ${NOW}
        FROM ticket AS t ${TICKET_SCOPE('t')} AND t.id = NEW.ticket_id
          AND NEW.workspace_id = p.workspace_id
          AND NEW.owner_id = t.value ->> '$.mandate.actor.id';
    END;
    CREATE TRIGGER change_feed_verification_update AFTER UPDATE ON verification_job
    WHEN OLD.verification_id IS NOT NEW.verification_id OR OLD.workspace_id IS NOT NEW.workspace_id
      OR OLD.owner_id IS NOT NEW.owner_id OR OLD.ticket_id IS NOT NEW.ticket_id OR OLD.status IS NOT NEW.status
      OR OLD.version IS NOT NEW.version OR OLD.last_sequence IS NOT NEW.last_sequence OR OLD.runner_id IS NOT NEW.runner_id
      OR OLD.runner_pid IS NOT NEW.runner_pid OR OLD.process_id IS NOT NEW.process_id OR OLD.created_at IS NOT NEW.created_at
      OR OLD.updated_at IS NOT NEW.updated_at OR OLD.finished_at IS NOT NEW.finished_at
      OR OLD.request_json IS NOT NEW.request_json OR OLD.record_json IS NOT NEW.record_json BEGIN
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        SELECT p.workspace_id, t.value ->> '$.mandate.actor.id', 'verification', OLD.verification_id, OLD.ticket_id, ${NOW}
        FROM ticket AS t ${TICKET_SCOPE('t')} AND t.id = OLD.ticket_id
          AND OLD.workspace_id = p.workspace_id AND OLD.owner_id = t.value ->> '$.mandate.actor.id'
          AND NOT EXISTS (
            SELECT 1 FROM ticket AS nt JOIN project AS np
              ON nt.value ->> '$.lifecycle.issue.source' = 'manual:' || np.workspace_id || ':' || np.id
            WHERE nt.id = NEW.ticket_id
              AND nt.value ->> '$.mandate.actor.source' = nt.value ->> '$.lifecycle.issue.source'
              AND NEW.workspace_id = np.workspace_id
              AND NEW.owner_id = nt.value ->> '$.mandate.actor.id'
              AND np.workspace_id = p.workspace_id
              AND nt.value ->> '$.mandate.actor.id' = t.value ->> '$.mandate.actor.id'
              AND NEW.verification_id = OLD.verification_id
          );
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        SELECT p.workspace_id, t.value ->> '$.mandate.actor.id', 'verification', NEW.verification_id, NEW.ticket_id, ${NOW}
        FROM ticket AS t ${TICKET_SCOPE('t')} AND t.id = NEW.ticket_id
          AND NEW.workspace_id = p.workspace_id
          AND NEW.owner_id = t.value ->> '$.mandate.actor.id';
    END;
    CREATE TRIGGER change_feed_verification_delete AFTER DELETE ON verification_job BEGIN
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        SELECT p.workspace_id, t.value ->> '$.mandate.actor.id', 'verification', OLD.verification_id, OLD.ticket_id, ${NOW}
        FROM ticket AS t ${TICKET_SCOPE('t')} AND t.id = OLD.ticket_id
          AND OLD.workspace_id = p.workspace_id
          AND OLD.owner_id = t.value ->> '$.mandate.actor.id';
    END;

    CREATE TRIGGER change_feed_employee_insert AFTER INSERT ON employee BEGIN
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        VALUES (NEW.workspace_id, NULL, 'employee', NEW.id, NULL, ${NOW});
    END;
    CREATE TRIGGER change_feed_employee_update AFTER UPDATE ON employee
    WHEN OLD.id IS NOT NEW.id OR OLD.workspace_id IS NOT NEW.workspace_id OR OLD.name IS NOT NEW.name
      OR OLD.version IS NOT NEW.version OR OLD.enabled IS NOT NEW.enabled OR OLD.runtime_id IS NOT NEW.runtime_id
      OR OLD.config_json IS NOT NEW.config_json BEGIN
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        SELECT OLD.workspace_id, NULL, 'employee', OLD.id, NULL, ${NOW}
        WHERE OLD.workspace_id IS NOT NEW.workspace_id OR OLD.id IS NOT NEW.id;
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        VALUES (NEW.workspace_id, NULL, 'employee', NEW.id, NULL, ${NOW});
    END;
    CREATE TRIGGER change_feed_employee_delete AFTER DELETE ON employee BEGIN
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        VALUES (OLD.workspace_id, NULL, 'employee', OLD.id, NULL, ${NOW});
    END;

    CREATE TRIGGER change_feed_project_insert AFTER INSERT ON project BEGIN
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        VALUES (NEW.workspace_id, NULL, 'project', NEW.id, NULL, ${NOW});
    END;
    CREATE TRIGGER change_feed_project_update AFTER UPDATE ON project
    WHEN OLD.id IS NOT NEW.id OR OLD.workspace_id IS NOT NEW.workspace_id OR OLD.name IS NOT NEW.name
      OR OLD.version IS NOT NEW.version OR OLD.archived IS NOT NEW.archived OR OLD.repository_path IS NOT NEW.repository_path
      OR OLD.worktree_root IS NOT NEW.worktree_root OR OLD.config_json IS NOT NEW.config_json BEGIN
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        SELECT OLD.workspace_id, NULL, 'project', OLD.id, NULL, ${NOW}
        WHERE OLD.workspace_id IS NOT NEW.workspace_id OR OLD.id IS NOT NEW.id;
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        VALUES (NEW.workspace_id, NULL, 'project', NEW.id, NULL, ${NOW});
    END;
    CREATE TRIGGER change_feed_project_delete AFTER DELETE ON project BEGIN
      INSERT INTO change_feed (workspace_id, owner_id, entity, resource_id, ticket_id, at)
        VALUES (OLD.workspace_id, NULL, 'project', OLD.id, NULL, ${NOW});
    END;
  `
}

/** Installs the journal and all resource triggers in one caller-compatible SQLite savepoint. */
export function initializeChangeFeedSchema(db: DatabaseSync): void {
  requireDependencySchema(db)
  const version = readVersion(db, CHANGE_FEED_SCHEMA_KEY, 'change feed')
  if (version !== undefined) {
    if (version !== CHANGE_FEED_SCHEMA_VERSION) throw new Error(`Unsupported change feed schema version: ${version}`)
    requireChangeFeedSchema(db)
    return
  }
  if (ownsChangeFeedObjects(db)) throw new Error('Unversioned change feed schema; refusing implicit migration')
  savepoint(db, 'change_feed_schema', () => {
    db.exec(`
      CREATE TABLE change_feed (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id TEXT NOT NULL,
        owner_id TEXT,
        entity TEXT NOT NULL CHECK (entity IN ('task', 'execution', 'verification', 'employee', 'project')),
        resource_id TEXT NOT NULL,
        ticket_id TEXT,
        at TEXT NOT NULL
      );
      CREATE INDEX change_feed_scope_sequence ON change_feed (workspace_id, owner_id, sequence);
      CREATE TABLE change_feed_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        epoch TEXT NOT NULL CHECK (length(epoch) = 32),
        pruned_through INTEGER NOT NULL CHECK (pruned_through >= 0)
      );
      INSERT INTO change_feed_meta (id, epoch, pruned_through) VALUES (1, lower(hex(randomblob(16))), 0);
    `)
    db.exec(triggerSql())
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(
      CHANGE_FEED_SCHEMA_KEY,
      JSON.stringify(CHANGE_FEED_SCHEMA_VERSION),
    )
    requireChangeFeedSchema(db)
  })
}

function requireSafeId(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error('Invalid change feed scope')
  return value
}

function scopeHash(ownerId: string, workspaceId: string): string {
  return createHash('sha256').update(JSON.stringify([ownerId, workspaceId])).digest('hex')
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify([1, value.epoch, value.scope, value.sequence]), 'utf8').toString('base64url')
}

function decodeCursor(value: unknown): CursorValue {
  try {
    if (typeof value !== 'string' || !CURSOR_ASCII.test(value)) throw new Error()
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) throw new Error()
    const parsed: unknown = JSON.parse(decoded.toString('utf8'))
    if (!Array.isArray(parsed) || parsed.length !== 4 || parsed[0] !== 1
      || typeof parsed[1] !== 'string' || !HEX_128.test(parsed[1])
      || typeof parsed[2] !== 'string' || !SHA256.test(parsed[2])
      || typeof parsed[3] !== 'number' || !Number.isSafeInteger(parsed[3]) || parsed[3] < 0) throw new Error()
    return { epoch: parsed[1], scope: parsed[2], sequence: parsed[3] }
  } catch {
    throw new ChangeFeedInputError()
  }
}

function requireCanonicalTimestamp(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new Error('Change feed row is corrupt')
  }
  return value
}

function safeInteger(value: unknown, minimum: number, label: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`Change feed ${label} is corrupt`)
  }
  return number
}

function currentHead(db: DatabaseSync, meta: Meta): number {
  const row = db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'change_feed'").get()
  const sequence = row === undefined ? 0 : safeInteger(row.seq, 0, 'sequence')
  const greatest = db.prepare('SELECT MAX(sequence) AS sequence FROM change_feed').get()?.sequence
  if (sequence < meta.prunedThrough || (greatest !== null && greatest !== undefined && sequence < safeInteger(greatest,1,'sequence'))) {
    throw new Error('Change feed sequence metadata is corrupt')
  }
  return sequence
}

function normalizeReadInput(input: { cursor?: string; limit?: number } | undefined): { cursor?: string; limit: number } {
  if (input === undefined) return { limit: DEFAULT_LIMIT }
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ChangeFeedInputError()
  const record = input as Record<string, unknown>
  if (Object.keys(record).some(key => key !== 'cursor' && key !== 'limit')) throw new ChangeFeedInputError()
  if (record.cursor !== undefined && typeof record.cursor !== 'string') throw new ChangeFeedInputError()
  const limit = record.limit === undefined ? DEFAULT_LIMIT : record.limit
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ChangeFeedInputError()
  }
  return { ...(record.cursor === undefined ? {} : { cursor: record.cursor }), limit }
}

export interface ChangeFeedRepositoryOptions { db: DatabaseSync; ownerId: string; workspaceId: string }

/** Owner/workspace-scoped reader plus explicit global retention operation. */
export class ChangeFeedRepository implements ChangeFeedReader {
  private readonly db: DatabaseSync
  private readonly ownerId: string
  private readonly workspaceId: string
  private readonly scope: string

  constructor(options: ChangeFeedRepositoryOptions) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Invalid change feed repository options')
    const record = options as unknown as Record<string, unknown>
    if (Object.keys(record).some(key => key !== 'db' && key !== 'ownerId' && key !== 'workspaceId')) {
      throw new Error('Invalid change feed repository options')
    }
    if (!options.db || typeof options.db.prepare !== 'function') throw new Error('Invalid change feed database')
    this.db = options.db
    this.ownerId = requireSafeId(options.ownerId)
    this.workspaceId = requireSafeId(options.workspaceId)
    this.scope = scopeHash(this.ownerId, this.workspaceId)
    requireChangeFeedSchema(this.db)
  }

  readPage(input?: { cursor?: string; limit?: number }): ChangeFeedPage {
    const normalized = normalizeReadInput(input)
    if (this.db.isTransaction) throw new Error('Change feed reads require no open caller transaction')
    const requested = normalized.cursor === undefined ? undefined : decodeCursor(normalized.cursor)
    this.db.exec('BEGIN DEFERRED')
    try {
      requireChangeFeedSchema(this.db)
      const meta = readMeta(this.db)
      const head = currentHead(this.db, meta)
      const headCursor = encodeCursor({ epoch: meta.epoch, scope: this.scope, sequence: head })
      if (!requested) {
        this.db.exec('COMMIT')
        return { changes: [], cursor: headCursor, hasMore: false, reset: { cursor: headCursor, reason: 'initial' } }
      }
      if (requested.epoch !== meta.epoch || requested.scope !== this.scope) {
        this.db.exec('COMMIT')
        return { changes: [], cursor: headCursor, hasMore: false, reset: { cursor: headCursor, reason: 'replaced' } }
      }
      if (requested.sequence > head) {
        this.db.exec('COMMIT')
        return { changes: [], cursor: headCursor, hasMore: false, reset: { cursor: headCursor, reason: 'future' } }
      }
      // Cursor is last acknowledged sequence: equality has already consumed every removed row.
      if (requested.sequence < meta.prunedThrough) {
        this.db.exec('COMMIT')
        return { changes: [], cursor: headCursor, hasMore: false, reset: { cursor: headCursor, reason: 'expired' } }
      }

      const rows = this.db.prepare(`SELECT sequence, workspace_id, owner_id, entity, resource_id, ticket_id, at
        FROM change_feed
        WHERE workspace_id = ? AND (owner_id = ? OR owner_id IS NULL) AND sequence > ?
        ORDER BY sequence LIMIT ?`).all(
        this.workspaceId,
        this.ownerId,
        requested.sequence,
        normalized.limit + 1,
      ) as Record<string, unknown>[]
      const hasMore = rows.length > normalized.limit
      const visible = hasMore ? rows.slice(0, normalized.limit) : rows
      const changes = visible.map(row => {
        const sequence = safeInteger(row.sequence, 1, 'row')
        if (row.workspace_id !== this.workspaceId || (row.owner_id !== null && row.owner_id !== this.ownerId)
          || typeof row.entity !== 'string' || !ENTITIES.has(row.entity)
          || typeof row.resource_id !== 'string' || !JOURNAL_ID.test(row.resource_id)
          || (row.ticket_id !== null && (typeof row.ticket_id !== 'string' || !JOURNAL_ID.test(row.ticket_id)))) {
          throw new Error('Change feed row is corrupt')
        }
        const notice = {
          entity: row.entity as ChangeEntity,
          resourceId: row.resource_id,
          ...(row.ticket_id === null ? {} : { ticketId: row.ticket_id as string }),
          at: requireCanonicalTimestamp(row.at),
        }
        return { cursor: encodeCursor({ epoch: meta.epoch, scope: this.scope, sequence }), notice }
      })
      const pageCursor = hasMore
        ? changes.at(-1)!.cursor
        : headCursor
      this.db.exec('COMMIT')
      return { changes, cursor: pageCursor, hasMore }
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK')
      throw error
    }
  }

  prune(keepLast: number): { removed: number } {
    if (typeof keepLast !== 'number' || !Number.isSafeInteger(keepLast) || keepLast < 1 || keepLast > MAX_KEEP) {
      throw new Error(`keepLast must be between 1 and ${MAX_KEEP}`)
    }
    requireChangeFeedSchema(this.db)
    return savepoint(this.db, 'change_feed_prune', () => {
      const boundary = this.db.prepare('SELECT sequence FROM change_feed ORDER BY sequence DESC LIMIT 1 OFFSET ?')
        .get(keepLast - 1) as { sequence?: unknown } | undefined
      if (!boundary) return { removed: 0 }
      const oldestRetained = safeInteger(boundary.sequence, 1, 'retention boundary')
      const removedMax = this.db.prepare('SELECT MAX(sequence) AS sequence FROM change_feed WHERE sequence < ?')
        .get(oldestRetained) as { sequence?: unknown } | undefined
      if (removedMax?.sequence === null || removedMax?.sequence === undefined) return { removed: 0 }
      const watermark = safeInteger(removedMax.sequence, 1, 'retention watermark')
      const result = this.db.prepare('DELETE FROM change_feed WHERE sequence <= ?').run(watermark)
      const removed = safeInteger(result.changes, 0, 'retention count')
      this.db.prepare(`UPDATE change_feed_meta
        SET pruned_through = CASE WHEN pruned_through < ? THEN ? ELSE pruned_through END WHERE id = ?`)
        .run(watermark, watermark, META_ID)
      return { removed }
    })
  }
}
