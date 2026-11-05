/** Owner-scoped, read-only product projections over an explicitly initialized application database. */
import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { EXECUTION_STATES, TERMINAL_EXECUTION_STATES, type ExecutionRecord, type ExecutionState } from '../execution/model.ts'
import { TASK_STATES, type TaskAudit, type TaskState } from '../core/lifecycle-model.ts'
import type { Ticket } from '../core/model.ts'
import type { Project } from '../projects/projects.ts'
import { LAO_SCHEMA_VERSION } from '../storage/store.ts'
import type { TaskQueryRow } from '../storage/task-queries.ts'
import type { Employee } from '../workforce/employees.ts'

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const DETAIL_LIMIT = 200
const TASK_STATE_SET = new Set<string>(TASK_STATES)
const EXECUTION_STATE_SET = new Set<string>(EXECUTION_STATES)
const ACTIVE_EXECUTION_STATES = EXECUTION_STATES.filter(state => !TERMINAL_EXECUTION_STATES.includes(state))

const SCOPED_TICKETS = `FROM ticket AS t
  JOIN project AS p
    ON t.value ->> '$.lifecycle.issue.source' = 'manual:' || ? || ':' || p.id
  WHERE p.workspace_id = ?
    AND t.value ->> '$.mandate.actor.id' = ?
    AND t.value ->> '$.mandate.actor.source' = t.value ->> '$.lifecycle.issue.source'`

const SCOPED_EXECUTIONS = `FROM execution AS e
  JOIN ticket AS t ON t.id = e.ticket_id
  JOIN project AS p
    ON t.value ->> '$.lifecycle.issue.source' = 'manual:' || ? || ':' || p.id
  WHERE p.workspace_id = ?
    AND t.value ->> '$.mandate.actor.id' = ?
    AND t.value ->> '$.mandate.actor.source' = t.value ->> '$.lifecycle.issue.source'`

const EXECUTION_COLUMNS = `e.execution_id, e.assignment_id, e.ticket_id, e.agent_id, e.runtime, e.generation,
  e.cwd, e.input_revision, e.policy_version, e.state, e.runner_id, e.last_sequence, e.created_at, e.updated_at,
  e.spec_json, e.state_json`

export interface ProductOverview {
  tasks: { total: number; byStatus: Record<TaskState, number> }
  employees: { configured: number; enabled: number; busy: number }
  executions: { total: number; active: number; unknown: number }
}

export interface ProductTaskListOptions {
  limit?: number
  beforeRowid?: number
  states?: readonly TaskState[]
  projectId?: string
  employeeId?: string
}

export interface ProductTaskListResult {
  items: TaskQueryRow[]
  nextCursor?: number
}

export interface ProductExecutionListOptions {
  limit?: number
  beforeRowid?: number
  states?: readonly ExecutionState[]
  projectId?: string
  employeeId?: string
  ticketId?: string
}

export interface ProductExecutionListResult {
  items: ExecutionRecord[]
  nextCursor?: number
}

export interface ProductTaskDetail {
  ticket: Ticket
  executions: ExecutionRecord[]
  history: TaskAudit[]
  historyTruncated: boolean
  executionsTruncated: boolean
}

export interface ProductQueriesOptions {
  db: DatabaseSync
  ownerId: string
  workspaceId?: string
}

function fail(message: string): never { throw new Error(message) }

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`Invalid ${label}`)
  return value as Record<string, unknown>
}

function requireSafeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`Invalid ${label}`)
  return value
}

function requireNonemptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) fail(`Invalid ${label}`)
  return value
}

function requireSafeInteger(value: unknown, label: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) fail(`Invalid ${label}`)
  return value
}

function numberFromSql(value: unknown, label: string): number {
  const number = typeof value === 'bigint' ? Number(value) : value
  return requireSafeInteger(number, label)
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== 'string') fail(`Invalid ${label}`)
  try { return JSON.parse(value) as unknown } catch { return fail(`Invalid ${label}`) }
}

function requireTaskState(value: unknown): TaskState {
  if (typeof value !== 'string' || !TASK_STATE_SET.has(value)) fail('Database contains an unknown or missing task lifecycle status')
  return value as TaskState
}

