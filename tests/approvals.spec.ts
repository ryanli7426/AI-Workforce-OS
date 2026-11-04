import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  APPROVAL_SCHEMA_KEY,
  APPROVAL_SCHEMA_VERSION,
  ApprovalRepository,
  initializeApprovalSchema,
  type CreateApprovalInput,
} from '../src/governance/approvals.ts'

let dir: string
const opened: DatabaseSync[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'approvals-'))
})

afterEach(() => {
  for (const db of opened.splice(0)) {
    try { db.close() } catch { /* already closed */ }
  }
  rmSync(dir, { recursive: true, force: true })
})

function open(path = join(dir, 'approvals.sqlite')): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000')
  opened.push(db)
  return db
}

function baseCreate(overrides: Partial<CreateApprovalInput> = {}): CreateApprovalInput {
  return {
    id: 'apr-1',
    workspaceId: 'ws-1',
    requesterId: 'agent-1',
    taskId: 'task-1',
    executionId: 'exec-1',
    action: 'git.push',
    resource: 'repo:demo',
    parametersHash: 'params-aaa',
    artifactRevision: 'art-1',
    policyVersion: 'policy-1',
    createdAt: '2026-11-04T02:00:00.000Z',
    expiresAt: '2026-11-04T03:00:00.000Z',
    ...overrides,
  }
}

function seed(path?: string) {
  const db = open(path)
  initializeApprovalSchema(db)
  return { db, repo: ApprovalRepository(db) }
}

function auditKinds(db: DatabaseSync, id: string): string[] {
  return db.prepare('SELECT kind FROM approval_audit WHERE approval_id = ? ORDER BY seq')
    .all(id)
    .map(row => String(row.kind))
}

describe('initializeApprovalSchema', () => {
  it('is additive, versioned, and rejects future schema before writes', () => {
    const db = open()
    initializeApprovalSchema(db)
    expect(JSON.parse(String(db.prepare('SELECT value FROM kv WHERE key = ?').get(APPROVAL_SCHEMA_KEY)?.value)))
      .toBe(APPROVAL_SCHEMA_VERSION)
    initializeApprovalSchema(db)
    db.prepare('UPDATE kv SET value = ? WHERE key = ?').run(JSON.stringify(99), APPROVAL_SCHEMA_KEY)
    expect(() => initializeApprovalSchema(db)).toThrow(/Unsupported approval schema 99/)
    const repo = ApprovalRepository(db)
    expect(() => repo.create(baseCreate())).toThrow(/Unsupported approval schema 99/)
  })

  it('rolls back a failed nested initializer savepoint without leaving partial DDL ownership claims', () => {
    const db = open()
    initializeApprovalSchema(db)
    db.exec('SAVEPOINT boom')
    try {
      db.exec('CREATE TABLE approval_audit_broken (seq INTEGER)')
      throw new Error('crash')
    } catch {
      db.exec('ROLLBACK TO boom')
      db.exec('RELEASE boom')
    }
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'approval_audit_broken'").get()).toBeUndefined()
    expect(ApprovalRepository(db).create(baseCreate()).status).toBe('PENDING')
  })
})

