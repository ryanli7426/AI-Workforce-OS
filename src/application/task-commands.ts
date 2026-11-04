/** Idempotent owner Task commands with durable per-key receipts; schema is explicit-only. */
import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Rule } from '../assessor/rules.ts'
import { TASK_STATES } from '../core/lifecycle-model.ts'
import type { Ticket } from '../core/model.ts'
import { ProjectRepository } from '../projects/projects.ts'
import type { LocalStore } from '../storage/store.ts'
import { requireCommandSchema, loadReceipt, insertReceipt } from '../storage/command-receipts.ts'
export { initializeCommandSchema, COMMAND_SCHEMA_KEY, COMMAND_SCHEMA_VERSION } from '../storage/command-receipts.ts'
import {
  LocalTaskService,
  type CreateTaskInput,
} from './tasks.ts'


const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const SAFE_FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const CREDENTIAL_FIELD = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pat|credential)/i
const MAX_REASON = 8192
const MAX_EVIDENCE = 512
const CREATE_REQUIRED = ['issueId', 'projectId', 'title', 'description', 'taskType'] as const
const CREATE_OPTIONAL = ['priority'] as const
const RECEIPT_COLUMNS = [
  'workspace_id',
  'owner_id',
  'command_key',
  'command_hash',
  'result_json',
  'created_at',
] as const
const TASK_STATE_SET = new Set<string>(TASK_STATES)

export type TaskCommandErrorCode =
  | 'INVALID_COMMAND'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STATE_CONFLICT'

export class TaskCommandError extends Error {
  readonly code: TaskCommandErrorCode
  constructor(code: TaskCommandErrorCode, message: string) {
    super(message)
    this.name = 'TaskCommandError'
    this.code = code
  }
}

export type LocalTaskCommand =
  | { kind: 'create'; input: CreateTaskInput }
  | { kind: 'approve'; ticketId: string; expectedVersion: number; reason: string }
  | { kind: 'reject'; ticketId: string; expectedVersion: number; reason: string }
  | { kind: 'cancel'; ticketId: string; expectedVersion: number; reason: string }
  | { kind: 'retry'; ticketId: string; expectedVersion: number; reason: string }
  | {
    kind: 'review'
    ticketId: string
    expectedVersion: number
    executionId: string
    artifactRevision: string
    approved: boolean
    reason: string
  }

export interface LocalTaskCommandsOptions {
  store: LocalStore
  ownerId: string
  rules: readonly Rule[]
  workspaceId?: string
}

export interface TaskCommandResult {
  ticket: Ticket
  replayed: boolean
}

type NormalizedCommand =
  | { kind: 'create'; input: CreateTaskInput }
  | { kind: 'approve'; ticketId: string; expectedVersion: number; reason: string }
  | { kind: 'reject'; ticketId: string; expectedVersion: number; reason: string }
  | { kind: 'cancel'; ticketId: string; expectedVersion: number; reason: string }
  | { kind: 'retry'; ticketId: string; expectedVersion: number; reason: string }
  | {
    kind: 'review'
    ticketId: string
    expectedVersion: number
    executionId: string
    artifactRevision: string
    approved: boolean
    reason: string
  }

