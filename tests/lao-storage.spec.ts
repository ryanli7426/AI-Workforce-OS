import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalStore } from '../src/storage/store.ts'
import { SqliteRepositories } from '../src/storage/sqlite.ts'
import { lao } from './fixtures/lao.ts'

let dir: string
const opened: SqliteRepositories[] = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lao-storage-')) })
afterEach(() => { for (const s of opened.splice(0)) { try { s.close() } catch {} }; rmSync(dir, { recursive: true, force: true }) })
const open = (path = join(dir, 'lao.sqlite')) => { const s = new LocalStore(path); opened.push(s); return s }

describe('SQLite integration', () => {
  it('persists domain facts, source identity, execution evidence and review through reopen', () => {
    const path = join(dir, 'state.sqlite'), store = open(path), h = lao(store), t = h.accept(), a = h.running(t.id)
    h.engine.recordExecution(t.id, h.result(a)); h.verify(t.id, a); h.engine.reviewTask(t.id, h.review(a))
    const before = store.workflow.history(t.id)
    store.close()
    const again = open(path)
    expect(again.tickets.get(t.id)?.lifecycle?.status).toBe('DONE')
    expect(again.workflow.history(t.id)).toEqual(before)
    expect(again.workflow.findIssue(t.lifecycle!.issue)).toBe(t.id)
    expect(again.workflow.domainEvents().some(e => e.type === 'trigger.received')).toBe(true)
    expect(again.db.prepare('SELECT count(*) AS n FROM approval_history').get()?.n).toBe(1)
    expect(lao(again).accept(undefined, h.trigger('revision-2')).id).toBe(t.id)
    expect(again.tickets.list()).toHaveLength(1)
  })
  it('rolls back acceptance, bindings and domain events in one transaction', () => {
    const store = open(), h = lao(store)
    expect(() => store.atomic(() => { h.accept(); throw new Error('crash') })).toThrow('crash')
    expect(store.tickets.list()).toEqual([])
    expect(store.workflow.domainEvents()).toEqual([])
    expect(store.workflow.findIssue(h.outcome().task!.issue)).toBeUndefined()
    h.accept()
    expect(store.tickets.list()).toHaveLength(1)
  })
  it('enforces source uniqueness across separate SQLite connections', () => {
    const path = join(dir, 'state.sqlite'), first = open(path), second = open(path), h = lao(first), t = h.accept()
    expect(() => second.workflow.bindIssue(t.lifecycle!.issue, 'another')).toThrow('already bound')
    expect(lao(second).accept(undefined, h.trigger('another-event')).id).toBe(t.id)
    expect(first.tickets.list()).toHaveLength(1)
  })
  it('discards nested afterCommit actions on rollback and publishes only committed actions', () => {
    const store = open(), events: string[] = []
    store.atomic(() => {
      store.set('outer', true); store.afterCommit(() => events.push('outer'))
      expect(() => store.atomic(() => { store.set('inner', true); store.afterCommit(() => events.push('inner')); throw new Error('bad') })).toThrow()
      expect(events).toEqual([])
      store.atomic(() => { store.set('other', true); store.afterCommit(() => events.push('other')) })
    })
    expect(events).toEqual(['outer', 'other'])
    expect(store.get('inner')).toBeUndefined()
    expect(store.get('outer')).toBe(true)
  })
  it('rolls back launch intent with failed assignment reservation', () => {
    const store = open(), h = lao(store, { executor: {
      start: (t, a) => { store.db.prepare('INSERT INTO effect (kind,key,value,seq,due,since) VALUES (?,?,?,?,?,?)')
        .run('launch', a.id, JSON.stringify({ ticketId: t.id }), 1, 0, t.updatedAt); throw new Error('intent failed') },
      deliver: () => {}, stop: () => {},
    } }), t = h.accept()
    expect(() => h.running(t.id)).toThrow('intent failed')
    expect(store.tickets.get(t.id)?.lifecycle?.status).toBe('QUEUED')
    expect(store.tickets.get(t.id)?.assignments).toEqual([])
    expect(store.db.prepare('SELECT count(*) AS n FROM effect').get()?.n).toBe(0)
  })
  it('keeps interrupted work blocked after reopen and does not call executor.start', () => {
    const path = join(dir, 'state.sqlite'), first = open(path), h = lao(first), t = h.accept(), a = h.running(t.id)
    first.close()
    const second = open(path), recovered = lao(second)
    recovered.engine.assignmentInterrupted(t.id, a)
    expect(recovered.starts).toEqual([])
    expect(() => recovered.engine.retryTicket(t.id)).toThrow('confirmed stopped')
    expect(second.tickets.get(t.id)?.lifecycle?.status).toBe('BLOCKED')
  })
})

