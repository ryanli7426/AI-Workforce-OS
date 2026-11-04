/** Read-only task projections over an existing ticket table. Does not initialize or migrate schema. */
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import { TASK_STATES, type TaskState } from '../core/lifecycle-model.ts'

const MAX_LIMIT = 200
const DEFAULT_LIMIT = 50
const TASK_STATE_SET = new Set<string>(TASK_STATES)

export interface TaskQueryRow {
  id: string
  title: string
  status: TaskState
  updatedAt: string
  priority: number
  agentId?: string
  source: string
  rowid: number
}

export interface TaskListOptions {
  limit?: number
  beforeRowid?: number
  states?: readonly TaskState[]
  agentId?: string
  source?: string
}

export interface TaskListResult {
  items: TaskQueryRow[]
  nextCursor?: number
}

export interface TaskCounts {
  total: number
  byState: Record<TaskState, number>
}

function fail(message: string): never {
  throw new Error(message)
}

function requireNonemptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) fail(`Invalid task ${label}`)
  return value
}

function requireSafeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail(`Invalid ${label}`)
  return value
}

function requireTaskState(value: unknown): TaskState {
  if (typeof value !== 'string' || !TASK_STATE_SET.has(value)) fail('Database contains an unknown or missing task lifecycle status')
  return value as TaskState
}

function emptyCounts(): Record<TaskState, number> {
  return Object.fromEntries(TASK_STATES.map(state => [state, 0])) as Record<TaskState, number>
}

function projectRow(row: Record<string, unknown>): TaskQueryRow {
  const rowid = requireSafeInteger(row.rowid, 'rowid')
  const id = requireNonemptyString(row.id, 'id')
  let value: unknown
  try { value = JSON.parse(String(row.value)) }
  catch { fail('Database contains an invalid ticket record') }
  if (!value || typeof value !== 'object') fail('Database contains an invalid ticket record')
  const ticket = value as Record<string, unknown>
  const lifecycle = ticket.lifecycle
  if (!lifecycle || typeof lifecycle !== 'object') fail('Database contains an unknown or missing task lifecycle status')
  const life = lifecycle as Record<string, unknown>
  const status = requireTaskState(life.status)
  const issue = life.issue
  if (!issue || typeof issue !== 'object') fail('Database contains an invalid task issue identity')
  const issueRecord = issue as Record<string, unknown>
  const source = requireNonemptyString(issueRecord.source, 'source')
  if (typeof issueRecord.priority !== 'number' || !Number.isFinite(issueRecord.priority)) fail('Invalid task priority')
  const title = requireNonemptyString(ticket.title, 'title')
  const updatedAt = requireNonemptyString(ticket.updatedAt, 'updatedAt')
  if (typeof ticket.id !== 'string' || ticket.id.length === 0 || ticket.id !== id) fail('Invalid task id')

  let agentId: string | undefined
  if (ticket.assignments !== undefined) {
    if (!Array.isArray(ticket.assignments)) fail('Invalid task assignments')
    const latest = ticket.assignments.at(-1)
    if (latest !== undefined) {
      if (!latest || typeof latest !== 'object') fail('Invalid task assignment')
      const raw = (latest as Record<string, unknown>).agentId
      if (raw !== undefined && raw !== null) {
        agentId = requireNonemptyString(raw, 'agentId')
      }
    }
  }

  const projected: TaskQueryRow = { id, title, status, updatedAt, priority: issueRecord.priority, source, rowid }
  if (agentId !== undefined) projected.agentId = agentId
  return projected
}

function normalizeListOptions(options: TaskListOptions = {}): {
  limit: number
  beforeRowid?: number
  states?: readonly TaskState[]
  agentId?: string
  source?: string
} {
  const limit = options.limit === undefined ? DEFAULT_LIMIT : requireSafeInteger(options.limit, 'limit')
  if (limit < 1 || limit > MAX_LIMIT) fail(`limit must be between 1 and ${MAX_LIMIT}`)
  const beforeRowid = options.beforeRowid === undefined ? undefined : requireSafeInteger(options.beforeRowid, 'beforeRowid')
  if (beforeRowid !== undefined && beforeRowid < 1) fail('Invalid beforeRowid')
  let states: readonly TaskState[] | undefined
  if (options.states !== undefined) {
    if (!Array.isArray(options.states)) fail('Invalid states filter')
    states = options.states.map(state => requireTaskState(state))
  }
  const agentId = options.agentId === undefined ? undefined : requireNonemptyString(options.agentId, 'agentId filter')
  const source = options.source === undefined ? undefined : requireNonemptyString(options.source, 'source filter')
  return { limit, beforeRowid, states, agentId, source }
}

/** Read-only queries for local workspace tickets already present in `db`. */
export function TaskQueries(db: DatabaseSync) {
  return {
    get(id: string): TaskQueryRow | undefined {
      requireNonemptyString(id, 'id')
      const row = db.prepare('SELECT rowid, id, value FROM ticket WHERE id = ?').get(id)
      if (!row) return undefined
      return projectRow(row as Record<string, unknown>)
    },

    list(options: TaskListOptions = {}): TaskListResult {
      const normalized = normalizeListOptions(options)
      const clauses: string[] = []
      const parameters: SQLInputValue[] = []
      if (normalized.beforeRowid !== undefined) {
        clauses.push('rowid < ?')
        parameters.push(normalized.beforeRowid)
      }
      if (normalized.states && normalized.states.length > 0) {
        clauses.push(`value ->> '$.lifecycle.status' IN (${normalized.states.map(() => '?').join(', ')})`)
        parameters.push(...normalized.states)
      }
      if (normalized.agentId !== undefined) {
        // Engine keeps only the latest assignment active; match that agent only (not historical ones).
        clauses.push(`value ->> '$.assignments[#-1].agentId' = ?`)
        parameters.push(normalized.agentId)
      }
      if (normalized.source !== undefined) {
        clauses.push(`value ->> '$.lifecycle.issue.source' = ?`)
        parameters.push(normalized.source)
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
      parameters.push(normalized.limit + 1)
      const rows = db.prepare(
        `SELECT rowid, id, value FROM ticket ${where} ORDER BY rowid DESC LIMIT ?`,
      ).all(...parameters) as Record<string, unknown>[]
      const hasMore = rows.length > normalized.limit
      const page = hasMore ? rows.slice(0, normalized.limit) : rows
      const items = page.map(row => projectRow(row))
      const result: TaskListResult = { items }
      if (hasMore) {
        const cursor = items.at(-1)?.rowid
        if (cursor === undefined) fail('Invalid pagination cursor')
        result.nextCursor = cursor
      }
      return result
    },

    counts(): TaskCounts {
      const totalRow = db.prepare('SELECT COUNT(*) AS total FROM ticket').get() as { total: number | bigint } | undefined
      const total = Number(totalRow?.total ?? 0)
      if (!Number.isSafeInteger(total) || total < 0) fail('Invalid task total')
      const byState = emptyCounts()
      const groups = db.prepare(
        `SELECT value ->> '$.lifecycle.status' AS status, COUNT(*) AS n FROM ticket GROUP BY value ->> '$.lifecycle.status'`,
      ).all() as { status: unknown; n: number | bigint }[]
      let accounted = 0
      for (const group of groups) {
        const status = requireTaskState(group.status)
        const n = Number(group.n)
        if (!Number.isSafeInteger(n) || n < 0) fail('Invalid task count')
        byState[status] = n
        accounted += n
      }
      if (accounted !== total) fail('Task count aggregation mismatch')
      return { total, byState }
    },
  }
}