function requireExecutionState(value: unknown): ExecutionState {
  if (typeof value !== 'string' || !EXECUTION_STATE_SET.has(value)) fail('Database contains an unknown execution state')
  return value as ExecutionState
}

function emptyTaskCounts(): Record<TaskState, number> {
  return Object.fromEntries(TASK_STATES.map(state => [state, 0])) as Record<TaskState, number>
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function projectTaskRow(row: Record<string, unknown>): TaskQueryRow {
  const rowid = requireSafeInteger(row.rowid, 'task rowid', 1)
  const id = requireSafeId(row.id, 'task id')
  const ticket = requireObject(parseJson(row.value, 'ticket record'), 'ticket record')
  if (ticket.id !== id) fail('Invalid task id')
  const lifecycle = requireObject(ticket.lifecycle, 'task lifecycle')
  const issue = requireObject(lifecycle.issue, 'task issue')
  const status = requireTaskState(lifecycle.status)
  const title = requireNonemptyString(ticket.title, 'task title')
  const updatedAt = requireNonemptyString(ticket.updatedAt, 'task updatedAt')
  if (typeof issue.priority !== 'number' || !Number.isFinite(issue.priority)) fail('Invalid task priority')
  const source = requireNonemptyString(issue.source, 'task source')
  let agentId: string | undefined
  if (!Array.isArray(ticket.assignments)) fail('Invalid task assignments')
  const latest = ticket.assignments.at(-1)
  if (latest !== undefined) {
    const assignment = requireObject(latest, 'task assignment')
    if (assignment.agentId !== undefined && assignment.agentId !== null) agentId = requireSafeId(assignment.agentId, 'task agentId')
  }
  return { id, title, status, updatedAt, priority: issue.priority, source, rowid, ...(agentId ? { agentId } : {}) }
}

function validateSchema(db: DatabaseSync): void {
  const kv = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()
  if (!kv) fail('Product queries require an initialized database')
  const expected: Readonly<Record<string, number>> = {
    schema: LAO_SCHEMA_VERSION,
    'project-schema': 1,
    'employee-schema': 1,
    'execution-schema': 1,
    'intent-schema': 1,
    'approval-schema': 1,
  }
  for (const [key, expectedVersion] of Object.entries(expected)) {
    const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key)
    if (!row) fail(`Product query schema is not initialized: ${key}`)
    const version = parseJson(row.value, `${key} schema version`)
    if (version !== expectedVersion) fail(`Unsupported product query schema: ${key}`)
  }
  // Preparing these reads verifies the actual tables and columns without creating or migrating anything.
  db.prepare('SELECT id, value FROM ticket LIMIT 0').all()
  db.prepare('SELECT id, ticket_id, value FROM event_log LIMIT 0').all()
  db.prepare('SELECT id, workspace_id, config_json FROM project LIMIT 0').all()
  db.prepare('SELECT id, workspace_id, enabled, config_json FROM employee LIMIT 0').all()
  db.prepare(`SELECT execution_id, assignment_id, ticket_id, agent_id, runtime, generation, cwd, input_revision,
    policy_version, state, runner_id, last_sequence, created_at, updated_at, spec_json, state_json
    FROM execution LIMIT 0`).all()
  db.prepare('SELECT id, kind, status FROM orchestration_intent LIMIT 0').all()
  db.prepare('SELECT id, workspace_id, status, value FROM approval LIMIT 0').all()
}