function unknownFieldMessage(label: string, field: string): string {
  if (SAFE_FIELD_NAME.test(field) && !CREDENTIAL_FIELD.test(field)) return `Unknown ${label} field: ${field}`
  return `Unknown ${label} field`
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TaskCommandError('INVALID_COMMAND', `Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new TaskCommandError('INVALID_COMMAND', unknownFieldMessage(label, field))
  }
  for (const field of keys) {
    if (!(field in value)) throw new TaskCommandError('INVALID_COMMAND', `Missing ${label} field: ${field}`)
  }
}

function requireSafeId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new TaskCommandError('INVALID_COMMAND', `Invalid ${field}`)
  }
}

function requireReason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > MAX_REASON) {
    throw new TaskCommandError('INVALID_COMMAND', 'Invalid reason')
  }
  return value
}

function requireEvidenceText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > MAX_EVIDENCE) {
    throw new TaskCommandError('INVALID_COMMAND', `Invalid ${field}`)
  }
  return value
}

function requireVersion(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TaskCommandError('INVALID_COMMAND', 'Invalid expectedVersion')
  }
  return value
}

function requireCreateInput(value: unknown): CreateTaskInput {
  const body = requireObject(value, 'create')
  const allowed = new Set<string>([...CREATE_REQUIRED, ...CREATE_OPTIONAL])
  for (const field of Object.keys(body)) {
    if (!allowed.has(field)) throw new TaskCommandError('INVALID_COMMAND', unknownFieldMessage('create', field))
  }
  for (const field of CREATE_REQUIRED) {
    if (!(field in body)) throw new TaskCommandError('INVALID_COMMAND', `Missing create field: ${field}`)
  }
  requireSafeId(body.issueId, 'issueId')
  requireSafeId(body.projectId, 'projectId')
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.includes('\0') || body.title.length > 512) {
    throw new TaskCommandError('INVALID_COMMAND', 'Invalid title')
  }
  if (typeof body.description !== 'string' || !body.description.trim() || body.description.includes('\0') || body.description.length > 8192) {
    throw new TaskCommandError('INVALID_COMMAND', 'Invalid description')
  }
  requireSafeId(body.taskType, 'taskType')
  const input: CreateTaskInput = {
    issueId: body.issueId,
    projectId: body.projectId,
    title: body.title,
    description: body.description,
    taskType: body.taskType,
  }
  if ('priority' in body) {
    if (typeof body.priority !== 'number' || !Number.isFinite(body.priority) || body.priority < 0) {
      throw new TaskCommandError('INVALID_COMMAND', 'Invalid priority')
    }
    input.priority = body.priority
  }
  return input
}

function normalizeCommand(command: unknown): NormalizedCommand {
  const body = requireObject(command, 'command')
  if (!('kind' in body) || typeof body.kind !== 'string') {
    throw new TaskCommandError('INVALID_COMMAND', 'Invalid command kind')
  }
  switch (body.kind) {
    case 'create': {
      requireExactKeys(body, ['kind', 'input'], 'command')
      return { kind: 'create', input: requireCreateInput(body.input) }
    }
    case 'approve':
    case 'reject':
    case 'cancel':
    case 'retry': {
      requireExactKeys(body, ['kind', 'ticketId', 'expectedVersion', 'reason'], 'command')
      requireSafeId(body.ticketId, 'ticketId')
      return {
        kind: body.kind,
        ticketId: body.ticketId,
        expectedVersion: requireVersion(body.expectedVersion),
        reason: requireReason(body.reason),
      }
    }
    case 'review': {
      requireExactKeys(body, ['kind', 'ticketId', 'expectedVersion', 'executionId', 'artifactRevision', 'approved', 'reason'], 'command')
      requireSafeId(body.ticketId, 'ticketId')
      if (typeof body.approved !== 'boolean') throw new TaskCommandError('INVALID_COMMAND', 'Invalid approved')
      return {
        kind: 'review',
        ticketId: body.ticketId,
        expectedVersion: requireVersion(body.expectedVersion),
        executionId: requireEvidenceText(body.executionId, 'executionId'),
        artifactRevision: requireEvidenceText(body.artifactRevision, 'artifactRevision'),
        approved: body.approved,
        reason: requireReason(body.reason),
      }
    }
    default:
      throw new TaskCommandError('INVALID_COMMAND', 'Invalid command kind')
  }
}

function canonicalJson(value: unknown): string {
  const seen = new Set<object>()
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new TaskCommandError('INVALID_COMMAND', 'Invalid canonical number')
      return Object.is(item, -0) ? 0 : item
    }
    if (typeof item !== 'object') throw new TaskCommandError('INVALID_COMMAND', 'Invalid canonical value')
    if (seen.has(item as object)) throw new TaskCommandError('INVALID_COMMAND', 'Invalid canonical cycle')
    seen.add(item as object)
    if (Array.isArray(item)) return item.map(visit)
    const out: Record<string, unknown> = {}
    for (const keyName of Object.keys(item as Record<string, unknown>).sort()) {
      out[keyName] = visit((item as Record<string, unknown>)[keyName])
    }
    return out
  }
  return JSON.stringify(visit(value))
}

function hashCommand(command: NormalizedCommand): string {
  return createHash('sha256').update(canonicalJson(command)).digest('hex')
}

function cloneTicket(ticket: Ticket): Ticket {
  return structuredClone(ticket)
}

function parseManualSource(source: string): { workspaceId: string; projectId: string } | undefined {
  const parts = source.split(':')
  if (parts.length !== 3 || parts[0] !== 'manual') return undefined
  const workspaceId = parts[1]
  const projectId = parts[2]
  if (!workspaceId || !projectId || !SAFE_ID.test(workspaceId) || !SAFE_ID.test(projectId)) return undefined
  return { workspaceId, projectId }
}

function corruptReceipt(): Error {
  return new Error('Corrupt command receipt')
}

function operationalFailure(): Error {
  return new Error('Command persistence failed')
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Minimal trusted Ticket shape for stored receipts; rejects scalars/foreign/mismatched scope without writes. */
function parseStoredReceiptTicket(
  resultJson: string,
  ownerId: string,
  workspaceId: string,
  db: DatabaseSync,
): Ticket {
  let parsed: unknown
  try {
    parsed = JSON.parse(resultJson)
  } catch {
    throw corruptReceipt()
  }
  if (!isObject(parsed)) throw corruptReceipt()
  if (typeof parsed.id !== 'string' || !SAFE_ID.test(parsed.id)) throw corruptReceipt()
  if (!isObject(parsed.lifecycle)) throw corruptReceipt()
  if (typeof parsed.lifecycle.status !== 'string' || !TASK_STATE_SET.has(parsed.lifecycle.status)) {
    throw corruptReceipt()
  }
  if (
    typeof parsed.lifecycle.version !== 'number'
    || !Number.isSafeInteger(parsed.lifecycle.version)
    || parsed.lifecycle.version < 0
  ) {
    throw corruptReceipt()
  }
  if (!isObject(parsed.lifecycle.issue) || typeof parsed.lifecycle.issue.source !== 'string') {
    throw corruptReceipt()
  }
  if (!isObject(parsed.mandate) || !isObject(parsed.mandate.actor)) throw corruptReceipt()
  const actor = parsed.mandate.actor
  if (typeof actor.id !== 'string' || typeof actor.source !== 'string') throw corruptReceipt()
  if (actor.id !== ownerId) throw corruptReceipt()
  const source = parsed.lifecycle.issue.source
  if (actor.source !== source) throw corruptReceipt()
  const scope = parseManualSource(source)
  if (!scope || scope.workspaceId !== workspaceId) throw corruptReceipt()
  let project
  try {
    project = new ProjectRepository(db).get(scope.projectId)
  } catch {
    throw corruptReceipt()
  }
  if (!project || project.workspaceId !== workspaceId) throw corruptReceipt()
  return cloneTicket(parsed as unknown as Ticket)
}

function isCoreBusinessStateError(message: string): boolean {
  return /Illegal task transition|Ticket is not |Authorization is stale|Retry limit reached|Ticket has already ended|Verification has not passed|does not match current execution|Conflicting (?:create payload|evidence|snapshot)|An assignment is still active|Previous process has not been confirmed stopped|Execution conditions no longer hold|Verification does not match|Review does not match|Execution is not allowed|No enabled admission rule matched|Workspace is required|Task type is required/i
    .test(message)
}

function mapServiceError(error: unknown): never {
  if (error instanceof TaskCommandError) throw error
  const message = error instanceof Error ? error.message : ''
  if (/Corrupt command receipt|Command persistence failed/i.test(message)) {
    throw error instanceof Error ? error : corruptReceipt()
  }
  if (/not initialized|unsupported command schema|Application module not initialized|Command schema|Command receipt schema|main schema/i.test(message)) {
    throw error
  }
  if (/Unknown ticket|different owner|Cross-workspace|not in this workspace|Task project/i.test(message)) {
    throw new TaskCommandError('NOT_FOUND', 'Ticket not found')
  }
  if (/Invalid |Missing |Unknown \w+ field/i.test(message)) {
    throw new TaskCommandError('INVALID_COMMAND', 'Invalid command')
  }
  if (isCoreBusinessStateError(message)) {
    throw new TaskCommandError('STATE_CONFLICT', 'Task state conflict')
  }
  throw operationalFailure()
}

/** Trusted owner command facade: receipt replay + version-checked Task mutations in one store transaction. */
export class LocalTaskCommands {
  private readonly store: LocalStore
  private readonly ownerId: string
  private readonly workspaceId: string
  private readonly tasks: LocalTaskService
  private readonly rulesSnapshot: readonly Rule[]

  constructor(options: LocalTaskCommandsOptions) {
    if (!options || typeof options !== 'object') throw new TaskCommandError('INVALID_COMMAND', 'Invalid LocalTaskCommands options')
    if (!options.store) throw new TaskCommandError('INVALID_COMMAND', 'LocalStore is required')
    requireSafeId(options.ownerId, 'ownerId')
    const workspaceId = options.workspaceId ?? 'local'
    requireSafeId(workspaceId, 'workspaceId')
    if (!Array.isArray(options.rules)) throw new TaskCommandError('INVALID_COMMAND', 'Invalid rules')
    requireCommandSchema(options.store.db)
    this.store = options.store
    this.ownerId = options.ownerId
    this.workspaceId = workspaceId
    this.rulesSnapshot = options.rules.map(rule => ({
      id: rule.id,
      enabled: rule.enabled,
      taskTypes: [...rule.taskTypes],
      priority: rule.priority,
      approvalRequired: rule.approvalRequired,
      reviewRequired: rule.reviewRequired,
      retryLimit: rule.retryLimit,
    }))
    this.tasks = new LocalTaskService({
      store: options.store,
      ownerId: this.ownerId,
      workspaceId: this.workspaceId,
      rules: this.rulesSnapshot,
    })
  }

  execute(key: string, command: LocalTaskCommand): TaskCommandResult {
    requireSafeId(key, 'key')
    const normalized = normalizeCommand(command)
    const commandHash = hashCommand(normalized)

    try {
      return this.store.atomic(() => {
        const existing = loadReceipt(this.store.db, this.workspaceId, this.ownerId, key)
        if (existing) {
          if (existing.command_hash !== commandHash) {
            throw new TaskCommandError('IDEMPOTENCY_CONFLICT', 'Idempotency key conflict')
          }
          const ticket = parseStoredReceiptTicket(
            existing.result_json,
            this.ownerId,
            this.workspaceId,
            this.store.db,
          )
          return { ticket: cloneTicket(ticket), replayed: true }
        }

        if (normalized.kind !== 'create') {
          const current = this.tasks.get(normalized.ticketId)
          if (!current?.lifecycle) throw new TaskCommandError('NOT_FOUND', 'Ticket not found')
          if (current.lifecycle.version !== normalized.expectedVersion) {
            throw new TaskCommandError('VERSION_CONFLICT', 'Ticket version conflict')
          }
        }

        let ticket: Ticket
        try {
          ticket = this.invoke(normalized)
        } catch (error) {
          mapServiceError(error)
        }

        const snapshot = cloneTicket(ticket)
        insertReceipt(
          this.store.db,
          this.workspaceId,
          this.ownerId,
          key,
          commandHash,
          snapshot,
          new Date().toISOString(),
        )
        return { ticket: cloneTicket(snapshot), replayed: false }
      })
    } catch (error) {
      if (error instanceof TaskCommandError) throw error
      mapServiceError(error)
    }
  }

  private invoke(command: NormalizedCommand): Ticket {
    switch (command.kind) {
      case 'create':
        return this.tasks.create({ ...command.input })
      case 'approve':
        return this.tasks.approve(command.ticketId, command.reason)
      case 'reject':
        return this.tasks.reject(command.ticketId, command.reason)
      case 'cancel':
        return this.tasks.cancel(command.ticketId, command.reason)
      case 'retry':
        return this.tasks.retry(command.ticketId, command.reason)
      case 'review':
        return this.tasks.review(command.ticketId, {
          executionId: command.executionId,
          artifactRevision: command.artifactRevision,
          approved: command.approved,
          reason: command.reason,
        })
    }
  }
}
