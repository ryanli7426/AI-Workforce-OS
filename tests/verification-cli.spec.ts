/**
 * Durable verification CLI. Owns only this file and src/cli/verification-commands.ts.
 * Parent routes runVerificationCommand; programmatic invocation is sufficient here.
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  runVerificationCommand,
  verificationCliOwnerIdForTests,
} from '../src/cli/verification-commands.ts'
import { LocalTaskService } from '../src/application/tasks.ts'
import type { Rule } from '../src/assessor/rules.ts'
import { createSettings, defaultSettings } from '../src/config/settings.ts'
import { ProjectRepository } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { VERIFICATION_SCHEMA_KEY } from '../src/storage/verification-jobs.ts'
import { LocalStore } from '../src/storage/store.ts'

let root: string
const opened: LocalStore[] = []

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'verification-cli-')))
  chmodSync(root, 0o700)
})

afterEach(() => {
  for (const store of opened.splice(0)) {
    try { store.close() } catch { /* ignore */ }
  }
  rmSync(root, { recursive: true, force: true })
})

function run(...argv: string[]) {
  let stdout = ''
  let stderr = ''
  const code = runVerificationCommand(argv, {
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
  git(dir, ['config', 'user.email', 'verification-cli@example.com'])
  git(dir, ['config', 'user.name', 'Verification CLI'])
  writeFileSync(join(dir, 'README'), 'fixture\n', { mode: 0o600 })
  git(dir, ['add', 'README'])
  git(dir, ['commit', '-m', 'init'])
  return realpathSync(dir)
}

function ownerId(): string {
  return verificationCliOwnerIdForTests()
}

function docsRules(): Rule[] {
  return [{
    id: 'documentation',
    enabled: true,
    taskTypes: ['documentation'],
    priority: 10,
    approvalRequired: false,
    reviewRequired: true,
    retryLimit: 2,
  }]
}

function initDataDir(name = 'data', options: { configure?: boolean } = {}): string {
  const dataDir = join(root, name)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  chmodSync(dataDir, 0o700)
  const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
  opened.push(store)
  initializeApplicationSchema(store)
  store.close()
  opened.pop()
  if (options.configure !== false) {
    const defaults = defaultSettings({
      ownerId: ownerId(),
      claudeCommand: resolve('/usr/bin/true'),
    })
    createSettings(join(dataDir, 'settings.json'), {
      schemaVersion: defaults.schemaVersion,
      workspaceId: defaults.workspaceId,
      ownerId: defaults.ownerId,
      runtime: {
        ...defaults.runtime,
        id: 'claude-local',
        driver: 'claude-code',
        command: defaults.runtime.command,
      },
      scheduler: { ...defaults.scheduler },
      rules: docsRules().map(rule => ({ ...rule, taskTypes: [...rule.taskTypes] })),
    })
  }
  return realpathSync(dataDir)
}

function samplePlan() {
  return {
    id: 'local-checks',
    revision: 'revision-1',
    checks: [{
      id: 'node-version',
      command: process.execPath,
      args: ['--version'],
      timeoutMs: 5_000,
    }],
  }
}

function writePrivatePlansFile(name: string, value: unknown): string {
  const path = join(root, name)
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

function seedProject(dataDir: string): void {
  const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
  opened.push(store)
  new ProjectRepository(store.db).create({
    id: 'project-1',
    workspaceId: 'local',
    name: 'Project 1',
    ownerId: 'business-owner',
    repositoryPath: initGitRepo(join(root, 'repo-project-1')),
    worktreeRoot: join(root, 'worktrees-project-1'),
    allowedTaskTypes: ['documentation'],
  })
  store.close()
  opened.pop()
}

interface ReviewFixture {
  ticketId: string
  executionId: string
  artifactRevision: string
  expectedVersion: number
}

function seedReviewTicket(dataDir: string): ReviewFixture {
  seedProject(dataDir)
  const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
  opened.push(store)
  const tasks = new LocalTaskService({
    store,
    ownerId: ownerId(),
    workspaceId: 'local',
    rules: docsRules(),
  })
  const created = tasks.create({
    issueId: 'issue-1',
    projectId: 'project-1',
    title: 'Verify durable CLI enqueue',
    description: 'Fixture ticket for verification CLI',
    taskType: 'documentation',
  })
  const assigned = tasks.engine.assignTask(
    created.id,
    'claude-local',
    'claude-code',
    join(root, `work-${created.id}`),
  )
  const assignmentId = assigned.assignments.at(-1)!.id
  tasks.engine.assignmentStarted(created.id, assignmentId)
  const executionId = `execution-${assignmentId}`
  const artifactRevision = 'ab'.repeat(32)
  const ticket = tasks.engine.recordExecution(created.id, {
    assignmentId,
    executionId,
    artifactRevision,
    exitCode: 0,
    terminal: 'success',
    summary: 'Fixture execution completed',
  })
  expect(ticket.lifecycle?.status).toBe('REVIEW')
  const expectedVersion = ticket.lifecycle!.version
  store.close()
  opened.pop()
  return { ticketId: created.id, executionId, artifactRevision, expectedVersion }
}

/** Domain/config files only; SQLite may create -wal/-shm sidecars even for readonly opens. */
function listDomainFiles(dataDir: string): string[] {
  return readdirSync(dataDir)
    .filter(name => !name.startsWith('workforce.sqlite-'))
    .sort()
}

describe('runVerificationCommand routing', () => {
  it('returns undefined for unrecognized commands so the parent can fall through', () => {
    expect(runVerificationCommand(['tickets'])).toBeUndefined()
    expect(runVerificationCommand([])).toBeUndefined()
    expect(runVerificationCommand(['api-init'])).toBeUndefined()
  })
})

describe('verification plans registry', () => {
  it('registers trusted local plans exclusively and lists compact metadata only', () => {
    const dataDir = initDataDir()
    const file = writePrivatePlansFile('plans.json', { plans: [samplePlan()] })

    const created = run('verification-plans-init', '--data-dir', dataDir, '--file', file)
    expect(created.code).toBe(0)
    expect(created.json).toMatchObject({
      schemaVersion: 1,
      planCount: 1,
      plans: [{
        id: 'local-checks',
        revision: 'revision-1',
        checkIds: ['node-version'],
        timeouts: [5_000],
      }],
    })
    expect(JSON.stringify(created.json)).not.toContain('--version')
    expect(JSON.stringify(created.json)).not.toContain(process.execPath)

    const listed = run('verification-plans', '--data-dir', dataDir)
    expect(listed.code).toBe(0)
    expect(listed.json).toEqual([{
      id: 'local-checks',
      revision: 'revision-1',
      checkIds: ['node-version'],
      timeouts: [5_000],
    }])
    expect(listed.stdout).not.toContain('command')
    expect(listed.stdout).not.toContain('args')
    expect(listed.stdout).not.toContain(process.execPath)

    const again = run('verification-plans-init', '--data-dir', dataDir, '--file', file)
    expect(again.code).toBe(1)
    expect(again.stderr).toMatch(/already exists/i)
    expect(readFileSync(join(dataDir, 'verification-plans.json'), 'utf8')).toContain('local-checks')
  })

  it('rejects bare arrays and keeps the private registry absent', () => {
    const dataDir = initDataDir()
    const before = listDomainFiles(dataDir)
    const file = writePrivatePlansFile('bare.json', [samplePlan()])
    const result = run('verification-plans-init', '--data-dir', dataDir, '--file', file)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/plans array|object/i)
    expect(existsSync(join(dataDir, 'verification-plans.json'))).toBe(false)
    expect(listDomainFiles(dataDir)).toEqual(before)
  })

  it('lists empty plans without creating files', () => {
    const dataDir = initDataDir()
    const before = listDomainFiles(dataDir)
    const listed = run('verification-plans', '--data-dir', dataDir)
    expect(listed.code).toBe(0)
    expect(listed.json).toEqual([])
    expect(listDomainFiles(dataDir)).toEqual(before)
    expect(existsSync(join(dataDir, 'verification-plans.json'))).toBe(false)
  })
})

describe('verification create/status/cancel', () => {
  it('creates, shows scoped status/history, cancels, and replays idempotently', () => {
    const dataDir = initDataDir()
    const file = writePrivatePlansFile('plans.json', { plans: [samplePlan()] })
    expect(run('verification-plans-init', '--data-dir', dataDir, '--file', file).code).toBe(0)
    const fixture = seedReviewTicket(dataDir)

    const created = run(
      'verification-create', fixture.ticketId,
      '--data-dir', dataDir,
      '--plan', 'local-checks',
      '--plan-revision', 'revision-1',
      '--expected-version', String(fixture.expectedVersion),
      '--execution-id', fixture.executionId,
      '--artifact-revision', fixture.artifactRevision,
      '--reason', 'Owner requested durable verification',
      '--key', 'create-key-1',
    )
    expect(created.code).toBe(0)
    expect(created.json).toMatchObject({ replayed: false })
    const verificationId = (created.json as { verificationId: string }).verificationId
    expect(verificationId).toMatch(/^v-/)

    const replay = run(
      'verification-create', fixture.ticketId,
      '--data-dir', dataDir,
      '--plan', 'local-checks',
      '--plan-revision', 'revision-1',
      '--expected-version', String(fixture.expectedVersion),
      '--execution-id', fixture.executionId,
      '--artifact-revision', fixture.artifactRevision,
      '--reason', 'Owner requested durable verification',
      '--key', 'create-key-1',
    )
    expect(replay.code).toBe(0)
    expect(replay.json).toEqual({ verificationId, replayed: true })

    const beforeStatus = listDomainFiles(dataDir)
    const status = run('verification-status', verificationId, '--data-dir', dataDir)
    expect(status.code).toBe(0)
    expect(status.json).toMatchObject({
      job: {
        status: 'QUEUED',
        request: {
          verificationId,
          ticketId: fixture.ticketId,
          executionId: fixture.executionId,
          artifactRevision: fixture.artifactRevision,
        },
      },
    })
    expect(Array.isArray((status.json as { history: unknown[] }).history)).toBe(true)
    expect(listDomainFiles(dataDir)).toEqual(beforeStatus)

    const cancelled = run(
      'verification-cancel', verificationId,
      '--data-dir', dataDir,
      '--expected-version', '1',
      '--reason', 'Owner withdrew verification',
      '--key', 'cancel-key-1',
    )
    expect(cancelled.code).toBe(0)
    expect(cancelled.json).toEqual({ verificationId, replayed: false })

    const cancelReplay = run(
      'verification-cancel', verificationId,
      '--data-dir', dataDir,
      '--expected-version', '1',
      '--reason', 'Owner withdrew verification',
      '--key', 'cancel-key-1',
    )
    expect(cancelReplay.code).toBe(0)
    expect(cancelReplay.json).toEqual({ verificationId, replayed: true })

    const after = run('verification-status', verificationId, '--data-dir', dataDir)
    expect(after.code).toBe(0)
    expect((after.json as { job: { status: string } }).job.status).toBe('CANCELLED')
  })

  it('hides foreign verification ids as not found', () => {
    const dataDir = initDataDir()
    const missing = run('verification-status', 'v-missing-id', '--data-dir', dataDir)
    expect(missing.code).toBe(1)
    expect(missing.stderr).toMatch(/not found/i)
    expect(missing.stderr).not.toContain('v-missing-id')
  })
})

describe('schema and missing storage preflight', () => {
  it('does not create storage for missing database', () => {
    const dataDir = join(root, 'missing-data')
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    chmodSync(dataDir, 0o700)
    const before = listDomainFiles(dataDir)
    const result = run('verification-plans', '--data-dir', dataDir)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/not initialized|run init/i)
    expect(listDomainFiles(dataDir)).toEqual(before)
    expect(existsSync(join(dataDir, 'workforce.sqlite'))).toBe(false)
  })

  it('rejects future verification schema without mutating registry', () => {
    const dataDir = initDataDir()
    const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
    opened.push(store)
    store.set(VERIFICATION_SCHEMA_KEY, 99)
    store.close()
    opened.pop()
    const before = listDomainFiles(dataDir)
    const result = run('verification-plans', '--data-dir', dataDir)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/verification schema/i)
    expect(listDomainFiles(dataDir)).toEqual(before)
    expect(existsSync(join(dataDir, 'verification-plans.json'))).toBe(false)
  })
})

