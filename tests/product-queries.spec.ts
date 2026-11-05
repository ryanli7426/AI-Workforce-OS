import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProductQueries } from '../src/application/product-queries.ts'
import { LocalTaskService } from '../src/application/tasks.ts'
import type { Rule } from '../src/assessor/rules.ts'
import type { Ticket } from '../src/core/model.ts'
import type { ExecutionState } from '../src/execution/model.ts'
import { ExecutionRepository } from '../src/execution/repository.ts'
import { ProjectRepository, type ProjectCreateInput } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LocalStore } from '../src/storage/store.ts'
import { EmployeeRepository, type EmployeeCreateInput } from '../src/workforce/employees.ts'

let root: string
const opened: { close(): void }[] = []

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'product-queries-')) })
afterEach(() => {
  for (const item of opened.splice(0)) { try { item.close() } catch { /* already closed */ } }
  rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, {
    cwd,
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: root,
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    },
    stdio: 'ignore', timeout: 15_000,
  })
}

function gitRepository(name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  git(path, ['init'])
  git(path, ['config', 'user.email', 'queries@example.com'])
  git(path, ['config', 'user.name', 'Queries Test'])
  writeFileSync(join(path, 'README.md'), '# fixture\n')
  git(path, ['add', 'README.md'])
  git(path, ['commit', '-m', 'fixture'])
  return resolve(path)
}

function openStore(path: string): LocalStore {
  const store = new LocalStore(path)
  opened.push(store)
  initializeApplicationSchema(store)
  return store
}

function close(item: { close(): void }): void {
  item.close()
  opened.splice(opened.indexOf(item), 1)
}

function project(store: LocalStore, id: string, ownerId = 'owner-1', workspaceId = 'local') {
  const input: ProjectCreateInput = {
    id, workspaceId, ownerId, name: `${workspaceId}-${id}`,
    repositoryPath: gitRepository(`repo-${workspaceId}-${id}`),
    worktreeRoot: join(root, `worktrees-${workspaceId}-${id}`),
    allowedTaskTypes: ['docs'],
  }
  return new ProjectRepository(store.db).create(input)
}

function employee(store: LocalStore, id: string, enabled: boolean) {
  const input: EmployeeCreateInput = {
    id, workspaceId: 'local', name: id, role: 'Writer', responsibilities: ['docs'], capabilities: ['editing'],
    runtimeId: 'runtime-local', projectIds: ['project-a'], maxConcurrency: 2, timeoutMs: 60_000,
  }
  const repository = new EmployeeRepository(store.db)
  const created = repository.create(input)
  return enabled ? repository.setEnabled(id, { expectedVersion: created.version, enabled: true }) : created
}

const rules: Rule[] = [{
  id: 'docs', enabled: true, taskTypes: ['docs'], priority: 10,
  approvalRequired: false, reviewRequired: true, retryLimit: 1,
}]

function service(store: LocalStore, ownerId = 'owner-1', workspaceId = 'local') {
  return new LocalTaskService({ store, ownerId, workspaceId, rules, now: () => '2026-11-05T00:00:00.000Z' })
}

function createTask(tasks: LocalTaskService, issueId: string, projectId: string) {
  return tasks.create({ issueId, projectId, title: `Task ${issueId}`, description: `Description ${issueId}`, taskType: 'docs' })
}

function reserveExecution(
  store: LocalStore,
  ticket: Ticket,
  executionId: string,
  agentId: string,
  state: Extract<ExecutionState, 'STARTING' | 'RUNNING' | 'FAILED' | 'UNKNOWN'> = 'STARTING',
) {
  const executions = new ExecutionRepository(store.db)
  const record = executions.reserve({
    executionId, assignmentId: `assignment-${executionId}`, ticketId: ticket.id, agentId,
    runtime: 'local-runner', generation: 1, cwd: join(root, executionId), inputRevision: `revision-${executionId}`,
    policyVersion: ticket.lifecycle!.policyVersion,
  })
  if (state === 'RUNNING') {
    return executions.apply({
      executionId, generation: 1, sequence: 1, at: '2026-11-05T00:00:01.000Z', state, runnerId: 'runner-a',
    })
  }
  if (state === 'FAILED') {
    return executions.apply({
      executionId, generation: 1, sequence: 1, at: '2026-11-05T00:00:01.000Z', state, runnerId: 'runner-a',
      reason: 'fixture startup failure',
    })
  }
  if (state === 'UNKNOWN') return executions.markUnknown(executionId, 'fixture ownership is unknown')
  return record
}

