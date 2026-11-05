import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  VerificationCoordinator,
  type VerificationCollection,
  type VerificationJobRunner,
} from '../src/application/verification-coordinator.ts'
import { LocalTaskService } from '../src/application/tasks.ts'
import type { Rule } from '../src/assessor/rules.ts'
import type { RunnerEvent, RunnerSnapshot } from '../src/runner/protocol.ts'
import { ProjectRepository } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LocalStore } from '../src/storage/store.ts'
import { VerificationJobRepository } from '../src/storage/verification-jobs.ts'
import type { VerificationReport } from '../src/verification/local-checks.ts'
import type { VerificationJobRequest } from '../src/verification/model.ts'

const OWNER_ID = 'owner-1'
const WORKSPACE_ID = 'local'
const RUNNER_ID = 'runner-1'
const RUNNER_PID = 4101
const REPORT_DIGEST = 'd'.repeat(64)
const OTHER_DIGEST = 'e'.repeat(64)
const opened: LocalStore[] = []
let root: string
let clock: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verification-coordinator-'))
  clock = '2026-11-05T00:00:00.000Z'
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

function initGitRepo(directory: string): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  git(directory, ['init'])
  git(directory, ['config', 'user.email', 'verification@example.com'])
  git(directory, ['config', 'user.name', 'Verification Fixture'])
  writeFileSync(join(directory, 'README'), 'fixture\n', { mode: 0o600 })
  git(directory, ['add', 'README'])
  git(directory, ['commit', '-m', 'init'])
  return resolve(directory)
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

interface Harness {
  store: LocalStore
  tasks: LocalTaskService
  jobs: VerificationJobRepository
  runner: FakeVerificationRunner
}

function harness(): Harness {
  const store = new LocalStore(join(root, `workforce-${opened.length}.sqlite`))
  opened.push(store)
  initializeApplicationSchema(store)
  new ProjectRepository(store.db).create({
    id: 'proj-1',
    workspaceId: WORKSPACE_ID,
    name: 'Docs',
    ownerId: OWNER_ID,
    repositoryPath: initGitRepo(join(root, `repo-${opened.length}`)),
    worktreeRoot: join(root, `worktrees-${opened.length}`),
    allowedTaskTypes: ['docs'],
  })
  const tasks = new LocalTaskService({
    store,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    rules: rules(),
    now: () => clock,
  })
  return {
    store,
    tasks,
    jobs: new VerificationJobRepository(store.db),
    runner: new FakeVerificationRunner(store),
  }
}

interface ReviewFixture {
  ticketId: string
  request: VerificationJobRequest
}

function reserveReviewJob(h: Harness, index: number): ReviewFixture {
  const created = h.tasks.create({
    issueId: `issue-${index}`,
    projectId: 'proj-1',
    title: `Docs task ${index}`,
    description: `Verify docs task ${index}`,
    taskType: 'docs',
  })
  const assigned = h.tasks.engine.assignTask(
    created.id,
    'claude-local',
    'claude-code',
    join(root, 'work', created.id),
  )
  const assignmentId = assigned.assignments.at(-1)!.id
  h.tasks.engine.assignmentStarted(created.id, assignmentId)
  const artifactRevision = index.toString(16).repeat(64)
  const executionId = `execution-${index}`
  const review = h.tasks.engine.recordExecution(created.id, {
    assignmentId,
    executionId,
    artifactRevision,
    exitCode: 0,
    terminal: 'success',
    summary: 'Produced immutable artifact',
  })
  const lifecycle = review.lifecycle!
  expect(lifecycle.status).toBe('REVIEW')
  const request: VerificationJobRequest = {
    verificationId: `verification-${index}`,
    workspaceId: WORKSPACE_ID,
    ownerId: OWNER_ID,
    ticketId: created.id,
    expectedTaskVersion: lifecycle.version,
    policyVersion: lifecycle.policyVersion,
    executionId,
    artifactId: `artifact-${executionId}`,
    artifactRevision,
    plan: {
      id: 'review-plan',
      revision: 'r1',
      checks: [{ id: 'test', command: process.execPath, args: ['--version'], timeoutMs: 10_000 }],
    },
    reason: 'Owner requested verification',
    createdAt: clock,
  }
  h.jobs.reserve(request)
  return { ticketId: created.id, request }
}