describe('ApprovalRepository', () => {
  it('creates an immutable PENDING request, returns defensive copies, and reopens', () => {
    const path = join(dir, 'state.sqlite')
    const { db, repo } = seed(path)
    const created = repo.create(baseCreate())
    expect(created.status).toBe('PENDING')
    expect(created.decision).toBeUndefined()
    expect(created.consumedAt).toBeUndefined()
    created.status = 'APPROVED'
    expect(repo.get('apr-1')?.status).toBe('PENDING')
    expect(auditKinds(db, 'apr-1')).toEqual(['request'])
    expect(() => repo.create(baseCreate())).toThrow(/already exists/)
    db.close()

    const again = open(path)
    initializeApprovalSchema(again)
    const reloaded = ApprovalRepository(again).get('apr-1')
    expect(reloaded).toMatchObject({
      id: 'apr-1',
      status: 'PENDING',
      action: 'git.push',
      parametersHash: 'params-aaa',
      policyVersion: 'policy-1',
    })
  })

  it('validates nonempty fields, ISO timestamps, and expiresAt > createdAt', () => {
    const { repo } = seed()
    expect(() => repo.create(baseCreate({ id: '  ' }))).toThrow(/Invalid id/)
    expect(() => repo.create(baseCreate({ createdAt: 'not-a-date' }))).toThrow(/Invalid createdAt/)
    expect(() => repo.create(baseCreate({
      createdAt: '2026-11-04T03:00:00.000Z',
      expiresAt: '2026-11-04T03:00:00.000Z',
    }))).toThrow(/expiresAt must be after createdAt/)
    expect(() => repo.create(baseCreate({
      createdAt: '2026-11-04T04:00:00.000Z',
      expiresAt: '2026-11-04T03:00:00.000Z',
    }))).toThrow(/expiresAt must be after createdAt/)
    expect(() => repo.create({ ...baseCreate(), extra: true } as CreateApprovalInput)).toThrow(/unexpected or missing fields/)
  })

  it('rejects self-approval, missing/spoofed authorized flags, and expiry on decide', () => {
    const { repo } = seed()
    repo.create(baseCreate())
    expect(() => repo.decide('apr-1', {
      actorId: 'agent-1',
      decision: 'approved',
      reason: 'ship it',
      at: '2026-11-04T02:10:00.000Z',
      authorized: true,
    })).toThrow(/Self-approval/)
    expect(() => repo.decide('apr-1', {
      actorId: 'human-1',
      decision: 'approved',
      reason: 'ship it',
      at: '2026-11-04T02:10:00.000Z',
      authorized: false,
    })).toThrow(/Authorization was not granted/)
    expect(() => repo.decide('apr-1', {
      actorId: 'human-1',
      decision: 'approved',
      reason: 'ship it',
      at: '2026-11-04T02:10:00.000Z',
      authorized: 'true' as unknown as boolean,
    })).toThrow(/Authorization was not granted/)
    expect(() => repo.decide('apr-1', {
      actorId: 'human-1',
      decision: 'approved',
      reason: 'ship it',
      at: '2026-11-04T02:10:00.000Z',
    } as never)).toThrow(/unexpected or missing fields/)
    expect(() => repo.decide('apr-1', {
      actorId: 'human-1',
      decision: 'approved',
      reason: 'ship it',
      at: '2026-11-04T03:00:00.000Z',
      authorized: true,
    })).toThrow(/expired/)
    expect(repo.get('apr-1')?.status).toBe('PENDING')
  })

  it('records decisions idempotently for identical payloads and rejects conflicts', () => {
    const { db, repo } = seed()
    repo.create(baseCreate())
    const decision = {
      actorId: 'human-1',
      decision: 'approved' as const,
      reason: 'looks safe',
      at: '2026-11-04T02:15:00.000Z',
      authorized: true,
    }
    const first = repo.decide('apr-1', decision)
    expect(first.status).toBe('APPROVED')
    expect(first.decision).toEqual({
      actorId: 'human-1',
      decision: 'approved',
      reason: 'looks safe',
      at: '2026-11-04T02:15:00.000Z',
    })
    const second = repo.decide('apr-1', decision)
    expect(second).toEqual(first)
    expect(auditKinds(db, 'apr-1').filter(kind => kind === 'decision')).toHaveLength(1)
    expect(() => repo.decide('apr-1', { ...decision, reason: 'changed mind' })).toThrow(/Conflicting/)
    expect(() => repo.decide('apr-1', { ...decision, decision: 'rejected' })).toThrow(/Conflicting/)
  })

  it('consumes an approved request once with exact scope and rejects stale scope/expiry', () => {
    const { db, repo } = seed()
    repo.create(baseCreate())
    repo.decide('apr-1', {
      actorId: 'human-1',
      decision: 'approved',
      reason: 'ok',
      at: '2026-11-04T02:20:00.000Z',
      authorized: true,
    })
    const scope = {
      at: '2026-11-04T02:30:00.000Z',
      action: 'git.push',
      resource: 'repo:demo',
      parametersHash: 'params-aaa',
      artifactRevision: 'art-1',
      policyVersion: 'policy-1',
      executionId: 'exec-1',
      authorized: true,
    }
    expect(() => repo.consume('apr-1', { ...scope, parametersHash: 'params-bbb' })).toThrow(/scope does not match/)
    expect(() => repo.consume('apr-1', { ...scope, artifactRevision: 'art-2' })).toThrow(/scope does not match/)
    expect(() => repo.consume('apr-1', { ...scope, policyVersion: 'policy-2' })).toThrow(/scope does not match/)
    expect(() => repo.consume('apr-1', { ...scope, executionId: 'exec-2' })).toThrow(/scope does not match/)
    expect(() => repo.consume('apr-1', { ...scope, at: '2026-11-04T03:00:00.000Z' })).toThrow(/expired/)
    expect(repo.get('apr-1')?.consumedAt).toBeUndefined()

    const consumed = repo.consume('apr-1', scope)
    expect(consumed.consumedAt).toBe(scope.at)
    expect(() => repo.consume('apr-1', scope)).toThrow(/already consumed/)
    expect(() => repo.consume('apr-1', { ...scope, at: '2026-11-04T02:31:00.000Z' })).toThrow(/already consumed/)
    expect(auditKinds(db, 'apr-1')).toEqual(['request', 'decision', 'consumption'])
  })

  it('does not consume rejected approvals and rejects unauthorized consume', () => {
    const { repo } = seed()
    repo.create(baseCreate())
    repo.decide('apr-1', {
      actorId: 'human-1',
      decision: 'rejected',
      reason: 'too risky',
      at: '2026-11-04T02:20:00.000Z',
      authorized: true,
    })
    expect(() => repo.consume('apr-1', {
      at: '2026-11-04T02:30:00.000Z',
      action: 'git.push',
      resource: 'repo:demo',
      parametersHash: 'params-aaa',
      artifactRevision: 'art-1',
      policyVersion: 'policy-1',
      executionId: 'exec-1',
      authorized: true,
    })).toThrow(/not approved/)
    expect(() => repo.consume('apr-1', {
      at: '2026-11-04T02:30:00.000Z',
      action: 'git.push',
      resource: 'repo:demo',
      parametersHash: 'params-aaa',
      artifactRevision: 'art-1',
      policyVersion: 'policy-1',
      executionId: 'exec-1',
      authorized: 1 as unknown as boolean,
    })).toThrow(/Authorization was not granted/)
  })

  it('allows only one consume winner across separate connections', () => {
    const path = join(dir, 'race.sqlite')
    const first = seed(path)
    first.repo.create(baseCreate())
    first.repo.decide('apr-1', {
      actorId: 'human-1',
      decision: 'approved',
      reason: 'ok',
      at: '2026-11-04T02:20:00.000Z',
      authorized: true,
    })
    const secondDb = open(path)
    const second = ApprovalRepository(secondDb)
    const scopeA = {
      at: '2026-11-04T02:30:00.000Z',
      action: 'git.push',
      resource: 'repo:demo',
      parametersHash: 'params-aaa',
      artifactRevision: 'art-1',
      policyVersion: 'policy-1',
      executionId: 'exec-1',
      authorized: true,
    }
    const scopeB = { ...scopeA, at: '2026-11-04T02:30:01.000Z' }

    const winner = first.repo.consume('apr-1', scopeA)
    expect(winner.consumedAt).toBe(scopeA.at)
    expect(() => second.consume('apr-1', scopeB)).toThrow(/already consumed/)
    expect(second.get('apr-1')?.consumedAt).toBe(scopeA.at)
    expect(auditKinds(secondDb, 'apr-1').filter(kind => kind === 'consumption')).toHaveLength(1)

    const claimed = secondDb.prepare(`UPDATE approval
      SET consumed_at = ?, value = json_set(value, '$.consumedAt', ?)
      WHERE id = ? AND status = 'APPROVED' AND consumed_at IS NULL`)
      .run('2026-11-04T02:30:02.000Z', '2026-11-04T02:30:02.000Z', 'apr-1')
    expect(Number(claimed.changes)).toBe(0)
  })

  it('rolls back decide/consume changes when the surrounding savepoint fails', () => {
    const { db, repo } = seed()
    repo.create(baseCreate())
    db.exec('SAVEPOINT outer')
    try {
      repo.decide('apr-1', {
        actorId: 'human-1',
        decision: 'approved',
        reason: 'ok',
        at: '2026-11-04T02:20:00.000Z',
        authorized: true,
      })
      expect(repo.get('apr-1')?.status).toBe('APPROVED')
      throw new Error('boom')
    } catch (error) {
      expect(error).toMatchObject({ message: 'boom' })
      db.exec('ROLLBACK TO outer')
      db.exec('RELEASE outer')
    }
    expect(repo.get('apr-1')?.status).toBe('PENDING')
    expect(auditKinds(db, 'apr-1')).toEqual(['request'])
  })
})
