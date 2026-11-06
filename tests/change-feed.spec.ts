import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalTaskService } from '../src/application/tasks.ts'
import type { Rule } from '../src/assessor/rules.ts'
import type { Ticket } from '../src/core/model.ts'
import { ChangeFeedInputError } from '../src/events/change-feed.ts'
import { ExecutionRepository } from '../src/execution/repository.ts'
import { ProjectRepository } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import {
  CHANGE_FEED_SCHEMA_KEY,
  CHANGE_FEED_SCHEMA_VERSION,
  ChangeFeedRepository,
  initializeChangeFeedSchema,
  requireChangeFeedSchema,
} from '../src/storage/change-feed.ts'
import { LocalStore } from '../src/storage/store.ts'
import { VerificationJobRepository } from '../src/storage/verification-jobs.ts'
import type { VerificationJobRequest } from '../src/verification/model.ts'
import { EmployeeRepository } from '../src/workforce/employees.ts'

let root: string
const opened: { close(): void }[] = []

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'change-feed-')) })
afterEach(() => {
  for (const item of opened.splice(0)) { try { item.close() } catch { /* already closed */ } }
  rmSync(root, { recursive: true, force: true })
})

const rules: Rule[] = [{
  id: 'docs', enabled: true, taskTypes: ['docs'], priority: 10,
  approvalRequired: false, reviewRequired: true, retryLimit: 1,
}]

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: root,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    },
    stdio: 'ignore', timeout: 15_000,
  })
}

function gitRepository(name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  git(path, ['init'])
  git(path, ['config', 'user.email', 'feed@example.com'])
  git(path, ['config', 'user.name', 'Feed Test'])
  writeFileSync(join(path, 'README.md'), '# fixture\n')
  git(path, ['add', 'README.md'])
  git(path, ['commit', '-m', 'fixture'])
  return resolve(path)
}

function openStore(path = join(root, 'store.sqlite'), withFeed = true): LocalStore {
  const store = new LocalStore(path)
  opened.push(store)
  initializeApplicationSchema(store)
  if (withFeed) initializeChangeFeedSchema(store.db)
  else {
    // Prepare an owned historical database predating this additive module.
    for (const row of store.db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'change_feed_%'").all()) {
      store.db.exec('DROP TRIGGER "'+String(row.name).replaceAll('"','""')+'"')
    }
    store.db.exec("DROP TABLE change_feed;DROP TABLE change_feed_meta;DELETE FROM kv WHERE key='change-feed-schema'")
  }
  return store
}

function close(item: { close(): void }): void {
  item.close()
  const index = opened.indexOf(item)
  if (index >= 0) opened.splice(index, 1)
}

function createProject(store: LocalStore, id: string, workspaceId = 'local', ownerId = 'business-owner') {
  return new ProjectRepository(store.db).create({
    id, workspaceId, ownerId, name: `${workspaceId}-${id}`,
    repositoryPath: gitRepository(`${workspaceId}-${id}`),
    worktreeRoot: join(root, `worktrees-${workspaceId}-${id}`),
    allowedTaskTypes: ['docs'],
  })
}

function taskService(store: LocalStore, ownerId = 'owner-1', workspaceId = 'local') {
  return new LocalTaskService({ store, ownerId, workspaceId, rules, now: () => '2026-11-05T00:00:00.000Z' })
}

function createTask(store: LocalStore, issueId: string, projectId: string, ownerId = 'owner-1', workspaceId = 'local') {
  return taskService(store, ownerId, workspaceId).create({
    issueId, projectId, title: `Task ${issueId}`, description: `Description ${issueId}`, taskType: 'docs',
  })
}

function saveTicketCopy(store: LocalStore, template: Ticket, id: string, ownerId: string): Ticket {
  const ticket = structuredClone(template)
  ticket.id = id
  ticket.mandate.actor.id = ownerId
  ticket.lifecycle!.issue.issueId = id
  ticket.createdAt = '2026-11-05T00:01:00.000Z'
  ticket.updatedAt = ticket.createdAt
  store.tickets.save(ticket)
  return ticket
}

