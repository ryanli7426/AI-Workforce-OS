import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initializeProjectSchema, ProjectRepository, type ProjectCreateInput } from '../src/projects/projects.ts'

const opened: DatabaseSync[] = []
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'projects-'))
})

afterEach(() => {
  for (const db of opened.splice(0)) {
    try { db.close() } catch { /* ignore */ }
  }
  rmSync(root, { recursive: true, force: true })
})

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    HOME: root,
  }
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: gitEnv(), stdio: 'ignore', timeout: 15_000 })
}

function initGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'projects-test@example.com'])
  git(dir, ['config', 'user.name', 'Projects Test'])
  writeFileSync(join(dir, 'README'), 'fixture\n', { mode: 0o600 })
  git(dir, ['add', 'README'])
  git(dir, ['commit', '-m', 'init'])
  return resolve(dir)
}

function openDb(path = join(root, 'state.sqlite')): DatabaseSync {
  const db = new DatabaseSync(path)
  opened.push(db)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  return db
}

function repo(db: DatabaseSync): ProjectRepository {
  initializeProjectSchema(db)
  return new ProjectRepository(db)
}

function baseInput(overrides: Partial<ProjectCreateInput> = {}): ProjectCreateInput {
  const repositoryPath = initGitRepo(join(root, `repo-${Math.random().toString(16).slice(2)}`))
  const worktreeRoot = join(root, `worktrees-${Math.random().toString(16).slice(2)}`)
  return {
    id: 'proj-1',
    workspaceId: 'ws-1',
    name: 'Alpha',
    ownerId: 'owner-1',
    repositoryPath,
    worktreeRoot,
    allowedTaskTypes: ['feature', 'fix'],
    ...overrides,
  }
}

