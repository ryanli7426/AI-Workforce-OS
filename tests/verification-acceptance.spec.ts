import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createOwnerAuthenticator } from '../src/api/auth.ts'
import { createApiServer } from '../src/api/server.ts'
import { VerificationCoordinator } from '../src/application/verification-coordinator.ts'
import { LocalTaskService } from '../src/application/tasks.ts'
import { ArtifactStore, type ArtifactManifest } from '../src/artifacts/snapshots.ts'
import type { Rule } from '../src/assessor/rules.ts'
import { createSettings, defaultSettings, type LocalSettings } from '../src/config/settings.ts'
import { createVerificationPlans } from '../src/config/verification-plans.ts'
import { ExecutionRepository } from '../src/execution/repository.ts'
import { ProjectRepository } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LocalStore } from '../src/storage/store.ts'
import { VerificationJobRepository } from '../src/storage/verification-jobs.ts'
import { VerificationRunnerClient } from '../src/verification/client.ts'
import type { VerificationCheckRequest } from '../src/verification/local-checks.ts'
import type { VerificationJob, VerificationJobPlan } from '../src/verification/model.ts'

const OWNER = 'owner-acceptance'
const WORKSPACE = 'local'
const PROJECT = 'project-acceptance'
const PLAN_ID = 'acceptance'
const PLAN_REVISION = 'r1'
const TERMINAL_RUNNER_STATES = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'])
const TERMINAL_JOB_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED'])

interface Fixture {
  root: string
  dataDir: string
  dbPath: string
  repository: string
  store: LocalStore
  tasks: LocalTaskService
  settings: LocalSettings
  app: FastifyInstance
  baseUrl: string
  token: string
  ticketId: string
  executionId: string
  artifact: ArtifactManifest
  plan: VerificationJobPlan
  client: VerificationRunnerClient
  coordinator: VerificationCoordinator
}

interface OwnedRunner {
  client: VerificationRunnerClient
  verificationId: string
}

let testRoot: string
const openStores = new Set<LocalStore>()
const openApps = new Set<FastifyInstance>()
const ownedRunners = new Map<string, OwnedRunner>()

