import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LocalVerificationCommands,
  VerificationCommandError,
  type CreateVerificationInput,
} from '../src/application/verification-commands.ts'
import { LocalTaskService } from '../src/application/tasks.ts'
import type { Rule } from '../src/assessor/rules.ts'
import type { Ticket } from '../src/core/model.ts'
import { ProjectRepository } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LocalStore } from '../src/storage/store.ts'
import { VerificationJobRepository } from '../src/storage/verification-jobs.ts'
import type { VerificationJobPlan } from '../src/verification/model.ts'

const opened: LocalStore[] = []
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verification-commands-'))
})

afterEach(() => {
  for (const store of opened.splice(0)) {
    try { store.close() } catch { /* already closed */ }
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

function initGitRepo(name: string): string {
  const directory = join(root, name)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  git(directory, ['init'])
  git(directory, ['config', 'user.email', 'verification@example.com'])
  git(directory, ['config', 'user.name', 'Verification Fixture'])
  writeFileSync(join(directory, 'README.md'), '# fixture\n', { mode: 0o600 })
  git(directory, ['add', 'README.md'])
  git(directory, ['commit', '-m', 'fixture'])
  return resolve(directory)
}

function openStore(path = join(root, 'workforce.sqlite'), initialize = true): LocalStore {
  const store = new LocalStore(path)
  opened.push(store)
  if (initialize) initializeApplicationSchema(store)
  return store
}

function closeStore(store: LocalStore): void {
  store.close()
  const index = opened.indexOf(store)
  if (index >= 0) opened.splice(index, 1)
}

function rules(): Rule[] {
  return [{
    id: 'docs',
    enabled: true,
    taskTypes: ['docs'],
    priority: 10,
    approvalRequired: false,
    reviewRequired: true,
    retryLimit: 1,
  }]
}

function plans(): VerificationJobPlan[] {
  return [{
    id: 'local-checks',
    revision: 'revision-1',
    checks: [{ id: 'node-version', command: process.execPath, args: ['--version'], timeoutMs: 5_000 }],
  }]
}

function seedProject(store: LocalStore, workspaceId = 'local', projectId = 'project-1'): void {
  new ProjectRepository(store.db).create({
    id: projectId,
    workspaceId,
    name: `Project ${projectId}`,
    ownerId: 'business-owner',
    repositoryPath: initGitRepo(`repo-${projectId}`),
    worktreeRoot: join(root, `worktrees-${projectId}`),
    allowedTaskTypes: ['docs'],
  })
}

interface ReviewFixture {
  ticket: Ticket
  executionId: string
  artifactRevision: string
  input: CreateVerificationInput
}

function createReviewFixture(
  store: LocalStore,
  options: { ownerId?: string; workspaceId?: string; projectId?: string; issueId?: string; artifact?: string } = {},
): ReviewFixture {
  const ownerId = options.ownerId ?? 'owner-1'
  const workspaceId = options.workspaceId ?? 'local'
  const projectId = options.projectId ?? 'project-1'
  seedProject(store, workspaceId, projectId)
  const tasks = new LocalTaskService({ store, ownerId, workspaceId, rules: rules() })
  const created = tasks.create({
    issueId: options.issueId ?? 'issue-1',
    projectId,
    title: 'Verify the completed change',
    description: 'Exercise the durable verification command boundary',
    taskType: 'docs',
  })
  const assigned = tasks.engine.assignTask(
    created.id,
    'codex-local',
    'codex',
    join(root, `work-${created.id}`),
  )
  const assignmentId = assigned.assignments.at(-1)!.id
  tasks.engine.assignmentStarted(created.id, assignmentId)
  const executionId = `execution-${assignmentId}`
  const artifactRevision = options.artifact ?? 'a'.repeat(64)
  const ticket = tasks.engine.recordExecution(created.id, {
    assignmentId,
    executionId,
    artifactRevision,
    exitCode: 0,
    terminal: 'success',
    summary: 'Fixture execution completed',
  })
  expect(ticket.lifecycle?.status).toBe('REVIEW')
  return {
    ticket,
    executionId,
    artifactRevision,
    input: {
      expectedVersion: ticket.lifecycle!.version,
      executionId,
      artifactRevision,
      planId: 'local-checks',
      planRevision: 'revision-1',
      reason: 'Owner requested checks for the exact execution artifact',
    },
  }
}

function commands(
  store: LocalStore,
  ownerId = 'owner-1',
  workspaceId = 'local',
  registeredPlans: readonly VerificationJobPlan[] = plans(),
): LocalVerificationCommands {
  return new LocalVerificationCommands({ store, ownerId, workspaceId, rules: rules(), plans: registeredPlans })
}

function count(store: LocalStore, table: 'verification_job' | 'verification_job_receipt' | 'verification_job_audit'): number {
  return Number((store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count)
}

function expectCode(operation: () => unknown, code: VerificationCommandError['code']): void {
  try {
    operation()
    expect.fail(`expected ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(VerificationCommandError)
    expect((error as VerificationCommandError).code).toBe(code)
  }
}

describe('LocalVerificationCommands create and durable receipts', () => {
  it('reserves an immutable request for the current successful execution and exposes cloned query results', () => {
    const store = openStore()
    const fixture = createReviewFixture(store)
    const api = commands(store)

    const result = api.create('create-1', fixture.ticket.id, fixture.input)
    expect(result.replayed).toBe(false)
    const job = api.get(result.verificationId)!
    expect(job).toMatchObject({
      status: 'QUEUED',
      version: 1,
      request: {
        verificationId: result.verificationId,
        workspaceId: 'local',
        ownerId: 'owner-1',
        ticketId: fixture.ticket.id,
        expectedTaskVersion: fixture.ticket.lifecycle!.version,
        policyVersion: fixture.ticket.lifecycle!.policyVersion,
        executionId: fixture.executionId,
        artifactId: `artifact-${fixture.executionId}`,
        artifactRevision: fixture.artifactRevision,
        plan: plans()[0],
        reason: fixture.input.reason,
      },
    })
    expect(api.list(fixture.ticket.id).items.map(item => item.request.verificationId)).toEqual([result.verificationId])
    expect(api.history(result.verificationId).map(item => item.action)).toEqual(['reserved', 'receipt_inserted'])

    job.request.plan.checks[0]!.args[0] = '--mutated'
    const listed = api.list(fixture.ticket.id).items[0]!
    listed.request.reason = 'mutated result'
    expect(api.get(result.verificationId)?.request.plan.checks[0]?.args).toEqual(['--version'])
    expect(api.get(result.verificationId)?.request.reason).toBe(fixture.input.reason)
    expect(api.plans()).toEqual(plans())
  })

  it('replays create and cancel receipts after SQLite reopen without repeating mutations', () => {
    const path = join(root, 'reopen.sqlite')
    const first = openStore(path)
    const fixture = createReviewFixture(first)
    const created = commands(first).create('durable-create', fixture.ticket.id, fixture.input)
    const auditAfterCreate = count(first, 'verification_job_audit')
    closeStore(first)

    const second = openStore(path, false)
    const reopened = commands(second)
    expect(reopened.create('durable-create', fixture.ticket.id, { ...fixture.input })).toEqual({
      verificationId: created.verificationId,
      replayed: true,
    })
    expect(count(second, 'verification_job')).toBe(1)
    expect(count(second, 'verification_job_receipt')).toBe(1)
    expect(count(second, 'verification_job_audit')).toBe(auditAfterCreate)

    const cancel = reopened.cancel('durable-cancel', created.verificationId, {
      expectedVersion: 1,
      reason: 'Cancel before the verifier starts',
    })
    expect(cancel.replayed).toBe(false)
    expect(reopened.get(created.verificationId)).toMatchObject({
      status: 'CANCELLED',
      version: 2,
      failureCode: 'cancelled_before_launch',
      cancelRequested: { actorId: 'owner-1', reason: 'Cancel before the verifier starts' },
    })
    const auditAfterCancel = count(second, 'verification_job_audit')
    closeStore(second)

    const third = openStore(path, false)
    const replayed = commands(third).cancel('durable-cancel', created.verificationId, {
      expectedVersion: 1,
      reason: 'Cancel before the verifier starts',
    })
    expect(replayed).toEqual({ verificationId: created.verificationId, replayed: true })
    expect(count(third, 'verification_job_receipt')).toBe(2)
    expect(count(third, 'verification_job_audit')).toBe(auditAfterCancel)
  })

  it('rejects changed payloads for reused create and cancel idempotency keys', () => {
    const store = openStore()
    const fixture = createReviewFixture(store)
    const api = commands(store)
    const created = api.create('same-create-key', fixture.ticket.id, fixture.input)

    expectCode(() => api.create('same-create-key', fixture.ticket.id, {
      ...fixture.input,
      reason: 'Different command under the same key',
    }), 'IDEMPOTENCY_CONFLICT')
    expect(count(store, 'verification_job')).toBe(1)
    expect(count(store, 'verification_job_receipt')).toBe(1)

    api.cancel('same-cancel-key', created.verificationId, { expectedVersion: 1, reason: 'First reason' })
    expectCode(() => api.cancel('same-cancel-key', created.verificationId, {
      expectedVersion: 1,
      reason: 'Changed reason',
    }), 'IDEMPOTENCY_CONFLICT')
    expect(count(store, 'verification_job_receipt')).toBe(2)
  })
})

describe('LocalVerificationCommands authorization and state fences', () => {
  it('rejects stale task versions, mismatched execution evidence, and absent plans without receipts', () => {
    const store = openStore()
    const fixture = createReviewFixture(store)
    const api = commands(store)

    expectCode(() => api.create('stale', fixture.ticket.id, {
      ...fixture.input,
      expectedVersion: fixture.input.expectedVersion + 1,
    }), 'VERSION_CONFLICT')
    expectCode(() => api.create('wrong-execution', fixture.ticket.id, {
      ...fixture.input,
      executionId: 'execution-other',
    }), 'STATE_CONFLICT')
    expectCode(() => api.create('wrong-artifact', fixture.ticket.id, {
      ...fixture.input,
      artifactRevision: 'b'.repeat(64),
    }), 'STATE_CONFLICT')
    expectCode(() => commands(store, 'owner-1', 'local', []).create(
      'missing-plan',
      fixture.ticket.id,
      fixture.input,
    ), 'INVALID_COMMAND')
    expect(count(store, 'verification_job')).toBe(0)
    expect(count(store, 'verification_job_receipt')).toBe(0)
    expect(count(store, 'verification_job_audit')).toBe(0)
  })

  it('masks jobs and tickets outside the authenticated owner/workspace scope', () => {
    const store = openStore()
    const fixture = createReviewFixture(store)
    const owner = commands(store)
    const created = owner.create('owned', fixture.ticket.id, fixture.input)
    const foreignOwner = commands(store, 'owner-2')
    const foreignWorkspace = commands(store, 'owner-1', 'other')

    for (const foreign of [foreignOwner, foreignWorkspace]) {
      expect(foreign.get(created.verificationId)).toBeUndefined()
      expectCode(() => foreign.list(fixture.ticket.id), 'NOT_FOUND')
      expectCode(() => foreign.history(created.verificationId), 'NOT_FOUND')
      expectCode(() => foreign.cancel('foreign-cancel', created.verificationId, {
        expectedVersion: 1,
        reason: 'Must remain hidden',
      }), 'NOT_FOUND')
    }
    expect(count(store, 'verification_job_receipt')).toBe(1)
    expect(owner.get(created.verificationId)?.status).toBe('QUEUED')
  })

  it('retains active occupancy through launched cancellation and permits a new job only after terminal proof', () => {
    const store = openStore()
    const fixture = createReviewFixture(store)
    const api = commands(store)
    const created = api.create('active-1', fixture.ticket.id, fixture.input)
    const repository = new VerificationJobRepository(store.db)
    expect(repository.beginLaunch(created.verificationId)).toMatchObject({ status: 'STARTING', version: 2 })

    const cancelled = api.cancel('cancel-active', created.verificationId, {
      expectedVersion: 2,
      reason: 'Stop the launched verifier',
    })
    expect(cancelled.replayed).toBe(false)
    expect(api.get(created.verificationId)).toMatchObject({ status: 'STOPPING', version: 3 })
    expectCode(() => api.create('active-2', fixture.ticket.id, fixture.input), 'STATE_CONFLICT')
    expect(count(store, 'verification_job')).toBe(1)

    repository.apply({
      verificationId: created.verificationId,
      sequence: 1,
      runnerId: 'runner-1',
      runnerPid: 101,
      status: 'CANCELLED',
      at: new Date().toISOString(),
      terminalConfirmed: true,
      failureCode: 'CANCELLED',
    })
    expect(api.get(created.verificationId)?.status).toBe('CANCELLED')
    const replacement = api.create('active-2', fixture.ticket.id, fixture.input)
    expect(replacement.verificationId).not.toBe(created.verificationId)
    expect(count(store, 'verification_job')).toBe(2)
  })
})

describe('LocalVerificationCommands validation and transaction rollback', () => {
  it('rejects malformed commands before writes and rolls reserve/audit back when receipt persistence fails', () => {
    const store = openStore()
    const fixture = createReviewFixture(store)
    const api = commands(store)

    expectCode(() => api.create('invalid-extra', fixture.ticket.id, {
      ...fixture.input,
      secret: 'must-not-be-accepted',
    } as never), 'INVALID_COMMAND')
    expectCode(() => api.cancel('invalid-cancel', 'verification-1', {
      expectedVersion: 0,
      reason: 'invalid version',
    }), 'INVALID_COMMAND')
    expect(count(store, 'verification_job')).toBe(0)
    expect(count(store, 'verification_job_receipt')).toBe(0)
    expect(count(store, 'verification_job_audit')).toBe(0)

    store.db.exec(`
      CREATE TRIGGER abort_verification_receipt
      BEFORE INSERT ON verification_job_receipt
      BEGIN
        SELECT RAISE(ABORT, 'forced failure with secret-token');
      END;
    `)
    let caught: unknown
    try {
      api.create('receipt-abort', fixture.ticket.id, fixture.input)
      expect.fail('expected persistence failure')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(VerificationCommandError)
    expect(String((caught as Error).message)).toBe('Verification persistence failed')
    expect(String((caught as Error).message)).not.toMatch(/secret-token|sqlite|trigger/i)
    expect(count(store, 'verification_job')).toBe(0)
    expect(count(store, 'verification_job_receipt')).toBe(0)
    expect(count(store, 'verification_job_audit')).toBe(0)
  })
  it('accepts dotted plan identifiers and revisions from the actual trusted registry contract', () => {
    const store = openStore()
    const fixture = createReviewFixture(store)
    const registered = plans().map(plan => ({...plan,id:'docs.content',revision:'v1.0'}))
    const result = commands(store,'owner-1','local',registered).create('dotted-plan',fixture.ticket.id,{...fixture.input,planId:'docs.content',planRevision:'v1.0'})
    expect(new VerificationJobRepository(store.db).get(result.verificationId)?.request.plan).toMatchObject({id:'docs.content',revision:'v1.0'})
  })

})
