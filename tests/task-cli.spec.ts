import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  runTaskCommand,
  taskCliOwnerIdForTests,
  withLocalStoreForTests,
} from '../src/cli/task-commands.ts'
import { LocalTaskService } from '../src/application/tasks.ts'
import type { Rule } from '../src/assessor/rules.ts'
import { loadSettings } from '../src/config/settings.ts'
import { ProjectRepository } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LocalStore } from '../src/storage/store.ts'
import { EmployeeRepository } from '../src/workforce/employees.ts'
import { ExecutionRepository } from '../src/execution/repository.ts'
import { RunnerClient } from '../src/runner/client.ts'
import { acquireControllerLease } from '../src/application/controller-lease.ts'

const FIXTURE = resolve('tests/fixtures/claude-task-cli.mjs')

let root: string
const opened: LocalStore[] = []
const dataDirs: string[] = []

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'task-cli-')))
})

afterEach(async () => {
  // run-once intentionally detaches. Stop/observe owned fresh fixtures before deleting their files.
  for (const dataDir of dataDirs.splice(0)) {
    const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
    let ids: string[]
    try { ids = new ExecutionRepository(store.db).list().map(item => item.executionId) } finally { store.close() }
    const runner = new RunnerClient({ root: join(dataDir, 'runners') })
    for (const id of ids) {
      const terminal = new Set(['SUCCEEDED','FAILED','TIMED_OUT','CANCELLED'])
      let state = await runner.status(id)
      if (!terminal.has(state.state)) {
        await runner.stop(id, 'Owned Task CLI fixture cleanup')
        const deadline = Date.now() + 8_000
        while (!terminal.has(state.state) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 25))
          state = await runner.status(id)
        }
      }
      if (!terminal.has(state.state)) throw new Error('Owned Task CLI fixture has no confirmed terminal proof; preserving evidence')
    }
  }
  for (const store of opened.splice(0)) {
    try { store.close() } catch { /* ignore */ }
  }
  rmSync(root, { recursive: true, force: true })
}, 15_000)

async function run(...argv: string[]) {
  let stdout = ''
  let stderr = ''
  const code = await runTaskCommand(argv, {
    stdout: { write: value => { stdout += value; return true } },
    stderr: { write: value => { stderr += value; return true } },
  })
  const json = stdout.startsWith('{') || stdout.startsWith('[')
    ? JSON.parse(stdout) as unknown
    : undefined
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

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: gitEnv(), stdio: 'ignore', timeout: 15_000 })
}

function initGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'task-cli@example.com'])
  git(dir, ['config', 'user.name', 'Task CLI'])
  writeFileSync(join(dir, 'README'), 'fixture\n', { mode: 0o600 })
  git(dir, ['add', 'README'])
  git(dir, ['commit', '-m', 'init'])
  return realpathSync(dir)
}

function initDataDir(name = 'data'): string {
  const dataDir = join(root, name)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  chmodSync(dataDir, 0o700)
  dataDirs.push(dataDir)
  const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
  opened.push(store)
  initializeApplicationSchema(store)
  store.close()
  opened.pop()
  return dataDir
}

function ownerId(): string {
  return taskCliOwnerIdForTests()
}

function docsRules(): Rule[] {
  return [{
    id: 'documentation',
    enabled: true,
    taskTypes: ['documentation'],
    priority: 10,
    approvalRequired: true,
    reviewRequired: true,
    retryLimit: 2,
  }]
}

async function configure(dataDir: string, command = resolve('/usr/bin/true')) {
  return run('configure', '--data-dir', dataDir, '--claude-command', command)
}

function seedProject(dataDir: string, overrides: { id?: string; workspaceId?: string; ownerId?: string } = {}) {
  const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
  opened.push(store)
  const project = new ProjectRepository(store.db).create({
    id: overrides.id ?? 'proj-1',
    workspaceId: overrides.workspaceId ?? 'local',
    name: 'Docs',
    ownerId: overrides.ownerId ?? ownerId(),
    repositoryPath: initGitRepo(join(root, `repo-${Math.random().toString(16).slice(2)}`)),
    worktreeRoot: join(root, `worktrees-${Math.random().toString(16).slice(2)}`),
    allowedTaskTypes: ['documentation'],
  })
  store.close()
  opened.pop()
  return project
}