function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function waitFor<T>(operation: () => T | Promise<T>, accept: (value: T) => boolean, label: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let last: T | undefined
  while (Date.now() < deadline) {
    try {
      last = await operation()
      if (accept(last)) return last
    } catch {
      // The producer may be between exclusive/atomic file publication steps.
    }
    await delay(25)
  }
  throw new Error(`Timed out waiting for ${label}${last === undefined ? '' : `; last=${JSON.stringify(last)}`}`)
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync('/usr/bin/git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    env: {
      PATH: '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
}

function initializeGitRepository(path: string): { repository: string; baseRevision: string } {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  git(path, ['init', '--quiet'])
  git(path, ['config', 'user.name', 'Verification Acceptance'])
  git(path, ['config', 'user.email', 'verification-acceptance@example.test'])
  writeFileSync(join(path, 'README.md'), 'baseline\n', { mode: 0o600 })
  git(path, ['add', '--', 'README.md'])
  git(path, ['commit', '--quiet', '-m', 'fixture baseline'])
  const baseRevision = git(path, ['rev-parse', 'HEAD'])
  writeFileSync(join(path, 'README.md'), 'candidate artifact\n', { mode: 0o600 })
  return { repository: resolve(path), baseRevision }
}

function rules(): Rule[] {
  return [{
    id: 'documentation',
    enabled: true,
    taskTypes: ['documentation'],
    priority: 10,
    approvalRequired: false,
    reviewRequired: true,
    retryLimit: 1,
  }]
}

function settingsFor(): LocalSettings {
  const base = defaultSettings({ ownerId: OWNER })
  return {
    ...base,
    scheduler: { ...base.scheduler, maxConcurrency: 1 },
    rules: rules(),
  }
}

function openStore(path: string): LocalStore {
  const store = new LocalStore(path)
  openStores.add(store)
  return store
}

function closeStore(store: LocalStore): void {
  if (!openStores.delete(store)) return
  store.close()
}

async function closeApp(app: FastifyInstance): Promise<void> {
  if (!openApps.delete(app)) return
  await app.close()
}

function startCountingWaitCheck(marker: string, release: string): VerificationCheckRequest {
  return {
    id: 'wait-for-release',
    command: process.execPath,
    args: ['-e', [
      "const fs = require('node:fs')",
      'const marker = process.argv[1]',
      'const release = process.argv[2]',
      "fs.appendFileSync(marker, 'start\\n', { mode: 0o600 })",
      'const poll = () => fs.existsSync(release) ? process.exit(0) : setTimeout(poll, 20)',
      'poll()',
    ].join(';'), marker, release],
    timeoutMs: 20_000,
  }
}

function nonzeroCheck(marker: string): VerificationCheckRequest {
  return {
    id: 'real-nonzero',
    command: process.execPath,
    args: ['-e', [
      "const fs = require('node:fs')",
      "fs.appendFileSync(process.argv[1], 'start\\n', { mode: 0o600 })",
      "process.stderr.write('fixture check failed')",
      'process.exit(7)',
    ].join(';'), marker],
    timeoutMs: 5_000,
  }
}

function foreverCheck(marker: string): VerificationCheckRequest {
  return {
    id: 'cancel-after-progress',
    command: process.execPath,
    args: ['-e', [
      "const fs = require('node:fs')",
      "fs.appendFileSync(process.argv[1], 'start\\n', { mode: 0o600 })",
      'setInterval(() => {}, 1_000)',
    ].join(';'), marker],
    timeoutMs: 20_000,
  }
}

async function makeFixture(check: VerificationCheckRequest): Promise<Fixture> {
  const root = testRoot
  const dataDir = realpathSync(join(root, 'data'))
  const dbPath = join(dataDir, 'workforce.sqlite')
  const settings = settingsFor()
  createSettings(join(dataDir, 'settings.json'), settings)
  const plan: VerificationJobPlan = { id: PLAN_ID, revision: PLAN_REVISION, checks: [check] }
  createVerificationPlans(dataDir, { ownerId: OWNER, workspaceId: WORKSPACE }, [plan])

  const store = openStore(dbPath)
  initializeApplicationSchema(store)
  chmodSync(dbPath, 0o600)

  const initialized = initializeGitRepository(join(root, 'project'))
  const worktreeRoot = join(root, 'worktrees')
  mkdirSync(worktreeRoot, { mode: 0o700 })
  new ProjectRepository(store.db).create({
    id: PROJECT,
    workspaceId: WORKSPACE,
    name: 'Acceptance Project',
    ownerId: OWNER,
    repositoryPath: initialized.repository,
    worktreeRoot,
    allowedTaskTypes: ['documentation'],
  })

  const artifactStore = new ArtifactStore({ root: join(dataDir, 'artifacts') })
  const executionId = `exec-${randomBytes(6).toString('hex')}`
  const artifact = await artifactStore.capture({
    artifactId: `artifact-${executionId}`,
    executionId,
    cwd: initialized.repository,
    baseRevision: initialized.baseRevision,
  })

  const tasks = new LocalTaskService({
    store,
    ownerId: OWNER,
    workspaceId: WORKSPACE,
    rules: settings.rules,
  })
  const created = tasks.create({
    issueId: `issue-${randomBytes(5).toString('hex')}`,
    projectId: PROJECT,
    title: 'Verify captured candidate',
    description: 'Deterministic acceptance fixture; no model execution is claimed.',
    taskType: 'documentation',
  })
  const assigned = tasks.engine.assignTask(created.id, 'fixture-worker', 'fixture-runtime', join(worktreeRoot, created.id))
  const assignment = assigned.assignments.at(-1)
  if (!assignment) throw new Error('Fixture assignment was not created')
  tasks.engine.assignmentStarted(created.id, assignment.id)
  tasks.engine.recordExecution(created.id, {
    assignmentId: assignment.id,
    executionId,
    artifactRevision: artifact.revision,
    exitCode: 0,
    terminal: 'success',
    summary: 'Deterministic fixture reached REVIEW',
  })
  expect(tasks.get(created.id)?.lifecycle?.status).toBe('REVIEW')

  const token = randomBytes(32).toString('hex')
  const app = createApiServer({
    store,
    settings,
    authenticator: createOwnerAuthenticator({ token, ownerId: OWNER, workspaceId: WORKSPACE }),
    allowedOrigins: [],
    dataDir,
  })
  openApps.add(app)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address() as AddressInfo
  const baseUrl = `http://127.0.0.1:${address.port}`

  const client = new VerificationRunnerClient({ dataDir })
  const coordinator = new VerificationCoordinator({
    store,
    tasks,
    ownerId: OWNER,
    workspaceId: WORKSPACE,
    runner: client,
    maxConcurrency: 1,
  })
  return {
    root,
    dataDir,
    dbPath,
    repository: initialized.repository,
    store,
    tasks,
    settings,
    app,
    baseUrl,
    token,
    ticketId: created.id,
    executionId,
    artifact,
    plan,
    client,
    coordinator,
  }
}

async function postJson<T>(fixture: Pick<Fixture, 'baseUrl' | 'token'>, path: string, key: string, body: unknown): Promise<{
  status: number
  replayed: string | null
  body: T
}> {
  const response = await fetch(`${fixture.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${fixture.token}`,
      'content-type': 'application/json',
      'idempotency-key': key,
    },
    body: JSON.stringify(body),
  })
  return {
    status: response.status,
    replayed: response.headers.get('idempotency-replayed'),
    body: await response.json() as T,
  }
}

