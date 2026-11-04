import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalTaskService } from '../src/application/tasks.ts'
import type { Rule } from '../src/assessor/rules.ts'
import type { EngineOptions } from '../src/core/part.ts'
import { IntentRepository } from '../src/orchestration/intents.ts'
import { ProjectRepository, type ProjectCreateInput } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LocalStore } from '../src/storage/store.ts'

const opened: LocalStore[] = []
let root: string
let clock = '2026-11-04T00:00:00.000Z'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-app-'))
  clock = '2026-11-04T00:00:00.000Z'
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
  git(dir, ['config', 'user.email', 'task-app@example.com'])
  git(dir, ['config', 'user.name', 'Task App'])
  writeFileSync(join(dir, 'README'), 'fixture\n', { mode: 0o600 })
  git(dir, ['add', 'README'])
  git(dir, ['commit', '-m', 'init'])
  return resolve(dir)
}

function openStore(path = join(root, 'workforce.sqlite')): LocalStore {
  const store = new LocalStore(path)
  opened.push(store)
  initializeApplicationSchema(store)
  return store
}

function rules(overrides: Partial<Rule> = {}): Rule[] {
  return [{
    id: 'docs',
    enabled: true,
    taskTypes: ['docs'],
    priority: 10,
    approvalRequired: true,
    reviewRequired: true,
    retryLimit: 1,
    ...overrides,
  }]
}

function projectInput(overrides: Partial<ProjectCreateInput> = {}): ProjectCreateInput {
  const repositoryPath = initGitRepo(join(root, `repo-${Math.random().toString(16).slice(2)}`))
  const worktreeRoot = join(root, `worktrees-${Math.random().toString(16).slice(2)}`)
  return {
    id: 'proj-1',
    workspaceId: 'local',
    name: 'Docs',
    ownerId: 'owner-1',
    repositoryPath,
    worktreeRoot,
    allowedTaskTypes: ['docs'],
    ...overrides,
  }
}

function service(store: LocalStore, ruleList: Rule[] = rules(), workspaceId = 'local'): LocalTaskService {
  return new LocalTaskService({
    store,
    ownerId: 'owner-1',
    rules: ruleList,
    workspaceId,
    now: () => clock,
  })
}

function seedProject(store: LocalStore, overrides: Partial<ProjectCreateInput> = {}) {
  return new ProjectRepository(store.db).create(projectInput(overrides))
}

function engineOptions(tasks: LocalTaskService): EngineOptions {
  return (tasks.engine as unknown as { options: EngineOptions }).options
}