function seedEmployee(dataDir: string, runtimeId: string) {
  const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
  opened.push(store)
  const employees = new EmployeeRepository(store.db)
  const created = employees.create({
    id: 'emp-1',
    workspaceId: 'local',
    name: 'Docs Worker',
    role: 'writer',
    responsibilities: ['documentation'],
    capabilities: ['documentation'],
    runtimeId,
    projectIds: ['proj-1'],
    maxConcurrency: 1,
    timeoutMs: 5_000,
  })
  employees.setEnabled(created.id, { expectedVersion: created.version, enabled: true })
  store.close()
  opened.pop()
}

function writeCreateFile(name: string, body: Record<string, unknown>): string {
  const path = join(root, name)
  writeFileSync(path, `${JSON.stringify(body)}\n`, { mode: 0o600 })
  return path
}

const VALID_CREATE = {
  project: 'proj-1',
  issue: 'issue-1',
  title: 'Fix docs',
  description: 'Tighten wording',
  taskType: 'documentation',
} as const

describe('runTaskCommand recognition', () => {
  it('returns undefined for unrecognized commands so the legacy CLI can handle them', async () => {
    expect(await runTaskCommand(['status', '--data-dir', join(root, 'x')])).toBeUndefined()
    expect(await runTaskCommand(['--help'])).toBeUndefined()
    expect(await runTaskCommand([])).toBeUndefined()
  })
})

describe('configure', () => {
  it('creates settings exclusively without overwrite or model invocation', async () => {
    const dataDir = initDataDir()
    const command = resolve('/bin/echo')
    const first = await configure(dataDir, command)
    expect(first.code).toBe(0)
    expect(first.stderr).toBe('')
    expect(first.json).toMatchObject({
      schemaVersion: 1,
      workspaceId: 'local',
      ownerId: ownerId(),
      runtime: { id: 'claude-local', driver: 'claude-code', command, graceMs: expect.any(Number) },
    })
    const settingsFile = join(dataDir, 'settings.json')
    expect(statSync(settingsFile).mode & 0o777).toBe(0o600)
    expect(loadSettings(settingsFile).runtime.command).toBe(command)
    expect(loadSettings(settingsFile).runtime.graceMs).toBeGreaterThan(0)

    const before = readFileSync(settingsFile)
    const second = await configure(dataDir, command)
    expect(second.code).toBe(1)
    expect(second.stderr).toMatch(/already exists/i)
    expect(readFileSync(settingsFile)).toEqual(before)
  })

  it('does not create a database when configure is pointed at a missing data dir', async () => {
    const missing = join(root, 'missing-configure')
    const result = await configure(missing)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/run init first/)
    expect(existsSync(missing)).toBe(false)
  })
})

describe('task create and approve', () => {
  it('creates then approves into QUEUED using settings owner and rules', async () => {
    const dataDir = initDataDir()
    await configure(dataDir)
    seedProject(dataDir)
    const file = writeCreateFile('task.json', { ...VALID_CREATE })
    const created = await run('task-create', '--data-dir', dataDir, '--file', file)
    expect(created.code).toBe(0)
    expect(created.json).toMatchObject({
      title: 'Fix docs',
      lifecycle: { status: 'WAITING_APPROVAL', taskType: 'documentation' },
      mandate: { actor: { id: ownerId() } },
    })
    const ticketId = (created.json as { id: string }).id
    const approved = await run('task-approve', ticketId, '--data-dir', dataDir, '--reason', 'Owner approved')
    expect(approved.code).toBe(0)
    expect(approved.json).toMatchObject({ lifecycle: { status: 'QUEUED' } })
  })
})

describe('withLocalStore async lifetime', () => {
  it('keeps the store open until an awaited async operation settles', async () => {
    const dataDir = initDataDir()
    await configure(dataDir)
    let queriedAfterAwait = false
    await withLocalStoreForTests(dataDir, async (store) => {
      await new Promise<void>(resolvePromise => setTimeout(resolvePromise, 5))
      const row = store.db.prepare("SELECT value FROM kv WHERE key = 'schema'").get()
      expect(row).toBeTruthy()
      queriedAfterAwait = true
      return 'ok'
    })
    expect(queriedAfterAwait).toBe(true)
  })
})