function reader(store: LocalStore, ownerId = 'owner-1', workspaceId = 'local') {
  return new ChangeFeedRepository({ db: store.db, ownerId, workspaceId })
}

function initialCursor(feed: ChangeFeedRepository): string {
  const page = feed.readPage()
  expect(page.reset?.reason).toBe('initial')
  return page.cursor
}

function sha(value: string): string { return createHash('sha256').update(value).digest('hex') }

function verificationRequest(ticket: Ticket, verificationId = 'verify-1', overrides: Partial<VerificationJobRequest> = {}): VerificationJobRequest {
  return {
    verificationId, workspaceId: 'local', ownerId: 'owner-1', ticketId: ticket.id,
    expectedTaskVersion: ticket.lifecycle!.version, policyVersion: ticket.lifecycle!.policyVersion,
    executionId: `execution-${verificationId}`, artifactId: `artifact-${verificationId}`,
    artifactRevision: sha(`artifact-${verificationId}`),
    plan: { id: `plan-${verificationId}`, revision: 'revision-1', checks: [{
      id: 'check-1', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5_000,
    }] },
    reason: 'verification requested', createdAt: '2026-11-05T00:00:01.000Z', ...overrides,
  }
}

function rewriteCursor(cursor: string, patch: (parts: unknown[]) => void): string {
  const parts = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown[]
  patch(parts)
  return Buffer.from(JSON.stringify(parts)).toString('base64url')
}

describe('change feed schema', () => {
  it('requires all current schemas and installs atomically and idempotently', () => {
    const uncomposed = new LocalStore(join(root, 'uncomposed.sqlite'))
    opened.push(uncomposed)
    expect(() => initializeChangeFeedSchema(uncomposed.db)).toThrow(/requires current schema/)
    expect(uncomposed.db.prepare("SELECT name FROM sqlite_master WHERE name = 'change_feed'").get()).toBeUndefined()

    const store = openStore(join(root, 'atomic.sqlite'), false)
    store.db.exec('BEGIN')
    initializeChangeFeedSchema(store.db)
    expect(store.db.prepare('SELECT value FROM kv WHERE key = ?').get(CHANGE_FEED_SCHEMA_KEY)?.value)
      .toBe(JSON.stringify(CHANGE_FEED_SCHEMA_VERSION))
    store.db.exec('ROLLBACK')
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'change_feed'").get()).toBeUndefined()

    initializeChangeFeedSchema(store.db)
    initializeChangeFeedSchema(store.db)
    requireChangeFeedSchema(store.db)
  })

  it('fails closed for future, unversioned, incomplete, and missing-trigger state without repair', () => {
    const future = openStore(join(root, 'future.sqlite'), false)
    future.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(CHANGE_FEED_SCHEMA_KEY, '2')
    expect(() => initializeChangeFeedSchema(future.db)).toThrow(/Unsupported change feed schema version/)
    expect(future.db.prepare("SELECT name FROM sqlite_master WHERE name = 'change_feed'").get()).toBeUndefined()

    const unversioned = openStore(join(root, 'unversioned.sqlite'), false)
    unversioned.db.exec('CREATE TABLE change_feed (sequence INTEGER PRIMARY KEY)')
    expect(() => initializeChangeFeedSchema(unversioned.db)).toThrow(/Unversioned change feed schema/)

    const incomplete = openStore(join(root, 'incomplete.sqlite'))
    incomplete.db.exec('DROP TRIGGER change_feed_ticket_insert')
    expect(() => requireChangeFeedSchema(incomplete.db)).toThrow(/incomplete/)
    expect(() => initializeChangeFeedSchema(incomplete.db)).toThrow(/incomplete/)
    expect(incomplete.db.prepare("SELECT name FROM sqlite_master WHERE name = 'change_feed_ticket_insert'").get()).toBeUndefined()
  })

  it('constructs and queries without installing or repairing schema', () => {
    const store = openStore(join(root, 'query.sqlite'), false)
    expect(() => new ChangeFeedRepository({ db: store.db, ownerId: 'owner-1', workspaceId: 'local' }))
      .toThrow(/not initialized/)
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'change_feed'").get()).toBeUndefined()
  })
})

