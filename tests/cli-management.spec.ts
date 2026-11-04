import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli } from '../src/cli/index.ts'
import { BACKUP_SCHEMA, verifyBackup } from '../src/storage/backup.ts'
import { LAO_SCHEMA_VERSION, LocalStore } from '../src/storage/store.ts'

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'workforce-cli-mgmt-')) })
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

function initGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  execFileSync('git', ['init'], { cwd: dir, env: gitEnv(), stdio: 'ignore', timeout: 15_000 })
  execFileSync('git', ['config', 'user.email', 'cli-mgmt@example.com'], { cwd: dir, env: gitEnv(), stdio: 'ignore', timeout: 15_000 })
  execFileSync('git', ['config', 'user.name', 'CLI Mgmt'], { cwd: dir, env: gitEnv(), stdio: 'ignore', timeout: 15_000 })
  writeFileSync(join(dir, 'README'), 'fixture\n', { mode: 0o600 })
  execFileSync('git', ['add', 'README'], { cwd: dir, env: gitEnv(), stdio: 'ignore', timeout: 15_000 })
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, env: gitEnv(), stdio: 'ignore', timeout: 15_000 })
  return resolve(dir)
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

function employeeInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'emp-alpha',
    name: 'Alpha Coder',
    role: 'software-engineer',
    responsibilities: ['implement features'],
    capabilities: ['typescript'],
    runtimeId: 'runtime-local-1',
    projectIds: ['proj-core'],
    maxConcurrency: 2,
    timeoutMs: 60_000,
    ...overrides,
  }
}

function projectInput(overrides: Record<string, unknown> = {}) {
  const repositoryPath = initGitRepo(join(root, `repo-${Math.random().toString(16).slice(2)}`))
  const worktreeRoot = join(root, `worktrees-${Math.random().toString(16).slice(2)}`)
  return {
    id: 'proj-alpha',
    name: 'Alpha',
    ownerId: 'owner-1',
    repositoryPath,
    worktreeRoot,
    allowedTaskTypes: ['feature', 'fix'],
    ...overrides,
  }
}