describe('strict args and no-echo failures', () => {
  it('rejects unknown and duplicated options without echoing raw secrets', () => {
    const dataDir = initDataDir()
    const secret = 'deadbeef'.repeat(8)

    const unknown = run(
      'verification-create', 'ticket-1',
      '--data-dir', dataDir,
      '--plan', 'local-checks',
      '--plan-revision', 'revision-1',
      '--expected-version', '1',
      '--execution-id', 'execution-1',
      '--artifact-revision', 'ab'.repeat(32),
      '--reason', 'reason',
      '--key', 'key-1',
      '--secret-token', secret,
    )
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toMatch(/Unknown option/)
    expect(unknown.stderr).not.toContain(secret)
    expect(unknown.stderr).not.toContain('--secret-token')

    const duplicate = run(
      'verification-plans',
      '--data-dir', dataDir,
      '--data-dir', dataDir,
    )
    expect(duplicate.code).toBe(1)
    expect(duplicate.stderr).toMatch(/only be provided once/)

    const badKey = run(
      'verification-cancel', 'v-id',
      '--data-dir', dataDir,
      '--expected-version', '1',
      '--reason', 'stop',
      '--key', '../evil',
    )
    expect(badKey.code).toBe(1)
    expect(badKey.stderr).toMatch(/Invalid value for --key/)
    expect(badKey.stderr).not.toContain('../evil')
  })

  it('rejects private-mode and symlink-unsafe data dirs', () => {
    const dataDir = initDataDir()
    chmodSync(dataDir, 0o755)
    const open = run('verification-plans', '--data-dir', dataDir)
    expect(open.code).toBe(1)
    expect(open.stderr).toMatch(/private \(0700\)/)
  })
})
