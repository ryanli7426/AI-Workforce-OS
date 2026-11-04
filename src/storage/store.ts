/** Independent SQLite Store for LAO; reuses the original domain repositories and transactions. */
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { SqliteRepositories } from './sqlite.ts'
import type { TaskState } from '../core/lifecycle-model.ts'

export const LAO_SCHEMA_VERSION = 12
export interface StoreOptions {
  /** Explicit opt-in, with a consistent SQLite snapshot before converting legacy schema 11. */
  migrateLegacy?: boolean
  report?: (error: unknown) => void
}
/** Validate ownership/version before the repository can enable WAL or create tables. */
function preflight(path: string, options: StoreOptions): void {
  if (path === ':memory:' || !existsSync(path) || statSync(path).size === 0) return
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(row => String(row.name))
    if (!tables.length) return
    if (!tables.includes('kv')) throw new Error('Unversioned database; refusing implicit migration')
    const row = db.prepare("SELECT value FROM kv WHERE key = 'schema'").get()
    if (!row) throw new Error('Unversioned database; refusing implicit migration')
    let version: unknown
    try { version = JSON.parse(String(row.value)) } catch { throw new Error('Invalid database schema metadata') }
    if (version !== 11 && version !== LAO_SCHEMA_VERSION) throw new Error(`Unsupported LAO schema ${String(version)}`)
    if (version === 11 && !options.migrateLegacy) throw new Error('Legacy schema 11 requires explicit migrateLegacy and backup')
  } finally { db.close() }
}
/** Owns the standalone schema and quarantines legacy runtime work instead of relaunching it. */
export class LocalStore extends SqliteRepositories {
  readonly backupPath?: string
  constructor(path: string, options: StoreOptions = {}) {
    preflight(path, options)
    super(path, options.report)
    try {
      const version = this.get<number>('schema')
      if (version === undefined && this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ticket'").get()
        && this.db.prepare('SELECT 1 FROM ticket LIMIT 1').get()) throw new Error('Unversioned database contains tasks; refusing implicit migration')
      if (version !== undefined && version !== 11 && version !== LAO_SCHEMA_VERSION) throw new Error(`Unsupported LAO schema ${version}; only schema 11 can be imported`)
      if (version === 11 && !options.migrateLegacy) throw new Error('Legacy schema 11 requires explicit migrateLegacy and backup')
      if (version === 11 && path === ':memory:') throw new Error('Legacy migration requires a file-backed backup')
      if (version === 11) {
        this.backupPath = `${path}.schema11-${randomUUID()}.sqlite`
        this.db.prepare('VACUUM INTO ?').run(this.backupPath)
        chmodSync(this.backupPath, 0o600)
      }
      this.atomic(() => {
        this.initializeSchema()
        this.initializeWorkflow()
        if (version === 11) this.importLegacy()
        this.set('schema', LAO_SCHEMA_VERSION)
      })
    } catch (error) { this.close(); throw error }
  }
  private importLegacy(): void {
    const at = new Date().toISOString()
    for (const ticket of this.tickets.list()) {
      if (ticket.lifecycle) throw new Error('Unexpected LAO lifecycle in legacy database')
      const status: TaskState = !ticket.ended ? 'BLOCKED' : ['completed', 'merged'].includes(ticket.ended.outcome) ? 'DONE' : 'CANCELLED'
      ticket.lifecycle = { status, version: 1, taskType: 'legacy', attempts: ticket.assignments.length,
        policy: { approvalRequired: true, reviewRequired: true, retryLimit: 0 }, policyVersion: ticket.mandate.policyVersion,
        issue: { source: 'legacy-import', issueId: ticket.id, revision: 'schema11', updatedAt: ticket.updatedAt,
          priority: 0, closed: !!ticket.ended, description: ticket.mandate.scope } }
      // Preserve original assignment identities and active flags: no runtime can assume their processes stopped.
      for (const assignment of ticket.assignments) assignment.runtime ??= 'legacy-unavailable'
      this.tickets.save(ticket)
      this.workflow.bindIssue(ticket.lifecycle.issue, ticket.id)
      this.workflow.append({ id: randomUUID(), ticketId: ticket.id, at, actor: 'migration', kind: 'migration', to: status,
        policyVersion: ticket.mandate.policyVersion, reason: 'Imported historical state; legacy runtime cannot be resumed by LAO' })
    }
    // Keep exact copies for audit, but never dispatch old DSH effects or old pending messages.
    this.db.exec(`CREATE TABLE legacy_effect AS SELECT * FROM effect;
      CREATE TABLE legacy_outbox AS SELECT * FROM outbox;
      DELETE FROM effect;
      UPDATE outbox SET value = json_set(value, '$.status', 'dropped', '$.dropped.reason', 'channelIgnored', '$.dropped.at', '${at}')
        WHERE value ->> '$.status' = 'pending';`)
    for (const thread of this.threads.list()) {
      // Preserve queued/evaluating records in an audit snapshot while disabling replay into a different runtime.
      this.set(`legacy-thread:${thread.key}`, thread)
      thread.pending = []; delete thread.evaluating
      this.threads.save(thread)
    }
  }
}