/** Produces the original schema without importing its host-specific application layer. */
class LegacyFixture extends SqliteRepositories {
  constructor(path: string) { super(path); this.atomic(() => { this.initializeSchema(); this.set('schema', 11) }) }
}
function legacy(path: string) {
  const store = new LegacyFixture(path); opened.push(store)
  const h = lao(), ticket = h.accept(), assignment = h.running(ticket.id)
  const old = h.repo.tickets.get(ticket.id)!
  delete old.lifecycle
  store.tickets.save(old)
  store.triggers.save(h.trigger())
  store.decisions.save(h.repo.decisions.get(old.decisionId)!)
  store.db.prepare('INSERT INTO effect (kind,key,value,seq,due,since) VALUES (?,?,?,?,?,?)').run('launch', assignment, '{}', 1, 0, old.updatedAt)
  store.close()
  return ticket.id
}
describe('schema 11 import', () => {
  it('requires explicit migration and backs up before quarantining legacy work', () => {
    const path = join(dir, 'legacy.sqlite'), id = legacy(path)
    expect(() => new LocalStore(path)).toThrow('explicit')
    const store = new LocalStore(path, { migrateLegacy: true }); opened.push(store)
    expect(existsSync(store.backupPath!)).toBe(true)
    const backup = new DatabaseSync(store.backupPath!, { readOnly: true })
    expect(backup.prepare("SELECT value FROM kv WHERE key='schema'").get()?.value).toBe('11'); backup.close()
    expect(store.get('schema')).toBe(12)
    expect(store.tickets.get(id)?.lifecycle?.status).toBe('BLOCKED')
    expect(store.tickets.get(id)?.assignments.at(-1)?.state).toBe('running')
    expect(store.db.prepare('SELECT count(*) AS n FROM effect').get()?.n).toBe(0)
    expect(store.db.prepare('SELECT count(*) AS n FROM legacy_effect').get()?.n).toBe(1)
    expect(lao(store).starts).toEqual([])
  })
  it('leaves version and legacy effects unchanged when a migration fails', () => {
    const path = join(dir, 'legacy.sqlite'), id = legacy(path)
    const db = new DatabaseSync(path)
    // Simulate a corrupt legacy aggregate that cannot be converted.
    db.prepare('UPDATE ticket SET value = json_remove(value, ?) WHERE id = ?').run('$.mandate', id); db.close()
    expect(() => new LocalStore(path, { migrateLegacy: true })).toThrow()
    const after = new DatabaseSync(path)
    expect(after.prepare("SELECT value FROM kv WHERE key='schema'").get()?.value).toBe('11')
    expect(after.prepare('SELECT count(*) AS n FROM effect').get()?.n).toBe(1)
    expect(after.prepare("SELECT name FROM sqlite_master WHERE name='source_issue'").get()).toBeUndefined()
    after.close()
  })
  it.each([10, 13])('rejects unsupported schema %s without resetting it', version => {
    const path = join(dir, 'future.sqlite'), store = open(path)
    store.set('schema', version); store.close()
    expect(() => new LocalStore(path)).toThrow('Unsupported')
    const db = new DatabaseSync(path)
    expect(db.prepare("SELECT value FROM kv WHERE key='schema'").get()?.value).toBe(String(version)); db.close()
  })
})

describe('database ownership preflight', () => {
  it.each(['effect', 'outbox', 'thread'])('rejects unversioned %s data before changing schema or journal mode', table => {
    const path = join(dir, `unversioned-${table}.sqlite`)
    const fixture = new DatabaseSync(path)
    fixture.exec(`CREATE TABLE ${table} (value TEXT); INSERT INTO ${table} VALUES ('legacy');`)
    fixture.close()
    expect(() => new LocalStore(path)).toThrow('Unversioned')
    const after = new DatabaseSync(path, { readOnly: true })
    try {
      expect(after.prepare('PRAGMA journal_mode').get()?.journal_mode).toBe('delete')
      expect(after.prepare("SELECT name FROM sqlite_master WHERE name='kv'").get()).toBeUndefined()
      expect(after.prepare(`SELECT value FROM ${table}`).get()?.value).toBe('legacy')
    } finally { after.close() }
  })
})