describe('management CLI extension', () => {
  it('help describes the new management commands', () => {
    const result = run('--help')
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('employees')
    expect(result.stdout).toContain('employee-create')
    expect(result.stdout).toContain('employee-enable')
    expect(result.stdout).toContain('projects')
    expect(result.stdout).toContain('project-create')
    expect(result.stdout).toContain('backup')
    expect(result.stdout).toContain('--file')
    expect(result.stdout).toContain('--backup-dir')
  })

  it('init installs application module schemas used by management commands', () => {
    const dataDir = join(root, 'data')
    expect(run('init', '--data-dir', dataDir)).toMatchObject({
      code: 0,
      stderr: '',
      json: { initialized: true, schema: LAO_SCHEMA_VERSION },
    })

    const listed = run('employees', '--data-dir', dataDir)
    expect(listed).toMatchObject({ code: 0, stderr: '', json: [] })
    expect(run('projects', '--data-dir', dataDir)).toMatchObject({ code: 0, stderr: '', json: [] })
  })

  it('creates, lists, and enables employees for the local workspace only', () => {
    const dataDir = join(root, 'data')
    expect(run('init', '--data-dir', dataDir).code).toBe(0)

    const file = join(root, 'employee.json')
    writeJson(file, employeeInput())

    const created = run('employee-create', '--data-dir', dataDir, '--file', file)
    expect(created.code).toBe(0)
    expect(created.json).toMatchObject({
      id: 'emp-alpha',
      workspaceId: 'local',
      enabled: false,
      version: 1,
      runtimeId: 'runtime-local-1',
    })

    expect(run('employees', '--data-dir', dataDir)).toMatchObject({
      code: 0,
      json: [expect.objectContaining({ id: 'emp-alpha', workspaceId: 'local', enabled: false, version: 1 })],
    })

    const enabled = run('employee-enable', 'emp-alpha', '--data-dir', dataDir, '--version', '1')
    expect(enabled.code).toBe(0)
    expect(enabled.json).toMatchObject({ id: 'emp-alpha', enabled: true, version: 2 })
    expect(run('employees', '--data-dir', dataDir).json).toEqual([
      expect.objectContaining({ id: 'emp-alpha', enabled: true, version: 2 }),
    ])
  })

  it('creates and lists projects for the local workspace', () => {
    const dataDir = join(root, 'data')
    expect(run('init', '--data-dir', dataDir).code).toBe(0)

    const input = projectInput()
    const file = join(root, 'project.json')
    writeJson(file, input)

    const created = run('project-create', '--data-dir', dataDir, '--file', file)
    expect(created.code).toBe(0)
    expect(created.stderr).toBe('')
    const project = created.json as {
      id: string
      workspaceId: string
      name: string
      archived: boolean
      version: number
      repositoryPath: string
      worktreeRoot: string
    }
    expect(project).toMatchObject({
      id: 'proj-alpha',
      workspaceId: 'local',
      name: 'Alpha',
      archived: false,
      version: 1,
    })
    expect(project.repositoryPath).toBe(realpathSync(input.repositoryPath))
    expect(project.worktreeRoot.endsWith(`/${input.worktreeRoot.split('/').pop()}`)).toBe(true)
    expect(run('projects', '--data-dir', dataDir)).toMatchObject({
      code: 0,
      json: [expect.objectContaining({ id: 'proj-alpha', workspaceId: 'local', version: 1 })],
    })
  })

  it('creates a database-only backup from an existing LocalStore connection', () => {
    const dataDir = join(root, 'data')
    expect(run('init', '--data-dir', dataDir).code).toBe(0)
    const employeeFile = join(root, 'employee.json')
    writeJson(employeeFile, employeeInput({ id: 'emp-backup' }))
    expect(run('employee-create', '--data-dir', dataDir, '--file', employeeFile).code).toBe(0)

    const backupDir = join(root, 'backups')
    mkdirSync(backupDir, { mode: 0o700 })
    const result = run('backup', '--data-dir', dataDir, '--backup-dir', backupDir)
    expect(result.code).toBe(0)
    expect(result.json).toMatchObject({
      version: 1,
      schema: BACKUP_SCHEMA,
      databaseFile: 'database.sqlite',
      sourceSchema: LAO_SCHEMA_VERSION,
    })
    const manifest = result.json as { id: string }
    expect(verifyBackup(join(backupDir, manifest.id))).toMatchObject(result.json as object)

    const employees = run('employees', '--data-dir', dataDir)
    expect(employees.json).toEqual([expect.objectContaining({ id: 'emp-backup' })])
  })

  it.each(['employees', 'projects', 'employee-create', 'project-create', 'backup'] as const)(
    '%s never initializes missing storage',
    command => {
      const dataDir = join(root, 'missing')
      const argv = command === 'employee-create' || command === 'project-create'
        ? [command, '--data-dir', dataDir, '--file', join(root, 'missing.json')]
        : command === 'backup'
          ? [command, '--data-dir', dataDir, '--backup-dir', join(root, 'backups')]
          : [command, '--data-dir', dataDir]
      if (command === 'employee-create' || command === 'project-create') {
        writeJson(join(root, 'missing.json'), employeeInput())
      }
      const result = run(...argv)
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('run init first')
      expect(existsSync(dataDir)).toBe(false)
    },
  )

  it('read-only management queries do not mutate the database bytes', () => {
    const dataDir = join(root, 'data')
    expect(run('init', '--data-dir', dataDir).code).toBe(0)
    const path = join(dataDir, 'workforce.sqlite')
    const before = readFileSync(path)
    expect(run('employees', '--data-dir', dataDir).code).toBe(0)
    expect(run('projects', '--data-dir', dataDir).code).toBe(0)
    expect(readFileSync(path)).toEqual(before)
  })

  it('rejects non-local workspaceId and unknown create fields without leaking file contents', () => {
    const dataDir = join(root, 'data')
    expect(run('init', '--data-dir', dataDir).code).toBe(0)

    const foreign = join(root, 'foreign.json')
    writeJson(foreign, employeeInput({ workspaceId: 'other', name: 'SECRET_TOKEN_VALUE' }))
    const foreignResult = run('employee-create', '--data-dir', dataDir, '--file', foreign)
    expect(foreignResult.code).toBe(1)
    expect(foreignResult.stderr).toContain('workspaceId')
    expect(foreignResult.stderr).not.toContain('SECRET_TOKEN_VALUE')
    expect(foreignResult.stdout).toBe('')

    const unknown = join(root, 'unknown.json')
    writeJson(unknown, employeeInput({ apiKey: 'super-secret' }))
    const unknownResult = run('employee-create', '--data-dir', dataDir, '--file', unknown)
    expect(unknownResult.code).toBe(1)
    expect(unknownResult.stderr).toMatch(/Unknown employee create field|apiKey/)
    expect(unknownResult.stderr).not.toContain('super-secret')
  })

  it('rejects symlink, oversized, and invalid JSON input files', () => {
    const dataDir = join(root, 'data')
    expect(run('init', '--data-dir', dataDir).code).toBe(0)

    const target = join(root, 'target.json')
    writeJson(target, employeeInput())
    const linked = join(root, 'linked.json')
    symlinkSync(target, linked)
    expect(run('employee-create', '--data-dir', dataDir, '--file', linked)).toMatchObject({
      code: 1,
      stdout: '',
    })
    expect(run('employee-create', '--data-dir', dataDir, '--file', linked).stderr).toMatch(/symbolic link|regular file/)

    const huge = join(root, 'huge.json')
    writeFileSync(huge, `{"id":"x","pad":"${'a'.repeat(130 * 1024)}"}`, { mode: 0o600 })
    expect(run('employee-create', '--data-dir', dataDir, '--file', huge).stderr).toContain('128KiB')

    const invalid = join(root, 'invalid.json')
    writeFileSync(invalid, '{not-json', { mode: 0o600 })
    expect(run('employee-create', '--data-dir', dataDir, '--file', invalid).stderr).toContain('not valid JSON')
    expect(run('employees', '--data-dir', dataDir).json).toEqual([])
  })

  it.each([
    { argv: ['employee-create', '--data-dir', 'x'], error: 'Missing required option --file' },
    { argv: ['employee-create', '--file', 'a.json', '--file', 'b.json'], error: 'only be provided once' },
    { argv: ['employee-enable', '--data-dir', 'x', '--version', '1'], error: 'Missing employee id' },
    { argv: ['employee-enable', 'emp-1', '--data-dir', 'x'], error: 'Missing required option --version' },
    { argv: ['employee-enable', 'emp-1', '--version', '0', '--data-dir', 'x'], error: 'Invalid value for --version' },
    { argv: ['employee-enable', 'emp-1', '--version', '1', '--version', '2', '--data-dir', 'x'], error: 'only be provided once' },
    { argv: ['backup', '--data-dir', 'x'], error: 'Missing required option --backup-dir' },
    { argv: ['backup', '--backup-dir', 'y', '--backup-dir', 'z', '--data-dir', 'x'], error: 'only be provided once' },
    { argv: ['employees', '--file', 'x.json'], error: 'Unknown option' },
    { argv: ['status', '--backup-dir', 'x'], error: 'Unknown option' },
    { argv: ['employee-create', '--data-dir', 'x', '--file', 'a.json', 'extra'], error: 'Unexpected argument' },
  ])('rejects invalid management arguments: $argv', ({ argv, error }) => {
    const result = run(...argv)
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(error)
  })

  it('rejects legacy and unsupported schemas for management reads and writes without migrating', () => {
    const dataDir = join(root, 'legacy')
    mkdirSync(dataDir, { mode: 0o700 })
    const path = join(dataDir, 'workforce.sqlite')
    const db = new DatabaseSync(path)
    try {
      db.exec('CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL); CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL)')
      db.prepare('INSERT INTO kv VALUES (?, ?)').run('schema', JSON.stringify(11))
    } finally { db.close() }
    const before = readFileSync(path)

    for (const command of [
      ['employees', '--data-dir', dataDir],
      ['projects', '--data-dir', dataDir],
      ['employee-enable', 'emp-1', '--data-dir', dataDir, '--version', '1'],
      ['backup', '--data-dir', dataDir, '--backup-dir', join(root, 'backups')],
    ] as const) {
      const result = run(...command)
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/Legacy LAO schema 11|explicit migrateLegacy/)
      expect(readFileSync(path)).toEqual(before)
    }
  })

  it('rejects main-schema-only databases that lack application modules', () => {
    const dataDir = join(root, 'main-only')
    mkdirSync(dataDir, { mode: 0o700 })
    const path = join(dataDir, 'workforce.sqlite')
    const store = new LocalStore(path)
    store.close()

    const listed = run('employees', '--data-dir', dataDir)
    expect(listed.code).toBe(1)
    expect(listed.stderr).toMatch(/not initialized|unsupported/i)

    const file = join(root, 'employee.json')
    writeJson(file, employeeInput())
    const created = run('employee-create', '--data-dir', dataDir, '--file', file)
    expect(created.code).toBe(1)
    expect(created.stderr).toMatch(/not initialized|unsupported/i)
  })

  it('doctor remains non-mutating after management commands exist', () => {
    const dataDir = join(root, 'doctor-data')
    const result = run('doctor', '--data-dir', dataDir)
    expect(result.code).toBe(0)
    expect(result.json).toEqual({
      runtime: { node: process.version, platform: process.platform, arch: process.arch },
      environment: { cwd: process.cwd(), dataDir, databaseExists: false },
    })
    expect(existsSync(dataDir)).toBe(false)
  })
})
