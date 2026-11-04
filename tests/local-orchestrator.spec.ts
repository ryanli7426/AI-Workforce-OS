import { execFileSync } from 'node:child_process'
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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalOrchestrator } from '../src/application/local-orchestrator.ts'
import { LocalTaskService } from '../src/application/tasks.ts'
import type { Rule } from '../src/assessor/rules.ts'
import { ArtifactStore } from '../src/artifacts/snapshots.ts'
import { latestAssignment } from '../src/core/model.ts'
import { TERMINAL_EXECUTION_STATES } from '../src/execution/model.ts'
import { ExecutionRepository } from '../src/execution/repository.ts'
import { IntentRepository } from '../src/orchestration/intents.ts'
import { RunnerClient } from '../src/runner/client.ts'
import { ProjectRepository, type ProjectCreateInput } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LocalStore } from '../src/storage/store.ts'
import { EmployeeRepository, type EmployeeCreateInput } from '../src/workforce/employees.ts'

const SPEC_DIR = dirname(fileURLToPath(import.meta.url))
const FIXTURE = resolve(SPEC_DIR, 'fixtures/claude-task-cli.mjs')
const WORKER_PATH = resolve(SPEC_DIR, '../dist/runner/worker.js')
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function delay(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    HOME: home,
  }
}

function git(cwd: string, home: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: gitEnv(home), stdio: 'ignore', timeout: 15_000 })
}

function initGitRepo(dir: string, home: string, body = 'hello typoo world\n'): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  git(dir, home, ['init'])
  git(dir, home, ['config', 'user.email', 'orchestrator@example.com'])
  git(dir, home, ['config', 'user.name', 'Orchestrator Test'])
  writeFileSync(join(dir, 'README.md'), body, { mode: 0o600 })
  git(dir, home, ['add', 'README.md'])
  git(dir, home, ['commit', '-m', 'init'])
  return realpathSync(dir)
}

interface RuntimeOverrides {
  id?: string
  command?: string
  timeoutMs?: number
  maxOutputBytes?: number
  graceMs?: number
}

interface Harness {
  root: string
  store: LocalStore
  tasks: LocalTaskService
  projects: ProjectRepository
  employees: EmployeeRepository
  launcher: string
  executions: () => ExecutionRepository
  intents: () => IntentRepository
  createOrchestrator: (overrides?: { maxConcurrency?: number; runtime?: RuntimeOverrides }) => LocalOrchestrator
  seedProject: (overrides?: Partial<ProjectCreateInput>) => ReturnType<ProjectRepository['create']>
  seedEmployee: (overrides?: Partial<EmployeeCreateInput> & { enabled?: boolean }) => void
  reopen: () => void
}