function snapshot(
  request: VerificationJobRequest,
  state: RunnerSnapshot['state'],
  sequence: number,
  overrides: Partial<RunnerSnapshot> = {},
): RunnerSnapshot {
  return {
    version: 1,
    executionId: request.verificationId,
    assignmentId: request.verificationId,
    ticketId: request.ticketId,
    generation: 1,
    runnerId: RUNNER_ID,
    runnerPid: RUNNER_PID,
    state,
    sequence,
    startedAt: clock,
    updatedAt: clock,
    heartbeatAt: clock,
    stdoutBytes: 0,
    stderrBytes: 0,
    ...overrides,
  }
}

function event(
  request: VerificationJobRequest,
  state: RunnerEvent['state'],
  sequence: number,
  overrides: Partial<RunnerEvent> = {},
): RunnerEvent {
  return { ...snapshot(request, state, sequence), at: clock, ...overrides }
}

function report(
  request: VerificationJobRequest,
  state: 'passed' | 'failed' = 'passed',
  overrides: Partial<VerificationReport> = {},
): VerificationReport {
  return {
    verificationId: request.verificationId,
    executionId: request.executionId,
    artifactId: request.artifactId,
    artifactRevision: request.artifactRevision,
    state,
    checks: state === 'failed'
      ? [{ id: 'test', exitCode: 1, signal: null, durationMs: 5, stdout: '', stderr: 'failed', reason: 'process exited with code 1' }]
      : [{ id: 'test', exitCode: 0, signal: null, durationMs: 5, stdout: 'ok', stderr: '' }],
    createdAt: clock,
    ...overrides,
  }
}

function completed(
  request: VerificationJobRequest,
  state: 'passed' | 'failed' = 'passed',
  reportSha256 = REPORT_DIGEST,
): VerificationCollection {
  return {
    status: 'completed',
    terminalConfirmed: true,
    reportSha256,
    report: report(request, state),
  }
}

class FakeVerificationRunner implements VerificationJobRunner {
  readonly startCalls: VerificationJobRequest[] = []
  readonly statusCalls: string[] = []
  readonly eventCalls: { id: string; afterSequence?: number }[] = []
  readonly stopCalls: { id: string; reason: string }[] = []
  readonly collectCalls: VerificationJobRequest[] = []
  readonly startFailures = new Set<string>()
  readonly startResults = new Map<string, RunnerSnapshot>()
  readonly statuses = new Map<string, RunnerSnapshot>()
  readonly eventLogs = new Map<string, RunnerEvent[]>()
  readonly collections = new Map<string, VerificationCollection | Error>()

  constructor(private readonly store: LocalStore) {}

  private outsideTransaction(method: string): void {
    expect(this.store.db.isTransaction, `${method} performed runner IO inside a transaction`).toBe(false)
  }

  async start(request: VerificationJobRequest): Promise<RunnerSnapshot> {
    this.outsideTransaction('start')
    this.startCalls.push(structuredClone(request))
    if (this.startFailures.has(request.verificationId)) throw new Error('start confirmation unavailable')
    return this.startResults.get(request.verificationId) ?? snapshot(request, 'STARTING', 0)
  }

  async status(id: string): Promise<RunnerSnapshot> {
    this.outsideTransaction('status')
    this.statusCalls.push(id)
    const value = this.statuses.get(id)
    if (!value) throw new Error('status unavailable')
    return structuredClone(value)
  }

  async events(id: string, afterSequence?: number): Promise<RunnerEvent[]> {
    this.outsideTransaction('events')
    this.eventCalls.push({ id, ...(afterSequence === undefined ? {} : { afterSequence }) })
    return structuredClone((this.eventLogs.get(id) ?? []).filter(item => item.sequence > (afterSequence ?? 0)))
  }

  async stop(id: string, reason: string): Promise<{ accepted: boolean; detail?: string }> {
    this.outsideTransaction('stop')
    this.stopCalls.push({ id, reason })
    return { accepted: true }
  }

  async collect(request: VerificationJobRequest): Promise<VerificationCollection> {
    this.outsideTransaction('collect')
    this.collectCalls.push(structuredClone(request))
    const value = this.collections.get(request.verificationId)
    if (value instanceof Error) throw value
    if (!value) throw new Error('terminal report is missing')
    return structuredClone(value)
  }
}