describe('LocalTaskService construction', () => {
  it('requires initialized application schemas and snapshots rules for policyVersion', () => {
    const store = new LocalStore(join(root, 'uninit.sqlite'))
    opened.push(store)
    expect(() => new LocalTaskService({ store, ownerId: 'owner-1', rules: rules() })).toThrow(/not initialized/)
    initializeApplicationSchema(store)
    const mutable = rules()
    const tasks = new LocalTaskService({ store, ownerId: 'owner-1', rules: mutable, now: () => clock })
    seedProject(store)
    mutable[0]!.priority = 1
    mutable[0]!.approvalRequired = false
    const ticket = tasks.create({
      issueId: 'issue-1', projectId: 'proj-1', title: 'Fix docs', description: 'Tighten wording', taskType: 'docs', priority: 99,
    })
    expect(ticket.lifecycle?.policy.approvalRequired).toBe(true)
    expect(ticket.lifecycle?.issue.priority).toBe(10)
    expect(ticket.mandate.policyVersion).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('create, approve, and ownership', () => {
  it('creates through approval into queue without launching runtime work', () => {
    const store = openStore()
    seedProject(store)
    const tasks = service(store)
    const ticket = tasks.create({
      issueId: 'issue-1', projectId: 'proj-1', title: 'Fix docs', description: 'Tighten wording', taskType: 'docs',
    })
    expect(ticket.lifecycle?.status).toBe('WAITING_APPROVAL')
    expect(ticket.assignments).toEqual([])
    expect(new IntentRepository(store.db).list()).toEqual([])
    const queued = tasks.approve(ticket.id, 'Owner approved scoped docs edits')
    expect(queued.lifecycle?.status).toBe('QUEUED')
    expect(tasks.get(ticket.id)?.title).toBe('Fix docs')
    expect(tasks.list()).toHaveLength(1)
  })

  it('is idempotent for the same payload and rejects conflicting payloads without partial writes', () => {
    const store = openStore()
    seedProject(store)
    const tasks = service(store)
    const first = tasks.create({
      issueId: 'issue-1', projectId: 'proj-1', title: 'Fix docs', description: 'Tighten wording', taskType: 'docs', priority: 4,
    })
    clock = '2026-11-05T00:00:00.000Z'
    const again = tasks.create({
      issueId: 'issue-1', projectId: 'proj-1', title: 'Fix docs', description: 'Tighten wording', taskType: 'docs', priority: 4,
    })
    expect(again.id).toBe(first.id)
    expect(again.createdAt).toBe(first.createdAt)
    expect(store.tickets.list()).toHaveLength(1)
    expect(store.triggers.get(store.tickets.get(first.id)!.origin.triggerId)?.at).toBe(first.createdAt)

    const beforeTriggers = store.db.prepare('SELECT count(*) AS n FROM trigger').get() as { n: number }
    expect(() => tasks.create({
      issueId: 'issue-1', projectId: 'proj-1', title: 'Changed title', description: 'Tighten wording', taskType: 'docs', priority: 4,
    })).toThrow(/Conflicting/)
    expect(store.tickets.list()).toHaveLength(1)
    expect(store.db.prepare('SELECT count(*) AS n FROM trigger').get()).toEqual(beforeTriggers)
  })

  it('blocks missing, cross-workspace, archived, and disallowed project types without storing tasks', () => {
    const store = openStore()
    seedProject(store, { id: 'proj-1', workspaceId: 'local', allowedTaskTypes: ['docs'] })
    seedProject(store, { id: 'proj-other', workspaceId: 'other', name: 'Other', allowedTaskTypes: ['docs'] })
    const archived = seedProject(store, { id: 'proj-archived', name: 'Archived', allowedTaskTypes: ['docs'] })
    new ProjectRepository(store.db).archive('proj-archived', { expectedVersion: archived.version })
    const tasks = service(store)

    expect(() => tasks.create({
      issueId: 'missing', projectId: 'nope', title: 'x', description: 'y', taskType: 'docs',
    })).toThrow(/Execution is not allowed/)
    expect(() => tasks.create({
      issueId: 'foreign', projectId: 'proj-other', title: 'x', description: 'y', taskType: 'docs',
    })).toThrow(/Execution is not allowed/)
    expect(() => tasks.create({
      issueId: 'archived', projectId: 'proj-archived', title: 'x', description: 'y', taskType: 'docs',
    })).toThrow(/Execution is not allowed/)
    expect(() => tasks.create({
      issueId: 'bad-type', projectId: 'proj-1', title: 'x', description: 'y', taskType: 'feature',
    })).toThrow(/Execution is not allowed|No enabled admission rule/)
    expect(store.tickets.list()).toEqual([])
  })

  it('rejects unknown create fields and caps priority from rules', () => {
    const store = openStore()
    seedProject(store)
    const tasks = service(store)
    expect(() => tasks.create({
      issueId: 'issue-1', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs', actor: 'evil',
    } as never)).toThrow(/Unknown create field/)
    const ticket = tasks.create({
      issueId: 'issue-1', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs', priority: 99,
    })
    expect(ticket.lifecycle?.issue.priority).toBe(10)
  })

  it('rejects cross-workspace task actions', () => {
    const store = openStore()
    seedProject(store, { id: 'proj-a', workspaceId: 'alpha', name: 'A' })
    seedProject(store, { id: 'proj-b', workspaceId: 'beta', name: 'B' })
    const alpha = service(store, rules(), 'alpha')
    const beta = service(store, rules(), 'beta')
    const ticket = alpha.create({
      issueId: 'issue-1', projectId: 'proj-a', title: 't', description: 'd', taskType: 'docs',
    })
    expect(beta.get(ticket.id)).toBeUndefined()
    expect(beta.list()).toEqual([])
    expect(() => beta.approve(ticket.id, 'nope')).toThrow(/Cross-workspace/)
  })
})

describe('intent executor ports', () => {
  it('enqueues launch intents inside the engine transaction and rolls them back together', () => {
    const store = openStore()
    seedProject(store)
    const tasks = service(store, rules({ approvalRequired: false }))
    const ticket = tasks.create({
      issueId: 'issue-1', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs',
    })
    expect(ticket.lifecycle?.status).toBe('QUEUED')

    expect(() => store.atomic(() => {
      tasks.engine.assignTask(ticket.id, 'claude-local', 'claude-code', join(root, 'work', ticket.id))
      throw new Error('force-rollback')
    })).toThrow('force-rollback')

    expect(new IntentRepository(store.db).list()).toEqual([])
    expect(store.tickets.get(ticket.id)?.lifecycle?.status).toBe('QUEUED')
    expect(store.tickets.get(ticket.id)?.assignments).toEqual([])

    const assigned = tasks.engine.assignTask(ticket.id, 'claude-local', 'claude-code', join(root, 'work', ticket.id))
    const assignment = assigned.assignments.at(-1)!
    const intents = new IntentRepository(store.db).list()
    expect(intents).toHaveLength(1)
    expect(intents[0]).toMatchObject({
      id: `launch:${assignment.id}`,
      kind: 'launch',
      key: assignment.id,
      generation: 1,
      status: 'PENDING',
      payload: {
        ticketId: ticket.id,
        assignmentId: assignment.id,
        agentId: 'claude-local',
        runtime: 'claude-code',
        cwd: join(root, 'work', ticket.id),
        generation: 1,
      },
    })
  })

  it('enqueues stop intents on cancel and keeps the assignment until confirmed', () => {
    const store = openStore()
    seedProject(store)
    const tasks = service(store, rules({ approvalRequired: false }))
    const ticket = tasks.create({
      issueId: 'issue-1', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs',
    })
    const assigned = tasks.engine.assignTask(ticket.id, 'claude-local', 'claude-code', join(root, 'work', ticket.id))
    const assignmentId = assigned.assignments.at(-1)!.id
    tasks.engine.assignmentStarted(ticket.id, assignmentId)

    const cancelled = tasks.cancel(ticket.id, 'No longer needed')
    expect(cancelled.lifecycle?.cancelRequested?.actor).toBe('owner-1')
    const stop = new IntentRepository(store.db).list().find(item => item.kind === 'stop')
    expect(stop).toMatchObject({
      id: `stop:${assignmentId}`,
      key: assignmentId,
      payload: { ticketId: ticket.id, assignmentId, reason: 'No longer needed' },
    })
    expect(store.tickets.get(ticket.id)?.assignments.at(-1)?.state).toBe('running')
  })

  it('throws explicit unsupported on deliver rather than pretending sent', () => {
    const store = openStore()
    seedProject(store)
    const tasks = service(store, rules({ approvalRequired: false }))
    const ticket = tasks.create({
      issueId: 'issue-1', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs',
    })
    const assigned = tasks.engine.assignTask(ticket.id, 'claude-local', 'claude-code', join(root, 'work', ticket.id))
    const assignment = assigned.assignments.at(-1)!
    expect(() => engineOptions(tasks).executor.deliver(ticket, assignment)).toThrow(/unsupported/i)
  })
})

describe('verify and review stay owner-bound evidence checks', () => {
  it('records verification and review through Core without auto-DONE on create', () => {
    const store = openStore()
    seedProject(store)
    const tasks = service(store, rules({ approvalRequired: false, reviewRequired: true }))
    const created = tasks.create({
      issueId: 'issue-1', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs',
    })
    expect(created.lifecycle?.status).toBe('QUEUED')
    const assigned = tasks.engine.assignTask(created.id, 'claude-local', 'claude-code', join(root, 'work', created.id))
    const assignmentId = assigned.assignments.at(-1)!.id
    tasks.engine.assignmentStarted(created.id, assignmentId)
    const reviewed = tasks.engine.recordExecution(created.id, {
      assignmentId,
      executionId: `execution-${assignmentId}`,
      artifactRevision: 'sha:abc',
      exitCode: 0,
      terminal: 'success',
      summary: 'Updated README',
    })
    expect(reviewed.lifecycle?.status).toBe('REVIEW')
    tasks.verify(created.id, {
      executionId: `execution-${assignmentId}`,
      artifactRevision: 'sha:abc',
      state: 'not_required',
      reason: 'Documentation-only change; CI explicitly not required',
    })
    const done = tasks.review(created.id, {
      executionId: `execution-${assignmentId}`,
      artifactRevision: 'sha:abc',
      approved: true,
      reason: 'Looks good',
    })
    expect(done.lifecycle?.status).toBe('DONE')
  })
})