function harness(): Harness {
  chmodSync(FIXTURE, 0o755)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'local-orchestrator-')))
  const dbPath = join(root, 'workforce.sqlite')
  let store = new LocalStore(dbPath)
  initializeApplicationSchema(store)
  const projects = new ProjectRepository(store.db)
  const employees = new EmployeeRepository(store.db)
  const rules: Rule[] = [{
    id: 'docs',
    enabled: true,
    taskTypes: ['docs'],
    priority: 10,
    approvalRequired: true,
    reviewRequired: true,
    retryLimit: 1,
  }]
  let tasks = new LocalTaskService({
    store,
    ownerId: 'owner-1',
    rules,
    workspaceId: 'local',
  })

  const stopActive = async (activeStore: LocalStore) => {
    const repository = new ExecutionRepository(activeStore.db)
    for (const execution of repository.list()) {
      if ((TERMINAL_EXECUTION_STATES as readonly string[]).includes(execution.state)) continue
      try {
        const runnerRoot = join(root, 'runners')
        const { RunnerClient } = await import('../src/runner/client.ts')
        const client = new RunnerClient({
          root: runnerRoot,
          workerPath: WORKER_PATH,
        })
        const snapshot = await client.status(execution.executionId)
        if (!(TERMINAL_EXECUTION_STATES as readonly string[]).includes(snapshot.state)) {
          await client.stop(execution.executionId, 'test cleanup')
          if (snapshot.processId) {
            try { process.kill(-snapshot.processId, 'SIGKILL') } catch { /* ignore */ }
          }
        }
      } catch { /* ignore */ }
    }
  }

  cleanups.push(async () => {
    try { await stopActive(store) } catch { /* ignore */ }
    try { store.close() } catch { /* ignore */ }
    rmSync(root, { recursive: true, force: true })
  })

  const seedProject = (overrides: Partial<ProjectCreateInput> = {}) => {
    const repositoryPath = initGitRepo(join(root, `repo-${Math.random().toString(16).slice(2)}`), root)
    const worktreeRoot = join(root, `worktrees-${Math.random().toString(16).slice(2)}`)
    mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 })
    return projects.create({
      id: 'proj-1',
      workspaceId: 'local',
      name: 'Docs',
      ownerId: 'owner-1',
      repositoryPath,
      worktreeRoot,
      allowedTaskTypes: ['docs'],
      ...overrides,
    })
  }

  const seedEmployee = (overrides: Partial<EmployeeCreateInput> & { enabled?: boolean } = {}) => {
    const { enabled = true, ...rest } = overrides
    const created = employees.create({
      id: 'emp-1',
      workspaceId: 'local',
      name: 'Docs Worker',
      role: 'writer',
      responsibilities: ['docs'],
      capabilities: ['docs'],
      runtimeId: 'runtime-local-1',
      projectIds: ['proj-1'],
      maxConcurrency: 1,
      timeoutMs: 5_000,
      ...rest,
    })
    if (enabled) employees.setEnabled(created.id, { expectedVersion: created.version, enabled: true })
  }

  const launcher = join(root, 'claude-fixture')
  writeFileSync(launcher, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FIXTURE)} "$@"\n`, { mode: 0o755 })
  chmodSync(launcher, 0o755)

  const create = (overrides: { maxConcurrency?: number; runtime?: RuntimeOverrides } = {}) => new LocalOrchestrator({
    store,
    tasks,
    runtime: {
      id: overrides.runtime?.id ?? 'runtime-local-1',
      command: overrides.runtime?.command ?? launcher,
      timeoutMs: overrides.runtime?.timeoutMs ?? 5_000,
      maxOutputBytes: overrides.runtime?.maxOutputBytes ?? 256 * 1024,
      ...(overrides.runtime?.graceMs === undefined ? {} : { graceMs: overrides.runtime.graceMs }),
    },
    runnerRoot: join(root, 'runners'),
    artifactRoot: join(root, 'artifacts'),
    maxConcurrency: overrides.maxConcurrency ?? 1,
  })

  return {
    root,
    get store() { return store },
    get tasks() { return tasks },
    projects,
    employees,
    launcher,
    executions: () => new ExecutionRepository(store.db),
    intents: () => new IntentRepository(store.db),
    createOrchestrator: create,
    seedProject,
    seedEmployee,
    reopen() {
      store.close()
      store = new LocalStore(dbPath)
      initializeApplicationSchema(store)
      tasks = new LocalTaskService({
        store,
        ownerId: 'owner-1',
        rules,
        workspaceId: 'local',
      })
    },
  }
}

async function tickUntil(
  orch: LocalOrchestrator,
  tasks: LocalTaskService,
  ticketId: string,
  status: string,
  timeoutMs = 10_000,
): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    await orch.tick()
    if (tasks.get(ticketId)?.lifecycle?.status === status) return
    await delay(40)
  }
  throw new Error(`timed out waiting for ${ticketId} to reach ${status} (have ${tasks.get(ticketId)?.lifecycle?.status})`)
}

describe('LocalOrchestrator closed loop', () => {
  it('create → approval → queue → tick → RUNNING → file change → REVIEW, then explicit verify/review → DONE', async () => {
    const h = harness()
    h.seedProject()
    h.seedEmployee()
    const created = h.tasks.create({
      issueId: 'issue-1',
      projectId: 'proj-1',
      title: 'Fix typo',
      description: 'Correct README typoo. FIXTURE_MODE=success',
      taskType: 'docs',
    })
    expect(created.lifecycle?.status).toBe('WAITING_APPROVAL')
    const queued = h.tasks.approve(created.id, 'Owner approved docs fix')
    expect(queued.lifecycle?.status).toBe('QUEUED')

    const orch = h.createOrchestrator()
    await tickUntil(orch, h.tasks, created.id, 'REVIEW')
    const reviewed = h.tasks.get(created.id)!
    expect(reviewed.lifecycle?.status).toBe('REVIEW')
    expect(reviewed.lifecycle?.result?.terminal).toBe('success')
    expect(reviewed.lifecycle?.result?.artifactRevision).toMatch(/^[a-f0-9]{64}$/)

    const assignment = latestAssignment(reviewed)!
    const cwd = assignment.worktreePath!
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toContain('typo')
    expect(readFileSync(join(cwd, 'README.md'), 'utf8')).not.toContain('typoo')

    const result = reviewed.lifecycle!.result!
    h.tasks.verify(created.id, {
      executionId: result.executionId,
      artifactRevision: result.artifactRevision,
      state: 'not_required',
      reason: 'Docs-only change waived',
    })
    const done = h.tasks.review(created.id, {
      executionId: result.executionId,
      artifactRevision: result.artifactRevision,
      approved: true,
      reason: 'Looks good',
    })
    expect(done.lifecycle?.status).toBe('DONE')
  })

  it('enforces global concurrency of one across two queued tasks', async () => {
    const h = harness()
    h.seedProject()
    h.seedEmployee({ maxConcurrency: 2 })
    const first = h.tasks.create({
      issueId: 'issue-a',
      projectId: 'proj-1',
      title: 'A',
      description: 'FIXTURE_MODE=wait FIXTURE_WAIT_MS=800',
      taskType: 'docs',
    })
    const second = h.tasks.create({
      issueId: 'issue-b',
      projectId: 'proj-1',
      title: 'B',
      description: 'FIXTURE_MODE=wait FIXTURE_WAIT_MS=800',
      taskType: 'docs',
    })
    h.tasks.approve(first.id, 'go')
    h.tasks.approve(second.id, 'go')

    const orch = h.createOrchestrator({ maxConcurrency: 1 })
    const firstTick = await orch.tick()
    expect(firstTick.assigned).toBe(1)
    await delay(80)
    await orch.tick()
    const statuses = [h.tasks.get(first.id)!.lifecycle!.status, h.tasks.get(second.id)!.lifecycle!.status]
    expect(statuses.filter(status => status === 'QUEUED')).toHaveLength(1)
    expect(statuses.some(status => status === 'ASSIGNED' || status === 'RUNNING')).toBe(true)
  })

  it('schedules higher assessed lifecycle priority before lower priority', async () => {
    const h = harness()
    h.seedProject()
    h.seedEmployee({ maxConcurrency: 2 })
    const low = h.tasks.create({
      issueId: 'issue-low',
      projectId: 'proj-1',
      title: 'Low',
      description: 'FIXTURE_MODE=wait FIXTURE_WAIT_MS=2000',
      taskType: 'docs',
      priority: 1,
    })
    const high = h.tasks.create({
      issueId: 'issue-high',
      projectId: 'proj-1',
      title: 'High',
      description: 'FIXTURE_MODE=wait FIXTURE_WAIT_MS=2000',
      taskType: 'docs',
      priority: 10,
    })
    expect(low.lifecycle?.issue.priority).toBe(1)
    expect(high.lifecycle?.issue.priority).toBe(10)
    h.tasks.approve(low.id, 'go')
    h.tasks.approve(high.id, 'go')

    const orch = h.createOrchestrator({ maxConcurrency: 1 })
    const tick = await orch.tick()
    expect(tick.assigned).toBe(1)
    expect(h.tasks.get(high.id)?.lifecycle?.status).not.toBe('QUEUED')
    expect(h.tasks.get(low.id)?.lifecycle?.status).toBe('QUEUED')
  })

  it('does not launch a cancelled queued task and stops a starting task', async () => {
    const h = harness()
    h.seedProject()
    h.seedEmployee()
    const queued = h.tasks.create({
      issueId: 'issue-queued',
      projectId: 'proj-1',
      title: 'Queued cancel',
      description: 'FIXTURE_MODE=success',
      taskType: 'docs',
    })
    h.tasks.approve(queued.id, 'go')
    h.tasks.cancel(queued.id, 'Cancel before schedule')
    const orch = h.createOrchestrator()
    const tick = await orch.tick()
    expect(tick.assigned).toBe(0)
    expect(h.tasks.get(queued.id)?.lifecycle?.status).toBe('CANCELLED')
    expect(h.executions().list()).toEqual([])

    const starting = h.tasks.create({
      issueId: 'issue-start',
      projectId: 'proj-1',
      title: 'Starting cancel',
      description: 'FIXTURE_MODE=wait FIXTURE_WAIT_MS=5000',
      taskType: 'docs',
    })
    h.tasks.approve(starting.id, 'go')
    await orch.tick()
    await delay(80)
    await orch.tick()
    expect(['ASSIGNED', 'RUNNING']).toContain(h.tasks.get(starting.id)?.lifecycle?.status)
    h.tasks.cancel(starting.id, 'Cancel while starting')
    const startedAt = Date.now()
    while (Date.now() - startedAt < 8_000) {
      await orch.tick()
      const status = h.tasks.get(starting.id)?.lifecycle?.status
      if (status === 'CANCELLED') break
      await delay(50)
    }
    expect(h.tasks.get(starting.id)?.lifecycle?.status).toBe('CANCELLED')
    expect(latestAssignment(h.tasks.get(starting.id)!)?.state).toBe('ended')
  })

  it('cancellation race during launch skips spawn and ends the assignment', async () => {
    const h = harness()
    const project = h.seedProject()
    h.seedEmployee()
    const ticket = h.tasks.create({
      issueId: 'issue-launch-race',
      projectId: 'proj-1',
      title: 'Launch race',
      description: 'FIXTURE_MODE=success',
      taskType: 'docs',
    })
    h.tasks.approve(ticket.id, 'go')
    const executionId = 'exec-cancel-race-1'
    const cwd = join(project.worktreeRoot, executionId)
    h.tasks.engine.assignTask(ticket.id, 'emp-1', 'claude-code', cwd)
    expect(h.tasks.get(ticket.id)?.lifecycle?.status).toBe('ASSIGNED')
    h.tasks.cancel(ticket.id, 'Cancel after assign before launch dispatch')
    expect(h.tasks.get(ticket.id)?.lifecycle?.cancelRequested).toBeTruthy()

    const orch = h.createOrchestrator()
    await orch.tick()
    expect(h.tasks.get(ticket.id)?.lifecycle?.status).toBe('CANCELLED')
    expect(latestAssignment(h.tasks.get(ticket.id)!)?.state).toBe('ended')
    expect(h.executions().list()).toEqual([])
    expect(existsSync(join(cwd, '.fixture-launch-count'))).toBe(false)
  })

  it('confirms cancellation after spawn before Core has observed the process start', async () => {
    const h = harness()
    h.seedProject()
    h.seedEmployee()
    const ticket = h.tasks.create({
      issueId: 'late-core-start', projectId: 'proj-1', title: 'Late observation',
      description: 'FIXTURE_MODE=delayed-success FIXTURE_DELAY_MS=1800', taskType: 'docs',
    })
    h.tasks.approve(ticket.id, 'go')
    // Model a controller crash between durable Runner start and the Core callback.
    const delayedCallback = vi.spyOn(h.tasks.engine, 'assignmentStarted').mockImplementation(() => {})
    const orch = h.createOrchestrator()
    try {
      await orch.tick()
      expect(h.tasks.get(ticket.id)?.lifecycle?.status).toBe('ASSIGNED')
      expect(h.executions().list()).toHaveLength(1)
      h.tasks.cancel(ticket.id, 'Cancel during observation gap')
    } finally {
      delayedCallback.mockRestore()
    }
    await tickUntil(orch, h.tasks, ticket.id, 'CANCELLED', 8_000)
    expect(latestAssignment(h.tasks.get(ticket.id)!)?.state).toBe('ended')
    expect(TERMINAL_EXECUTION_STATES).toContain(h.executions().list()[0]!.state)
    expect(h.tasks.get(ticket.id)?.lifecycle?.result).toBeUndefined()
  })

  it('marks nonzero and permission-denial fixture outcomes as FAILED', async () => {
    const h = harness()
    h.seedProject()
    h.seedEmployee()
    const orch = h.createOrchestrator()

    const nonzero = h.tasks.create({
      issueId: 'issue-nonzero',
      projectId: 'proj-1',
      title: 'Nonzero',
      description: 'FIXTURE_MODE=nonzero',
      taskType: 'docs',
    })
    h.tasks.approve(nonzero.id, 'go')
    await tickUntil(orch, h.tasks, nonzero.id, 'FAILED')
    expect(h.tasks.get(nonzero.id)?.lifecycle?.result?.terminal).toBe('error')

    const denial = h.tasks.create({
      issueId: 'issue-denial',
      projectId: 'proj-1',
      title: 'Denial',
      description: 'FIXTURE_MODE=denial',
      taskType: 'docs',
    })
    h.tasks.approve(denial.id, 'go')
    await tickUntil(orch, h.tasks, denial.id, 'FAILED')
    expect(h.tasks.get(denial.id)?.lifecycle?.result?.terminal).toBe('error')
  })

  it('process startup failure ends assignment as FAILED without auto-retry', async () => {
    const h = harness()
    h.seedProject()
    h.seedEmployee()
    const ticket = h.tasks.create({
      issueId: 'issue-startup',
      projectId: 'proj-1',
      title: 'Startup fail',
      description: 'FIXTURE_MODE=success',
      taskType: 'docs',
    })
    h.tasks.approve(ticket.id, 'go')
    const missing = join(h.root, 'missing-claude-binary')
    const orch = h.createOrchestrator({
      runtime: { command: missing, graceMs: 5_000 },
    })
    await tickUntil(orch, h.tasks, ticket.id, 'FAILED', 12_000)
    const failed = h.tasks.get(ticket.id)!
    expect(failed.lifecycle?.status).toBe('FAILED')
    expect(latestAssignment(failed)?.state).toBe('ended')
    expect(h.executions().list()).toHaveLength(1)
    expect(h.executions().list()[0]?.startedAt).toBeUndefined()

    await orch.tick()
    expect(h.tasks.get(ticket.id)?.lifecycle?.status).toBe('FAILED')
    expect(h.executions().list()).toHaveLength(1)
    expect(h.intents().list().filter(intent => intent.kind === 'launch' && intent.status === 'PENDING')).toEqual([])
  })

  it('does not double-launch after restarting the orchestrator control object', async () => {
    const h = harness()
    h.seedProject()
    h.seedEmployee()
    const ticket = h.tasks.create({
      issueId: 'issue-once',
      projectId: 'proj-1',
      title: 'Once',
      description: 'FIXTURE_MODE=count',
      taskType: 'docs',
    })
    h.tasks.approve(ticket.id, 'go')

    const first = h.createOrchestrator()
    await first.tick()
    await delay(100)
    h.reopen()
    const second = h.createOrchestrator()
    await second.tick()
    await tickUntil(second, h.tasks, ticket.id, 'REVIEW')

    const cwd = latestAssignment(h.tasks.get(ticket.id)!)!.worktreePath!
    const lines = readFileSync(join(cwd, '.fixture-launch-count'), 'utf8').trim().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(h.executions().list()).toHaveLength(1)
  })

  it('does not schedule disabled employees, missing capabilities, or foreign projects', async () => {
    const h = harness()
    h.seedProject({ id: 'proj-1' })
    h.seedProject({ id: 'proj-foreign', name: 'Foreign', allowedTaskTypes: ['docs'] })
    h.seedEmployee({ id: 'emp-disabled', enabled: false })
    h.employees.create({
      id: 'emp-nocap',
      workspaceId: 'local',
      name: 'No Cap',
      role: 'writer',
      responsibilities: ['docs'],
      capabilities: ['feature'],
      runtimeId: 'runtime-local-1',
      projectIds: ['proj-1'],
      maxConcurrency: 1,
      timeoutMs: 5_000,
    })
    h.employees.setEnabled('emp-nocap', { expectedVersion: 1, enabled: true })
    h.employees.create({
      id: 'emp-foreign',
      workspaceId: 'local',
      name: 'Foreign Only',
      role: 'writer',
      responsibilities: ['docs'],
      capabilities: ['docs'],
      runtimeId: 'runtime-local-1',
      projectIds: ['proj-foreign'],
      maxConcurrency: 1,
      timeoutMs: 5_000,
    })
    h.employees.setEnabled('emp-foreign', { expectedVersion: 1, enabled: true })

    const ticket = h.tasks.create({
      issueId: 'issue-skip',
      projectId: 'proj-1',
      title: 'Skip',
      description: 'FIXTURE_MODE=success',
      taskType: 'docs',
    })
    h.tasks.approve(ticket.id, 'go')
    const orch = h.createOrchestrator()
    const tick = await orch.tick()
    expect(tick.assigned).toBe(0)
    expect(h.tasks.get(ticket.id)?.lifecycle?.status).toBe('QUEUED')
    expect(h.intents().list()).toEqual([])
  })

  it('retains UNKNOWN occupancy and rejects concurrent duplicate tick', async () => {
    const h = harness()
    h.seedProject()
    h.seedEmployee()
    const ticket = h.tasks.create({
      issueId: 'issue-unknown',
      projectId: 'proj-1',
      title: 'Unknown',
      description: 'FIXTURE_MODE=wait FIXTURE_WAIT_MS=20000',
      taskType: 'docs',
    })
    h.tasks.approve(ticket.id, 'go')
    const orch = h.createOrchestrator()

    const pending = orch.tick()
    await expect(orch.tick()).rejects.toThrow(/not reentrant/i)
    await pending

    await delay(120)
    await orch.tick()
    const execution = h.executions().list()[0]
    expect(execution).toBeTruthy()
    const { RunnerClient } = await import('../src/runner/client.ts')
    const client = new RunnerClient({
      root: join(h.root, 'runners'),
      workerPath: WORKER_PATH,
    })
    let snapshot = await client.status(execution!.executionId)
    for (let i = 0; !snapshot.runnerPid && i < 100; i++) {
      await delay(20)
      snapshot = await client.status(execution!.executionId)
    }
    process.kill(snapshot.runnerPid, 'SIGKILL')
    await delay(120)
    const reconciled = await orch.reconcile()
    expect(reconciled.assigned).toBe(0)
    expect(reconciled.dispatched).toBe(0)
    expect(reconciled.unknown).toBeGreaterThanOrEqual(1)
    expect(h.executions().get(execution!.executionId)?.state).toBe('UNKNOWN')

    const other = h.tasks.create({
      issueId: 'issue-blocked-by-unknown',
      projectId: 'proj-1',
      title: 'Blocked',
      description: 'FIXTURE_MODE=success',
      taskType: 'docs',
    })
    h.tasks.approve(other.id, 'go')
    const after = await orch.tick()
    expect(after.assigned).toBe(0)
    expect(h.tasks.get(other.id)?.lifecycle?.status).toBe('QUEUED')
  })

  it('honors runtime graceMs and resolves the worker without depending on caller cwd', async () => {
    const h = harness()
    h.seedProject()
    h.seedEmployee()
    const ticket = h.tasks.create({
      issueId: 'issue-cwd',
      projectId: 'proj-1',
      title: 'Cwd independent',
      description: 'FIXTURE_MODE=wait FIXTURE_WAIT_MS=2500',
      taskType: 'docs',
    })
    h.tasks.approve(ticket.id, 'go')

    const previousCwd = process.cwd()
    const unrelated = mkdtempSync(join(tmpdir(), 'orchestrator-cwd-'))
    try {
      process.chdir(unrelated)
      const orch = h.createOrchestrator({ runtime: { graceMs: 2_500 } })
      await orch.tick()
      await delay(120)
      await orch.tick()
      const execution = h.executions().list()[0]
      expect(execution).toBeTruthy()
      const request = JSON.parse(readFileSync(join(h.root, 'runners', execution!.executionId, 'request.json'), 'utf8')) as {
        spec: { graceMs: number; command: string }
      }
      expect(request.spec.graceMs).toBe(2_500)
      expect(request.spec.command).toBe(h.launcher)
      expect(['ASSIGNED', 'RUNNING']).toContain(h.tasks.get(ticket.id)?.lifecycle?.status)
    } finally {
      process.chdir(previousCwd)
      rmSync(unrelated, { recursive: true, force: true })
    }
  })

  it('retains cancelled UNKNOWN execution ownership when a launch intent is replayed', async () => {
    const h = harness()
    h.seedProject()
    h.seedEmployee()
    const ticket = h.tasks.create({
      issueId: 'unknown-replay-cancel', projectId: 'proj-1', title: 'Uncertain launch replay',
      description: 'FIXTURE_MODE=wait FIXTURE_WAIT_MS=20000', taskType: 'docs',
    })
    h.tasks.approve(ticket.id, 'go')
    const orch = h.createOrchestrator()
    await tickUntil(orch, h.tasks, ticket.id, 'RUNNING', 5_000)
    const execution = h.executions().list()[0]!
    const client = new RunnerClient({ root: join(h.root, 'runners'), workerPath: WORKER_PATH })
    const snapshot = await client.status(execution.executionId)
    process.kill(snapshot.runnerPid, 'SIGKILL')
    await delay(100)
    await orch.reconcile()
    expect(h.executions().get(execution.executionId)?.state).toBe('UNKNOWN')
    h.tasks.cancel(ticket.id, 'Cancellation does not prove process exit')

    // Simulate durable launch replay after the effect occurred but acknowledgement
    // was lost. The existing execution reservation must fence this replay.
    h.store.db.prepare("UPDATE orchestration_intent SET status='PENDING', due_at=0 WHERE id=?")
      .run(`launch:${execution.assignmentId}`)
    const result = await orch.tick()
    expect(result.unknown).toBeGreaterThanOrEqual(1)
    const current = h.tasks.get(ticket.id)!
    expect(current.lifecycle?.cancelRequested).toBeDefined()
    expect(current.lifecycle?.status).not.toBe('CANCELLED')
    expect(latestAssignment(current)?.state).not.toBe('ended')
    expect(h.executions().list()).toHaveLength(1)
  })

  it('rejects replay artifacts with mismatched execution identity and reuses matching ones', async () => {
    const h = harness()
    h.seedProject()
    h.seedEmployee()
    const baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: h.projects.get('proj-1')!.repositoryPath,
      encoding: 'utf8',
      env: gitEnv(h.root),
    }).trim()
    const artifacts = new ArtifactStore({ root: join(h.root, 'artifacts') })
    const orch = h.createOrchestrator()

    const mismatch = h.tasks.create({
      issueId: 'issue-artifact-mismatch',
      projectId: 'proj-1',
      title: 'Mismatch',
      description: 'FIXTURE_MODE=delayed-success FIXTURE_DELAY_MS=1200',
      taskType: 'docs',
    })
    h.tasks.approve(mismatch.id, 'go')
    await tickUntil(orch, h.tasks, mismatch.id, 'RUNNING', 5_000)
    await delay(150)
    const mismatchExecution = h.executions().list().find(item => item.ticketId === mismatch.id)!
    const mismatchCwd = latestAssignment(h.tasks.get(mismatch.id)!)!.worktreePath!
    await artifacts.capture({
      artifactId: `artifact-${mismatchExecution.executionId}`,
      executionId: 'foreign-execution-id',
      cwd: mismatchCwd,
      baseRevision,
    })

    await tickUntil(orch, h.tasks, mismatch.id, 'FAILED', 8_000)
    const failed = h.tasks.get(mismatch.id)!
    expect(failed.lifecycle?.status).toBe('FAILED')
    expect(latestAssignment(failed)?.state).toBe('ended')
    expect(latestAssignment(failed)?.endedReason ?? '').toMatch(/Snapshot failure:.*identity/i)
    expect(failed.lifecycle?.result).toBeUndefined()

    const reuse = h.tasks.create({
      issueId: 'issue-artifact-reuse',
      projectId: 'proj-1',
      title: 'Reuse',
      description: 'FIXTURE_MODE=delayed-success FIXTURE_DELAY_MS=1200',
      taskType: 'docs',
    })
    h.tasks.approve(reuse.id, 'go')
    await tickUntil(orch, h.tasks, reuse.id, 'RUNNING', 5_000)
    await delay(150)
    const reuseExecution = h.executions().list().find(item => item.ticketId === reuse.id)!
    const reuseCwd = latestAssignment(h.tasks.get(reuse.id)!)!.worktreePath!
    // Simulate a crash after snapshot persistence, before Core evidence is saved.
    // The snapshot must represent the terminal worktree, never a running draft.
    const client = new RunnerClient({ root: join(h.root, 'runners'), workerPath: WORKER_PATH })
    const terminalDeadline = Date.now() + 5_000
    while (Date.now() < terminalDeadline) {
      const snapshot = await client.status(reuseExecution.executionId)
      if (TERMINAL_EXECUTION_STATES.includes(snapshot.state)) break
      await delay(25)
    }
    expect((await client.status(reuseExecution.executionId)).state).toBe('SUCCEEDED')
    const matching = await artifacts.capture({
      artifactId: `artifact-${reuseExecution.executionId}`,
      executionId: reuseExecution.executionId,
      cwd: reuseCwd,
      baseRevision,
    })
    await tickUntil(orch, h.tasks, reuse.id, 'REVIEW', 8_000)
    const reviewed = h.tasks.get(reuse.id)!
    expect(reviewed.lifecycle?.status).toBe('REVIEW')
    expect(reviewed.lifecycle?.result?.artifactRevision).toBe(matching.revision)
    expect(reviewed.lifecycle?.result?.executionId).toBe(reuseExecution.executionId)
  }, 25_000)

  it('rejects an artifact captured before the execution finished, even with the same execution ID', async () => {
    const h = harness()
    const project = h.seedProject()
    h.seedEmployee()
    const ticket = h.tasks.create({
      issueId: 'premature-artifact', projectId: project.id, title: 'Draft is not final',
      description: 'FIXTURE_MODE=delayed-success FIXTURE_DELAY_MS=1200', taskType: 'docs',
    })
    h.tasks.approve(ticket.id, 'go')
    const orch = h.createOrchestrator()
    await tickUntil(orch, h.tasks, ticket.id, 'RUNNING', 5_000)
    await delay(100)
    const execution = h.executions().list()[0]!
    const baseRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: project.repositoryPath, encoding: 'utf8', env: gitEnv(h.root), timeout: 5_000,
    }).trim()
    await new ArtifactStore({ root: join(h.root, 'artifacts') }).capture({
      artifactId: `artifact-${execution.executionId}`, executionId: execution.executionId,
      cwd: execution.cwd, baseRevision,
    })
    await tickUntil(orch, h.tasks, ticket.id, 'FAILED', 8_000)
    expect(latestAssignment(h.tasks.get(ticket.id)!)?.endedReason).toMatch(/predates terminal/)
    expect(h.tasks.get(ticket.id)?.lifecycle?.result).toBeUndefined()
  }, 12_000)
})