describe('strict parsing and JSON', () => {
  it('rejects duplicate, unknown, and missing options without creating storage', async () => {
    const missing = join(root, 'no-db')
    const unknown = await run('task-create', '--data-dir', missing, '--file', join(root, 'x.json'), '--owner', 'evil')
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toMatch(/Unknown option/)
    expect(existsSync(missing)).toBe(false)

    const dup = await run('configure', '--data-dir', missing, '--claude-command', '/bin/echo', '--claude-command', '/bin/echo')
    expect(dup.code).toBe(1)
    expect(dup.stderr).toMatch(/only be provided once/)

    const noFile = await run('task-create', '--data-dir', missing)
    expect(noFile.code).toBe(1)
    expect(noFile.stderr).toMatch(/Missing required option --file/)
  })

  it('rejects invalid create JSON fields without echoing untrusted key material', async () => {
    const dataDir = initDataDir()
    await configure(dataDir)
    seedProject(dataDir)
    const secret = 'sk-ant-api03-SUPERSECRETVALUE99'
    const bad = writeCreateFile('bad.json', {
      ...VALID_CREATE,
      [secret]: 'spoof',
      api_key: secret,
    })
    const result = await run('task-create', '--data-dir', dataDir, '--file', bad)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/unknown field/i)
    expect(result.stderr).not.toContain(secret)
    expect(result.stderr).not.toContain('api_key')
  })

  it('rejects non-string create fields without String() coercion', async () => {
    const dataDir = initDataDir()
    await configure(dataDir)
    seedProject(dataDir)

    const cases: Array<{ field: keyof typeof VALID_CREATE; value: unknown }> = [
      { field: 'project', value: null },
      { field: 'project', value: 12 },
      { field: 'project', value: { id: 'proj-1' } },
      { field: 'issue', value: null },
      { field: 'issue', value: 7 },
      { field: 'issue', value: ['issue-1'] },
      { field: 'title', value: null },
      { field: 'title', value: 1 },
      { field: 'title', value: { text: 'x' } },
      { field: 'description', value: null },
      { field: 'description', value: 0 },
      { field: 'description', value: { body: 'x' } },
      { field: 'taskType', value: null },
      { field: 'taskType', value: 3 },
      { field: 'taskType', value: { type: 'documentation' } },
    ]

    for (const { field, value } of cases) {
      const body = { ...VALID_CREATE, [field]: value }
      const file = writeCreateFile(`bad-${field}-${typeof value}.json`, body)
      const result = await run('task-create', '--data-dir', dataDir, '--file', file)
      expect(result.code, `${field}=${JSON.stringify(value)}`).toBe(1)
      expect(result.stderr, `${field}=${JSON.stringify(value)}`).toMatch(new RegExp(`Invalid ${field}`, 'i'))
    }
  })

  it('rejects create JSON and data-dir paths that use untrusted ancestor symlinks', async () => {
    const dataDir = initDataDir()
    await configure(dataDir)
    seedProject(dataDir)

    const realFile = writeCreateFile('real-create.json', { ...VALID_CREATE })
    const linkDir = join(root, 'link-dir')
    mkdirSync(join(root, 'target-dir'), { mode: 0o700 })
    symlinkSync(join(root, 'target-dir'), linkDir)
    const linkedFile = join(linkDir, 'create.json')
    writeFileSync(join(root, 'target-dir', 'create.json'), readFileSync(realFile), { mode: 0o600 })

    const linkedCreate = await run('task-create', '--data-dir', dataDir, '--file', linkedFile)
    expect(linkedCreate.code).toBe(1)
    expect(linkedCreate.stderr).toMatch(/symbolic link/i)

    const linkedData = join(root, 'data-link')
    symlinkSync(dataDir, linkedData)
    const viaLink = await run('executions', '--data-dir', linkedData)
    expect(viaLink.code).toBe(1)
    expect(viaLink.stderr).toMatch(/symbolic link|real directory/i)
  })
})