function parseEmployee(row: Record<string, unknown>, workspaceId: string): Employee {
  const item = requireObject(parseJson(row.config_json, 'employee configuration'), 'employee configuration')
  if (item.id !== row.id || item.workspaceId !== row.workspace_id || item.workspaceId !== workspaceId) fail('Invalid employee configuration identity')
  requireSafeId(item.id, 'employee id'); requireSafeId(item.workspaceId, 'employee workspaceId')
  requireNonemptyString(item.name, 'employee name'); requireNonemptyString(item.role, 'employee role')
  requireSafeId(item.runtimeId, 'employee runtimeId')
  for (const field of ['responsibilities', 'capabilities', 'projectIds'] as const) {
    if (!Array.isArray(item[field]) || item[field].some(value => typeof value !== 'string' || !value)) fail(`Invalid employee ${field}`)
  }
  requireSafeInteger(item.maxConcurrency, 'employee maxConcurrency', 1)
  requireSafeInteger(item.timeoutMs, 'employee timeoutMs', 1)
  requireSafeInteger(item.version, 'employee version', 1)
  if (typeof item.enabled !== 'boolean' || Number(row.enabled) !== (item.enabled ? 1 : 0)) fail('Invalid employee enabled configuration')
  return cloneJson(item as unknown as Employee)
}

function parseProject(row: Record<string, unknown>, workspaceId: string): Project {
  const item = requireObject(parseJson(row.config_json, 'project configuration'), 'project configuration')
  if (item.id !== row.id || item.workspaceId !== row.workspace_id || item.workspaceId !== workspaceId) fail('Invalid project configuration identity')
  requireSafeId(item.id, 'project id'); requireSafeId(item.workspaceId, 'project workspaceId'); requireSafeId(item.ownerId, 'project ownerId')
  requireNonemptyString(item.name, 'project name'); requireNonemptyString(item.repositoryPath, 'project repositoryPath')
  requireNonemptyString(item.worktreeRoot, 'project worktreeRoot')
  if (!Array.isArray(item.allowedTaskTypes) || item.allowedTaskTypes.some(value => typeof value !== 'string' || !value)) fail('Invalid project allowedTaskTypes')
  if (typeof item.archived !== 'boolean') fail('Invalid project archived configuration')
  requireSafeInteger(item.version, 'project version', 1)
  return cloneJson(item as unknown as Project)
}

function parseExecution(row: Record<string, unknown>): ExecutionRecord {
  const record = requireObject(parseJson(row.state_json, 'execution record'), 'execution record')
  const spec = requireObject(parseJson(row.spec_json, 'execution spec'), 'execution spec')
  const executionId = requireSafeId(row.execution_id, 'executionId')
  const assignmentId = requireSafeId(row.assignment_id, 'execution assignmentId')
  const ticketId = requireSafeId(row.ticket_id, 'execution ticketId')
  const agentId = requireSafeId(row.agent_id, 'execution agentId')
  const runtime = requireNonemptyString(row.runtime, 'execution runtime')
  const generation = numberFromSql(row.generation, 'execution generation')
  if (generation < 1) fail('Invalid execution generation')
  const cwd = requireNonemptyString(row.cwd, 'execution cwd')
  const inputRevision = requireNonemptyString(row.input_revision, 'execution inputRevision')
  const policyVersion = requireNonemptyString(row.policy_version, 'execution policyVersion')
  const state = requireExecutionState(row.state)
  const runnerId = row.runner_id === null ? undefined : requireNonemptyString(row.runner_id, 'execution runnerId')
  const lastSequence = numberFromSql(row.last_sequence, 'execution lastSequence')
  const createdAt = requireNonemptyString(row.created_at, 'execution createdAt')
  const updatedAt = requireNonemptyString(row.updated_at, 'execution updatedAt')
  const identity = { executionId, assignmentId, ticketId, agentId, runtime, generation, cwd, inputRevision, policyVersion }
  for (const [field, value] of Object.entries(identity)) {
    if (spec[field] !== value || record[field] !== value) fail('Invalid execution record identity')
  }
  if (record.state !== state || record.runnerId !== runnerId || record.lastSequence !== lastSequence
    || record.createdAt !== createdAt || record.updatedAt !== updatedAt) fail('Invalid execution record identity')
  return cloneJson(record as unknown as ExecutionRecord)
}

