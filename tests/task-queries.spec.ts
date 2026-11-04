import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TASK_STATES } from '../src/core/lifecycle-model.ts'
import { LocalStore } from '../src/storage/store.ts'
import { TaskQueries } from '../src/storage/task-queries.ts'
import { lao } from './fixtures/lao.ts'

let dir: string
const opened: { close(): void }[] = []

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'task-queries-')) })
afterEach(() => {
  for (const item of opened.splice(0)) {
    try { item.close() } catch { /* ignore */ }
  }
  rmSync(dir, { recursive: true, force: true })
})

function openStore(path = join(dir, 'workforce.sqlite')): LocalStore {
  const store = new LocalStore(path)
  opened.push(store)
  return store
}

function openQueries(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  opened.push(db)
  return { db, queries: TaskQueries(db) }
}

function fingerprint(path: string) {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const schema = db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all()
    const tickets = db.prepare('SELECT rowid, id, value FROM ticket ORDER BY rowid').all()
    const kv = db.prepare('SELECT key, value FROM kv ORDER BY key').all()
    return {
      file: createHash('sha256').update(readFileSync(path)).digest('hex'),
      schema,
      tickets,
      kv,
    }
  } finally {
    db.close()
  }
}

function seedTicket(store: LocalStore, ticket: Record<string, unknown>) {
  store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run(String(ticket.id), JSON.stringify(ticket))
}

