import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EmployeeRepository,
  initializeEmployeeSchema,
  type EmployeeCreateInput,
} from '../src/workforce/employees.ts'

let dir: string
const opened: DatabaseSync[] = []

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workforce-employees-'))
})

afterEach(() => {
  for (const db of opened.splice(0)) {
    try { db.close() } catch { /* ignore */ }
  }
  rmSync(dir, { recursive: true, force: true })
})

function open(path = join(dir, 'employees.sqlite')): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  opened.push(db)
  return db
}

function baseCreate(overrides: Partial<EmployeeCreateInput> = {}): EmployeeCreateInput {
  return {
    id: 'emp-alpha',
    workspaceId: 'ws-main',
    name: 'Alpha Coder',
    role: 'software-engineer',
    responsibilities: ['implement features', 'write tests'],
    capabilities: ['typescript', 'code-review'],
    runtimeId: 'runtime-local-1',
    projectIds: ['proj-core'],
    maxConcurrency: 2,
    timeoutMs: 60_000,
    ...overrides,
  }
}

describe('initializeEmployeeSchema', () => {
  it('requires kv and rejects future schema versions before writes', () => {
    const bare = new DatabaseSync(join(dir, 'bare.sqlite'))
    opened.push(bare)
    expect(() => initializeEmployeeSchema(bare)).toThrow(/kv table/)

    const db = open()
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('employee-schema', JSON.stringify(2))
    expect(() => initializeEmployeeSchema(db)).toThrow(/Unknown employee schema version: 2/)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'employee'").get()).toBeUndefined()
  })

  it('is idempotent for schema version 1', () => {
    const db = open()
    initializeEmployeeSchema(db)
    initializeEmployeeSchema(db)
    expect(JSON.parse(String(db.prepare('SELECT value FROM kv WHERE key = ?').get('employee-schema')!.value))).toBe(1)
  })
})