async function enqueue(fixture: Fixture, key = `enqueue-${randomBytes(6).toString('hex')}`): Promise<string> {
  const task = fixture.tasks.get(fixture.ticketId)?.lifecycle
  if (!task?.result) throw new Error('Fixture task has no execution result')
  const payload = {
    expectedVersion: task.version,
    executionId: fixture.executionId,
    artifactRevision: fixture.artifact.revision,
    planId: fixture.plan.id,
    planRevision: fixture.plan.revision,
    reason: 'Owner requested trusted local verification',
  }
  const first = await postJson<{ verificationId: string; replayed: boolean }>(
    fixture,
    `/api/v1/tasks/${fixture.ticketId}/verifications`,
    key,
    payload,
  )
  expect(first.status).toBe(202)
  expect(first.replayed).toBe('false')
  expect(first.body.replayed).toBe(false)
  expect(first.body.verificationId).toMatch(/^v-[a-f0-9-]+$/)

  const replay = await postJson<{ verificationId: string; replayed: boolean }>(
    fixture,
    `/api/v1/tasks/${fixture.ticketId}/verifications`,
    key,
    payload,
  )
  expect(replay.status).toBe(202)
  expect(replay.replayed).toBe('true')
  expect(replay.body).toEqual({ verificationId: first.body.verificationId, replayed: true })
  return first.body.verificationId
}

function trackRunner(client: VerificationRunnerClient, verificationId: string): void {
  ownedRunners.set(verificationId, { client, verificationId })
}

async function waitForRunnerTerminal(client: VerificationRunnerClient, verificationId: string): Promise<void> {
  await waitFor(
    () => client.status(verificationId),
    snapshot => TERMINAL_RUNNER_STATES.has(snapshot.state),
    `runner ${verificationId} terminal state`,
  )
}

async function driveCoordinatorToTerminal(
  coordinator: VerificationCoordinator,
  repository: VerificationJobRepository,
  verificationId: string,
): Promise<VerificationJob> {
  return waitFor(async () => {
    await coordinator.tick()
    const job = repository.get(verificationId)
    if (!job) throw new Error('Verification job disappeared')
    return job
  }, job => TERMINAL_JOB_STATES.has(job.status), `verification job ${verificationId} terminal state`)
}

function startCount(marker: string): number {
  if (!existsSync(marker)) return 0
  return readFileSync(marker, 'utf8').split('\n').filter(Boolean).length
}

beforeEach(() => {
  testRoot = realpathSync(mkdtempSync(join(tmpdir(), 'verification-acceptance-')))
  chmodSync(testRoot, 0o700)
  mkdirSync(join(testRoot, 'data'), { mode: 0o700 })
})

afterEach(async () => {
  let cleanupUnconfirmed = false
  for (const owned of ownedRunners.values()) {
    try {
      const snapshot = await owned.client.status(owned.verificationId)
      if (!TERMINAL_RUNNER_STATES.has(snapshot.state)) {
        await owned.client.stop(owned.verificationId, 'acceptance fixture cleanup')
        await waitForRunnerTerminal(owned.client, owned.verificationId)
      }
      const input = JSON.parse(readFileSync(join(testRoot,'data','verification-inputs',owned.verificationId,'input.json'),'utf8'))
      await owned.client.collect(input.request)
    } catch {
      cleanupUnconfirmed = true
      // Never signal a stored PID. Cleanup is restricted to the authenticated client for this test's runner.
    }
  }
  ownedRunners.clear()
  for (const app of [...openApps]) {
    try { await closeApp(app) } catch { /* already closed */ }
  }
  for (const store of [...openStores]) {
    try { closeStore(store) } catch { /* already closed */ }
  }
  if (cleanupUnconfirmed) throw new Error('Verification fixture stop unconfirmed; preserving private evidence')
  rmSync(testRoot, { recursive: true, force: true })
})