describe('TaskQueries', () => {
  it('projects LocalStore fixture tickets and returns undefined when absent', () => {
    const path = join(dir, 'get.sqlite')
    const store = openStore(path)
    const h = lao(store)
    const ticket = h.accept()
    const assignmentId = h.running(ticket.id)
    expect(assignmentId).toBeTruthy()
    store.close()

    const { queries } = openQueries(path)
    const row = queries.get(ticket.id)
    expect(row).toEqual({
      id: ticket.id,
      title: 'Fix typo',
      status: 'RUNNING',
      updatedAt: expect.any(String),
      priority: 10,
      agentId: 'claude-local',
      source: 'ding:team-a',
      rowid: expect.any(Number),
    })
    expect(Number.isSafeInteger(row!.rowid)).toBe(true)
    expect(queries.get('missing-task')).toBeUndefined()
  })

  it('paginates by rowid without duplicates and exposes a stable cursor', () => {
    const path = join(dir, 'page.sqlite')
    const store = openStore(path)
    const h = lao(store)
    const ids: string[] = []
    for (let index = 0; index < 5; index++) {
      const ticket = h.accept(
        value => { value.task!.issue.issueId = `issue-${index}` },
        { ...h.trigger(`event-${index}`), threads: [{ source: 'ding:team-a', id: `issue-${index}` }] },
      )
      ids.push(ticket.id)
    }
    store.close()

    const { queries } = openQueries(path)
    const first = queries.list({ limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBe(first.items[1]!.rowid)
    expect(first.items[0]!.rowid).toBeGreaterThan(first.items[1]!.rowid)

    const second = queries.list({ limit: 2, beforeRowid: first.nextCursor })
    expect(second.items).toHaveLength(2)
    expect(second.nextCursor).toBe(second.items[1]!.rowid)

    const third = queries.list({ limit: 2, beforeRowid: second.nextCursor })
    expect(third.items).toHaveLength(1)
    expect(third.nextCursor).toBeUndefined()

    const seen = [...first.items, ...second.items, ...third.items].map(item => item.id)
    expect(seen).toHaveLength(5)
    expect(new Set(seen).size).toBe(5)
    expect(seen).toEqual([...ids].reverse())
  })

  it('filters by lifecycle states, latest assignment agent, and issue source', () => {
    const path = join(dir, 'filter.sqlite')
    const store = openStore(path)
    const h = lao(store)
    const queued = h.accept(value => { value.task!.issue.issueId = 'issue-queued' }, {
      ...h.trigger('event-queued'), threads: [{ source: 'ding:team-a', id: 'issue-queued' }],
    })
    const running = h.accept(value => { value.task!.issue.issueId = 'issue-running' }, {
      ...h.trigger('event-running'), threads: [{ source: 'ding:team-a', id: 'issue-running' }],
    })
    h.running(running.id)
    const other = h.accept(value => {
      value.task!.issue.issueId = 'issue-other'
      value.task!.issue.source = 'github:acme'
    }, {
      ...h.trigger('event-other'),
      source: 'github:acme',
      threads: [{ source: 'github:acme', id: 'issue-other' }],
      actor: { source: 'github:acme', id: 'bob' },
    })
    h.engine.assignTask(other.id, 'codex-local', 'codex', `/worktrees/${other.id}`)
    store.close()

    const { queries } = openQueries(path)
    expect(queries.list({ states: ['QUEUED'] }).items.map(item => item.id)).toEqual([queued.id])
    expect(queries.list({ states: ['RUNNING'] }).items.map(item => item.id)).toEqual([running.id])
    expect(queries.list({ agentId: 'claude-local' }).items.map(item => item.id)).toEqual([running.id])
    expect(queries.list({ agentId: 'codex-local' }).items.map(item => item.id)).toEqual([other.id])
    expect(queries.list({ source: 'github:acme' }).items.map(item => item.id)).toEqual([other.id])
    expect(queries.list({ source: 'ding:team-a', states: ['QUEUED', 'RUNNING'] }).items.map(item => item.id).sort())
      .toEqual([queued.id, running.id].sort())
  })

  it('aggregates counts in SQL without inventing lifecycle states', () => {
    const path = join(dir, 'counts.sqlite')
    const store = openStore(path)
    const h = lao(store)
    h.accept(value => { value.task!.issue.issueId = 'a' }, {
      ...h.trigger('a'), threads: [{ source: 'ding:team-a', id: 'a' }],
    })
    const running = h.accept(value => { value.task!.issue.issueId = 'b' }, {
      ...h.trigger('b'), threads: [{ source: 'ding:team-a', id: 'b' }],
    })
    h.running(running.id)
    store.close()

    const { queries } = openQueries(path)
    const counts = queries.counts()
    expect(counts.total).toBe(2)
    expect(counts.byState.QUEUED).toBe(1)
    expect(counts.byState.RUNNING).toBe(1)
    expect(Object.keys(counts.byState).sort()).toEqual([...TASK_STATES].sort())
    expect(Object.values(counts.byState).reduce((sum, n) => sum + n, 0)).toBe(2)
  })

  it('rejects invalid cursors, limits, and filter inputs', () => {
    const path = join(dir, 'invalid.sqlite')
    const store = openStore(path)
    lao(store).accept()
    store.close()
    const { queries } = openQueries(path)

    expect(() => queries.list({ limit: 0 })).toThrow(/limit/)
    expect(() => queries.list({ limit: 201 })).toThrow(/limit/)
    expect(() => queries.list({ limit: 1.5 })).toThrow(/limit/)
    expect(() => queries.list({ beforeRowid: Number.NaN })).toThrow(/beforeRowid/)
    expect(() => queries.list({ beforeRowid: 1.25 })).toThrow(/beforeRowid/)
    expect(() => queries.list({ beforeRowid: Number.POSITIVE_INFINITY })).toThrow(/beforeRowid/)
    expect(() => queries.list({ states: ['RUNNING', 'NOT_A_STATE' as 'RUNNING'] })).toThrow(/lifecycle status/)
    expect(() => queries.list({ agentId: '' })).toThrow(/agentId/)
    expect(() => queries.list({ source: '' })).toThrow(/source/)
    expect(() => queries.get('')).toThrow(/id/)
  })

  it('binds filter parameters so injection strings do not mutate storage', () => {
    const path = join(dir, 'injection.sqlite')
    const store = openStore(path)
    const ticket = lao(store).accept()
    store.close()
    const before = fingerprint(path)
    const { queries } = openQueries(path)
    const injection = `ding:team-a'; DROP TABLE ticket;--`
    expect(queries.list({ source: injection }).items).toEqual([])
    expect(queries.list({ agentId: injection }).items).toEqual([])
    expect(queries.get(`${ticket.id}'; DROP TABLE ticket;--`)).toBeUndefined()
    expect(fingerprint(path)).toEqual(before)
  })

  it('fails closed on malformed stored lifecycle rows', () => {
    const path = join(dir, 'malformed.sqlite')
    const store = openStore(path)
    seedTicket(store, {
      id: 'bad-status',
      title: 'Broken',
      updatedAt: '2026-11-04T00:00:00.000Z',
      lifecycle: {
        status: 'THINKING',
        issue: { source: 'ding:team-a', issueId: 'x', revision: 'v1', updatedAt: '2026-11-04T00:00:00.000Z', description: 'x', priority: 1, closed: false },
      },
      assignments: [],
    })
    seedTicket(store, {
      id: 'missing-lifecycle',
      title: 'Legacy',
      updatedAt: '2026-11-04T00:00:00.000Z',
      assignments: [],
    })
    seedTicket(store, {
      id: 'bad-priority',
      title: 'Priority',
      updatedAt: '2026-11-04T00:00:00.000Z',
      lifecycle: {
        status: 'QUEUED',
        issue: { source: 'ding:team-a', issueId: 'y', revision: 'v1', updatedAt: '2026-11-04T00:00:00.000Z', description: 'y', priority: 'high', closed: false },
      },
      assignments: [],
    })
    store.close()

    const { queries } = openQueries(path)
    expect(() => queries.get('bad-status')).toThrow(/lifecycle status/)
    expect(() => queries.get('missing-lifecycle')).toThrow(/lifecycle status/)
    expect(() => queries.get('bad-priority')).toThrow(/priority/)
    expect(() => queries.list()).toThrow()
    expect(() => queries.counts()).toThrow(/lifecycle status/)
  })

  it('leaves database bytes and schema unchanged after read-only queries', () => {
    const path = join(dir, 'unchanged.sqlite')
    const store = openStore(path)
    const h = lao(store)
    const ticket = h.accept()
    h.running(ticket.id)
    store.close()

    const before = fingerprint(path)
    const { queries } = openQueries(path)
    expect(queries.get(ticket.id)?.status).toBe('RUNNING')
    expect(queries.list({ limit: 10 }).items).toHaveLength(1)
    expect(queries.counts().total).toBe(1)
    expect(fingerprint(path)).toEqual(before)
  })

  it('matches only the latest assignment agent when older assignments differ', () => {
    const path = join(dir, 'latest-agent.sqlite')
    const store = openStore(path)
    seedTicket(store, {
      id: 'task-1',
      title: 'Retried',
      updatedAt: '2026-11-04T00:00:00.000Z',
      lifecycle: {
        status: 'RUNNING',
        issue: { source: 'ding:team-a', issueId: 'issue-1', revision: 'v1', updatedAt: '2026-11-04T00:00:00.000Z', description: 'x', priority: 3, closed: false },
      },
      assignments: [
        { id: 'a0', state: 'ended', createdAt: '2026-11-04T00:00:00.000Z', agentId: 'old-agent' },
        { id: 'a1', state: 'running', createdAt: '2026-11-04T00:01:00.000Z', agentId: 'new-agent' },
      ],
    })
    store.close()

    const { queries } = openQueries(path)
    expect(queries.list({ agentId: 'old-agent' }).items).toEqual([])
    expect(queries.list({ agentId: 'new-agent' }).items.map(item => item.agentId)).toEqual(['new-agent'])
    expect(queries.get('task-1')?.agentId).toBe('new-agent')
  })
})