function coordinator(h: Harness, maxConcurrency = 1): VerificationCoordinator {
  return new VerificationCoordinator({
    store: h.store,
    tasks: h.tasks,
    ownerId: OWNER_ID,
    workspaceId: WORKSPACE_ID,
    runner: h.runner,
    maxConcurrency,
  })
}

describe('VerificationCoordinator scheduling and recovery', () => {
  it('keeps runner IO outside transactions, starts once, applies ordered proof once, and never auto-completes the Task', async () => {
    const h = harness()
    const fixture = reserveReviewJob(h, 1)
    const id = fixture.request.verificationId
    h.runner.eventLogs.set(id, [
      event(fixture.request, 'STARTING', 1),
      event(fixture.request, 'RUNNING', 2),
      event(fixture.request, 'SUCCEEDED', 3),
    ])
    h.runner.collections.set(id, completed(fixture.request))

    await expect(coordinator(h).tick()).resolves.toEqual({ launched: 1, observed: 0, unknown: 0 })

    expect(h.runner.startCalls.map(item => item.verificationId)).toEqual([id])
    expect(h.runner.collectCalls.map(item => item.verificationId)).toEqual([id])
    expect(h.jobs.get(id)).toMatchObject({
      status: 'COMPLETED',
      lastSequence: 3,
      outcome: 'passed',
      reportSha256: REPORT_DIGEST,
      application: 'applied',
    })
    const task = h.tasks.get(fixture.ticketId)!.lifecycle!
    expect(task.status).toBe('REVIEW')
    expect(task.result?.verification).toBe('passed')
    const verificationAudit = h.store.workflow.history(fixture.ticketId)
      .find(item => item.verificationProvenance?.verificationId === id)
    expect(verificationAudit).toMatchObject({
      kind: 'evidence',
      actor: OWNER_ID,
      verification: 'passed',
      executionId: fixture.request.executionId,
      artifactRevision: fixture.request.artifactRevision,
      verificationProvenance: {
        verificationId: id,
        reportSha256: REPORT_DIGEST,
        planId: 'review-plan',
        planRevision: 'r1',
      },
    })
    expect(h.jobs.history(id).filter(item => item.action === 'event_applied').map(item => item.sequence))
      .toEqual([1, 2, 3])
    expect(h.jobs.history(id).at(-1)).toMatchObject({
      action: 'application_recorded',
      reasonCode: 'applied',
    })

    await expect(coordinator(h).tick()).resolves.toEqual({ launched: 0, observed: 0, unknown: 0 })
    expect(h.runner.startCalls).toHaveLength(1)
    expect(h.runner.collectCalls).toHaveLength(1)
    expect(h.store.workflow.history(fixture.ticketId).filter(item => item.verificationProvenance)).toHaveLength(1)
  })

  it('reconciles launched jobs after restart without launching queued work', async () => {
    const h = harness()
    const launched = reserveReviewJob(h, 1)
    const queued = reserveReviewJob(h, 2)
    h.jobs.beginLaunch(launched.request.verificationId)
    h.runner.eventLogs.set(launched.request.verificationId, [event(launched.request, 'STARTING', 1)])
    h.runner.statuses.set(launched.request.verificationId, snapshot(launched.request, 'STARTING', 1))

    await expect(coordinator(h, 2).reconcile()).resolves.toEqual({ launched: 0, observed: 1, unknown: 0 })

    expect(h.runner.startCalls).toEqual([])
    expect(h.jobs.get(launched.request.verificationId)).toMatchObject({ status: 'STARTING', lastSequence: 1 })
    expect(h.jobs.get(queued.request.verificationId)?.status).toBe('QUEUED')
  })

  it('retains an UNKNOWN concurrency slot and accepts a late authentic first event without restarting', async () => {
    const h = harness()
    const uncertain = reserveReviewJob(h, 1)
    const queued = reserveReviewJob(h, 2)
    const id = uncertain.request.verificationId
    h.runner.startFailures.add(id)

    await coordinator(h).tick()
    expect(h.jobs.get(id)).toMatchObject({ status: 'UNKNOWN', lastSequence: 0, failureCode: 'START_UNCONFIRMED' })
    expect(h.jobs.get(queued.request.verificationId)?.status).toBe('QUEUED')

    h.runner.statuses.set(id, snapshot(uncertain.request, 'UNKNOWN', 0))
    await coordinator(h).tick()
    expect(h.runner.startCalls.map(item => item.verificationId)).toEqual([id])
    expect(h.jobs.get(queued.request.verificationId)?.status).toBe('QUEUED')

    h.runner.eventLogs.set(id, [
      event(uncertain.request, 'STARTING', 1),
      event(uncertain.request, 'RUNNING', 2),
    ])
    h.runner.statuses.set(id, snapshot(uncertain.request, 'RUNNING', 2))
    await coordinator(h).tick()

    expect(h.jobs.get(id)).toMatchObject({ status: 'RUNNING', lastSequence: 2 })
    expect(h.jobs.get(queued.request.verificationId)?.status).toBe('QUEUED')
    expect(h.runner.startCalls.map(item => item.verificationId)).toEqual([id])
  })

  it('rejects a mismatched start handshake instead of accepting later evidence for that launch', async () => {
    const h = harness()
    const fixture = reserveReviewJob(h, 1)
    const id = fixture.request.verificationId
    h.runner.startResults.set(id, snapshot(fixture.request, 'STARTING', 0, { ticketId: 'different-ticket' }))
    h.runner.statuses.set(id, snapshot(fixture.request, 'STARTING', 0))

    await coordinator(h).tick()

    expect(h.jobs.get(id)).toMatchObject({ status: 'UNKNOWN', failureCode: 'START_UNCONFIRMED' })
    expect(h.runner.eventCalls).toEqual([])
    expect(h.runner.statusCalls).toEqual([])
  })
})

