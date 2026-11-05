/** Idempotent owner workforce/project management commands with durable receipts and audits. */
import { createHash, randomUUID } from 'node:crypto'
import {
  EmployeeRepository,
  type Employee,
  type EmployeeCreateInput,
  type EmployeeEnableInput,
  type EmployeeUpdateInput,
} from '../workforce/employees.ts'
import {
  ProjectRepository,
  type PreparedProjectCreate,
  type Project,
  type ProjectArchiveInput,
  type ProjectCreateInput,
  type ProjectUpdateInput,
} from '../projects/projects.ts'
import type { LocalStore } from '../storage/store.ts'
import {
  insertManagementAudit,
  insertManagementReceipt,
  listManagementAudits,
  loadManagementReceipt,
  requireManagementSchema,
} from '../storage/management-commands.ts'
export {
  initializeManagementSchema,
  MANAGEMENT_SCHEMA_KEY,
  MANAGEMENT_SCHEMA_VERSION,
  requireManagementSchema,
} from '../storage/management-commands.ts'

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const MAX_REASON = 4096
const MAX_NAME_LENGTH = 256
const MAX_ROLE_LENGTH = 256
const MAX_LIST_ITEMS = 256
const MAX_ITEM_LENGTH = 512
const MAX_CONCURRENCY = 1024
const MAX_TIMEOUT_MS = 86_400_000

const EMPLOYEE_CREATE_FIELDS = [
  'id', 'name', 'role', 'responsibilities', 'capabilities', 'runtimeId', 'projectIds',
  'maxConcurrency', 'timeoutMs',
] as const
const EMPLOYEE_UPDATE_FIELDS = [
  'expectedVersion', 'name', 'role', 'responsibilities', 'capabilities', 'runtimeId', 'projectIds',
  'maxConcurrency', 'timeoutMs',
] as const
const EMPLOYEE_ENABLE_FIELDS = ['expectedVersion', 'enabled'] as const
const PROJECT_CREATE_FIELDS = [
  'id', 'name', 'ownerId', 'repositoryPath', 'worktreeRoot', 'allowedTaskTypes',
] as const
const PROJECT_UPDATE_FIELDS = ['expectedVersion', 'name', 'ownerId', 'allowedTaskTypes'] as const
const PROJECT_ARCHIVE_FIELDS = ['expectedVersion'] as const
const EMPLOYEE_RESULT_FIELDS = [
  'id', 'workspaceId', 'name', 'role', 'responsibilities', 'capabilities', 'runtimeId', 'projectIds',
  'maxConcurrency', 'timeoutMs', 'enabled', 'version',
] as const
const PROJECT_RESULT_FIELDS = [
  'id', 'workspaceId', 'name', 'ownerId', 'repositoryPath', 'worktreeRoot', 'allowedTaskTypes',
  'archived', 'version',
] as const
const SENSITIVE_EMPLOYEE_UPDATE = new Set([
  'responsibilities', 'capabilities', 'runtimeId', 'projectIds', 'maxConcurrency', 'timeoutMs',
])

export type ManagementCommandErrorCode =
  | 'INVALID_COMMAND'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STATE_CONFLICT'

export class ManagementCommandError extends Error {
  readonly code: ManagementCommandErrorCode
  constructor(code: ManagementCommandErrorCode, message: string) {
    super(message)
    this.name = 'ManagementCommandError'
    this.code = code
  }
}

export type ManagementCommand =
  | { kind: 'employee-create'; input: Omit<EmployeeCreateInput, 'workspaceId'>; reason: string }
  | { kind: 'employee-update'; id: string; input: EmployeeUpdateInput; reason: string }
  | { kind: 'employee-enable'; id: string; input: EmployeeEnableInput; reason: string }
  | { kind: 'project-create'; input: Omit<ProjectCreateInput, 'workspaceId'>; reason: string }
  | { kind: 'project-update'; id: string; input: ProjectUpdateInput; reason: string }
  | { kind: 'project-archive'; id: string; input: ProjectArchiveInput; reason: string }

export type ManagementResult =
  | { kind: 'employee'; employee: Employee; replayed: boolean }
  | { kind: 'project'; project: Project; replayed: boolean }

export interface ManagementAudit {
  id: string
  actorId: string
  workspaceId: string
  kind: 'employee' | 'project'
  resourceId: string
  action: string
  reason: string
  beforeVersion: number | null
  afterVersion: number
  createdAt: string
}

export interface LocalManagementCommandsOptions {
  store: LocalStore
  ownerId: string
  workspaceId?: string
  runtimeIds: readonly string[]
}