function readonlyQueries(path: string, ownerId = 'owner-1') {
  const db = new DatabaseSync(path, { readOnly: true })
  opened.push(db)
  return { db, queries: ProductQueries({ db, ownerId, workspaceId: 'local' }) }
}

function fingerprint(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

describe('ProductQueries', () => {
  it('returns initialized empty read models without changing database bytes', () => {
    const path = join(root, 'empty.sqlite')
    const store = openStore(path)
    close(store)
    const before = fingerprint(path)
    const { queries } = readonlyQueries(path)

    const overview = queries.overview()
    expect(overview.tasks.total).toBe(0)
    expect(Object.values(overview.tasks.byStatus).every(value => value === 0)).toBe(true)
    expect(overview.employees).toEqual({ configured: 0, enabled: 0, busy: 0 })
    expect(overview.executions).toEqual({ total: 0, active: 0, unknown: 0 })
    expect(queries.tasks()).toEqual({ items: [] })
    expect(queries.executions()).toEqual({ items: [] })
    expect(queries.execution('missing-execution')).toBeUndefined()
    expect(queries.employees()).toEqual([])
    expect(queries.projects()).toEqual([])
    expect(fingerprint(path)).toBe(before)
  })

  it('scopes before pagination and counts by mandate owner, and uses only the latest assignment employee', () => {
    const path = join(root, 'scope.sqlite')
    const store = openStore(path)
    project(store, 'project-a')
    project(store, 'project-b')
    project(store, 'foreign-project', 'owner-2')
    employee(store, 'employee-a', true)
    employee(store, 'employee-b', false)
    const tasks = service(store)
    const foreignTasks = service(store, 'owner-2')
    const owned: string[] = []
    for (let index = 0; index < 6; index++) {
      const ticket = createTask(tasks, `owned-${index}`, index % 2 ? 'project-a' : 'project-b')
      ticket.assignments = [
        { id: `old-${index}`, state: 'ended', createdAt: ticket.createdAt, agentId: 'employee-b' },
        { id: `new-${index}`, state: 'pending', createdAt: ticket.updatedAt, agentId: 'employee-a' },
      ]
      store.tickets.save(ticket)
      owned.push(ticket.id)
      createTask(foreignTasks, `foreign-${index}`, 'foreign-project')
    }
    close(store)

    const { queries } = readonlyQueries(path)
    const first = queries.tasks({ limit: 2, employeeId: 'employee-a' })
    const second = queries.tasks({ limit: 2, employeeId: 'employee-a', beforeRowid: first.nextCursor })
    const third = queries.tasks({ limit: 2, employeeId: 'employee-a', beforeRowid: second.nextCursor })
    expect([...first.items, ...second.items, ...third.items].map(item => item.id)).toEqual([...owned].reverse())
    expect(queries.tasks({ employeeId: 'employee-b' }).items).toEqual([])
    expect(queries.tasks({ projectId: 'project-a' }).items).toHaveLength(3)
    expect(queries.overview().tasks.total).toBe(6)
  })

  it('scopes executions before pagination and counts using the same owner, workspace and source-actor invariants as task get', () => {
    const path = join(root, 'execution-scope.sqlite')
    const store = openStore(path)
    project(store, 'project-a')
    project(store, 'remote-project', 'owner-3', 'remote')
    const ownedTasks = service(store)
    const foreignOwnerTasks = service(store, 'owner-2')
    const remoteTasks = service(store, 'owner-3', 'remote')

    const ownedOld = createTask(ownedTasks, 'owned-old', 'project-a')
    reserveExecution(store, ownedOld, 'execution-owned-old', 'employee-a')
    const foreignOld = createTask(foreignOwnerTasks, 'foreign-old', 'project-a')
    reserveExecution(store, foreignOld, 'execution-foreign-old', 'employee-a')
    const ownedMiddle = createTask(ownedTasks, 'owned-middle', 'project-a')
    reserveExecution(store, ownedMiddle, 'execution-owned-middle', 'employee-a')
    const remote = createTask(remoteTasks, 'remote', 'remote-project')
    reserveExecution(store, remote, 'execution-remote', 'employee-a')
    const mismatchedActor = createTask(ownedTasks, 'mismatched-actor', 'project-a')
    mismatchedActor.mandate.actor.source = 'manual:local:other-project'
    store.tickets.save(mismatchedActor)
    reserveExecution(store, mismatchedActor, 'execution-mismatched-actor', 'employee-a')
    const ownedNew = createTask(ownedTasks, 'owned-new', 'project-a')
    reserveExecution(store, ownedNew, 'execution-owned-new', 'employee-b')
    const foreignNew = createTask(foreignOwnerTasks, 'foreign-new', 'project-a')
    reserveExecution(store, foreignNew, 'execution-foreign-new', 'employee-a')
    close(store)

    const { queries } = readonlyQueries(path)
    const first = queries.executions({ limit: 2 })
    const second = queries.executions({ limit: 2, beforeRowid: first.nextCursor })
    expect(first.items.map(item => item.executionId)).toEqual(['execution-owned-new', 'execution-owned-middle'])
    expect(first.nextCursor).toEqual(expect.any(Number))
    expect(second).toEqual({ items: [expect.objectContaining({ executionId: 'execution-owned-old' })] })
    expect(queries.overview().executions.total).toBe(3)
    expect(queries.execution('execution-owned-new')?.ticketId).toBe(ownedNew.id)
    expect(queries.execution('execution-foreign-new')).toBeUndefined()
    expect(queries.execution('execution-remote')).toBeUndefined()
    expect(queries.execution('execution-mismatched-actor')).toBeUndefined()
  })

  it('combines execution state, project, employee and ticket filters over descending execution rowids', () => {
    const path = join(root, 'execution-filters.sqlite')
    const store = openStore(path)
    project(store, 'project-a')
    project(store, 'project-b')
    const tasks = service(store)
    const ticketA = createTask(tasks, 'filter-a', 'project-a')
    const ticketB = createTask(tasks, 'filter-b', 'project-a')
    const ticketC = createTask(tasks, 'filter-c', 'project-b')
    const ticketD = createTask(tasks, 'filter-d', 'project-b')
    reserveExecution(store, ticketA, 'execution-filter-a', 'employee-a', 'STARTING')
    reserveExecution(store, ticketB, 'execution-filter-b', 'employee-b', 'RUNNING')
    reserveExecution(store, ticketC, 'execution-filter-c', 'employee-a', 'UNKNOWN')
    reserveExecution(store, ticketD, 'execution-filter-d', 'employee-b', 'FAILED')
    close(store)

    const { queries } = readonlyQueries(path)
    expect(queries.executions({ states: ['RUNNING', 'UNKNOWN'] }).items.map(item => item.executionId))
      .toEqual(['execution-filter-c', 'execution-filter-b'])
    expect(queries.executions({ projectId: 'project-a', employeeId: 'employee-b', states: ['RUNNING'] }).items)
      .toEqual([expect.objectContaining({ executionId: 'execution-filter-b', ticketId: ticketB.id })])
    expect(queries.executions({
      projectId: 'project-b', employeeId: 'employee-a', ticketId: ticketC.id, states: ['UNKNOWN'],
    }).items).toEqual([expect.objectContaining({ executionId: 'execution-filter-c' })])
    expect(queries.executions({ ticketId: ticketA.id, states: ['FAILED'] })).toEqual({ items: [] })
  })

  it('matches LocalTaskService visibility when project business ownership differs from the workspace owner', () => {
    const path = join(root, 'project-owner.sqlite')
    const store = openStore(path)
    project(store, 'project-a', 'project-business-owner')
    const tasks = service(store)
    const ticket = createTask(tasks, 'issue-a', 'project-a')
    const executions = new ExecutionRepository(store.db)
    executions.reserve({
      executionId: 'execution-a', assignmentId: 'assignment-a', ticketId: ticket.id, agentId: 'employee-a',
      runtime: 'local-runner', generation: 1, cwd: join(root, 'execution-a'), inputRevision: 'revision-a',
      policyVersion: ticket.lifecycle!.policyVersion,
    })
    expect(tasks.get(ticket.id)?.id).toBe(ticket.id)
    close(store)

    const { queries } = readonlyQueries(path)
    expect(queries.overview()).toMatchObject({ tasks: { total: 1 }, executions: { total: 1, active: 1 } })
    expect(queries.task(ticket.id)?.ticket.id).toBe(ticket.id)
    expect(queries.tasks().items.map(item => item.id)).toEqual([ticket.id])
    expect(queries.execution('execution-a')?.ticketId).toBe(ticket.id)
  })

  it('reports persisted UNKNOWN occupancy, details and audit, while enabled remains configuration only', () => {
    const path = join(root, 'detail.sqlite')
    const store = openStore(path)
    project(store, 'project-a')
    employee(store, 'employee-a', true)
    employee(store, 'employee-b', true)
    const tasks = service(store)
    const ticket = createTask(tasks, 'issue-a', 'project-a')
    const assigned = tasks.engine.assignTask(ticket.id, 'employee-a', 'local-runner', join(root, 'assignment'))
    const assignmentId = assigned.assignments.at(-1)!.id
    tasks.engine.assignmentStarted(ticket.id, assignmentId)
    const executions = new ExecutionRepository(store.db)
    const execution = executions.reserve({
      executionId: 'execution-a', assignmentId, ticketId: ticket.id, agentId: 'employee-a', runtime: 'local-runner',
      generation: 1, cwd: join(root, 'execution-a'), inputRevision: 'revision-a', policyVersion: assigned.lifecycle!.policyVersion,
    })
    executions.markUnknown(execution.executionId, 'ownership needs reconciliation')
    close(store)

    const before = fingerprint(path)
    const { queries } = readonlyQueries(path)
    expect(queries.overview()).toMatchObject({
      employees: { configured: 2, enabled: 2, busy: 1 },
      executions: { total: 1, active: 1, unknown: 1 },
    })
    const detail = queries.task(ticket.id)!
    expect(detail.ticket.id).toBe(ticket.id)
    expect(detail.executions.map(item => item.state)).toEqual(['UNKNOWN'])
    expect(detail.history.length).toBeGreaterThan(0)
    expect(detail.history.map(item => item.at)).toEqual([...detail.history.map(item => item.at)].sort())
    expect(detail.historyTruncated).toBe(false)
    expect(detail.executionsTruncated).toBe(false)
    expect(queries.execution('execution-a')?.failureReason).toMatch(/reconciliation/)
    expect(queries.tasks({ states: ['RUNNING'] }).items).toHaveLength(1)
    expect(queries.employees()).toHaveLength(2)
    expect(queries.projects()).toHaveLength(1)
    expect(fingerprint(path)).toBe(before)
  })

  it('returns only the latest 200 executions and audit records with explicit truncation', () => {
    const path = join(root, 'truncated.sqlite')
    const store = openStore(path)
    project(store, 'project-a')
    const ticket = createTask(service(store), 'issue-a', 'project-a')
    const executions = new ExecutionRepository(store.db)
    for (let index = 0; index < 201; index++) {
      const suffix = String(index).padStart(3, '0')
      const executionId = `execution-${suffix}`
      executions.reserve({
        executionId, assignmentId: `assignment-${suffix}`, ticketId: ticket.id, agentId: 'employee-a', runtime: 'local-runner',
        generation: 1, cwd: join(root, executionId), inputRevision: `revision-${suffix}`, policyVersion: ticket.lifecycle!.policyVersion,
      })
      executions.apply({
        executionId, generation: 1, sequence: 1, at: `2026-11-05T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        state: 'FAILED', runnerId: 'runner-a', reason: 'fixture startup failure',
      })
      const audit = {
        id: `audit-${suffix}`, ticketId: ticket.id, at: `2026-11-06T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        actor: 'owner-1', reason: `audit ${suffix}`, kind: 'transition', policyVersion: ticket.lifecycle!.policyVersion,
        from: 'QUEUED', to: 'BLOCKED',
      }
      store.db.prepare('INSERT INTO event_log (id, ticket_id, kind, value) VALUES (?, ?, ?, ?)')
        .run(audit.id, audit.ticketId, audit.kind, JSON.stringify(audit))
    }
    close(store)

    const { queries } = readonlyQueries(path)
    const detail = queries.task(ticket.id)!
    expect(detail.executions).toHaveLength(200)
    expect(detail.executions[0]!.executionId).toBe('execution-200')
    expect(detail.executionsTruncated).toBe(true)
    expect(detail.history).toHaveLength(200)
    expect(detail.history.at(-1)!.id).toBe('audit-200')
    expect(detail.historyTruncated).toBe(true)
    const defaultPage = queries.executions()
    expect(defaultPage.items).toHaveLength(50)
    expect(defaultPage.items[0]!.executionId).toBe('execution-200')
    expect(defaultPage.nextCursor).toEqual(expect.any(Number))
    const maximumPage = queries.executions({ limit: 200 })
    expect(maximumPage.items).toHaveLength(200)
    expect(maximumPage.nextCursor).toEqual(expect.any(Number))
    expect(queries.executions({ limit: 200, beforeRowid: maximumPage.nextCursor }).items.map(item => item.executionId))
      .toEqual(['execution-000'])
  })

  it('returns defensive copies and rejects malicious identifiers and filters', () => {
    const path = join(root, 'copies.sqlite')
    const store = openStore(path)
    project(store, 'project-a')
    employee(store, 'employee-a', false)
    const ticket = createTask(service(store), 'issue-a', 'project-a')
    close(store)
    const { db, queries } = readonlyQueries(path)

    const firstTicket = queries.task(ticket.id)!
    firstTicket.ticket.title = 'mutated'
    firstTicket.history.splice(0)
    expect(queries.task(ticket.id)!.ticket.title).toBe('Task issue-a')
    expect(queries.task(ticket.id)!.history.length).toBeGreaterThan(0)
    const firstEmployee = queries.employees()[0]!
    firstEmployee.capabilities.push('mutated')
    expect(queries.employees()[0]!.capabilities).toEqual(['editing'])
    const firstProject = queries.projects()[0]!
    firstProject.allowedTaskTypes.push('mutated')
    expect(queries.projects()[0]!.allowedTaskTypes).toEqual(['docs'])

    expect(() => queries.tasks({ limit: 0 })).toThrow(/limit/)
    expect(() => queries.tasks({ beforeRowid: Number.NaN })).toThrow(/beforeRowid/)
    expect(() => queries.tasks({ states: ['NOT_REAL' as 'RUNNING'] })).toThrow(/lifecycle status/)
    expect(() => queries.tasks({ projectId: `project-a' OR 1=1--` })).toThrow(/projectId/)
    expect(() => queries.task('../foreign')).toThrow(/ticketId/)
    expect(() => queries.execution(`x' OR 1=1--`)).toThrow(/executionId/)
    expect(() => queries.tasks({ apiToken: 'untrusted' } as never)).toThrow(/^Unknown task list option$/)
    expect(() => queries.executions({ limit: 0 })).toThrow(/limit/)
    expect(() => queries.executions({ limit: 201 })).toThrow(/between 1 and 200/)
    expect(() => queries.executions({ limit: 1.5 })).toThrow(/limit/)
    expect(() => queries.executions({ beforeRowid: 0 })).toThrow(/beforeRowid/)
    expect(() => queries.executions({ beforeRowid: Number.NaN })).toThrow(/beforeRowid/)
    expect(() => queries.executions({ states: ['NOT_REAL' as 'RUNNING'] })).toThrow(/execution state filter/)
    expect(() => queries.executions({ states: ['RUNNING', 'RUNNING'] })).toThrow(/unique/)
    expect(() => queries.executions({ states: 'RUNNING' } as never)).toThrow(/states filter/)
    expect(() => queries.executions({ projectId: `project-a' OR 1=1--` })).toThrow(/projectId/)
    expect(() => queries.executions({ employeeId: '../employee-a' })).toThrow(/employeeId/)
    expect(() => queries.executions({ ticketId: 'ticket a' })).toThrow(/ticketId/)
    expect(() => queries.executions({ apiToken: 'untrusted' } as never)).toThrow(/^Unknown execution list option$/)
    expect(() => queries.executions(null as never)).toThrow(/Invalid execution list options/)
    expect(() => ProductQueries({ db, ownerId: 'owner-1', apiToken: 'untrusted' } as never))
      .toThrow(/^Unknown ProductQueries option$/)
  })

  it('rejects execution rows whose actual columns disagree with persisted spec and state identities', () => {
    const path = join(root, 'execution-identity.sqlite')
    const store = openStore(path)
    project(store, 'project-a')
    const ticket = createTask(service(store), 'identity-a', 'project-a')
    reserveExecution(store, ticket, 'execution-identity-a', 'employee-a')
    store.db.prepare('UPDATE execution SET assignment_id = ? WHERE execution_id = ?')
      .run('assignment-tampered', 'execution-identity-a')
    close(store)

    const { queries } = readonlyQueries(path)
    expect(() => queries.execution('execution-identity-a')).toThrow(/Invalid execution record identity/)
    expect(() => queries.executions()).toThrow(/Invalid execution record identity/)
    expect(() => queries.task(ticket.id)).toThrow(/Invalid execution record identity/)
  })

  it('fails closed on missing application schemas through a read-only connection', () => {
    const path = join(root, 'main-only.sqlite')
    const store = new LocalStore(path)
    opened.push(store)
    close(store)
    const before = fingerprint(path)
    const db = new DatabaseSync(path, { readOnly: true })
    opened.push(db)
    expect(() => ProductQueries({ db, ownerId: 'owner-1' })).toThrow(/schema is not initialized/)
    expect(fingerprint(path)).toBe(before)
  })
})