describe('VerificationCoordinator terminal application', () => {
  it('records a superseded completion without changing a Task that moved after enqueue', async () => {
    const h = harness()
    const fixture = reserveReviewJob(h, 1)
    h.tasks.verify(fixture.ticketId, {
      executionId: fixture.request.executionId,
      artifactRevision: fixture.request.artifactRevision,
      state: 'not_required',
      reason: 'Owner supplied a separate waiver after enqueue',
    })
    const taskBefore = structuredClone(h.tasks.get(fixture.ticketId))
    const historyBefore = h.store.workflow.history(fixture.ticketId)
    h.runner.eventLogs.set(fixture.request.verificationId, [event(fixture.request, 'SUCCEEDED', 1)])
    h.runner.collections.set(fixture.request.verificationId, completed(fixture.request))

    await coordinator(h).tick()

    expect(h.jobs.get(fixture.request.verificationId)).toMatchObject({
      status: 'COMPLETED',
      application: 'superseded',
      outcome: 'passed',
    })
    expect(h.tasks.get(fixture.ticketId)).toEqual(taskBefore)
    expect(h.store.workflow.history(fixture.ticketId)).toEqual(historyBefore)
  })

  it('distinguishes a completed nonzero check from verification infrastructure failure', async () => {
    const h = harness()
    const checkFailure = reserveReviewJob(h, 1)
    const infrastructureFailure = reserveReviewJob(h, 2)
    h.runner.eventLogs.set(checkFailure.request.verificationId, [event(checkFailure.request, 'SUCCEEDED', 1)])
    h.runner.collections.set(checkFailure.request.verificationId, completed(checkFailure.request, 'failed'))
    h.runner.eventLogs.set(infrastructureFailure.request.verificationId, [event(infrastructureFailure.request, 'FAILED', 1)])
    h.runner.collections.set(infrastructureFailure.request.verificationId, {
      status: 'failed',
      terminalConfirmed: true,
      reportSha256: OTHER_DIGEST,
      failureCode: 'CHECK_INFRASTRUCTURE_FAILED',
    })

    await coordinator(h, 2).tick()

    expect(h.jobs.get(checkFailure.request.verificationId)).toMatchObject({
      status: 'COMPLETED',
      outcome: 'failed',
      application: 'applied',
    })
    expect(h.tasks.get(checkFailure.ticketId)?.lifecycle).toMatchObject({
      status: 'REVIEW',
      result: { verification: 'failed' },
    })
    expect(h.jobs.get(infrastructureFailure.request.verificationId)).toMatchObject({
      status: 'FAILED',
      failureCode: 'CHECK_INFRASTRUCTURE_FAILED',
    })
    expect(h.tasks.get(infrastructureFailure.ticketId)?.lifecycle).toMatchObject({
      status: 'REVIEW',
      result: { verification: 'unknown' },
    })
  })

  it('uses the authenticated stop port for cancellation and retains occupancy until terminal proof', async () => {
    const h = harness()
    const cancelling = reserveReviewJob(h, 1)
    const queued = reserveReviewJob(h, 2)
    const id = cancelling.request.verificationId
    h.jobs.beginLaunch(id)
    h.jobs.apply({
      verificationId: id,
      sequence: 1,
      runnerId: RUNNER_ID,
      runnerPid: RUNNER_PID,
      status: 'STARTING',
      at: clock,
    })
    const active = h.jobs.get(id)!
    h.jobs.requestCancel(id, {
      expectedVersion: active.version,
      actorId: OWNER_ID,
      reason: 'Owner cancelled verification',
      at: clock,
    })
    h.runner.statuses.set(id, snapshot(cancelling.request, 'STOPPING', 1))

    await coordinator(h).tick()

    expect(h.runner.stopCalls).toEqual([{ id, reason: 'OWNER_VERIFICATION_CANCEL' }])
    expect(h.jobs.get(id)?.status).toBe('STOPPING')
    expect(h.jobs.get(queued.request.verificationId)?.status).toBe('QUEUED')
    expect(h.runner.startCalls).toEqual([])
  })

  it('keeps a terminal event UNKNOWN when the signed report is missing', async () => {
    const h = harness()
    const fixture = reserveReviewJob(h, 1)
    const before = structuredClone(h.tasks.get(fixture.ticketId))
    h.runner.eventLogs.set(fixture.request.verificationId, [event(fixture.request, 'SUCCEEDED', 1)])
    h.runner.collections.set(fixture.request.verificationId, {
      status: 'completed',
      terminalConfirmed: true,
      reportSha256: REPORT_DIGEST,
    })

    await coordinator(h).tick()

    expect(h.jobs.get(fixture.request.verificationId)).toMatchObject({
      status: 'UNKNOWN',
      lastSequence: 0,
      failureCode: 'EVIDENCE_UNCONFIRMED',
    })
    expect(h.tasks.get(fixture.ticketId)).toEqual(before)
  })

  it.each([
    {
      name: 'runner identity',
      arrange(h: Harness, fixture: ReviewFixture) {
        h.runner.eventLogs.set(fixture.request.verificationId, [
          event(fixture.request, 'SUCCEEDED', 1, { ticketId: 'different-ticket' }),
        ])
        h.runner.collections.set(fixture.request.verificationId, completed(fixture.request))
      },
    },
    {
      name: 'report identity',
      arrange(h: Harness, fixture: ReviewFixture) {
        h.runner.eventLogs.set(fixture.request.verificationId, [event(fixture.request, 'SUCCEEDED', 1)])
        h.runner.collections.set(fixture.request.verificationId, {
          ...completed(fixture.request),
          report: report(fixture.request, 'passed', { executionId: 'different-execution' }),
        })
      },
    },
    {
      name: 'report digest syntax',
      arrange(h: Harness, fixture: ReviewFixture) {
        h.runner.eventLogs.set(fixture.request.verificationId, [event(fixture.request, 'SUCCEEDED', 1)])
        h.runner.collections.set(fixture.request.verificationId, completed(fixture.request, 'passed', 'not-a-digest'))
      },
    },
  ])('does not release occupancy for mismatched $name evidence', async ({ arrange }) => {
    const h = harness()
    const fixture = reserveReviewJob(h, 1)
    const before = structuredClone(h.tasks.get(fixture.ticketId))
    arrange(h, fixture)

    await coordinator(h).tick()

    expect(h.jobs.get(fixture.request.verificationId)).toMatchObject({
      status: 'UNKNOWN',
      lastSequence: 0,
      failureCode: 'EVIDENCE_UNCONFIRMED',
    })
    expect(h.tasks.get(fixture.ticketId)).toEqual(before)
  })

  it('requires contiguous ordered terminal evidence', async () => {
    const h = harness()
    const fixture = reserveReviewJob(h, 1)
    h.runner.eventLogs.set(fixture.request.verificationId, [event(fixture.request, 'SUCCEEDED', 2)])
    h.runner.collections.set(fixture.request.verificationId, completed(fixture.request))

    await coordinator(h).tick()

    expect(h.jobs.get(fixture.request.verificationId)).toMatchObject({
      status: 'UNKNOWN',
      lastSequence: 0,
      failureCode: 'EVIDENCE_UNCONFIRMED',
    })
    expect(h.store.db.prepare('SELECT count(*) AS count FROM verification_job_event WHERE verification_id = ?')
      .get(fixture.request.verificationId)).toEqual({ count: 0 })
  })

  it('rejects a collected digest that differs from an already stored pending completion', async () => {
    const h = harness()
    const fixture = reserveReviewJob(h, 1)
    const id = fixture.request.verificationId
    h.jobs.beginLaunch(id)
    h.jobs.apply({
      verificationId: id,
      sequence: 1,
      runnerId: RUNNER_ID,
      runnerPid: RUNNER_PID,
      status: 'COMPLETED',
      at: clock,
      terminalConfirmed: true,
      outcome: 'passed',
      reportSha256: REPORT_DIGEST,
    })
    const taskBefore = structuredClone(h.tasks.get(fixture.ticketId))
    h.runner.collections.set(id, completed(fixture.request, 'passed', OTHER_DIGEST))

    await expect(coordinator(h).reconcile()).rejects.toThrow('Verification report does not match stored completion')

    expect(h.jobs.get(id)).toMatchObject({
      status: 'COMPLETED',
      application: 'pending',
      reportSha256: REPORT_DIGEST,
    })
    expect(h.tasks.get(fixture.ticketId)).toEqual(taskBefore)
  })

  it('rolls back terminal job evidence and Task verification together when application persistence fails', async () => {
    const h = harness()
    const fixture = reserveReviewJob(h, 1)
    const id = fixture.request.verificationId
    const taskBefore = structuredClone(h.tasks.get(fixture.ticketId))
    const taskHistoryBefore = h.store.workflow.history(fixture.ticketId)
    h.store.db.exec(`CREATE TRIGGER fail_verification_application
      BEFORE INSERT ON verification_job_audit
      WHEN NEW.action = 'application_recorded'
      BEGIN
        SELECT RAISE(ABORT, 'forced application audit failure');
      END`)
    h.runner.eventLogs.set(id, [event(fixture.request, 'SUCCEEDED', 1)])
    h.runner.collections.set(id, completed(fixture.request))

    await coordinator(h).tick()

    expect(h.jobs.get(id)).toMatchObject({
      status: 'UNKNOWN',
      lastSequence: 0,
      failureCode: 'EVIDENCE_UNCONFIRMED',
    })
    expect(h.jobs.history(id).some(item => item.action === 'event_applied' || item.action === 'application_recorded')).toBe(false)
    expect(h.store.db.prepare('SELECT count(*) AS count FROM verification_job_event WHERE verification_id = ?').get(id))
      .toEqual({ count: 0 })
    expect(h.tasks.get(fixture.ticketId)).toEqual(taskBefore)
    expect(h.store.workflow.history(fixture.ticketId)).toEqual(taskHistoryBefore)
  })
  it('treats a changed trusted policy as superseded after terminal proof', async () => {
    const h = harness()
    const fixture = reserveReviewJob(h, 1)
    const id = fixture.request.verificationId
    const original = structuredClone(h.tasks.get(fixture.ticketId))
    h.runner.eventLogs.set(id, [event(fixture.request,'STARTING',1),event(fixture.request,'RUNNING',2),event(fixture.request,'SUCCEEDED',3)])
    h.runner.collections.set(id, completed(fixture.request))
    const changedRules = rules().map(rule => ({...rule, priority: rule.priority + 1}))
    const tasks = new LocalTaskService({store:h.store,ownerId:OWNER_ID,workspaceId:WORKSPACE_ID,rules:changedRules})
    await new VerificationCoordinator({store:h.store,tasks,ownerId:OWNER_ID,workspaceId:WORKSPACE_ID,runner:h.runner}).tick()
    expect(h.jobs.get(id)).toMatchObject({status:'COMPLETED',outcome:'passed',application:'superseded'})
    expect(h.tasks.get(fixture.ticketId)).toEqual(original)
  })

})