type NormalizedCommand =
  | { kind: 'employee-create'; input: Omit<EmployeeCreateInput, 'workspaceId'>; reason: string }
  | { kind: 'employee-update'; id: string; input: EmployeeUpdateInput; reason: string }
  | { kind: 'employee-enable'; id: string; input: EmployeeEnableInput; reason: string }
  | { kind: 'project-create'; input: Omit<ProjectCreateInput, 'workspaceId'>; reason: string }
  | { kind: 'project-update'; id: string; input: ProjectUpdateInput; reason: string }
  | { kind: 'project-archive'; id: string; input: ProjectArchiveInput; reason: string }

type StoredResult =
  | { kind: 'employee'; employee: Employee }
  | { kind: 'project'; project: Project }

/** Static only: never echo arbitrary keys (safe-looking hex tokens match identifier patterns). */
function unknownFieldMessage(label: string): string {
  return `Unknown ${label} field`
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ManagementCommandError('INVALID_COMMAND', `Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function requireExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new ManagementCommandError('INVALID_COMMAND', unknownFieldMessage(label))
  }
  for (const field of keys) {
    if (!(field in value)) throw new ManagementCommandError('INVALID_COMMAND', `Missing ${label} field: ${field}`)
  }
}

function requireOnlyKnownFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields)
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new ManagementCommandError('INVALID_COMMAND', unknownFieldMessage(label))
  }
}

function requireSafeId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new ManagementCommandError('INVALID_COMMAND', `Invalid ${field}`)
  }
}

function requireReason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > MAX_REASON) {
    throw new ManagementCommandError('INVALID_COMMAND', 'Invalid reason')
  }
  return value
}

function requireName(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > maxLength) {
    throw new ManagementCommandError('INVALID_COMMAND', `Invalid ${field}`)
  }
  return value
}

function requirePositiveBound(value: unknown, field: string, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new ManagementCommandError('INVALID_COMMAND', `Invalid ${field}`)
  }
  return value
}

function requireStringList(
  value: unknown,
  field: string,
  options: { unique: boolean; safeIds: boolean },
): string[] {
  if (!Array.isArray(value)) throw new ManagementCommandError('INVALID_COMMAND', `Invalid ${field}`)
  if (value.length > MAX_LIST_ITEMS) throw new ManagementCommandError('INVALID_COMMAND', `Invalid ${field}`)
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (options.safeIds) requireSafeId(item, field)
    else if (typeof item !== 'string' || !item || item.includes('\0') || item.length > MAX_ITEM_LENGTH) {
      throw new ManagementCommandError('INVALID_COMMAND', `Invalid ${field}`)
    }
    if (options.unique) {
      if (seen.has(item as string)) throw new ManagementCommandError('INVALID_COMMAND', `Duplicate ${field} entry`)
      seen.add(item as string)
    }
    result.push(item as string)
  }
  return result
}

function requireAbsolutePathString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) {
    throw new ManagementCommandError('INVALID_COMMAND', `Invalid ${field}`)
  }
  return value
}

function requireEmployeeCreateInput(value: unknown): Omit<EmployeeCreateInput, 'workspaceId'> {
  const body = requireObject(value, 'employee create')
  requireOnlyKnownFields(body, EMPLOYEE_CREATE_FIELDS, 'employee create')
  for (const field of EMPLOYEE_CREATE_FIELDS) {
    if (!(field in body)) throw new ManagementCommandError('INVALID_COMMAND', `Missing employee create field: ${field}`)
  }
  if ('workspaceId' in body) throw new ManagementCommandError('INVALID_COMMAND', unknownFieldMessage('employee create'))
  requireSafeId(body.id, 'id')
  requireSafeId(body.runtimeId, 'runtimeId')
  return {
    id: body.id,
    name: requireName(body.name, 'name', MAX_NAME_LENGTH),
    role: requireName(body.role, 'role', MAX_ROLE_LENGTH),
    responsibilities: requireStringList(body.responsibilities, 'responsibilities', { unique: false, safeIds: false }),
    capabilities: requireStringList(body.capabilities, 'capabilities', { unique: true, safeIds: false }),
    runtimeId: body.runtimeId,
    projectIds: requireStringList(body.projectIds, 'projectIds', { unique: true, safeIds: true }),
    maxConcurrency: requirePositiveBound(body.maxConcurrency, 'maxConcurrency', MAX_CONCURRENCY),
    timeoutMs: requirePositiveBound(body.timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS),
  }
}

function requireEmployeeUpdateInput(value: unknown): EmployeeUpdateInput {
  const body = requireObject(value, 'employee update')
  requireOnlyKnownFields(body, EMPLOYEE_UPDATE_FIELDS, 'employee update')
  if (!('expectedVersion' in body)) throw new ManagementCommandError('INVALID_COMMAND', 'Missing employee update field: expectedVersion')
  const patch: EmployeeUpdateInput = {
    expectedVersion: requirePositiveBound(body.expectedVersion, 'expectedVersion', Number.MAX_SAFE_INTEGER),
  }
  if ('name' in body) patch.name = requireName(body.name, 'name', MAX_NAME_LENGTH)
  if ('role' in body) patch.role = requireName(body.role, 'role', MAX_ROLE_LENGTH)
  if ('responsibilities' in body) {
    patch.responsibilities = requireStringList(body.responsibilities, 'responsibilities', { unique: false, safeIds: false })
  }
  if ('capabilities' in body) {
    patch.capabilities = requireStringList(body.capabilities, 'capabilities', { unique: true, safeIds: false })
  }
  if ('runtimeId' in body) {
    requireSafeId(body.runtimeId, 'runtimeId')
    patch.runtimeId = body.runtimeId
  }
  if ('projectIds' in body) {
    patch.projectIds = requireStringList(body.projectIds, 'projectIds', { unique: true, safeIds: true })
  }
  if ('maxConcurrency' in body) {
    patch.maxConcurrency = requirePositiveBound(body.maxConcurrency, 'maxConcurrency', MAX_CONCURRENCY)
  }
  if ('timeoutMs' in body) {
    patch.timeoutMs = requirePositiveBound(body.timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS)
  }
  if (Object.keys(patch).length === 1) throw new ManagementCommandError('INVALID_COMMAND', 'No updatable fields provided')
  return patch
}

function requireEmployeeEnableInput(value: unknown): EmployeeEnableInput {
  const body = requireObject(value, 'employee enable')
  requireExactKeys(body, EMPLOYEE_ENABLE_FIELDS, 'employee enable')
  if (typeof body.enabled !== 'boolean') throw new ManagementCommandError('INVALID_COMMAND', 'Invalid enabled')
  return {
    expectedVersion: requirePositiveBound(body.expectedVersion, 'expectedVersion', Number.MAX_SAFE_INTEGER),
    enabled: body.enabled,
  }
}

function requireProjectCreateInput(value: unknown): Omit<ProjectCreateInput, 'workspaceId'> {
  const body = requireObject(value, 'project create')
  requireOnlyKnownFields(body, PROJECT_CREATE_FIELDS, 'project create')
  for (const field of PROJECT_CREATE_FIELDS) {
    if (!(field in body)) throw new ManagementCommandError('INVALID_COMMAND', `Missing project create field: ${field}`)
  }
  if ('workspaceId' in body) throw new ManagementCommandError('INVALID_COMMAND', unknownFieldMessage('project create'))
  requireSafeId(body.id, 'id')
  requireSafeId(body.ownerId, 'ownerId')
  return {
    id: body.id,
    name: requireName(body.name, 'name', MAX_NAME_LENGTH),
    ownerId: body.ownerId,
    repositoryPath: requireAbsolutePathString(body.repositoryPath, 'repositoryPath'),
    worktreeRoot: requireAbsolutePathString(body.worktreeRoot, 'worktreeRoot'),
    allowedTaskTypes: requireStringList(body.allowedTaskTypes, 'allowedTaskTypes', { unique: true, safeIds: false }),
  }
}

function requireProjectUpdateInput(value: unknown): ProjectUpdateInput {
  const body = requireObject(value, 'project update')
  requireOnlyKnownFields(body, PROJECT_UPDATE_FIELDS, 'project update')
  if (!('expectedVersion' in body)) throw new ManagementCommandError('INVALID_COMMAND', 'Missing project update field: expectedVersion')
  const patch: ProjectUpdateInput = {
    expectedVersion: requirePositiveBound(body.expectedVersion, 'expectedVersion', Number.MAX_SAFE_INTEGER),
  }
  if ('name' in body) patch.name = requireName(body.name, 'name', MAX_NAME_LENGTH)
  if ('ownerId' in body) {
    requireSafeId(body.ownerId, 'ownerId')
    patch.ownerId = body.ownerId
  }
  if ('allowedTaskTypes' in body) {
    patch.allowedTaskTypes = requireStringList(body.allowedTaskTypes, 'allowedTaskTypes', { unique: true, safeIds: false })
  }
  if (patch.name === undefined && patch.ownerId === undefined && patch.allowedTaskTypes === undefined) {
    throw new ManagementCommandError('INVALID_COMMAND', 'No updatable fields provided')
  }
  return patch
}

function requireProjectArchiveInput(value: unknown): ProjectArchiveInput {
  const body = requireObject(value, 'project archive')
  requireExactKeys(body, PROJECT_ARCHIVE_FIELDS, 'project archive')
  return {
    expectedVersion: requirePositiveBound(body.expectedVersion, 'expectedVersion', Number.MAX_SAFE_INTEGER),
  }
}

function normalizeCommand(command: unknown): NormalizedCommand {
  const body = requireObject(command, 'command')
  if (!('kind' in body) || typeof body.kind !== 'string') {
    throw new ManagementCommandError('INVALID_COMMAND', 'Invalid command kind')
  }
  switch (body.kind) {
    case 'employee-create': {
      requireExactKeys(body, ['kind', 'input', 'reason'], 'command')
      return { kind: 'employee-create', input: requireEmployeeCreateInput(body.input), reason: requireReason(body.reason) }
    }
    case 'employee-update': {
      requireExactKeys(body, ['kind', 'id', 'input', 'reason'], 'command')
      requireSafeId(body.id, 'id')
      return {
        kind: 'employee-update',
        id: body.id,
        input: requireEmployeeUpdateInput(body.input),
        reason: requireReason(body.reason),
      }
    }
    case 'employee-enable': {
      requireExactKeys(body, ['kind', 'id', 'input', 'reason'], 'command')
      requireSafeId(body.id, 'id')
      return {
        kind: 'employee-enable',
        id: body.id,
        input: requireEmployeeEnableInput(body.input),
        reason: requireReason(body.reason),
      }
    }
    case 'project-create': {
      requireExactKeys(body, ['kind', 'input', 'reason'], 'command')
      return { kind: 'project-create', input: requireProjectCreateInput(body.input), reason: requireReason(body.reason) }
    }
    case 'project-update': {
      requireExactKeys(body, ['kind', 'id', 'input', 'reason'], 'command')
      requireSafeId(body.id, 'id')
      return {
        kind: 'project-update',
        id: body.id,
        input: requireProjectUpdateInput(body.input),
        reason: requireReason(body.reason),
      }
    }
    case 'project-archive': {
      requireExactKeys(body, ['kind', 'id', 'input', 'reason'], 'command')
      requireSafeId(body.id, 'id')
      return {
        kind: 'project-archive',
        id: body.id,
        input: requireProjectArchiveInput(body.input),
        reason: requireReason(body.reason),
      }
    }
    default:
      throw new ManagementCommandError('INVALID_COMMAND', 'Invalid command kind')
  }
}

function canonicalJson(value: unknown): string {
  const seen = new Set<object>()
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new ManagementCommandError('INVALID_COMMAND', 'Invalid canonical number')
      return Object.is(item, -0) ? 0 : item
    }
    if (typeof item !== 'object') throw new ManagementCommandError('INVALID_COMMAND', 'Invalid canonical value')
    if (seen.has(item as object)) throw new ManagementCommandError('INVALID_COMMAND', 'Invalid canonical cycle')
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

function cloneEmployee(employee: Employee): Employee {
  return {
    id: employee.id,
    workspaceId: employee.workspaceId,
    name: employee.name,
    role: employee.role,
    responsibilities: [...employee.responsibilities],
    capabilities: [...employee.capabilities],
    runtimeId: employee.runtimeId,
    projectIds: [...employee.projectIds],
    maxConcurrency: employee.maxConcurrency,
    timeoutMs: employee.timeoutMs,
    enabled: employee.enabled,
    version: employee.version,
  }
}

function cloneProject(project: Project): Project {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    ownerId: project.ownerId,
    repositoryPath: project.repositoryPath,
    worktreeRoot: project.worktreeRoot,
    allowedTaskTypes: [...project.allowedTaskTypes],
    archived: project.archived,
    version: project.version,
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function corruptReceipt(): Error {
  return new Error('Corrupt management receipt')
}

function operationalFailure(): Error {
  return new Error('Management persistence failed')
}

function expectedResultKind(command: NormalizedCommand): 'employee' | 'project' {
  return command.kind.startsWith('employee-') ? 'employee' : 'project'
}

function expectedResourceId(command: NormalizedCommand): string {
  switch (command.kind) {
    case 'employee-create':
    case 'project-create':
      return command.input.id
    case 'employee-update':
    case 'employee-enable':
    case 'project-update':
    case 'project-archive':
      return command.id
  }
}

function sameStringArray(left: unknown, right: readonly string[]): boolean {
  if (!Array.isArray(left) || left.length !== right.length) return false
  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function hasExactKeys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const keys = Object.keys(value)
  if (keys.length !== fields.length) return false
  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) return false
  }
  return true
}

function employeeReceiptMatches(snapshot: Employee, stored: Record<string, unknown>): boolean {
  if (!hasExactKeys(stored, EMPLOYEE_RESULT_FIELDS)) return false
  return stored.id === snapshot.id
    && stored.workspaceId === snapshot.workspaceId
    && stored.name === snapshot.name
    && stored.role === snapshot.role
    && stored.runtimeId === snapshot.runtimeId
    && stored.maxConcurrency === snapshot.maxConcurrency
    && stored.timeoutMs === snapshot.timeoutMs
    && stored.enabled === snapshot.enabled
    && stored.version === snapshot.version
    && sameStringArray(stored.responsibilities, snapshot.responsibilities)
    && sameStringArray(stored.capabilities, snapshot.capabilities)
    && sameStringArray(stored.projectIds, snapshot.projectIds)
}

function projectReceiptMatches(snapshot: Project, stored: Record<string, unknown>): boolean {
  if (!hasExactKeys(stored, PROJECT_RESULT_FIELDS)) return false
  return stored.id === snapshot.id
    && stored.workspaceId === snapshot.workspaceId
    && stored.name === snapshot.name
    && stored.ownerId === snapshot.ownerId
    && stored.repositoryPath === snapshot.repositoryPath
    && stored.worktreeRoot === snapshot.worktreeRoot
    && stored.archived === snapshot.archived
    && stored.version === snapshot.version
    && sameStringArray(stored.allowedTaskTypes, snapshot.allowedTaskTypes)
}

function loadReplaySnapshot<T>(load: () => T | undefined): T | undefined {
  try {
    return load()
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    if (/Corrupt management receipt|Management persistence failed/i.test(message)) {
      throw error instanceof Error ? error : corruptReceipt()
    }
    if (/not initialized|unsupported|schema|main schema/i.test(message)) throw error
    throw corruptReceipt()
  }
}

/**
 * Replay trusts immutable repository snapshots bound to the normalized command identity.
 * Matching receipt hashes still reject wrong kind/id or replaced bodies; older versions remain valid after later edits.
 */
function parseStoredResult(
  resultJson: string,
  workspaceId: string,
  command: NormalizedCommand,
  employees: EmployeeRepository,
  projects: ProjectRepository,
): StoredResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(resultJson)
  } catch {
    throw corruptReceipt()
  }
  if (!isObject(parsed) || typeof parsed.kind !== 'string') throw corruptReceipt()

  const expectedKind = expectedResultKind(command)
  const expectedId = expectedResourceId(command)
  if (parsed.kind !== expectedKind) throw corruptReceipt()

  if (expectedKind === 'employee') {
    if (!isObject(parsed.employee)) throw corruptReceipt()
    const stored = parsed.employee
    if (typeof stored.id !== 'string' || stored.id !== expectedId) throw corruptReceipt()
    const version = stored.version
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
      throw corruptReceipt()
    }
    const snapshot = loadReplaySnapshot(() => employees.snapshot(expectedId, version))
    if (!snapshot || snapshot.workspaceId !== workspaceId) throw corruptReceipt()
    if (!employeeReceiptMatches(snapshot, stored)) throw corruptReceipt()
    return { kind: 'employee', employee: cloneEmployee(snapshot) }
  }

  if (!isObject(parsed.project)) throw corruptReceipt()
  const stored = parsed.project
  if (typeof stored.id !== 'string' || stored.id !== expectedId) throw corruptReceipt()
  const version = stored.version
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw corruptReceipt()
  }
  const snapshot = loadReplaySnapshot(() => projects.snapshot(expectedId, version))
  if (!snapshot || snapshot.workspaceId !== workspaceId) throw corruptReceipt()
  if (!projectReceiptMatches(snapshot, stored)) throw corruptReceipt()
  return { kind: 'project', project: cloneProject(snapshot) }
}

function toResult(stored: StoredResult, replayed: boolean): ManagementResult {
  if (stored.kind === 'employee') {
    return { kind: 'employee', employee: cloneEmployee(stored.employee), replayed }
  }
  return { kind: 'project', project: cloneProject(stored.project), replayed }
}

function mapRepositoryError(error: unknown): never {
  if (error instanceof ManagementCommandError) throw error
  const message = error instanceof Error ? error.message : ''
  if (/Corrupt management receipt|Management persistence failed/i.test(message)) {
    throw error instanceof Error ? error : corruptReceipt()
  }
  if (/not initialized|unsupported management schema|Unsupported main schema|Management schema|main schema|corrupt/i.test(message)) {
    throw error
  }
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOTDIR') {
    throw new ManagementCommandError('INVALID_COMMAND', 'Invalid project path')
  }
  if (/^(?:Employee|Project) does not exist$/i.test(message)) {
    throw new ManagementCommandError('NOT_FOUND', 'Resource not found')
  }
  if (/version conflict/i.test(message)) {
    throw new ManagementCommandError('VERSION_CONFLICT', 'Resource version conflict')
  }
  if (/Archived project cannot be updated/i.test(message)) {
    throw new ManagementCommandError('STATE_CONFLICT', 'Project state conflict')
  }
  if (/already exists/i.test(message)) {
    throw new ManagementCommandError('STATE_CONFLICT', 'Resource state conflict')
  }
  if (/Invalid prepared project create|path validation cannot run inside a transaction/i.test(message)) {
    throw new ManagementCommandError('INVALID_COMMAND', 'Invalid command')
  }
  if (/Invalid |Missing |Unknown \w+ field|Duplicate |No updatable fields|must be|overlap|symbolic|Git/i.test(message)) {
    throw new ManagementCommandError('INVALID_COMMAND', 'Invalid command')
  }
  throw operationalFailure()
}

/** Trusted owner management facade: receipt replay + scoped mutations + immutable audits in one store transaction. */
export class LocalManagementCommands {
  private readonly store: LocalStore
  private readonly ownerId: string
  private readonly workspaceId: string
  private readonly runtimeIds: ReadonlySet<string>
  private readonly employees: EmployeeRepository
  private readonly projects: ProjectRepository

  constructor(options: LocalManagementCommandsOptions) {
    if (!options || typeof options !== 'object') {
      throw new ManagementCommandError('INVALID_COMMAND', 'Invalid LocalManagementCommands options')
    }
    if (!options.store) throw new ManagementCommandError('INVALID_COMMAND', 'LocalStore is required')
    requireSafeId(options.ownerId, 'ownerId')
    const workspaceId = options.workspaceId ?? 'local'
    requireSafeId(workspaceId, 'workspaceId')
    if (!Array.isArray(options.runtimeIds) || options.runtimeIds.length === 0) {
      throw new ManagementCommandError('INVALID_COMMAND', 'Invalid runtimeIds')
    }
    const runtimeIds = new Set<string>()
    for (const runtimeId of options.runtimeIds) {
      requireSafeId(runtimeId, 'runtimeId')
      runtimeIds.add(runtimeId)
    }
    requireManagementSchema(options.store.db)
    this.store = options.store
    this.ownerId = options.ownerId
    this.workspaceId = workspaceId
    this.runtimeIds = runtimeIds
    this.employees = new EmployeeRepository(options.store.db)
    this.projects = new ProjectRepository(options.store.db)
  }

  execute(key: string, command: ManagementCommand): ManagementResult {
    requireSafeId(key, 'key')
    const normalized = normalizeCommand(command)
    const commandHash = hashCommand(normalized)

    try {
      if (normalized.kind === 'project-create') {
        return this.executeProjectCreate(key, normalized, commandHash)
      }
      return this.store.atomic(() => this.executeInTransaction(key, normalized, commandHash))
    } catch (error) {
      if (error instanceof ManagementCommandError) throw error
      mapRepositoryError(error)
    }
  }

  history(kind: 'employee' | 'project', id: string): ManagementAudit[] {
    requireSafeId(id, 'id')
    if (kind !== 'employee' && kind !== 'project') {
      throw new ManagementCommandError('INVALID_COMMAND', 'Invalid kind')
    }
    try {
      requireManagementSchema(this.store.db)
      if (kind === 'employee') {
        const employee = this.employees.get(id)
        if (!employee || employee.workspaceId !== this.workspaceId) {
          throw new ManagementCommandError('NOT_FOUND', 'Resource not found')
        }
      } else {
        const project = this.projects.get(id)
        if (!project || project.workspaceId !== this.workspaceId) {
          throw new ManagementCommandError('NOT_FOUND', 'Resource not found')
        }
      }
      return listManagementAudits(this.store.db, this.workspaceId, this.ownerId, kind, id, 100).map(row => ({
        id: row.id,
        actorId: row.actor_id,
        workspaceId: row.workspace_id,
        kind: row.kind as 'employee' | 'project',
        resourceId: row.resource_id,
        action: row.action,
        reason: row.reason,
        beforeVersion: row.before_version,
        afterVersion: row.after_version,
        createdAt: row.created_at,
      }))
    } catch (error) {
      if (error instanceof ManagementCommandError) throw error
      mapRepositoryError(error)
    }
  }

  private executeProjectCreate(
    key: string,
    command: Extract<NormalizedCommand, { kind: 'project-create' }>,
    commandHash: string,
  ): ManagementResult {
    const existing = loadManagementReceipt(this.store.db, this.workspaceId, this.ownerId, key)
    if (existing) {
      if (existing.command_hash !== commandHash) {
        throw new ManagementCommandError('IDEMPOTENCY_CONFLICT', 'Idempotency key conflict')
      }
      return toResult(
        parseStoredResult(existing.result_json, this.workspaceId, command, this.employees, this.projects),
        true,
      )
    }

    let prepared: PreparedProjectCreate
    try {
      if (this.store.db.isTransaction) {
        throw new ManagementCommandError('INVALID_COMMAND', 'Invalid command')
      }
      prepared = this.projects.prepareCreate({
        ...command.input,
        workspaceId: this.workspaceId,
      })
    } catch (error) {
      mapRepositoryError(error)
    }

    return this.store.atomic(() => {
      const again = loadManagementReceipt(this.store.db, this.workspaceId, this.ownerId, key)
      if (again) {
        if (again.command_hash !== commandHash) {
          throw new ManagementCommandError('IDEMPOTENCY_CONFLICT', 'Idempotency key conflict')
        }
        return toResult(
          parseStoredResult(again.result_json, this.workspaceId, command, this.employees, this.projects),
          true,
        )
      }

      let project: Project
      try {
        project = this.projects.commitCreate(prepared)
      } catch (error) {
        mapRepositoryError(error)
      }
      if (project.workspaceId !== this.workspaceId) {
        throw new ManagementCommandError('NOT_FOUND', 'Resource not found')
      }

      const stored: StoredResult = { kind: 'project', project: cloneProject(project) }
      this.writeAuditAndReceipt(key, commandHash, command.kind, project.id, 'project', command.reason, null, project.version, stored)
      return toResult(stored, false)
    })
  }

  private executeInTransaction(
    key: string,
    command: Exclude<NormalizedCommand, { kind: 'project-create' }>,
    commandHash: string,
  ): ManagementResult {
    const existing = loadManagementReceipt(this.store.db, this.workspaceId, this.ownerId, key)
    if (existing) {
      if (existing.command_hash !== commandHash) {
        throw new ManagementCommandError('IDEMPOTENCY_CONFLICT', 'Idempotency key conflict')
      }
      return toResult(
        parseStoredResult(existing.result_json, this.workspaceId, command, this.employees, this.projects),
        true,
      )
    }

    switch (command.kind) {
      case 'employee-create':
        return this.createEmployee(key, commandHash, command)
      case 'employee-update':
        return this.updateEmployee(key, commandHash, command)
      case 'employee-enable':
        return this.enableEmployee(key, commandHash, command)
      case 'project-update':
        return this.updateProject(key, commandHash, command)
      case 'project-archive':
        return this.archiveProject(key, commandHash, command)
    }
  }

  private assertRuntimeAllowed(runtimeId: string): void {
    if (!this.runtimeIds.has(runtimeId)) {
      throw new ManagementCommandError('INVALID_COMMAND', 'Invalid runtimeId')
    }
  }

  private assertProjectBindings(projectIds: readonly string[]): void {
    for (const projectId of projectIds) {
      let project: Project | undefined
      try {
        project = this.projects.get(projectId)
      } catch (error) {
        mapRepositoryError(error)
      }
      if (!project || project.workspaceId !== this.workspaceId || project.archived) {
        throw new ManagementCommandError('INVALID_COMMAND', 'Invalid projectIds')
      }
    }
  }

  private requireScopedEmployee(id: string): Employee {
    let employee: Employee | undefined
    try {
      employee = this.employees.get(id)
    } catch (error) {
      mapRepositoryError(error)
    }
    if (!employee || employee.workspaceId !== this.workspaceId) {
      throw new ManagementCommandError('NOT_FOUND', 'Resource not found')
    }
    return employee
  }

  private requireScopedProject(id: string): Project {
    let project: Project | undefined
    try {
      project = this.projects.get(id)
    } catch (error) {
      mapRepositoryError(error)
    }
    if (!project || project.workspaceId !== this.workspaceId) {
      throw new ManagementCommandError('NOT_FOUND', 'Resource not found')
    }
    return project
  }

  private writeAuditAndReceipt(
    key: string,
    commandHash: string,
    action: string,
    resourceId: string,
    kind: 'employee' | 'project',
    reason: string,
    beforeVersion: number | null,
    afterVersion: number,
    stored: StoredResult,
  ): void {
    const createdAt = new Date().toISOString()
    try {
      insertManagementAudit(this.store.db, {
        id: randomUUID(),
        actor_id: this.ownerId,
        workspace_id: this.workspaceId,
        kind,
        resource_id: resourceId,
        action,
        reason,
        before_version: beforeVersion,
        after_version: afterVersion,
        created_at: createdAt,
      })
      insertManagementReceipt(
        this.store.db,
        this.workspaceId,
        this.ownerId,
        key,
        commandHash,
        stored,
        createdAt,
      )
    } catch {
      throw operationalFailure()
    }
  }

  private createEmployee(
    key: string,
    commandHash: string,
    command: Extract<NormalizedCommand, { kind: 'employee-create' }>,
  ): ManagementResult {
    this.assertRuntimeAllowed(command.input.runtimeId)
    this.assertProjectBindings(command.input.projectIds)
    let employee: Employee
    try {
      employee = this.employees.create({
        ...command.input,
        workspaceId: this.workspaceId,
      })
    } catch (error) {
      mapRepositoryError(error)
    }
    if (employee.enabled) {
      throw new ManagementCommandError('STATE_CONFLICT', 'Employee state conflict')
    }
    if (employee.workspaceId !== this.workspaceId) {
      throw new ManagementCommandError('NOT_FOUND', 'Resource not found')
    }
    const stored: StoredResult = { kind: 'employee', employee: cloneEmployee(employee) }
    this.writeAuditAndReceipt(key, commandHash, command.kind, employee.id, 'employee', command.reason, null, employee.version, stored)
    return toResult(stored, false)
  }

  private updateEmployee(
    key: string,
    commandHash: string,
    command: Extract<NormalizedCommand, { kind: 'employee-update' }>,
  ): ManagementResult {
    const current = this.requireScopedEmployee(command.id)
    if (current.version !== command.input.expectedVersion) {
      throw new ManagementCommandError('VERSION_CONFLICT', 'Resource version conflict')
    }
    if (current.enabled) {
      for (const field of Object.keys(command.input)) {
        if (SENSITIVE_EMPLOYEE_UPDATE.has(field)) {
          throw new ManagementCommandError('STATE_CONFLICT', 'Disable employee before changing configuration')
        }
      }
    }
    if (command.input.runtimeId !== undefined) this.assertRuntimeAllowed(command.input.runtimeId)
    if (command.input.projectIds !== undefined) this.assertProjectBindings(command.input.projectIds)

    let employee: Employee
    try {
      employee = this.employees.update(command.id, command.input)
    } catch (error) {
      mapRepositoryError(error)
    }
    if (employee.workspaceId !== this.workspaceId) {
      throw new ManagementCommandError('NOT_FOUND', 'Resource not found')
    }
    const stored: StoredResult = { kind: 'employee', employee: cloneEmployee(employee) }
    this.writeAuditAndReceipt(
      key,
      commandHash,
      command.kind,
      employee.id,
      'employee',
      command.reason,
      current.version,
      employee.version,
      stored,
    )
    return toResult(stored, false)
  }

  private enableEmployee(
    key: string,
    commandHash: string,
    command: Extract<NormalizedCommand, { kind: 'employee-enable' }>,
  ): ManagementResult {
    const current = this.requireScopedEmployee(command.id)
    if (current.version !== command.input.expectedVersion) {
      throw new ManagementCommandError('VERSION_CONFLICT', 'Resource version conflict')
    }
    if (command.input.enabled) {
      this.assertRuntimeAllowed(current.runtimeId)
      this.assertProjectBindings(current.projectIds)
    }
    let employee: Employee
    try {
      employee = this.employees.setEnabled(command.id, command.input)
    } catch (error) {
      mapRepositoryError(error)
    }
    if (employee.workspaceId !== this.workspaceId) {
      throw new ManagementCommandError('NOT_FOUND', 'Resource not found')
    }
    const stored: StoredResult = { kind: 'employee', employee: cloneEmployee(employee) }
    this.writeAuditAndReceipt(
      key,
      commandHash,
      command.kind,
      employee.id,
      'employee',
      command.reason,
      current.version,
      employee.version,
      stored,
    )
    return toResult(stored, false)
  }

  private updateProject(
    key: string,
    commandHash: string,
    command: Extract<NormalizedCommand, { kind: 'project-update' }>,
  ): ManagementResult {
    const current = this.requireScopedProject(command.id)
    if (current.version !== command.input.expectedVersion) {
      throw new ManagementCommandError('VERSION_CONFLICT', 'Resource version conflict')
    }
    if (current.archived) {
      throw new ManagementCommandError('STATE_CONFLICT', 'Project state conflict')
    }
    let project: Project
    try {
      project = this.projects.update(command.id, command.input)
    } catch (error) {
      mapRepositoryError(error)
    }
    if (project.workspaceId !== this.workspaceId) {
      throw new ManagementCommandError('NOT_FOUND', 'Resource not found')
    }
    const stored: StoredResult = { kind: 'project', project: cloneProject(project) }
    this.writeAuditAndReceipt(
      key,
      commandHash,
      command.kind,
      project.id,
      'project',
      command.reason,
      current.version,
      project.version,
      stored,
    )
    return toResult(stored, false)
  }

  private archiveProject(
    key: string,
    commandHash: string,
    command: Extract<NormalizedCommand, { kind: 'project-archive' }>,
  ): ManagementResult {
    const current = this.requireScopedProject(command.id)
    if (current.version !== command.input.expectedVersion) {
      throw new ManagementCommandError('VERSION_CONFLICT', 'Resource version conflict')
    }
    let project: Project
    try {
      project = this.projects.archive(command.id, command.input)
    } catch (error) {
      mapRepositoryError(error)
    }
    if (project.workspaceId !== this.workspaceId) {
      throw new ManagementCommandError('NOT_FOUND', 'Resource not found')
    }
    const stored: StoredResult = { kind: 'project', project: cloneProject(project) }
    this.writeAuditAndReceipt(
      key,
      commandHash,
      command.kind,
      project.id,
      'project',
      command.reason,
      current.version,
      project.version,
      stored,
    )
    return toResult(stored, false)
  }
}
