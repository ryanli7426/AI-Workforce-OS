import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  initializeManagementSchema,
  LocalManagementCommands,
  MANAGEMENT_SCHEMA_KEY,
  MANAGEMENT_SCHEMA_VERSION,
  ManagementCommandError,
} from '../src/application/management-commands.ts'
import { ProjectRepository, type ProjectCreateInput } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LAO_SCHEMA_VERSION, LocalStore } from '../src/storage/store.ts'
import { EmployeeRepository, type EmployeeCreateInput } from '../src/workforce/employees.ts'

const opened: LocalStore[] = []
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mgmt-cmd-'))
})

afterEach(() => {
  for (const store of opened.splice(0)) {
    try { store.close() } catch { /* ignore */ }
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
  git(dir, ['config', 'user.email', 'mgmt@example.com'])
  git(dir, ['config', 'user.name', 'Mgmt'])
  writeFileSync(join(dir, 'README'), 'fixture\n', { mode: 0o600 })
  git(dir, ['add', 'README'])
  git(dir, ['commit', '-m', 'init'])
  return resolve(dir)
}

function openStore(path = join(root, 'workforce.sqlite')): LocalStore {
  const store = new LocalStore(path)
  opened.push(store)
  initializeApplicationSchema(store)
  initializeManagementSchema(store.db)
  return store
}

function commands(
  store: LocalStore,
  ownerId = 'owner-1',
  workspaceId = 'local',
  runtimeIds: readonly string[] = ['claude-local'],
): LocalManagementCommands {
  return new LocalManagementCommands({ store, ownerId, workspaceId, runtimeIds })
}

function seedProject(store: LocalStore, overrides: Partial<ProjectCreateInput> = {}) {
  const repositoryPath = initGitRepo(join(root, `repo-${Math.random().toString(16).slice(2)}`))
  const worktreeRoot = join(root, `worktrees-${Math.random().toString(16).slice(2)}`)
  return new ProjectRepository(store.db).create({
    id: 'proj-1',
    workspaceId: 'local',
    name: 'Docs',
    ownerId: 'biz-owner',
    repositoryPath,
    worktreeRoot,
    allowedTaskTypes: ['docs'],
    ...overrides,
  })
}

function employeeCreateInput(overrides: Partial<Omit<EmployeeCreateInput, 'workspaceId'>> = {}) {
  return {
    id: 'emp-1',
    name: 'Alpha',
    role: 'engineer',
    responsibilities: ['ship'],
    capabilities: ['typescript'],
    runtimeId: 'claude-local',
    projectIds: ['proj-1'],
    maxConcurrency: 2,
    timeoutMs: 60_000,
    ...overrides,
  }
}

function receiptCount(store: LocalStore): number {
  return (store.db.prepare('SELECT count(*) AS n FROM management_command_receipt').get() as { n: number }).n
}

function auditCount(store: LocalStore): number {
  return (store.db.prepare('SELECT count(*) AS n FROM management_audit').get() as { n: number }).n
}

describe('initializeManagementSchema', () => {
  it('requires current main schema and installs management-schema 1 explicitly', () => {
    const store = new LocalStore(join(root, 'mgmt.sqlite'))
    opened.push(store)
    expect(store.get('schema')).toBe(LAO_SCHEMA_VERSION)
    expect(() => new LocalManagementCommands({
      store, ownerId: 'owner-1', runtimeIds: ['claude-local'],
    })).toThrow(/not initialized/)
    expect(() => new LocalManagementCommands({
      store, ownerId: 'owner-1', runtimeIds: ['claude-local'],
    })).toThrow(/not initialized/)
    initializeManagementSchema(store.db)
    expect(store.get<number>(MANAGEMENT_SCHEMA_KEY)).toBe(MANAGEMENT_SCHEMA_VERSION)
    expect(() => new LocalManagementCommands({
      store, ownerId: 'owner-1', runtimeIds: ['claude-local'],
    })).not.toThrow()
  })

  it('refuses unsupported or unversioned management schema without mutating tables', () => {
    const store = openStore()
    store.set(MANAGEMENT_SCHEMA_KEY, 99)
    const before = store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'management_command_receipt'").get()
    expect(() => initializeManagementSchema(store.db)).toThrow(/Unsupported management schema/)
    expect(store.get<number>(MANAGEMENT_SCHEMA_KEY)).toBe(99)
    expect(store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'management_command_receipt'").get()).toEqual(before)

    const bare = new LocalStore(join(root, 'unversioned.sqlite'))
    opened.push(bare)
    bare.db.exec(`CREATE TABLE management_command_receipt (workspace_id TEXT)`)
    expect(() => initializeManagementSchema(bare.db)).toThrow(/Unversioned management schema/)
    expect(bare.get(MANAGEMENT_SCHEMA_KEY)).toBeUndefined()
  })

  it('refuses when main schema is not current', () => {
    const store = new LocalStore(join(root, 'bad-main.sqlite'))
    opened.push(store)
    store.set('schema', LAO_SCHEMA_VERSION - 1)
    expect(() => initializeManagementSchema(store.db)).toThrow(/main schema/)
    expect(store.get(MANAGEMENT_SCHEMA_KEY)).toBeUndefined()
  })

  it('fails construction on corrupt tables without initializing', () => {
    const store = openStore(join(root, 'corrupt.sqlite'))
    store.db.exec('DROP TABLE management_audit')
    store.db.exec(`CREATE TABLE management_audit (id TEXT PRIMARY KEY)`)
    expect(() => new LocalManagementCommands({
      store, ownerId: 'owner-1', runtimeIds: ['claude-local'],
    })).toThrow(/corrupt/i)
    expect(store.get<number>(MANAGEMENT_SCHEMA_KEY)).toBe(MANAGEMENT_SCHEMA_VERSION)
  })
})

describe('employee commands', () => {
  it('creates disabled employees, enables, updates, and replays after reopen', () => {
    const path = join(root, 'employees.sqlite')
    const store = openStore(path)
    seedProject(store)
    const api = commands(store)

    const created = api.execute('emp-create-1', {
      kind: 'employee-create',
      input: employeeCreateInput(),
      reason: 'onboard alpha',
    })
    expect(created.kind).toBe('employee')
    if (created.kind !== 'employee') throw new Error('expected employee')
    expect(created.replayed).toBe(false)
    expect(created.employee.enabled).toBe(false)
    expect(created.employee.version).toBe(1)
    expect(created.employee.workspaceId).toBe('local')
    expect(receiptCount(store)).toBe(1)
    expect(auditCount(store)).toBe(1)

    const replay = api.execute('emp-create-1', {
      kind: 'employee-create',
      input: employeeCreateInput(),
      reason: 'onboard alpha',
    })
    expect(replay.replayed).toBe(true)
    expect(auditCount(store)).toBe(1)

    const enabled = api.execute('emp-enable-1', {
      kind: 'employee-enable',
      id: 'emp-1',
      input: { expectedVersion: 1, enabled: true },
      reason: 'ready for intake',
    })
    expect(enabled.kind).toBe('employee')
    if (enabled.kind !== 'employee') throw new Error('expected employee')
    expect(enabled.employee.enabled).toBe(true)
    expect(enabled.employee.version).toBe(2)

    expect(() => api.execute('emp-sensitive', {
      kind: 'employee-update',
      id: 'emp-1',
      input: { expectedVersion: 2, runtimeId: 'claude-local', maxConcurrency: 3 },
      reason: 'should fail while enabled',
    })).toThrow(ManagementCommandError)

    const renamed = api.execute('emp-rename', {
      kind: 'employee-update',
      id: 'emp-1',
      input: { expectedVersion: 2, name: 'Alpha Two', role: 'senior' },
      reason: 'rename while enabled is allowed',
    })
    expect(renamed.kind).toBe('employee')
    if (renamed.kind !== 'employee') throw new Error('expected employee')
    expect(renamed.employee.name).toBe('Alpha Two')
    expect(renamed.employee.version).toBe(3)

    const disabled = api.execute('emp-disable', {
      kind: 'employee-enable',
      id: 'emp-1',
      input: { expectedVersion: 3, enabled: false },
      reason: 'disable before config change',
    })
    expect(disabled.kind).toBe('employee')
    if (disabled.kind !== 'employee') throw new Error('expected employee')
    expect(disabled.employee.enabled).toBe(false)

    const config = api.execute('emp-config', {
      kind: 'employee-update',
      id: 'emp-1',
      input: { expectedVersion: 4, maxConcurrency: 4, capabilities: ['typescript', 'review'] },
      reason: 'raise concurrency',
    })
    expect(config.kind).toBe('employee')
    if (config.kind !== 'employee') throw new Error('expected employee')
    expect(config.employee.maxConcurrency).toBe(4)
    expect(config.employee.version).toBe(5)

    store.close()
    const again = openStore(path)
    const restored = commands(again)
    const createAgain = restored.execute('emp-create-1', {
      kind: 'employee-create',
      input: employeeCreateInput(),
      reason: 'onboard alpha',
    })
    expect(createAgain.replayed).toBe(true)
    expect(createAgain.kind).toBe('employee')
    if (createAgain.kind !== 'employee') throw new Error('expected employee')
    expect(createAgain.employee.enabled).toBe(false)
    expect(createAgain.employee.version).toBe(1)

    const history = restored.history('employee', 'emp-1')
    expect(history.length).toBeGreaterThanOrEqual(4)
    expect(history.every(item => item.actorId === 'owner-1' && item.workspaceId === 'local')).toBe(true)
    expect(history[0]?.action).toMatch(/^employee-/)
    expect(history.every(item => !('apiKey' in item) && !String(item.reason).includes('sk-'))).toBe(true)
  })

  it('rejects foreign workspace projects, unknown runtime, credentials, and version conflicts', () => {
    const store = openStore()
    seedProject(store)
    seedProject(store, { id: 'proj-other', workspaceId: 'other', name: 'Other' })
    const archived = seedProject(store, { id: 'proj-arch', name: 'Archived' })
    new ProjectRepository(store.db).archive('proj-arch', { expectedVersion: archived.version })
    const api = commands(store)

    try {
      api.execute('bad-runtime', {
        kind: 'employee-create',
        input: employeeCreateInput({ runtimeId: 'not-allowed' }),
        reason: 'bad runtime',
      })
      expect.fail('expected INVALID_COMMAND')
    } catch (error) {
      expect(error).toBeInstanceOf(ManagementCommandError)
      expect((error as ManagementCommandError).code).toBe('INVALID_COMMAND')
      expect(String((error as Error).message)).not.toMatch(/not-allowed|token|secret/i)
    }

    expect(() => api.execute('bad-proj', {
      kind: 'employee-create',
      input: employeeCreateInput({ projectIds: ['proj-other'] }),
      reason: 'foreign project',
    })).toThrow(ManagementCommandError)

    expect(() => api.execute('bad-arch', {
      kind: 'employee-create',
      input: employeeCreateInput({ projectIds: ['proj-arch'] }),
      reason: 'archived project',
    })).toThrow(ManagementCommandError)

    try {
      api.execute('creds', {
        kind: 'employee-create',
        input: { ...employeeCreateInput(), api_token: 'sk-secret' } as never,
        reason: 'leak attempt',
      })
      expect.fail('expected INVALID_COMMAND')
    } catch (error) {
      expect(error).toBeInstanceOf(ManagementCommandError)
      expect((error as ManagementCommandError).code).toBe('INVALID_COMMAND')
      expect(String((error as Error).message)).toBe('Unknown employee create field')
      expect(String((error as Error).message)).not.toMatch(/api_token|sk-secret/i)
    }

    expect(() => api.execute('inject-ws', {
      kind: 'employee-create',
      input: { ...employeeCreateInput(), workspaceId: 'evil' } as never,
      reason: 'inject workspace',
    })).toThrow(ManagementCommandError)

    const created = api.execute('ok', {
      kind: 'employee-create',
      input: employeeCreateInput(),
      reason: 'ok',
    })
    expect(created.kind).toBe('employee')
    try {
      api.execute('stale', {
        kind: 'employee-update',
        id: 'emp-1',
        input: { expectedVersion: 99, name: 'Nope' },
        reason: 'stale',
      })
      expect.fail('expected VERSION_CONFLICT')
    } catch (error) {
      expect(error).toBeInstanceOf(ManagementCommandError)
      expect((error as ManagementCommandError).code).toBe('VERSION_CONFLICT')
    }
    expect(receiptCount(store)).toBe(1)

    expect(() => api.history('employee', 'missing')).toThrow(ManagementCommandError)
    expect(() => commands(store, 'owner-2').history('employee', 'emp-1')).not.toThrow()
    // foreign owner sees resource in workspace but audits are actor-scoped empty
    expect(commands(store, 'owner-2').history('employee', 'emp-1')).toEqual([])
  })
})

describe('project commands', () => {
  it('creates with Git preflight outside transactions and replays without duplicate audit', () => {
    const store = openStore()
    const api = commands(store)
    const repositoryPath = initGitRepo(join(root, 'proj-repo'))
    const worktreeRoot = join(root, 'proj-wt')
    const input = {
      id: 'proj-new',
      name: 'New',
      ownerId: 'biz-owner',
      repositoryPath,
      worktreeRoot,
      allowedTaskTypes: ['docs', 'fix'],
    }

    let sawTransactionDuringPreflight: boolean | undefined
    const originalPrepare = ProjectRepository.prototype.prepareCreate
    ProjectRepository.prototype.prepareCreate = function (this: ProjectRepository, value: ProjectCreateInput) {
      sawTransactionDuringPreflight = store.db.isTransaction
      return originalPrepare.call(this, value)
    }

    let created
    try {
      created = api.execute('proj-create-1', {
        kind: 'project-create',
        input,
        reason: 'register project',
      })
    } finally {
      ProjectRepository.prototype.prepareCreate = originalPrepare
    }

    expect(sawTransactionDuringPreflight).toBe(false)
    expect(created.kind).toBe('project')
    if (created.kind !== 'project') throw new Error('expected project')
    expect(created.replayed).toBe(false)
    expect(created.project.version).toBe(1)
    expect(created.project.archived).toBe(false)
    expect(created.project.workspaceId).toBe('local')
    expect(receiptCount(store)).toBe(1)
    expect(auditCount(store)).toBe(1)

    const again = api.execute('proj-create-1', {
      kind: 'project-create',
      input: { ...input },
      reason: 'register project',
    })
    expect(again.replayed).toBe(true)
    expect(auditCount(store)).toBe(1)
    expect(new ProjectRepository(store.db).list('local')).toHaveLength(1)

    try {
      api.execute('proj-create-1', {
        kind: 'project-create',
        input: { ...input, name: 'Changed' },
        reason: 'register project',
      })
      expect.fail('expected IDEMPOTENCY_CONFLICT')
    } catch (error) {
      expect(error).toBeInstanceOf(ManagementCommandError)
      expect((error as ManagementCommandError).code).toBe('IDEMPOTENCY_CONFLICT')
    }

    const updated = api.execute('proj-update-1', {
      kind: 'project-update',
      id: 'proj-new',
      input: { expectedVersion: 1, name: 'New Two', ownerId: 'biz-2' },
      reason: 'rename project',
    })
    expect(updated.kind).toBe('project')
    if (updated.kind !== 'project') throw new Error('expected project')
    expect(updated.project.name).toBe('New Two')
    expect(updated.project.repositoryPath).toBe(created.project.repositoryPath)

    const archived = api.execute('proj-archive-1', {
      kind: 'project-archive',
      id: 'proj-new',
      input: { expectedVersion: 2 },
      reason: 'retire project; running tasks unaffected',
    })
    expect(archived.kind).toBe('project')
    if (archived.kind !== 'project') throw new Error('expected project')
    expect(archived.project.archived).toBe(true)
    expect(archived.project.version).toBe(3)

    expect(() => api.execute('proj-update-arch', {
      kind: 'project-update',
      id: 'proj-new',
      input: { expectedVersion: 3, name: 'Nope' },
      reason: 'blocked',
    })).toThrow(ManagementCommandError)

    const history = api.history('project', 'proj-new')
    expect(history.map(item => item.action)).toEqual([
      'project-archive',
      'project-update',
      'project-create',
    ])
  })

  it('checks replay before Git preflight when mutable path disappears', () => {
    const store = openStore()
    const api = commands(store)
    const repositoryPath = initGitRepo(join(root, 'ephemeral-repo'))
    const worktreeRoot = join(root, 'ephemeral-wt')
    const input = {
      id: 'proj-ephemeral',
      name: 'Ephemeral',
      ownerId: 'biz-owner',
      repositoryPath,
      worktreeRoot,
      allowedTaskTypes: ['docs'],
    }
    const first = api.execute('ephemeral-key', {
      kind: 'project-create',
      input,
      reason: 'create then remove path',
    })
    expect(first.replayed).toBe(false)
    rmSync(repositoryPath, { recursive: true, force: true })
    const replay = api.execute('ephemeral-key', {
      kind: 'project-create',
      input,
      reason: 'create then remove path',
    })
    expect(replay.replayed).toBe(true)
    expect(replay.kind).toBe('project')
    if (replay.kind !== 'project') throw new Error('expected project')
    expect(replay.project.id).toBe('proj-ephemeral')
  })
})

describe('transaction rollback and operational errors', () => {
  it('rolls back resource, audit, and receipt together', () => {
    const store = openStore()
    seedProject(store)
    const api = commands(store)
    expect(() => store.atomic(() => {
      api.execute('roll-emp', {
        kind: 'employee-create',
        input: employeeCreateInput({ id: 'emp-roll' }),
        reason: 'will roll back',
      })
      throw new Error('force-rollback')
    })).toThrow('force-rollback')
    expect(new EmployeeRepository(store.db).get('emp-roll')).toBeUndefined()
    expect(receiptCount(store)).toBe(0)
    expect(auditCount(store)).toBe(0)
  })

  it('maps receipt insert abort to generic operational failure and rolls back', () => {
    const store = openStore()
    seedProject(store)
    const api = commands(store)
    store.db.exec(`
      CREATE TRIGGER abort_mgmt_receipt
      BEFORE INSERT ON management_command_receipt
      BEGIN
        SELECT RAISE(ABORT, 'forced receipt insert failure with secret-token');
      END;
    `)
    let caught: unknown
    try {
      api.execute('abort-1', {
        kind: 'employee-create',
        input: employeeCreateInput({ id: 'emp-abort' }),
        reason: 'abort receipt',
      })
      expect.fail('expected operational failure')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(ManagementCommandError)
    expect(String((caught as Error).message)).not.toMatch(/forced receipt|secret-token|sqlite|SQL/i)
    expect(new EmployeeRepository(store.db).get('emp-abort')).toBeUndefined()
    expect(receiptCount(store)).toBe(0)
    expect(auditCount(store)).toBe(0)
  })

  it('rejects forged prepared project creates and in-transaction path validation', () => {
    const store = openStore()
    const projects = new ProjectRepository(store.db)
    expect(() => projects.commitCreate({ __brand: 'PreparedProjectCreate' })).toThrow(/Invalid prepared/)
    expect(() => store.atomic(() => {
      projects.prepareCreate({
        id: 'inside',
        workspaceId: 'local',
        name: 'Inside',
        ownerId: 'biz',
        repositoryPath: initGitRepo(join(root, 'inside-repo')),
        worktreeRoot: join(root, 'inside-wt'),
        allowedTaskTypes: ['docs'],
      })
    })).toThrow(/inside a transaction/)
  })
})

describe('receipt replay integrity', () => {
  it('replays original immutable snapshot after later edits', () => {
    const store = openStore()
    seedProject(store)
    const api = commands(store)
    const created = api.execute('emp-create-snap', {
      kind: 'employee-create',
      input: employeeCreateInput({ id: 'emp-snap', name: 'Original' }),
      reason: 'create original',
    })
    expect(created.kind).toBe('employee')
    if (created.kind !== 'employee') throw new Error('expected employee')
    expect(created.employee.version).toBe(1)
    expect(created.employee.name).toBe('Original')

    const updated = api.execute('emp-update-snap', {
      kind: 'employee-update',
      id: 'emp-snap',
      input: { expectedVersion: 1, name: 'Later Name', role: 'lead' },
      reason: 'edit after create',
    })
    expect(updated.kind).toBe('employee')
    if (updated.kind !== 'employee') throw new Error('expected employee')
    expect(updated.employee.version).toBe(2)
    expect(updated.employee.name).toBe('Later Name')
    expect(new EmployeeRepository(store.db).get('emp-snap')?.name).toBe('Later Name')

    const replay = api.execute('emp-create-snap', {
      kind: 'employee-create',
      input: employeeCreateInput({ id: 'emp-snap', name: 'Original' }),
      reason: 'create original',
    })
    expect(replay.replayed).toBe(true)
    expect(replay.kind).toBe('employee')
    if (replay.kind !== 'employee') throw new Error('expected employee')
    expect(replay.employee).toEqual(created.employee)
    expect(replay.employee.version).toBe(1)
    expect(replay.employee.name).toBe('Original')
    expect(auditCount(store)).toBe(2)
  })

  it('rejects corrupt, foreign, wrong-kind, and malformed-array receipts without writes or leakage', () => {
    const store = openStore()
    seedProject(store)
    const api = commands(store)
    const createInput = employeeCreateInput({ id: 'emp-good' })
    const created = api.execute('good-key', {
      kind: 'employee-create',
      input: createInput,
      reason: 'baseline',
    })
    expect(created.kind).toBe('employee')
    if (created.kind !== 'employee') throw new Error('expected employee')

    const hash = (store.db.prepare(
      `SELECT command_hash AS h FROM management_command_receipt
       WHERE workspace_id = 'local' AND owner_id = 'owner-1' AND command_key = 'good-key'`,
    ).get() as { h: string }).h

    const employeesBefore = new EmployeeRepository(store.db).list('local').length
    const auditsBefore = auditCount(store)

    const assertCorruptNoWrite = (key: string, resultJson: string, leakPattern: RegExp) => {
      store.db.prepare(
        `INSERT INTO management_command_receipt
          (workspace_id, owner_id, command_key, command_hash, result_json, created_at)
         VALUES ('local', 'owner-1', ?, ?, ?, ?)`,
      ).run(key, hash, resultJson, new Date().toISOString())
      const receiptsBefore = receiptCount(store)
      let caught: unknown
      try {
        api.execute(key, {
          kind: 'employee-create',
          input: createInput,
          reason: 'baseline',
        })
        expect.fail(`expected corrupt rejection for ${key}`)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(Error)
      expect(caught).not.toBeInstanceOf(ManagementCommandError)
      expect(String((caught as Error).message)).toBe('Corrupt management receipt')
      expect(String((caught as Error).message)).not.toMatch(leakPattern)
      expect(new EmployeeRepository(store.db).list('local')).toHaveLength(employeesBefore)
      expect(auditCount(store)).toBe(auditsBefore)
      expect(receiptCount(store)).toBe(receiptsBefore)
    }

    assertCorruptNoWrite('scalar', '42', /42|token|secret|Bearer/i)

    const replacedBody = structuredClone(created)
    delete (replacedBody as { replayed?: boolean }).replayed
    replacedBody.employee = {
      ...replacedBody.employee,
      name: 'Replaced Body',
      role: 'attacker',
      responsibilities: ['exfil'],
    }
    assertCorruptNoWrite('replaced', JSON.stringify(replacedBody), /Replaced Body|attacker|exfil/i)

    const wrongId = structuredClone(created)
    delete (wrongId as { replayed?: boolean }).replayed
    wrongId.employee = { ...wrongId.employee, id: 'emp-other' }
    assertCorruptNoWrite('wrong-id', JSON.stringify(wrongId), /emp-other/i)

    const wrongKind = {
      kind: 'project',
      project: {
        id: 'emp-good',
        workspaceId: 'local',
        name: 'Fake',
        ownerId: 'biz',
        repositoryPath: '/tmp/repo',
        worktreeRoot: '/tmp/wt',
        allowedTaskTypes: ['docs'],
        archived: false,
        version: 1,
      },
    }
    assertCorruptNoWrite('wrong-kind', JSON.stringify(wrongKind), /Fake|\/tmp\/repo/i)

    const foreignWorkspace = structuredClone(created)
    delete (foreignWorkspace as { replayed?: boolean }).replayed
    foreignWorkspace.employee = { ...foreignWorkspace.employee, workspaceId: 'other-ws' }
    assertCorruptNoWrite('foreign-ws', JSON.stringify(foreignWorkspace), /other-ws/i)

    const malformedArrays = structuredClone(created)
    delete (malformedArrays as { replayed?: boolean }).replayed
    malformedArrays.employee = {
      ...malformedArrays.employee,
      projectIds: 'proj-1' as unknown as string[],
      capabilities: [{ name: 'typescript' }] as unknown as string[],
    }
    assertCorruptNoWrite('bad-arrays', JSON.stringify(malformedArrays), /typescript|proj-1/i)

    // Mutate the legitimate receipt body in place: hash still matches, body must not leak through.
    const altered = structuredClone(created)
    delete (altered as { replayed?: boolean }).replayed
    altered.employee = { ...altered.employee, name: 'Corrupted In Place', enabled: true }
    store.db.prepare(
      `UPDATE management_command_receipt SET result_json = ?
       WHERE workspace_id = 'local' AND owner_id = 'owner-1' AND command_key = 'good-key'`,
    ).run(JSON.stringify(altered))
    let inPlaceCaught: unknown
    try {
      api.execute('good-key', {
        kind: 'employee-create',
        input: createInput,
        reason: 'baseline',
      })
      expect.fail('expected in-place corruption rejection')
    } catch (error) {
      inPlaceCaught = error
    }
    expect(inPlaceCaught).toBeInstanceOf(Error)
    expect(inPlaceCaught).not.toBeInstanceOf(ManagementCommandError)
    expect(String((inPlaceCaught as Error).message)).toBe('Corrupt management receipt')
    expect(String((inPlaceCaught as Error).message)).not.toMatch(/Corrupted In Place/i)
    expect(new EmployeeRepository(store.db).get('emp-good')?.name).toBe('Alpha')
    expect(new EmployeeRepository(store.db).get('emp-good')?.enabled).toBe(false)
    expect(auditCount(store)).toBe(auditsBefore)
  })

  it('never echoes secret-shaped unknown field names (including 64-hex identifiers)', () => {
    const store = openStore()
    seedProject(store)
    const api = commands(store)

    for (let index = 0; index < 32; index += 1) {
      let field = randomBytes(32).toString('hex')
      // Hex tokens that start with a-f match former SAFE_FIELD_NAME and must stay silent.
      if (!/^[a-f]/i.test(field)) field = `a${field.slice(1)}`
      try {
        api.execute(`secret-field-${index}`, {
          kind: 'employee-create',
          input: { ...employeeCreateInput({ id: `emp-sec-${index}` }), [field]: 'x' } as never,
          reason: 'secret field probe',
        })
        expect.fail('expected INVALID_COMMAND')
      } catch (error) {
        expect(error).toBeInstanceOf(ManagementCommandError)
        expect((error as ManagementCommandError).code).toBe('INVALID_COMMAND')
        const message = String((error as Error).message)
        expect(message).toBe('Unknown employee create field')
        expect(message).not.toContain(field)
      }
    }

    const credentialField = `api_token_${randomBytes(8).toString('hex')}`
    try {
      api.execute('secret-cred-field', {
        kind: 'employee-create',
        input: { ...employeeCreateInput({ id: 'emp-sec-cred' }), [credentialField]: 'sk-live-secret' } as never,
        reason: 'credential shaped',
      })
      expect.fail('expected INVALID_COMMAND')
    } catch (error) {
      const message = String((error as Error).message)
      expect(message).toBe('Unknown employee create field')
      expect(message).not.toContain(credentialField)
      expect(message).not.toMatch(/sk-live-secret/i)
    }

    expect(receiptCount(store)).toBe(0)
    expect(auditCount(store)).toBe(0)
  })
})

describe('explicit management schema composition', () => {
  it('installs receipts and audit schema atomically through the application initializer', () => {
    const store = new LocalStore(':memory:')
    opened.push(store)
    initializeApplicationSchema(store)
    expect(store.get(MANAGEMENT_SCHEMA_KEY)).toBe(1)
    const commands = new LocalManagementCommands({store, ownerId:'owner-1', runtimeIds:['claude-local']})
    expect(() => commands.history('employee','missing')).toThrow('Resource not found')
    expect(store.db.prepare('SELECT count(*) AS n FROM management_command_receipt').get()?.n).toBe(0)
    expect(store.db.prepare('SELECT count(*) AS n FROM management_audit').get()?.n).toBe(0)
  })
})