function normalizeListOptions(options: ProductTaskListOptions): Required<Pick<ProductTaskListOptions, 'limit'>> & Omit<ProductTaskListOptions, 'limit'> {
  const input = requireObject(options, 'task list options')
  const allowed = new Set(['limit', 'beforeRowid', 'states', 'projectId', 'employeeId'])
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail('Unknown task list option')
  const limit = input.limit === undefined ? DEFAULT_LIMIT : requireSafeInteger(input.limit, 'limit', 1)
  if (limit > MAX_LIMIT) fail(`limit must be between 1 and ${MAX_LIMIT}`)
  const beforeRowid = input.beforeRowid === undefined ? undefined : requireSafeInteger(input.beforeRowid, 'beforeRowid', 1)
  let states: TaskState[] | undefined
  if (input.states !== undefined) {
    if (!Array.isArray(input.states)) fail('Invalid states filter')
    states = input.states.map(requireTaskState)
  }
  const projectId = input.projectId === undefined ? undefined : requireSafeId(input.projectId, 'projectId')
  const employeeId = input.employeeId === undefined ? undefined : requireSafeId(input.employeeId, 'employeeId')
  return { limit, beforeRowid, states, projectId, employeeId }
}

function normalizeExecutionListOptions(options: ProductExecutionListOptions):
Required<Pick<ProductExecutionListOptions, 'limit'>> & Omit<ProductExecutionListOptions, 'limit'> {
  const input = requireObject(options, 'execution list options')
  const allowed = new Set(['limit', 'beforeRowid', 'states', 'projectId', 'employeeId', 'ticketId'])
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail('Unknown execution list option')
  const limit = input.limit === undefined ? DEFAULT_LIMIT : requireSafeInteger(input.limit, 'limit', 1)
  if (limit > MAX_LIMIT) fail(`limit must be between 1 and ${MAX_LIMIT}`)
  const beforeRowid = input.beforeRowid === undefined ? undefined : requireSafeInteger(input.beforeRowid, 'beforeRowid', 1)
  let states: ExecutionState[] | undefined
  if (input.states !== undefined) {
    if (!Array.isArray(input.states)) fail('Invalid execution states filter')
    states = []
    const seen = new Set<ExecutionState>()
    for (const value of input.states) {
      if (typeof value !== 'string' || !EXECUTION_STATE_SET.has(value)) fail('Invalid execution state filter')
      const state = value as ExecutionState
      if (seen.has(state)) fail('Execution states filter must contain unique values')
      seen.add(state)
      states.push(state)
    }
  }
  const projectId = input.projectId === undefined ? undefined : requireSafeId(input.projectId, 'projectId')
  const employeeId = input.employeeId === undefined ? undefined : requireSafeId(input.employeeId, 'employeeId')
  const ticketId = input.ticketId === undefined ? undefined : requireSafeId(input.ticketId, 'ticketId')
  return { limit, beforeRowid, states, projectId, employeeId, ticketId }
}