describe('durable resource projection', () => {
  it('records actual repository writes, ignores exact unchanged updates, rolls back with the resource, and survives reopen', () => {
    const path = join(root, 'durable.sqlite')
    const store = openStore(path)
    const feed = reader(store)
    const cursor = initialCursor(feed)
    createProject(store, 'project-a')
    const ticket = createTask(store, 'issue-a', 'project-a')
    const employeeRepo = new EmployeeRepository(store.db)
    employeeRepo.create({
      id: 'employee-a', workspaceId: 'local', name: 'Employee A', role: 'Writer', responsibilities: ['docs'],
      capabilities: ['editing'], runtimeId: 'runtime-local', projectIds: ['project-a'], maxConcurrency: 1, timeoutMs: 60_000,
    })
    new ExecutionRepository(store.db).reserve({
      executionId: 'execution-a', assignmentId: 'assignment-a', ticketId: ticket.id, agentId: 'employee-a',
      runtime: 'local', generation: 1, cwd: join(root, 'execution-a'), inputRevision: 'revision-a',
      policyVersion: ticket.lifecycle!.policyVersion,
    })
    new VerificationJobRepository(store.db).reserve(verificationRequest(ticket))

    const unchangedBefore = Number(store.db.prepare('SELECT COUNT(*) AS count FROM change_feed').get()!.count)
    store.db.prepare('UPDATE employee SET name = name WHERE id = ?').run('employee-a')
    expect(Number(store.db.prepare('SELECT COUNT(*) AS count FROM change_feed').get()!.count)).toBe(unchangedBefore)

    store.db.exec('BEGIN')
    store.db.prepare("UPDATE employee SET name = 'Rolled back' WHERE id = 'employee-a'").run()
    store.db.exec('ROLLBACK')
    expect(Number(store.db.prepare('SELECT COUNT(*) AS count FROM change_feed').get()!.count)).toBe(unchangedBefore)
    close(store)

    const reopened = new LocalStore(path)
    opened.push(reopened)
    const page = reader(reopened).readPage({ cursor, limit: 20 })
    expect(page.changes.map(change => change.notice.entity)).toEqual([
      'project', 'task', 'task', 'employee', 'execution', 'verification',
    ])
    expect(page.changes.find(change => change.notice.entity === 'execution')?.notice.ticketId).toBe(ticket.id)
    expect(page.changes.find(change => change.notice.entity === 'verification')?.notice.ticketId).toBe(ticket.id)
    expect(page.changes.every(change => new Date(change.notice.at).toISOString() === change.notice.at)).toBe(true)
  })

  it('projects owner scope through the real task/project identity and not project business owner', () => {
    const store = openStore()
    const owner1 = reader(store, 'owner-1')
    const owner2 = reader(store, 'owner-2')
    const owner1Cursor = initialCursor(owner1)
    const owner2Cursor = initialCursor(owner2)
    createProject(store, 'project-a', 'local', 'unrelated-business-owner')
    const owned = createTask(store, 'owned', 'project-a', 'owner-1')
    const foreign = createTask(store, 'foreign', 'project-a', 'owner-2')

    const first = owner1.readPage({ cursor: owner1Cursor })
    expect([...new Set(first.changes.map(event => `${event.notice.entity}:${event.notice.resourceId}`))]).toEqual([
      'project:project-a', `task:${owned.id}`,
    ])
    const second = owner2.readPage({ cursor: owner2Cursor })
    expect([...new Set(second.changes.map(event => `${event.notice.entity}:${event.notice.resourceId}`))]).toEqual([
      'project:project-a', `task:${foreign.id}`,
    ])

    const cursor = first.cursor
    const cursor2 = second.cursor
    const moved = structuredClone(owned)
    moved.mandate.actor.id = 'owner-2'
    store.tickets.save(moved)
    expect(owner1.readPage({ cursor }).changes.map(event => event.notice.resourceId)).toEqual([owned.id])
    expect(owner2.readPage({ cursor: cursor2 }).changes.map(event => event.notice.resourceId)).toEqual([owned.id])

    const invalidCursor = owner1.readPage({ cursor }).cursor
    moved.mandate.actor.source = 'manual:local:another-project'
    store.tickets.save(moved)
    expect(owner1.readPage({ cursor: invalidCursor }).changes).toEqual([])
  })

  it('rejects declared verification scope that does not match its real task audience', () => {
    const store = openStore()
    createProject(store, 'project-a')
    const ticket = createTask(store, 'issue-a', 'project-a')
    const owner = reader(store)
    const cursor = owner.readPage().cursor
    new VerificationJobRepository(store.db).reserve(verificationRequest(ticket, 'verify-mismatch', { ownerId: 'owner-2' }))
    expect(owner.readPage({ cursor }).changes).toEqual([])
  })

  it('covers changed updates and preserves old scope for every resource deletion trigger', () => {
    const store = openStore()
    createProject(store, 'project-a')
    const ticket = createTask(store, 'delete-me', 'project-a')
    new EmployeeRepository(store.db).create({
      id: 'employee-a', workspaceId: 'local', name: 'Employee A', role: 'Writer', responsibilities: ['docs'],
      capabilities: ['editing'], runtimeId: 'runtime-local', projectIds: ['project-a'], maxConcurrency: 1, timeoutMs: 60_000,
    })
    new ExecutionRepository(store.db).reserve({
      executionId: 'execution-a', assignmentId: 'assignment-a', ticketId: ticket.id, agentId: 'employee-a',
      runtime: 'local', generation: 1, cwd: join(root, 'delete-execution'), inputRevision: 'revision-a',
      policyVersion: ticket.lifecycle!.policyVersion,
    })
    new VerificationJobRepository(store.db).reserve(verificationRequest(ticket, 'verification-a'))
    const feed = reader(store)
    const cursor = feed.readPage().cursor

    store.db.prepare("UPDATE execution SET updated_at = '2026-11-05T00:02:00.000Z' WHERE execution_id = 'execution-a'").run()
    store.db.prepare("UPDATE verification_job SET updated_at = '2026-11-05T00:02:00.000Z' WHERE verification_id = 'verification-a'").run()
    store.db.prepare("UPDATE employee SET name = 'Employee B' WHERE id = 'employee-a'").run()
    store.db.prepare("UPDATE project SET name = 'Project B' WHERE id = 'project-a'").run()
    store.db.prepare("DELETE FROM execution WHERE execution_id = 'execution-a'").run()
    store.db.prepare("DELETE FROM verification_job_audit WHERE verification_id = 'verification-a'").run()
    store.db.prepare("DELETE FROM verification_job WHERE verification_id = 'verification-a'").run()
    store.db.prepare('DELETE FROM ticket WHERE id = ?').run(ticket.id)
    store.db.prepare("DELETE FROM employee_snapshot WHERE id = 'employee-a'").run()
    store.db.prepare("DELETE FROM employee WHERE id = 'employee-a'").run()
    store.db.prepare("DELETE FROM project_snapshot WHERE id = 'project-a'").run()
    store.db.prepare("DELETE FROM project WHERE id = 'project-a'").run()

    expect(feed.readPage({ cursor, limit: 20 }).changes.map(event => event.notice.entity)).toEqual([
      'execution', 'verification', 'employee', 'project',
      'execution', 'verification', 'task', 'employee', 'project',
    ])
  })

  it('observes a committed write from a separate process through SQLite triggers', () => {
    const path = join(root, 'process.sqlite')
    const store = openStore(path)
    createProject(store, 'project-a')
    const feed = reader(store)
    const cursor = feed.readPage().cursor
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.prepare("UPDATE project SET name = ?, version = version + 1, config_json = json_set(config_json, '$.name', ?, '$.version', version + 1) WHERE id = ?")
        .run('Changed elsewhere', 'Changed elsewhere', 'project-a');
      db.close();
    `, path], { timeout: 10_000, stdio: 'pipe' })
    expect(feed.readPage({ cursor }).changes).toEqual([
      expect.objectContaining({ notice: expect.objectContaining({ entity: 'project', resourceId: 'project-a' }) }),
    ])
  })
})

describe('cursor, pagination, and retention', () => {
  it('does not replay history on initial connect and pages visible rows without foreign rows consuming the limit', () => {
    const store = openStore()
    createProject(store, 'project-a')
    const owner1 = reader(store, 'owner-1')
    const initial = owner1.readPage()
    expect(initial).toMatchObject({ changes: [], hasMore: false, reset: { reason: 'initial' } })
    const template = createTask(store, 'template', 'project-a')
    const start = owner1.readPage().cursor
    saveTicketCopy(store, template, 'foreign-a', 'owner-2')
    const visibleA = saveTicketCopy(store, template, 'visible-a', 'owner-1')
    saveTicketCopy(store, template, 'foreign-b', 'owner-2')
    const visibleB = saveTicketCopy(store, template, 'visible-b', 'owner-1')

    const first = owner1.readPage({ cursor: start, limit: 1 })
    expect(first.changes.map(event => event.notice.resourceId)).toEqual([visibleA.id])
    expect(first.hasMore).toBe(true)
    const second = owner1.readPage({ cursor: first.cursor, limit: 1 })
    expect(second.changes.map(event => event.notice.resourceId)).toEqual([visibleB.id])
    expect(second.hasMore).toBe(false)
    expect(owner1.readPage({ cursor: second.cursor }).changes).toEqual([])
  })

  it('uses per-event resumable cursors and advances an empty/finished page over invisible global rows', () => {
    const store = openStore()
    createProject(store, 'project-a')
    const owner1 = reader(store, 'owner-1')
    const template = createTask(store, 'template', 'project-a', 'owner-1')
    const start = owner1.readPage().cursor
    saveTicketCopy(store, template, 'visible', 'owner-1')
    saveTicketCopy(store, template, 'foreign', 'owner-2')
    const page = owner1.readPage({ cursor: start })
    expect(page.changes).toHaveLength(1)
    expect(page.cursor).not.toBe(page.changes[0]!.cursor)
    expect(owner1.readPage({ cursor: page.changes[0]!.cursor }).changes).toEqual([])
    expect(owner1.readPage({ cursor: page.cursor }).changes).toEqual([])
  })

  it('strictly validates inputs and canonical cursors with a static public error', () => {
    const store = openStore()
    const feed = reader(store)
    for (const input of [
      { cursor: '' }, { cursor: 'not+a+cursor' }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { extra: true },
    ]) {
      try {
        feed.readPage(input as never)
        expect.fail('expected invalid input')
      } catch (error) {
        expect(error).toBeInstanceOf(ChangeFeedInputError)
        expect((error as Error).message).toBe('Invalid change feed cursor or query')
      }
    }
    const cursor = feed.readPage().cursor
    expect(() => feed.readPage({ cursor: `${cursor}=` })).toThrow(ChangeFeedInputError)
    store.db.exec('BEGIN')
    expect(() => feed.readPage({ cursor })).toThrow(/no open caller transaction/)
    store.db.exec('ROLLBACK')
  })

  it('resets replaced scope/epoch and future positions at the current head', () => {
    const store = openStore()
    const feed = reader(store)
    const cursor = feed.readPage().cursor
    expect(reader(store, 'owner-2').readPage({ cursor }).reset?.reason).toBe('replaced')
    const replaced = rewriteCursor(cursor, parts => { parts[1] = '0'.repeat(32) })
    expect(feed.readPage({ cursor: replaced }).reset?.reason).toBe('replaced')
    const future = rewriteCursor(cursor, parts => { parts[3] = 100 })
    expect(feed.readPage({ cursor: future }).reset?.reason).toBe('future')
  })

  it('prunes latest global rows atomically, expires the inclusive watermark, and preserves the AUTOINCREMENT head', () => {
    const store = openStore()
    createProject(store, 'project-a')
    const feed = reader(store)
    const before = feed.readPage().cursor
    const first = createTask(store, 'first', 'project-a')
    const firstCursor = feed.readPage({ cursor: before }).changes[0]!.cursor
    createTask(store, 'second', 'project-a')
    createTask(store, 'third', 'project-a')
    const total = Number(store.db.prepare('SELECT COUNT(*) AS count FROM change_feed').get()!.count)
    expect(feed.prune(2)).toEqual({ removed: total - 2 })
    expect(feed.readPage({ cursor: before }).reset?.reason).toBe('expired')
    expect(feed.readPage({ cursor: firstCursor }).reset?.reason).toBe('expired')
    expect(feed.prune(2)).toEqual({ removed: 0 })
    expect(() => feed.prune(0)).toThrow(/between 1 and 1000000/)

    const headBeforeEmpty = feed.readPage().cursor
    store.db.exec('DELETE FROM change_feed')
    const emptyHead = feed.readPage().cursor
    expect(emptyHead).toBe(headBeforeEmpty)
    const next = createTask(store, 'after-empty', 'project-a')
    const resumed = feed.readPage({ cursor: emptyHead })
    expect([...new Set(resumed.changes.map(event => event.notice.resourceId))]).toEqual([next.id])
    expect(resumed.changes.map(event => event.notice.resourceId)).not.toContain(first.id)
  })

  it('fails closed on corrupt persisted rows without leaking their contents', () => {
    const store = openStore()
    const feed = reader(store)
    const cursor = feed.readPage().cursor
    store.db.prepare(`INSERT INTO change_feed
      (workspace_id, owner_id, entity, resource_id, ticket_id, at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('local', 'owner-1', 'task', 'secret-resource', null, 'not-a-date')
    expect(() => feed.readPage({ cursor })).toThrow('Change feed row is corrupt')
    try { feed.readPage({ cursor }) } catch (error) {
      expect((error as Error).message).not.toContain('secret-resource')
      expect((error as Error).message).not.toContain('not-a-date')
    }
  })
  it('resumes exactly at the greatest pruned sequence and rejects regressed durable sequence metadata', () => {
    const store=openStore();createProject(store,'boundary-project');const feed=reader(store)
    const cursor=feed.readPage().cursor
    for(let index=0;index<4;index++)createTask(store,`boundary-${index}`,'boundary-project')
    const events=feed.readPage({cursor}).changes
    feed.prune(2)
    const watermark=Number(store.db.prepare('SELECT pruned_through FROM change_feed_meta').get()!.pruned_through)
    const equal=events.find(event=>JSON.parse(Buffer.from(event.cursor,'base64url').toString('utf8'))[3]===watermark)!.cursor
    expect(feed.readPage({cursor:equal}).reset).toBeUndefined()
    expect(feed.readPage({cursor:equal}).changes).toHaveLength(2)
    const prior=rewriteCursor(equal,parts=>{parts[3]=watermark-1})
    expect(feed.readPage({cursor:prior}).reset?.reason).toBe('expired')
    store.db.prepare("UPDATE sqlite_sequence SET seq=0 WHERE name='change_feed'").run()
    expect(()=>feed.readPage({cursor:equal})).toThrow(/sequence metadata/)
  })
  it('refuses a changed trigger definition instead of silently losing notifications', () => {
    const store=openStore()
    store.db.exec('DROP TRIGGER change_feed_ticket_insert;CREATE TRIGGER change_feed_ticket_insert AFTER INSERT ON ticket BEGIN SELECT 1;END;')
    expect(()=>requireChangeFeedSchema(store.db)).toThrow(/corrupt/)
    expect(()=>initializeChangeFeedSchema(store.db)).toThrow(/corrupt/)
  })

})