describe('verification acceptance: API + compiled worker + SQLite + Core', () => {
  it('reconciles an independently completed real worker after API and database restart, then allows governed review', async () => {
    const marker = join(testRoot, 'starts.txt')
    const release = join(testRoot, 'fixture.release')
    const fixture = await makeFixture(startCountingWaitCheck(marker, release))
    const assignmentsBefore = fixture.tasks.get(fixture.ticketId)?.assignments.length
    const verificationId = await enqueue(fixture, 'restart-pass')

    const launched = await fixture.coordinator.tick()
    expect(launched.launched).toBe(1)
    trackRunner(fixture.client, verificationId)
    await waitFor(() => startCount(marker), count => count === 1, 'compiled check start marker')
    expect(new ExecutionRepository(fixture.store.db).list()).toEqual([])
    expect(fixture.tasks.get(fixture.ticketId)?.assignments.length).toBe(assignmentsBefore)

    await closeApp(fixture.app)
    closeStore(fixture.store)
    writeFileSync(release, 'release\n', { mode: 0o600 })
    await waitForRunnerTerminal(fixture.client, verificationId)

    const freshStore = openStore(fixture.dbPath)
    const freshTasks = new LocalTaskService({
      store: freshStore,
      ownerId: OWNER,
      workspaceId: WORKSPACE,
      rules: fixture.settings.rules,
    })
    const freshClient = new VerificationRunnerClient({ dataDir: fixture.dataDir })
    ownedRunners.set(verificationId, { client: freshClient, verificationId })
    const freshCoordinator = new VerificationCoordinator({
      store: freshStore,
      tasks: freshTasks,
      ownerId: OWNER,
      workspaceId: WORKSPACE,
      runner: freshClient,
      maxConcurrency: 1,
    })
    const repository = new VerificationJobRepository(freshStore.db)
    await waitFor(async () => {
      await freshCoordinator.reconcile()
      return repository.get(verificationId)
    }, job => job?.status === 'COMPLETED' && job.application === 'applied', 'fresh reconciliation application')

    const job = repository.get(verificationId)!
    expect(job).toMatchObject({ status: 'COMPLETED', outcome: 'passed', application: 'applied' })
    expect(job.reportSha256).toMatch(/^[a-f0-9]{64}$/)
    const reviewed = freshTasks.get(fixture.ticketId)!
    expect(reviewed.lifecycle?.status).toBe('REVIEW')
    expect(reviewed.lifecycle?.result?.verification).toBe('passed')
    const verificationAudit = freshStore.workflow.history(fixture.ticketId).find(entry =>
      entry.kind === 'evidence' && entry.verification === 'passed')
    expect(verificationAudit?.verificationProvenance).toEqual({
      verificationId,
      reportSha256: job.reportSha256,
      planId: PLAN_ID,
      planRevision: PLAN_REVISION,
    })
    expect(repository.history(verificationId).map(entry => entry.action)).toEqual(expect.arrayContaining([
      'reserved',
      'launch_claimed',
      'event_applied',
      'application_recorded',
    ]))
    expect(new ExecutionRepository(freshStore.db).list()).toEqual([])
    expect(reviewed.assignments.length).toBe(assignmentsBefore)

    const result = reviewed.lifecycle!.result!
    const done = freshTasks.review(fixture.ticketId, {
      executionId: result.executionId,
      artifactRevision: result.artifactRevision,
      approved: true,
      reason: 'Owner accepted independently verified fixture output',
    })
    expect(done.lifecycle?.status).toBe('DONE')

    await freshCoordinator.reconcile()
    expect(startCount(marker)).toBe(1)
    expect((await freshClient.status(verificationId)).state).toBe('SUCCEEDED')
  }, 30_000)

  it('records a real nonzero check as a completed failed report, not an infrastructure FAILED job', async () => {
    const marker = join(testRoot, 'nonzero-starts.txt')
    const fixture = await makeFixture(nonzeroCheck(marker))
    const verificationId = await enqueue(fixture, 'nonzero-report')
    trackRunner(fixture.client, verificationId)
    const repository = new VerificationJobRepository(fixture.store.db)
    const job = await driveCoordinatorToTerminal(fixture.coordinator, repository, verificationId)

    expect(startCount(marker)).toBe(1)
    expect(job).toMatchObject({
      status: 'COMPLETED',
      outcome: 'failed',
      application: 'applied',
    })
    expect(job.failureCode).toBeUndefined()
    expect(fixture.tasks.get(fixture.ticketId)?.lifecycle).toMatchObject({
      status: 'REVIEW',
      result: { executionId: fixture.executionId, verification: 'failed' },
    })
    expect((await fixture.client.collect(job.request)).report?.checks[0]).toMatchObject({
      id: 'real-nonzero',
      exitCode: 7,
    })
    expect(new ExecutionRepository(fixture.store.db).list()).toEqual([])
  }, 30_000)

  it('supersedes completion when the live task version is waived, preserving the newer Core evidence', async () => {
    const marker = join(testRoot, 'stale-starts.txt')
    const release = join(testRoot, 'stale.release')
    const fixture = await makeFixture(startCountingWaitCheck(marker, release))
    const verificationId = await enqueue(fixture, 'stale-version')
    await fixture.coordinator.tick()
    trackRunner(fixture.client, verificationId)
    await waitFor(() => startCount(marker), count => count === 1, 'live stale-version check')

    const beforeWaiver = fixture.tasks.get(fixture.ticketId)!.lifecycle!
    const waived = fixture.tasks.verify(fixture.ticketId, {
      executionId: fixture.executionId,
      artifactRevision: fixture.artifact.revision,
      state: 'not_required',
      reason: 'Owner issued a newer explicit waiver while verification was live',
    })
    expect(waived.lifecycle!.version).toBe(beforeWaiver.version + 1)
    const waivedVersion = waived.lifecycle!.version
    writeFileSync(release, 'release\n', { mode: 0o600 })

    const repository = new VerificationJobRepository(fixture.store.db)
    await waitFor(async () => {
      await fixture.coordinator.reconcile()
      return repository.get(verificationId)
    }, job => job?.status === 'COMPLETED' && job.application === 'superseded', 'superseded completion')

    const job = repository.get(verificationId)!
    expect(job).toMatchObject({ status: 'COMPLETED', outcome: 'passed', application: 'superseded' })
    const current = fixture.tasks.get(fixture.ticketId)!.lifecycle!
    expect(current.version).toBe(waivedVersion)
    expect(current.result?.verification).toBe('not_required')
    expect(fixture.store.workflow.history(fixture.ticketId).filter(entry => entry.verification === 'passed')).toEqual([])
    expect(repository.history(verificationId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'application_recorded', reasonCode: 'superseded' }),
    ]))
    expect(startCount(marker)).toBe(1)
  }, 30_000)

  it('authenticates cancellation only after progress proves the real engine entered, then confirms terminal cancellation', async () => {
    const marker = join(testRoot, 'cancel-starts.txt')
    const fixture = await makeFixture(foreverCheck(marker))
    const verificationId = await enqueue(fixture, 'cancel-live')
    await fixture.coordinator.tick()
    trackRunner(fixture.client, verificationId)
    const progressPath = join(fixture.dataDir, 'verification-inputs', verificationId, 'progress.json')
    const progress = await waitFor(() => JSON.parse(readFileSync(progressPath, 'utf8')) as {
      checkId: string
      processId: number
      at: string
    }, value => value.checkId === 'cancel-after-progress' && Number.isSafeInteger(value.processId), 'verification progress.json')
    expect(progress.processId).toBeGreaterThan(1)
    await waitFor(() => startCount(marker), count => count === 1, 'cancellable check marker')

    const repository = new VerificationJobRepository(fixture.store.db)
    const beforeCancel = repository.get(verificationId)!
    const cancelled = await postJson<{ verificationId: string; replayed: boolean }>(
      fixture,
      `/api/v1/verifications/${verificationId}/cancel`,
      'cancel-after-progress',
      { expectedVersion: beforeCancel.version, reason: 'Owner cancelled an entered verification engine' },
    )
    expect(cancelled.status).toBe(202)
    expect(cancelled.replayed).toBe('false')
    expect(cancelled.body).toEqual({ verificationId, replayed: false })

    const job = await driveCoordinatorToTerminal(fixture.coordinator, repository, verificationId)
    expect(job).toMatchObject({ status: 'CANCELLED', failureCode: 'CANCELLED' })
    expect(job.finishedAt).toBeTruthy()
    expect((await fixture.client.collect(job.request))).toMatchObject({
      status: 'cancelled',
      terminalConfirmed: true,
      failureCode: 'CANCELLED',
    })
    expect(fixture.tasks.get(fixture.ticketId)?.lifecycle).toMatchObject({
      status: 'REVIEW',
      result: { verification: 'unknown' },
    })
    expect(startCount(marker)).toBe(1)
    expect(new ExecutionRepository(fixture.store.db).list()).toEqual([])
  }, 30_000)
})