describe('EmployeeRepository', () => {
  it('creates disabled employees at version 1 and persists through reopen', () => {
    const path = join(dir, 'state.sqlite')
    const db = open(path)
    initializeEmployeeSchema(db)
    const repo = new EmployeeRepository(db)
    const created = repo.create(baseCreate())
    expect(created.enabled).toBe(false)
    expect(created.version).toBe(1)
    expect(created.runtimeId).toBe('runtime-local-1')
    expect(repo.snapshot('emp-alpha', 1)).toEqual(created)
    db.close()

    const again = open(path)
    initializeEmployeeSchema(again)
    const reopened = new EmployeeRepository(again)
    expect(reopened.get('emp-alpha')).toEqual(created)
    expect(reopened.list('ws-main')).toEqual([created])
  })

  it('keeps workspaces separated and rejects rename collisions', () => {
    const db = open()
    initializeEmployeeSchema(db)
    const repo = new EmployeeRepository(db)
    repo.create(baseCreate({ id: 'emp-a', workspaceId: 'ws-a', name: 'Shared Name' }))
    repo.create(baseCreate({ id: 'emp-b', workspaceId: 'ws-b', name: 'Shared Name' }))
    expect(repo.list('ws-a').map(item => item.id)).toEqual(['emp-a'])
    expect(repo.list('ws-b').map(item => item.id)).toEqual(['emp-b'])

    repo.create(baseCreate({ id: 'emp-c', workspaceId: 'ws-a', name: 'Other' }))
    expect(() => repo.update('emp-c', { expectedVersion: 1, name: 'Shared Name' }))
      .toThrow(/already exists|UNIQUE/i)
    expect(repo.get('emp-c')?.name).toBe('Other')
    expect(repo.get('emp-c')?.version).toBe(1)
  })

  it('versions updates, preserves immutable snapshots, and detects conflicts', () => {
    const db = open()
    initializeEmployeeSchema(db)
    const repo = new EmployeeRepository(db)
    const created = repo.create(baseCreate())
    const v1 = repo.snapshot('emp-alpha', 1)!
    expect(v1).toEqual(created)

    const updated = repo.update('emp-alpha', {
      expectedVersion: 1,
      role: 'staff-engineer',
      capabilities: ['typescript', 'architecture'],
      maxConcurrency: 4,
    })
    expect(updated.version).toBe(2)
    expect(updated.role).toBe('staff-engineer')
    expect(repo.snapshot('emp-alpha', 1)).toEqual(v1)
    expect(repo.snapshot('emp-alpha', 1)?.role).toBe('software-engineer')
    expect(repo.snapshot('emp-alpha', 2)).toEqual(updated)

    expect(() => repo.update('emp-alpha', { expectedVersion: 1, role: 'stale' }))
      .toThrow(/version conflict/i)
    expect(repo.get('emp-alpha')?.role).toBe('staff-engineer')

    const noop = repo.update('emp-alpha', { expectedVersion: 2, role: 'staff-engineer' })
    expect(noop.version).toBe(2)
  })

  it('defaults to disabled and only flips enabled through setEnabled', () => {
    const db = open()
    initializeEmployeeSchema(db)
    const repo = new EmployeeRepository(db)
    const created = repo.create(baseCreate())
    expect(created.enabled).toBe(false)
    expect('enabled' in baseCreate()).toBe(false)

    const enabled = repo.setEnabled('emp-alpha', { expectedVersion: 1, enabled: true })
    expect(enabled.enabled).toBe(true)
    expect(enabled.version).toBe(2)
    expect(enabled.runtimeId).toBe(created.runtimeId)
    expect(repo.snapshot('emp-alpha', 1)?.enabled).toBe(false)

    const same = repo.setEnabled('emp-alpha', { expectedVersion: 2, enabled: true })
    expect(same.version).toBe(2)

    const disabled = repo.setEnabled('emp-alpha', { expectedVersion: 2, enabled: false })
    expect(disabled.enabled).toBe(false)
    expect(disabled.version).toBe(3)
    expect(repo.get('emp-alpha')?.runtimeId).toBe('runtime-local-1')
  })

  it('rejects unknown secret, credential, permission and identity-mutation fields', () => {
    const db = open()
    initializeEmployeeSchema(db)
    const repo = new EmployeeRepository(db)
    repo.create(baseCreate())

    expect(() => repo.create({ ...baseCreate({ id: 'emp-secret' }), apiKey: 'sk-secret' } as EmployeeCreateInput))
      .toThrow(/Unknown employee create field: apiKey/)
    expect(() => repo.create({ ...baseCreate({ id: 'emp-cred' }), credentials: { token: 'x' } } as never))
      .toThrow(/Unknown employee create field: credentials/)
    expect(() => repo.update('emp-alpha', { expectedVersion: 1, permissions: ['admin'] } as never))
      .toThrow(/Unknown employee update field: permissions/)
    expect(() => repo.update('emp-alpha', { expectedVersion: 1, modelKey: 'k' } as never))
      .toThrow(/Unknown employee update field: modelKey/)
    expect(() => repo.update('emp-alpha', { expectedVersion: 1, workspaceId: 'ws-other' } as never))
      .toThrow(/Unknown employee update field: workspaceId/)
    expect(() => repo.update('emp-alpha', { expectedVersion: 1, id: 'emp-other' } as never))
      .toThrow(/Unknown employee update field: id/)
    expect(() => repo.setEnabled('emp-alpha', { expectedVersion: 1, enabled: true, token: 'x' } as never))
      .toThrow(/Unknown employee enable field: token/)
  })

  it('validates safe ids, unique capabilities, and bounded concurrency/timeout', () => {
    const db = open()
    initializeEmployeeSchema(db)
    const repo = new EmployeeRepository(db)

    expect(() => repo.create(baseCreate({ id: '../escape' }))).toThrow(/Invalid id/)
    expect(() => repo.create(baseCreate({ id: 'emp-bad-caps', capabilities: ['a', 'a'] })))
      .toThrow(/Duplicate capabilities/)
    expect(() => repo.create(baseCreate({ id: 'emp-bad-conc', maxConcurrency: 0 })))
      .toThrow(/Invalid maxConcurrency/)
    expect(() => repo.create(baseCreate({ id: 'emp-bad-timeout', timeoutMs: 86_400_001 })))
      .toThrow(/Invalid timeoutMs/)
    expect(() => repo.create(baseCreate({ id: 'emp-bad-projects', projectIds: ['ok', 'ok'] })))
      .toThrow(/Duplicate projectIds/)
  })

  it('returns defensive copies and rolls back failed nested writes', () => {
    const db = open()
    initializeEmployeeSchema(db)
    const repo = new EmployeeRepository(db)
    const created = repo.create(baseCreate())
    created.capabilities.push('mutated')
    created.responsibilities[0] = 'mutated'
    expect(repo.get('emp-alpha')?.capabilities).toEqual(['typescript', 'code-review'])
    expect(repo.get('emp-alpha')?.responsibilities[0]).toBe('implement features')

    const listed = repo.list('ws-main')
    listed[0]!.projectIds.push('proj-hack')
    expect(repo.get('emp-alpha')?.projectIds).toEqual(['proj-core'])

    expect(() => {
      db.exec('SAVEPOINT test_outer')
      try {
        repo.update('emp-alpha', { expectedVersion: 1, name: 'Temp Name' })
        throw new Error('boom')
      } catch (error) {
        db.exec('ROLLBACK TO test_outer')
        db.exec('RELEASE test_outer')
        throw error
      }
    }).toThrow('boom')
    expect(repo.get('emp-alpha')?.name).toBe('Alpha Coder')
    expect(repo.get('emp-alpha')?.version).toBe(1)
    expect(repo.snapshot('emp-alpha', 2)).toBeUndefined()
  })

  it('rejects repository writes when schema version is future', () => {
    const db = open()
    initializeEmployeeSchema(db)
    const repo = new EmployeeRepository(db)
    repo.create(baseCreate())
    db.prepare('UPDATE kv SET value = ? WHERE key = ?').run(JSON.stringify(9), 'employee-schema')
    expect(() => repo.create(baseCreate({ id: 'emp-next', name: 'Next' }))).toThrow(/Unknown employee schema version: 9/)
    expect(() => repo.update('emp-alpha', { expectedVersion: 1, role: 'x' })).toThrow(/Unknown employee schema version: 9/)
    expect(() => repo.setEnabled('emp-alpha', { expectedVersion: 1, enabled: true })).toThrow(/Unknown employee schema version: 9/)
  })
})