describe('Project records', () => {
  it('creates, reopens, lists, updates, archives, and keeps immutable snapshots', () => {
    const path = join(root, 'projects.sqlite')
    const db = openDb(path)
    const projects = repo(db)
    const created = projects.create(baseInput({ id: 'proj-a', name: 'Alpha' }))
    expect(created.version).toBe(1)
    expect(created.archived).toBe(false)
    expect(created.allowedTaskTypes).toEqual(['feature', 'fix'])
    expect(created.repositoryPath).toBe(resolve(created.repositoryPath))
    expect(created.worktreeRoot).toBe(resolve(created.worktreeRoot))

    const renamed = projects.update('proj-a', { expectedVersion: 1, name: 'Alpha Two', ownerId: 'owner-2' })
    expect(renamed.version).toBe(2)
    expect(renamed.name).toBe('Alpha Two')
    expect(renamed.ownerId).toBe('owner-2')
    expect(renamed.repositoryPath).toBe(created.repositoryPath)
    expect(renamed.worktreeRoot).toBe(created.worktreeRoot)

    const snap1 = projects.snapshot('proj-a', 1)
    expect(snap1).toEqual(created)
    snap1!.allowedTaskTypes.push('leaked')
    expect(projects.snapshot('proj-a', 1)?.allowedTaskTypes).toEqual(['feature', 'fix'])

    const archived = projects.archive('proj-a', { expectedVersion: 2 })
    expect(archived.archived).toBe(true)
    expect(archived.version).toBe(3)
    expect(() => projects.update('proj-a', { expectedVersion: 3, name: 'Nope' })).toThrow(/Archived/)
    expect(projects.archive('proj-a', { expectedVersion: 3 }).version).toBe(3)

    db.close()
    const again = openDb(path)
    initializeProjectSchema(again)
    const restored = new ProjectRepository(again)
    expect(restored.get('proj-a')?.name).toBe('Alpha Two')
    expect(restored.get('proj-a')?.archived).toBe(true)
    expect(restored.snapshot('proj-a', 1)?.name).toBe('Alpha')
    expect(restored.snapshot('proj-a', 2)?.ownerId).toBe('owner-2')
    expect(restored.list('ws-1')).toHaveLength(1)
  })

  it('rejects unknown fields, unsafe ids, duplicate task types, and missing schema', () => {
    const db = openDb()
    expect(() => new ProjectRepository(db).create(baseInput())).toThrow(/not initialized/)
    const projects = repo(db)
    const input = baseInput()
    expect(() => projects.create({ ...input, secret: 'x' } as ProjectCreateInput)).toThrow(/Unknown/)
    expect(() => projects.create({ ...input, id: '../escape' })).toThrow(/Invalid id/)
    expect(() => projects.create({ ...input, allowedTaskTypes: ['a', 'a'] })).toThrow(/Duplicate/)
    expect(() => projects.update(input.id, { expectedVersion: 1, repositoryPath: '/tmp' } as never)).toThrow(/Unknown/)
    expect(() => projects.archive(input.id, { expectedVersion: 1, force: true } as never)).toThrow(/Unknown/)
  })

  it('enforces workspace name uniqueness and does not invent readiness for other workspaces', () => {
    const projects = repo(openDb())
    const first = baseInput({ id: 'p1', name: 'Shared', workspaceId: 'ws-a' })
    projects.create(first)
    expect(() => projects.create(baseInput({ id: 'p2', name: 'Shared', workspaceId: 'ws-a' }))).toThrow(/already exists/)
    const other = projects.create(baseInput({ id: 'p3', name: 'Shared', workspaceId: 'ws-b' }))
    expect(other.workspaceId).toBe('ws-b')
    expect(projects.list('ws-a')).toHaveLength(1)
    expect(projects.list('ws-b')).toHaveLength(1)
  })

  it('rejects path escapes, overlaps, symlinks, and non-git roots without writing worktrees', () => {
    const projects = repo(openDb())
    const repositoryPath = initGitRepo(join(root, 'git-root'))
    const nested = join(repositoryPath, 'nested-worktrees')
    expect(() => projects.create(baseInput({
      id: 'overlap',
      repositoryPath,
      worktreeRoot: nested,
    }))).toThrow(/overlap/)

    const outside = join(root, 'outside-repo')
    mkdirSync(outside, { mode: 0o700 })
    expect(() => projects.create(baseInput({
      id: 'nongit',
      repositoryPath: outside,
      worktreeRoot: join(root, 'wt-1'),
    }))).toThrow(/Git/)

    const linkRepo = join(root, 'repo-link')
    symlinkSync(repositoryPath, linkRepo)
    expect(() => projects.create(baseInput({
      id: 'symlink-repo',
      repositoryPath: linkRepo,
      worktreeRoot: join(root, 'wt-2'),
    }))).toThrow(/symbolic/)

    const worktreeParent = join(root, 'wt-parent')
    mkdirSync(worktreeParent, { mode: 0o700 })
    const worktreeLink = join(root, 'wt-link')
    symlinkSync(worktreeParent, worktreeLink)
    expect(() => projects.create(baseInput({
      id: 'symlink-wt',
      repositoryPath,
      worktreeRoot: join(worktreeLink, 'child'),
    }))).toThrow(/symbolic/)

    expect(() => projects.create(baseInput({
      id: 'relative',
      repositoryPath: 'relative-repo',
      worktreeRoot: join(root, 'wt-3'),
    }))).toThrow(/absolute/)

    // Absent worktree root is allowed; module must not create it.
    const absent = join(root, 'absent-worktrees', 'leaf')
    const created = projects.create(baseInput({
      id: 'absent-ok',
      repositoryPath,
      worktreeRoot: absent,
    }))
    expect(created.worktreeRoot.endsWith(`${join('absent-worktrees', 'leaf')}`)).toBe(true)
    expect(created.worktreeRoot.startsWith('/')).toBe(true)
    expect(existsSync(absent)).toBe(false)
    expect(existsSync(join(root, 'absent-worktrees'))).toBe(false)
  })

  it('does not modify Git config or worktrees on project create', () => {
    const repositoryPath = initGitRepo(join(root, 'stable-git'))
    const beforeConfig = execFileSync('git', ['config', '--local', '--list'], {
      cwd: repositoryPath,
      env: gitEnv(),
      encoding: 'utf8',
    })
    const beforeHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryPath,
      env: gitEnv(),
      encoding: 'utf8',
    }).trim()
    const projects = repo(openDb())
    projects.create(baseInput({
      id: 'stable',
      repositoryPath,
      worktreeRoot: join(root, 'stable-wt'),
    }))
    const afterConfig = execFileSync('git', ['config', '--local', '--list'], {
      cwd: repositoryPath,
      env: gitEnv(),
      encoding: 'utf8',
    })
    const afterHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryPath,
      env: gitEnv(),
      encoding: 'utf8',
    }).trim()
    expect(afterConfig).toBe(beforeConfig)
    expect(afterHead).toBe(beforeHead)
    const worktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repositoryPath,
      env: gitEnv(),
      encoding: 'utf8',
    })
    expect(worktrees.trim().split('\n').filter(line => line.startsWith('worktree '))).toHaveLength(1)
  })

  it('rejects stale versions across connections and rolls back failed nested writes', () => {
    const path = join(root, 'race.sqlite')
    const firstDb = openDb(path)
    const secondDb = openDb(path)
    const first = repo(firstDb)
    initializeProjectSchema(secondDb)
    const second = new ProjectRepository(secondDb)
    const created = first.create(baseInput({ id: 'race', name: 'Race' }))

    const updated = first.update('race', { expectedVersion: 1, name: 'First wins' })
    expect(updated.version).toBe(2)
    expect(() => second.update('race', { expectedVersion: 1, name: 'Second loses' })).toThrow(/version conflict/)
    expect(second.get('race')?.name).toBe('First wins')

    expect(() => firstDb.exec('SAVEPOINT outer_test')).not.toThrow()
    try {
      expect(() => {
        first.update('race', { expectedVersion: 2, allowedTaskTypes: ['only'] })
        throw new Error('boom')
      }).toThrow('boom')
    } finally {
      firstDb.exec('ROLLBACK TO outer_test')
      firstDb.exec('RELEASE outer_test')
    }
    expect(first.get('race')?.allowedTaskTypes).toEqual(created.allowedTaskTypes)
    expect(first.get('race')?.version).toBe(2)
  })

  it('rejects future project schema versions before modifying tables', () => {
    const db = openDb()
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('project-schema', JSON.stringify(99))
    expect(() => initializeProjectSchema(db)).toThrow(/Unknown project schema version: 99/)
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'project'").get()).toBeUndefined()
  })

  it('returns defensive copies from get and list', () => {
    const projects = repo(openDb())
    projects.create(baseInput({ id: 'copy', name: 'Copy' }))
    const got = projects.get('copy')!
    got.allowedTaskTypes.push('mutated')
    got.name = 'changed'
    expect(projects.get('copy')?.allowedTaskTypes).toEqual(['feature', 'fix'])
    expect(projects.get('copy')?.name).toBe('Copy')
    const listed = projects.list('ws-1')
    listed[0]!.allowedTaskTypes.push('mutated')
    expect(projects.list('ws-1')[0]?.allowedTaskTypes).toEqual(['feature', 'fix'])
  })

  it('no-ops identical updates without bumping version', () => {
    const projects = repo(openDb())
    const created = projects.create(baseInput({ id: 'noop', name: 'Same' }))
    const again = projects.update('noop', {
      expectedVersion: 1,
      name: 'Same',
      ownerId: created.ownerId,
      allowedTaskTypes: [...created.allowedTaskTypes],
    })
    expect(again.version).toBe(1)
    expect(projects.snapshot('noop', 2)).toBeUndefined()
  })

  it('prepareCreate validates outside transactions and commitCreate rejects forged tokens', () => {
    const db = openDb()
    const projects = repo(db)
    const input = baseInput({ id: 'prepared', name: 'Prepared' })
    expect(db.isTransaction).toBe(false)
    const prepared = projects.prepareCreate(input)
    expect(() => projects.commitCreate({ __brand: 'PreparedProjectCreate' })).toThrow(/Invalid prepared/)
    const other = new ProjectRepository(db)
    expect(() => other.commitCreate(prepared)).toThrow(/Invalid prepared/)
    const created = projects.commitCreate(prepared)
    expect(created.id).toBe('prepared')
    expect(created.version).toBe(1)
    expect(() => projects.commitCreate(prepared)).toThrow(/Invalid prepared/)

    expect(() => {
      db.exec('BEGIN')
      try {
        projects.prepareCreate(baseInput({ id: 'tx-blocked', name: 'Tx' }))
      } finally {
        db.exec('ROLLBACK')
      }
    }).toThrow(/inside a transaction/)
  })
})

describe('integration gaps', () => {
  it('reports that LocalStore does not yet initialize project schema', () => {
    // Parent owns LocalStore / shared schema hooks; this package must not pretend readiness.
    const storeSource = readFileSync(new URL('../src/storage/store.ts', import.meta.url), 'utf8')
    expect(storeSource.includes('initializeProjectSchema')).toBe(false)
  })
})