/** Constructs read models in a trusted owner/workspace principal context. Construction performs reads only. */
export function ProductQueries(options: ProductQueriesOptions) {
  const input = requireObject(options, 'ProductQueries options')
  const allowed = new Set(['db', 'ownerId', 'workspaceId'])
  for (const key of Object.keys(input)) if (!allowed.has(key)) fail('Unknown ProductQueries option')
  if (!input.db || typeof (input.db as DatabaseSync).prepare !== 'function') fail('Invalid database')
  const db = input.db as DatabaseSync
  const ownerId = requireSafeId(input.ownerId, 'ownerId')
  const workspaceId = requireSafeId(input.workspaceId === undefined ? 'local' : input.workspaceId, 'workspaceId')
  validateSchema(db)
  const scopeParameters = (): SQLInputValue[] => [workspaceId, workspaceId, ownerId]

  const api = {
    overview(): ProductOverview {
      const byStatus = emptyTaskCounts()
      const taskGroups = db.prepare(`SELECT t.value ->> '$.lifecycle.status' AS status, COUNT(*) AS count ${SCOPED_TICKETS}
        GROUP BY t.value ->> '$.lifecycle.status'`).all(...scopeParameters()) as Record<string, unknown>[]
      let taskTotal = 0
      for (const group of taskGroups) {
        const status = requireTaskState(group.status)
        const count = numberFromSql(group.count, 'task count')
        byStatus[status] = count
        taskTotal += count
      }

      const employee = db.prepare(`SELECT COUNT(*) AS configured,
        COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled
        FROM employee WHERE workspace_id = ?`).get(workspaceId) as Record<string, unknown>

      const placeholders = ACTIVE_EXECUTION_STATES.map(() => '?').join(', ')
      const executionGroups = db.prepare(`SELECT e.state AS state, COUNT(*) AS count FROM execution AS e
        JOIN ticket AS t ON t.id = e.ticket_id
        JOIN project AS p ON t.value ->> '$.lifecycle.issue.source' = 'manual:' || ? || ':' || p.id
        WHERE p.workspace_id = ? AND t.value ->> '$.mandate.actor.id' = ?
          AND t.value ->> '$.mandate.actor.source' = t.value ->> '$.lifecycle.issue.source'
        GROUP BY e.state`).all(...scopeParameters()) as Record<string, unknown>[]
      let executionTotal = 0, active = 0, unknown = 0
      for (const group of executionGroups) {
        const state = requireExecutionState(group.state)
        const count = numberFromSql(group.count, 'execution count')
        executionTotal += count
        if (ACTIVE_EXECUTION_STATES.includes(state)) active += count
        if (state === 'UNKNOWN') unknown += count
      }
      const busyRow = db.prepare(`SELECT COUNT(DISTINCT e.agent_id) AS count FROM execution AS e
        JOIN employee AS m ON m.id = e.agent_id AND m.workspace_id = ?
        JOIN ticket AS t ON t.id = e.ticket_id
        JOIN project AS p ON t.value ->> '$.lifecycle.issue.source' = 'manual:' || ? || ':' || p.id
        WHERE p.workspace_id = ? AND t.value ->> '$.mandate.actor.id' = ?
          AND t.value ->> '$.mandate.actor.source' = t.value ->> '$.lifecycle.issue.source'
          AND e.state IN (${placeholders})`).get(
        workspaceId, ...scopeParameters(), ...ACTIVE_EXECUTION_STATES,
      ) as Record<string, unknown>

      return {
        tasks: { total: taskTotal, byStatus },
        employees: {
          configured: numberFromSql(employee.configured, 'configured employee count'),
          enabled: numberFromSql(employee.enabled, 'enabled employee count'),
          busy: numberFromSql(busyRow.count, 'busy employee count'),
        },
        executions: { total: executionTotal, active, unknown },
      }
    },

    tasks(options: ProductTaskListOptions = {}): ProductTaskListResult {
      const normalized = normalizeListOptions(options)
      const clauses: string[] = []
      const parameters = scopeParameters()
      if (normalized.beforeRowid !== undefined) { clauses.push('t.rowid < ?'); parameters.push(normalized.beforeRowid) }
      if (normalized.states?.length) {
        clauses.push(`t.value ->> '$.lifecycle.status' IN (${normalized.states.map(() => '?').join(', ')})`)
        parameters.push(...normalized.states)
      }
      if (normalized.projectId !== undefined) { clauses.push('p.id = ?'); parameters.push(normalized.projectId) }
      if (normalized.employeeId !== undefined) {
        clauses.push(`t.value ->> '$.assignments[#-1].agentId' = ?`)
        parameters.push(normalized.employeeId)
      }
      parameters.push(normalized.limit + 1)
      const extra = clauses.length ? ` AND ${clauses.join(' AND ')}` : ''
      const rows = db.prepare(`SELECT t.rowid AS rowid, t.id AS id, t.value AS value ${SCOPED_TICKETS}${extra}
        ORDER BY t.rowid DESC LIMIT ?`).all(...parameters) as Record<string, unknown>[]
      const hasMore = rows.length > normalized.limit
      const items = rows.slice(0, normalized.limit).map(projectTaskRow)
      return { items, ...(hasMore ? { nextCursor: items.at(-1)!.rowid } : {}) }
    },

    executions(options: ProductExecutionListOptions = {}): ProductExecutionListResult {
      const normalized = normalizeExecutionListOptions(options)
      const clauses: string[] = []
      const parameters = scopeParameters()
      if (normalized.beforeRowid !== undefined) { clauses.push('e.rowid < ?'); parameters.push(normalized.beforeRowid) }
      if (normalized.states?.length) {
        clauses.push(`e.state IN (${normalized.states.map(() => '?').join(', ')})`)
        parameters.push(...normalized.states)
      }
      if (normalized.projectId !== undefined) { clauses.push('p.id = ?'); parameters.push(normalized.projectId) }
      if (normalized.employeeId !== undefined) { clauses.push('e.agent_id = ?'); parameters.push(normalized.employeeId) }
      if (normalized.ticketId !== undefined) { clauses.push('e.ticket_id = ?'); parameters.push(normalized.ticketId) }
      parameters.push(normalized.limit + 1)
      const extra = clauses.length ? ` AND ${clauses.join(' AND ')}` : ''
      const rows = db.prepare(`SELECT e.rowid AS rowid, ${EXECUTION_COLUMNS} ${SCOPED_EXECUTIONS}${extra}
        ORDER BY e.rowid DESC LIMIT ?`).all(...parameters) as Record<string, unknown>[]
      const hasMore = rows.length > normalized.limit
      const page = rows.slice(0, normalized.limit).map(row => ({
        rowid: requireSafeInteger(row.rowid, 'execution rowid', 1),
        item: parseExecution(row),
      }))
      return {
        items: page.map(item => item.item),
        ...(hasMore ? { nextCursor: page.at(-1)!.rowid } : {}),
      }
    },

    task(ticketId: string): ProductTaskDetail | undefined {
      const id = requireSafeId(ticketId, 'ticketId')
      const row = db.prepare(`SELECT t.id AS id, t.value AS value ${SCOPED_TICKETS} AND t.id = ?`).get(
        ...scopeParameters(), id,
      ) as Record<string, unknown> | undefined
      if (!row) return undefined
      const ticket = requireObject(parseJson(row.value, 'ticket record'), 'ticket record')
      if (ticket.id !== id) fail('Invalid task id')

      const executionRows = db.prepare(`SELECT ${EXECUTION_COLUMNS} FROM execution AS e
        WHERE e.ticket_id = ? ORDER BY e.rowid DESC LIMIT ?`).all(id, DETAIL_LIMIT + 1) as Record<string, unknown>[]
      const historyRows = db.prepare(`SELECT value FROM event_log WHERE ticket_id = ? ORDER BY rowid DESC LIMIT ?`)
        .all(id, DETAIL_LIMIT + 1) as Record<string, unknown>[]
      const executionsTruncated = executionRows.length > DETAIL_LIMIT
      const historyTruncated = historyRows.length > DETAIL_LIMIT
      const executions = executionRows.slice(0, DETAIL_LIMIT).map(parseExecution)
      const history = historyRows.slice(0, DETAIL_LIMIT).reverse().map(item => {
        const audit = requireObject(parseJson(item.value, 'task audit'), 'task audit')
        if (audit.ticketId !== id) fail('Invalid task audit identity')
        return cloneJson(audit as unknown as TaskAudit)
      })
      return { ticket: cloneJson(ticket as unknown as Ticket), executions, history, historyTruncated, executionsTruncated }
    },

    employees(): Employee[] {
      const rows = db.prepare('SELECT id, workspace_id, enabled, config_json FROM employee WHERE workspace_id = ? ORDER BY rowid')
        .all(workspaceId) as Record<string, unknown>[]
      return rows.map(row => parseEmployee(row, workspaceId))
    },

    projects(): Project[] {
      const rows = db.prepare('SELECT id, workspace_id, config_json FROM project WHERE workspace_id = ? ORDER BY rowid')
        .all(workspaceId) as Record<string, unknown>[]
      return rows.map(row => parseProject(row, workspaceId))
    },

    execution(executionId: string): ExecutionRecord | undefined {
      const id = requireSafeId(executionId, 'executionId')
      const row = db.prepare(`SELECT ${EXECUTION_COLUMNS} ${SCOPED_EXECUTIONS}
        AND e.execution_id = ?`).get(...scopeParameters(), id) as Record<string, unknown> | undefined
      return row ? parseExecution(row) : undefined
    },
  }
  return api
}