describe('verification waive vs empty checks', () => {
  it('rejects empty checks-file arrays instead of silently waiving', async () => {
    const dataDir = initDataDir()
    await configure(dataDir)
    seedProject(dataDir)
    const file = writeCreateFile('verify-task.json', {
      ...VALID_CREATE,
      issue: 'issue-verify',
    })
    const created = await run('task-create', '--data-dir', dataDir, '--file', file)
    const ticketId = (created.json as { id: string }).id
    await run('task-approve', ticketId, '--data-dir', dataDir, '--reason', 'queue it')

    const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
    opened.push(store)
    const tasks = new LocalTaskService({
      store,
      ownerId: ownerId(),
      rules: docsRules(),
      workspaceId: 'local',
    })
    const assigned = tasks.engine.assignTask(ticketId, 'claude-local', 'claude-code', join(root, 'wt', ticketId))
    const assignmentId = assigned.assignments.at(-1)!.id
    tasks.engine.assignmentStarted(ticketId, assignmentId)
    tasks.engine.recordExecution(ticketId, {
      assignmentId,
      executionId: 'exec-empty-checks',
      artifactRevision: 'rev-empty',
      exitCode: 0,
      terminal: 'success',
      summary: 'changed docs',
    })
    store.close()
    opened.pop()

    const emptyChecks = join(root, 'empty-checks.json')
    writeFileSync(emptyChecks, '[]\n', { mode: 0o600 })
    const empty = await run(
      'task-verify', ticketId,
      '--data-dir', dataDir,
      '--reason', 'looks fine',
      '--checks-file', emptyChecks,
    )
    expect(empty.code).toBe(1)
    expect(empty.stderr).toMatch(/at least one check|--waive/i)

    const both = await run(
      'task-verify', ticketId,
      '--data-dir', dataDir,
      '--reason', 'waive docs',
      '--checks-file', emptyChecks,
      '--waive',
    )
    expect(both.code).toBe(1)
    expect(both.stderr).toMatch(/exactly one of --checks-file or --waive/i)
  })
})

describe('no implicit database creation', () => {
  it('fails task and executions commands without initializing storage', async () => {
    const missing = join(root, 'never-init')
    const file = writeCreateFile('create.json', { ...VALID_CREATE })
    for (const argv of [
      ['task-create', '--data-dir', missing, '--file', file],
      ['task-approve', 'task-1', '--data-dir', missing, '--reason', 'x'],
      ['executions', '--data-dir', missing],
      ['run-once', '--data-dir', missing],
    ] as const) {
      const result = await run(...argv)
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/run init first|not initialized/i)
    }
    expect(existsSync(missing)).toBe(false)
  })
})

describe('verification and review gates', () => {
  it('rejects missing or stale verification and review evidence', async () => {
    const dataDir = initDataDir()
    await configure(dataDir)
    seedProject(dataDir)
    const file = writeCreateFile('review-task.json', {
      project: 'proj-1',
      issue: 'issue-2',
      title: 'Review me',
      description: 'Needs evidence',
      taskType: 'documentation',
    })
    const created = await run('task-create', '--data-dir', dataDir, '--file', file)
    const ticketId = (created.json as { id: string }).id
    await run('task-approve', ticketId, '--data-dir', dataDir, '--reason', 'queue it')

    const missingVerify = await run('task-verify', ticketId, '--data-dir', dataDir, '--reason', 'waive docs', '--waive')
    expect(missingVerify.code).toBe(1)
    expect(missingVerify.stderr).toMatch(/no current execution result/i)

    const missingReview = await run(
      'task-review', ticketId,
      '--data-dir', dataDir,
      '--execution-id', 'exec-missing',
      '--artifact-revision', 'deadbeef',
      '--decision', 'approved',
      '--reason', 'looks fine',
    )
    expect(missingReview.code).toBe(1)
    expect(missingReview.stderr.length).toBeGreaterThan(0)

    const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
    opened.push(store)
    const tasks = new LocalTaskService({
      store,
      ownerId: ownerId(),
      rules: docsRules(),
      workspaceId: 'local',
    })
    const assigned = tasks.engine.assignTask(ticketId, 'claude-local', 'claude-code', join(root, 'wt', ticketId))
    const assignmentId = assigned.assignments.at(-1)!.id
    tasks.engine.assignmentStarted(ticketId, assignmentId)
    tasks.engine.recordExecution(ticketId, {
      assignmentId,
      executionId: 'exec-1',
      artifactRevision: 'rev-real',
      exitCode: 0,
      terminal: 'success',
      summary: 'changed docs',
    })
    store.close()
    opened.pop()

    const staleReview = await run(
      'task-review', ticketId,
      '--data-dir', dataDir,
      '--execution-id', 'exec-1',
      '--artifact-revision', 'rev-stale',
      '--decision', 'approved',
      '--reason', 'stale hash',
    )
    expect(staleReview.code).toBe(1)
    expect(staleReview.stderr).toMatch(/does not match|Verification has not passed|current execution/i)

    const reviewWithoutVerify = await run(
      'task-review', ticketId,
      '--data-dir', dataDir,
      '--execution-id', 'exec-1',
      '--artifact-revision', 'rev-real',
      '--decision', 'approved',
      '--reason', 'skip verify',
    )
    expect(reviewWithoutVerify.code).toBe(1)
    expect(reviewWithoutVerify.stderr).toMatch(/Verification has not passed|waived/i)
  })
})

