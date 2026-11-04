import { existsSync, chmodSync, mkdirSync, symlinkSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli } from '../src/cli/index.ts'
import { LAO_SCHEMA_VERSION, LocalStore } from '../src/storage/store.ts'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'workforce-cli-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function run(...argv: string[]) {
  let stdout = '', stderr = ''
  const code = runCli(argv, {
    stdout: { write: value => { stdout += value; return true } },
    stderr: { write: value => { stderr += value; return true } },
  })
  const json = stdout.startsWith('{') || stdout.startsWith('[') ? JSON.parse(stdout) as unknown : undefined
  return { code, stdout, stderr, json }
}

function schemaFixture(path: string, version: number): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
    db.prepare('INSERT INTO kv VALUES (?, ?)').run('schema', JSON.stringify(version))
  } finally { db.close() }
}

describe('foundation CLI', () => {
  it('shows help without running the CLI on import', () => {
    const result = run('--help')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Usage: workforce')
    expect(result.stderr).toBe('')
  })

  it.each(['status', 'tickets'])('%s never initializes missing storage', command => {
    const dataDir = join(root, 'missing')
    const result = run(command, '--data-dir', dataDir)
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('run init first')
    expect(existsSync(dataDir)).toBe(false)
  })

  it('reports doctor facts without creating or exposing environment values', () => {
    const dataDir = join(root, 'doctor-data')
    const result = run('doctor', '--data-dir', dataDir)
    expect(result.code).toBe(0)
    expect(result.json).toEqual({
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      environment: { cwd: process.cwd(), dataDir, databaseExists: false },
    })
    expect(result.stdout).not.toContain('TOKEN')
    expect(existsSync(dataDir)).toBe(false)
  })

  it('initializes private storage and supports status and ticket projections', () => {
    const dataDir = join(root, 'data')
    const initialized = run('init', '--data-dir', dataDir)
    expect(initialized).toMatchObject({ code: 0, stderr: '', json: { initialized: true, schema: LAO_SCHEMA_VERSION } })
    expect(statSync(dataDir).mode & 0o777).toBe(0o700)

    const path = join(dataDir, 'workforce.sqlite')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    const store = new LocalStore(path)
    try {
      store.db.prepare('INSERT INTO ticket (id, value) VALUES (?, ?)').run('task-1', JSON.stringify({
        id: 'task-1', title: 'First task', updatedAt: '2026-11-04T00:00:00.000Z', lifecycle: { status: 'RUNNING' },
      }))
    } finally { store.close() }

    const before = readFileSync(path)
    const status = run('status', '--data-dir', dataDir)
    expect(status.code).toBe(0)
    expect(status.json).toMatchObject({ initialized: true, schema: LAO_SCHEMA_VERSION,
      tasks: { total: 1, byStatus: { RUNNING: 1, DONE: 0 } } })
    expect(run('tickets', '--data-dir', dataDir)).toMatchObject({ code: 0, stderr: '', json: [{
      id: 'task-1', title: 'First task', status: 'RUNNING', updatedAt: '2026-11-04T00:00:00.000Z',
    }] })
    expect(readFileSync(path)).toEqual(before)
  })

  it.each([
    { argv: [], error: 'Missing command' },
    { argv: ['start'], error: 'Unknown command' },
    { argv: ['status', '--wat'], error: 'Unknown option' },
    { argv: ['status', '--data-dir'], error: 'Missing value' },
    { argv: ['status', '--data-dir', ''], error: 'Missing value' },
    { argv: ['status', '--data-dir', '--wat'], error: 'Missing value' },
    { argv: ['tickets', 'extra'], error: 'Unexpected argument' },
    { argv: ['init', '--data-dir', '/tmp/first', '--data-dir', '/tmp/second'], error: 'only be provided once' },
  ])('rejects invalid arguments: $argv', ({ argv, error }) => {
    const result = run(...argv)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(error)
  })

  it.each([
    { version: 11, error: 'Legacy LAO schema 11' },
    { version: LAO_SCHEMA_VERSION + 1, error: 'Unsupported LAO schema' },
  ])('rejects schema $version read-only without changing it', ({ version, error }) => {
    const dataDir = join(root, `schema-${version}`)
    const initialized = run('init', '--data-dir', dataDir)
    expect(initialized.code).toBe(0)
    const path = join(dataDir, 'workforce.sqlite')
    rmSync(path)
    rmSync(`${path}-shm`, { force: true })
    rmSync(`${path}-wal`, { force: true })
    schemaFixture(path, version)
    const before = readFileSync(path)

    for (const command of ['status', 'tickets']) {
      const result = run(command, '--data-dir', dataDir)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(error)
      expect(readFileSync(path)).toEqual(before)
      const db = new DatabaseSync(path, { readOnly: true })
      try { expect(db.prepare("SELECT value FROM kv WHERE key = 'schema'").get()?.value).toBe(String(version)) }
      finally { db.close() }
    }
  })
})


describe('initialization directory ownership', () => {
  it('refuses a shared directory without changing its permissions', () => {
    const path = join(root, 'shared'); mkdirSync(path); chmodSync(path, 0o755)
    expect(run('init', '--data-dir', path).code).toBe(1)
    expect(statSync(path).mode & 0o777).toBe(0o755)
    expect(existsSync(join(path, 'workforce.sqlite'))).toBe(false)
  })
  it('refuses a symlink data directory', () => {
    const target = join(root, 'target'), link = join(root, 'link')
    mkdirSync(target, { mode: 0o700 }); symlinkSync(target, link)
    expect(run('init', '--data-dir', link).code).toBe(1)
    expect(existsSync(join(target, 'workforce.sqlite'))).toBe(false)
  })
})