describe('cross-workspace denial', () => {
  it('rejects actions on tasks belonging to another workspace', async () => {
    const dataDir = initDataDir()
    await configure(dataDir)
    seedProject(dataDir, { id: 'proj-foreign', workspaceId: 'other' })
    const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
    opened.push(store)
    const foreign = new LocalTaskService({
      store,
      ownerId: ownerId(),
      rules: docsRules(),
      workspaceId: 'other',
    })
    const ticket = foreign.create({
      issueId: 'foreign-1',
      projectId: 'proj-foreign',
      title: 'Foreign',
      description: 'Other workspace',
      taskType: 'documentation',
    })
    store.close()
    opened.pop()

    const approved = await run('task-approve', ticket.id, '--data-dir', dataDir, '--reason', 'nope')
    expect(approved.code).toBe(1)
    expect(approved.stderr).toMatch(/Cross-workspace|Unknown ticket|different owner/i)
  })
})

describe('executions readonly', () => {
  it('lists executions without mutating schema or starting Runtime', async () => {
    const dataDir = initDataDir()
    const dbPath = join(dataDir, 'workforce.sqlite')
    const before = readFileSync(dbPath)
    const listed = await run('executions', '--data-dir', dataDir)
    expect(listed.code).toBe(0)
    expect(listed.json).toEqual([])
    expect(readFileSync(dbPath)).toEqual(before)
  })
})

describe('run-once fixture', () => {
  it('refuses a tick while the foreground controller lease is owned', async () => {
    const dataDir = initDataDir('owned-controller')
    await configure(dataDir)
    const lease = acquireControllerLease({dataDir})
    try {
      const once = await run('run-once','--data-dir',dataDir)
      expect(once.code).toBe(1)
      expect(once.stdout).toBe('')
      const store = new LocalStore(join(dataDir,'workforce.sqlite'))
      try {expect(new ExecutionRepository(store.db).list()).toEqual([])} finally {store.close()}
    } finally {lease.release()}
  })
  it('ticks once with the local mock Claude fixture and forwards runtime graceMs', async () => {
    expect(existsSync(FIXTURE)).toBe(true)
    chmodSync(FIXTURE, 0o755)
    const dataDir = initDataDir('run-once-data')
    const launcher = join(root, 'claude-fixture')
    writeFileSync(
      launcher,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} "$@"\n`,
      { mode: 0o755 },
    )
    chmodSync(launcher, 0o755)
    const configured = await configure(dataDir, launcher)
    expect(configured.code).toBe(0)
    const settings = loadSettings(join(dataDir, 'settings.json'))
    expect(settings.runtime.graceMs).toBeGreaterThan(0)
    const runtimeId = settings.runtime.id
    seedProject(dataDir)
    seedEmployee(dataDir, runtimeId)
    const file = writeCreateFile('run-once-task.json', {
      project: 'proj-1',
      issue: 'issue-run',
      title: 'Run fixture',
      description: 'Exercise orchestrator tick',
      taskType: 'documentation',
    })
    const created = await run('task-create', '--data-dir', dataDir, '--file', file)
    expect(created.code).toBe(0)
    const ticketId = (created.json as { id: string }).id
    const approved = await run('task-approve', ticketId, '--data-dir', dataDir, '--reason', 'run once')
    expect(approved.code).toBe(0)

    const once = await run('run-once', '--data-dir', dataDir)
    expect(once.code).toBe(0)
    expect(once.json).toMatchObject({
      assigned: expect.any(Number),
      dispatched: expect.any(Number),
      review: expect.any(Number),
      failed: expect.any(Number),
      unknown: expect.any(Number),
    })
    expect((once.json as { assigned: number }).assigned).toBeGreaterThanOrEqual(1)
  })
})
