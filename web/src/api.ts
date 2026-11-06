import type { ManagementCommand, ManagementResult, ManagementAudit } from '../../src/application/management-commands.ts'
import { createVerificationApi, type VerificationApi } from './verification-api.ts'
import { createChangeStreamClient } from './change-stream.ts'
import type { ChangeStreamClient } from './realtime-model.ts'
export type { ManagementCommand, ManagementResult, ManagementAudit } from '../../src/application/management-commands.ts'
import type { ProductOverview, ProductTaskListOptions, ProductTaskListResult, ProductTaskDetail, ProductExecutionListOptions, ProductExecutionListResult } from '../../src/application/product-queries.ts'
import type { LocalTaskCommand, TaskCommandResult } from '../../src/application/task-commands.ts'
import type { Employee } from '../../src/workforce/employees.ts'
import type { Project } from '../../src/projects/projects.ts'
import type { ExecutionRecord } from '../../src/execution/model.ts'
import type { ExecutionLogsResult } from '../../src/observability/execution-logs.ts'
export type { ProductOverview, ProductTaskListOptions, ProductTaskListResult, ProductTaskDetail, ProductExecutionListOptions, ProductExecutionListResult, LocalTaskCommand, TaskCommandResult, Employee, Project, ExecutionRecord, ExecutionLogsResult }
export interface Principal { ownerId: string; workspaceId: string; role: 'owner' }
export interface ApiClient {
  verification?: VerificationApi
  changes?: ChangeStreamClient
  executions(options?: ProductExecutionListOptions, signal?: AbortSignal): Promise<ProductExecutionListResult>
  manage(key: string, command: ManagementCommand, signal?: AbortSignal): Promise<ManagementResult>
  managementHistory(kind: 'employee' | 'project', id: string, signal?: AbortSignal): Promise<{items: ManagementAudit[]}>
  me(signal?: AbortSignal): Promise<Principal>
  overview(signal?: AbortSignal): Promise<ProductOverview>
  employees(signal?: AbortSignal): Promise<Employee[]>
  projects(signal?: AbortSignal): Promise<Project[]>
  tasks(options?: ProductTaskListOptions, signal?: AbortSignal): Promise<ProductTaskListResult>
  task(id: string, signal?: AbortSignal): Promise<ProductTaskDetail>
  execution(id: string, signal?: AbortSignal): Promise<ExecutionRecord>
  logs(ticketId: string, options?: { executionId?: string; maxBytes?: number }, signal?: AbortSignal): Promise<ExecutionLogsResult>
  command(key: string, command: LocalTaskCommand, signal?: AbortSignal): Promise<TaskCommandResult>
}

const API_PREFIX = '/api/v1'
const REQUEST_TIMEOUT_MS = 15_000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const MAX_TASK_LIMIT = 200
const MAX_LOG_BYTES = 1024 * 1024
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const TOKEN_HEX = /^[0-9a-f]{64}$/
const TASK_OPTION_KEYS = new Set(['limit', 'beforeRowid', 'states', 'projectId', 'employeeId'])
const LOG_OPTION_KEYS = new Set(['executionId', 'maxBytes'])
const TASK_STATES = [
  'NEW',
  'QUEUED',
  'ASSIGNED',
  'RUNNING',
  'REVIEW',
  'DONE',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
  'WAITING_APPROVAL',
] as const
const TASK_STATE_SET = new Set<string>(TASK_STATES)
const EXECUTION_STATES = [
  'STARTING',
  'RUNNING',
  'STOPPING',
  'SUCCEEDED',
  'FAILED',
  'TIMED_OUT',
  'CANCELLED',
  'UNKNOWN',
] as const
const EXECUTION_STATE_SET = new Set<string>(EXECUTION_STATES)
const SAFE_ERROR_CODES = new Set([
  'UNAUTHORIZED',
  'INVALID_REQUEST',
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'STATE_CONFLICT',
  'INVALID_HOST',
  'FORBIDDEN_ORIGIN',
  'INTERNAL_ERROR',
  'REQUEST_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'TIMEOUT',
  'ABORTED',
  'NETWORK',
  'INVALID_RESPONSE',
])

const ERROR_MESSAGES: Record<string, string> = {
  UNAUTHORIZED: '未授权，请重新连接。',
  INVALID_REQUEST: '请求无效。',
  NOT_FOUND: '未找到资源。',
  VERSION_CONFLICT: '版本冲突，请刷新后重试。',
  IDEMPOTENCY_CONFLICT: '幂等键冲突，请使用新的确认操作。',
  STATE_CONFLICT: '当前状态不允许此操作。',
  INVALID_HOST: '主机校验失败。',
  FORBIDDEN_ORIGIN: '来源不被允许。',
  INTERNAL_ERROR: '服务暂时不可用。',
  REQUEST_TOO_LARGE: '请求过大。',
  UNSUPPORTED_MEDIA_TYPE: '不支持的媒体类型。',
  TIMEOUT: '请求超时，请稍后重试。',
  ABORTED: '请求已取消。',
  NETWORK: '网络异常，请稍后重试。',
  INVALID_RESPONSE: '响应无效，请稍后重试。',
}

export class ApiError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, status: number) {
    const safeCode = SAFE_ERROR_CODES.has(code) ? code : 'INTERNAL_ERROR'
    super(ERROR_MESSAGES[safeCode] ?? ERROR_MESSAGES.INTERNAL_ERROR)
    this.name = 'ApiError'
    this.code = safeCode
    this.status = status
  }
}

export function newCommandKey(): string {
  return crypto.randomUUID()
}

function requireSafeId(value: unknown, _label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new ApiError('INVALID_REQUEST', 400)
  }
  return value
}

function requireSafeKey(value: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new ApiError('INVALID_REQUEST', 400)
  }
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function failInvalidResponse(): never {
  throw new ApiError('INVALID_RESPONSE', 0)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    failInvalidResponse()
  }
}

function errorCodeFromBody(body: unknown): string {
  if (!isRecord(body) || !isRecord(body.error)) return 'INTERNAL_ERROR'
  const code = body.error.code
  if (typeof code !== 'string' || !SAFE_ERROR_CODES.has(code)) return 'INTERNAL_ERROR'
  return code
}

function requireStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') failInvalidResponse()
  return value
}

function requireNumberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) failInvalidResponse()
  return value
}

function requireBooleanField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') failInvalidResponse()
  return value
}

function assertPrincipal(value: unknown): Principal {
  if (!isRecord(value)) failInvalidResponse()
  if (typeof value.ownerId !== 'string' || typeof value.workspaceId !== 'string' || value.role !== 'owner') {
    failInvalidResponse()
  }
  return { ownerId: value.ownerId, workspaceId: value.workspaceId, role: 'owner' }
}

function assertOverview(value: unknown): ProductOverview {
  if (!isRecord(value) || !isRecord(value.tasks) || !isRecord(value.employees) || !isRecord(value.executions)) {
    failInvalidResponse()
  }
  if (typeof value.tasks.total !== 'number' || !isRecord(value.tasks.byStatus)) failInvalidResponse()
  for (const count of Object.values(value.tasks.byStatus)) {
    if (typeof count !== 'number' || !Number.isFinite(count)) failInvalidResponse()
  }
  if (
    typeof value.employees.configured !== 'number'
    || typeof value.employees.enabled !== 'number'
    || typeof value.employees.busy !== 'number'
  ) {
    failInvalidResponse()
  }
  if (
    typeof value.executions.total !== 'number'
    || typeof value.executions.active !== 'number'
    || typeof value.executions.unknown !== 'number'
  ) {
    failInvalidResponse()
  }
  return value as unknown as ProductOverview
}

function assertTaskListItem(value: unknown): void {
  if (!isRecord(value)) failInvalidResponse()
  requireStringField(value, 'id')
  requireStringField(value, 'title')
  const status = requireStringField(value, 'status')
  if (!TASK_STATE_SET.has(status)) failInvalidResponse()
  requireStringField(value, 'updatedAt')
  requireNumberField(value, 'priority')
  requireStringField(value, 'source')
  requireNumberField(value, 'rowid')
  if (value.agentId !== undefined && typeof value.agentId !== 'string') failInvalidResponse()
}

function assertTaskList(value: unknown): ProductTaskListResult {
  if (!isRecord(value) || !Array.isArray(value.items)) failInvalidResponse()
  for (const item of value.items) assertTaskListItem(item)
  if (value.nextCursor !== undefined && (typeof value.nextCursor !== 'number' || !Number.isSafeInteger(value.nextCursor))) {
    failInvalidResponse()
  }
  return value as unknown as ProductTaskListResult
}

function assertTicketBasics(value: unknown): void {
  if (!isRecord(value)) failInvalidResponse()
  requireStringField(value, 'id')
  requireStringField(value, 'title')
  requireStringField(value, 'createdAt')
  requireStringField(value, 'updatedAt')
  if (value.lifecycle !== undefined) {
    if (!isRecord(value.lifecycle)) failInvalidResponse()
    const status = requireStringField(value.lifecycle, 'status')
    if (!TASK_STATE_SET.has(status)) failInvalidResponse()
    requireNumberField(value.lifecycle, 'version')
  }
}

function assertTaskDetail(value: unknown): ProductTaskDetail {
  if (!isRecord(value)) failInvalidResponse()
  assertTicketBasics(value.ticket)
  if (!Array.isArray(value.executions) || !Array.isArray(value.history)) failInvalidResponse()
  for (const execution of value.executions) assertExecution(execution)
  if (typeof value.historyTruncated !== 'boolean' || typeof value.executionsTruncated !== 'boolean') {
    failInvalidResponse()
  }
  return value as unknown as ProductTaskDetail
}

function assertExecution(value: unknown): ExecutionRecord {
  if (!isRecord(value)) failInvalidResponse()
  const executionId = requireStringField(value, 'executionId')
  if (!SAFE_ID.test(executionId)) failInvalidResponse()
  requireStringField(value, 'assignmentId')
  requireStringField(value, 'ticketId')
  requireStringField(value, 'agentId')
  requireStringField(value, 'runtime')
  requireNumberField(value, 'generation')
  requireStringField(value, 'cwd')
  requireStringField(value, 'inputRevision')
  requireStringField(value, 'policyVersion')
  const state = requireStringField(value, 'state')
  if (!EXECUTION_STATE_SET.has(state)) failInvalidResponse()
  requireStringField(value, 'createdAt')
  requireStringField(value, 'updatedAt')
  requireNumberField(value, 'lastSequence')
  return value as unknown as ExecutionRecord
}

function assertLogEntry(value: unknown): void {
  if (!isRecord(value)) failInvalidResponse()
  requireStringField(value, 'executionId')
  requireStringField(value, 'state')
  requireStringField(value, 'stdout')
  requireStringField(value, 'stderr')
  requireBooleanField(value, 'stdoutTruncated')
  requireBooleanField(value, 'stderrTruncated')
}

function assertLogs(value: unknown): ExecutionLogsResult {
  if (!isRecord(value) || typeof value.ticketId !== 'string' || !Array.isArray(value.executions)) {
    failInvalidResponse()
  }
  for (const entry of value.executions) assertLogEntry(entry)
  return value as unknown as ExecutionLogsResult
}

function assertCommandResult(value: unknown): TaskCommandResult {
  if (!isRecord(value) || typeof value.replayed !== 'boolean') failInvalidResponse()
  assertTicketBasics(value.ticket)
  return value as unknown as TaskCommandResult
}

function assertEmployee(value: unknown): void {
  if (!isRecord(value)) failInvalidResponse()
  requireStringField(value, 'id')
  requireStringField(value, 'workspaceId')
  requireStringField(value, 'name')
  requireStringField(value, 'role')
  if (!Array.isArray(value.responsibilities) || !Array.isArray(value.capabilities) || !Array.isArray(value.projectIds)) {
    failInvalidResponse()
  }
  requireStringField(value, 'runtimeId')
  requireNumberField(value, 'maxConcurrency')
  requireNumberField(value, 'timeoutMs')
  requireBooleanField(value, 'enabled')
  requireNumberField(value, 'version')
}

function assertEmployeeList(value: unknown): Employee[] {
  if (!Array.isArray(value)) failInvalidResponse()
  for (const item of value) assertEmployee(item)
  return value as unknown as Employee[]
}

function assertProject(value: unknown): void {
  if (!isRecord(value)) failInvalidResponse()
  requireStringField(value, 'id')
  requireStringField(value, 'workspaceId')
  requireStringField(value, 'name')
  requireStringField(value, 'ownerId')
  requireStringField(value, 'repositoryPath')
  requireStringField(value, 'worktreeRoot')
  if (!Array.isArray(value.allowedTaskTypes)) failInvalidResponse()
  requireBooleanField(value, 'archived')
  requireNumberField(value, 'version')
}

function assertProjectList(value: unknown): Project[] {
  if (!Array.isArray(value)) failInvalidResponse()
  for (const item of value) assertProject(item)
  return value as unknown as Project[]
}

function buildTasksQuery(options?: ProductTaskListOptions): string {
  if (options === undefined) return ''
  if (!isRecord(options)) throw new ApiError('INVALID_REQUEST', 400)
  for (const key of Object.keys(options)) {
    if (!TASK_OPTION_KEYS.has(key)) throw new ApiError('INVALID_REQUEST', 400)
  }
  const params = new URLSearchParams()
  if (options.limit !== undefined) {
    if (typeof options.limit !== 'number' || !Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > MAX_TASK_LIMIT) {
      throw new ApiError('INVALID_REQUEST', 400)
    }
    params.set('limit', String(options.limit))
  }
  if (options.beforeRowid !== undefined) {
    if (typeof options.beforeRowid !== 'number' || !Number.isSafeInteger(options.beforeRowid) || options.beforeRowid < 1) {
      throw new ApiError('INVALID_REQUEST', 400)
    }
    params.set('beforeRowid', String(options.beforeRowid))
  }
  if (options.states !== undefined) {
    if (!Array.isArray(options.states) || options.states.length === 0) {
      throw new ApiError('INVALID_REQUEST', 400)
    }
    const seen = new Set<string>()
    for (const state of options.states) {
      if (typeof state !== 'string' || !TASK_STATE_SET.has(state) || seen.has(state)) {
        throw new ApiError('INVALID_REQUEST', 400)
      }
      seen.add(state)
    }
    params.set('states', options.states.join(','))
  }
  if (options.projectId !== undefined) {
    params.set('projectId', requireSafeId(options.projectId, 'projectId'))
  }
  if (options.employeeId !== undefined) {
    params.set('employeeId', requireSafeId(options.employeeId, 'employeeId'))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

function buildLogsQuery(options?: { executionId?: string; maxBytes?: number }): string {
  if (options === undefined) return ''
  if (!isRecord(options)) throw new ApiError('INVALID_REQUEST', 400)
  for (const key of Object.keys(options)) {
    if (!LOG_OPTION_KEYS.has(key)) throw new ApiError('INVALID_REQUEST', 400)
  }
  const params = new URLSearchParams()
  if (options.executionId !== undefined) {
    params.set('executionId', requireSafeId(options.executionId, 'executionId'))
  }
  if (options.maxBytes !== undefined) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > MAX_LOG_BYTES) {
      throw new ApiError('INVALID_REQUEST', 400)
    }
    params.set('maxBytes', String(options.maxBytes))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

function commandPath(command: LocalTaskCommand): string {
  switch (command.kind) {
    case 'create':
      return `${API_PREFIX}/tasks`
    case 'approve':
    case 'reject':
    case 'cancel':
    case 'retry':
      return `${API_PREFIX}/tasks/${encodeURIComponent(requireSafeId(command.ticketId, 'ticketId'))}/${command.kind}`
    case 'review':
      return `${API_PREFIX}/tasks/${encodeURIComponent(requireSafeId(command.ticketId, 'ticketId'))}/review`
    default: {
      const _exhaustive: never = command
      void _exhaustive
      throw new ApiError('INVALID_REQUEST', 400)
    }
  }
}

function commandBody(command: LocalTaskCommand): unknown {
  switch (command.kind) {
    case 'create':
      return command.input
    case 'approve':
    case 'reject':
    case 'cancel':
    case 'retry':
      return { expectedVersion: command.expectedVersion, reason: command.reason }
    case 'review':
      return {
        expectedVersion: command.expectedVersion,
        executionId: command.executionId,
        artifactRevision: command.artifactRevision,
        approved: command.approved,
        reason: command.reason,
      }
    default: {
      const _exhaustive: never = command
      void _exhaustive
      throw new ApiError('INVALID_REQUEST', 400)
    }
  }
}

async function readBoundedText(response: Response, signal?: AbortSignal): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (contentLength !== null) {
    const size = Number(contentLength)
    if (!Number.isFinite(size) || size < 0 || size > MAX_RESPONSE_BYTES) {
      failInvalidResponse()
    }
  }

  const body = response.body
  if (!body) return ''

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0

  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined)
  }

  if (signal) {
    if (signal.aborted) {
      try {
        await reader.cancel()
      } catch {
        // ignore cancel failure
      } finally {
        try {
          reader.releaseLock()
        } catch {
          // lock may already be released
        }
      }
      throw new DOMException('Aborted', 'AbortError')
    }
    signal.addEventListener('abort', onAbort)
  }

  try {
    for (;;) {
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      const { done, value } = await reader.read()
      if (signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError')
      }
      if (done) break
      if (!value || value.byteLength === 0) continue
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel()
        } catch {
          // ignore cancel failure
        }
        failInvalidResponse()
      }
      chunks.push(value)
    }
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }
  } catch (error) {
    if (!(error instanceof ApiError)) {
      try {
        await reader.cancel()
      } catch {
        // ignore cancel failure
      }
    }
    throw error
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort)
    try {
      reader.releaseLock()
    } catch {
      // lock may already be released after cancel/close
    }
  }

  if (chunks.length === 0) return ''
  if (chunks.length === 1) return new TextDecoder().decode(chunks[0])
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

function mapRequestFailure(error: unknown, caller: AbortSignal | undefined, timedOut: boolean): never {
  if (error instanceof ApiError) throw error
  if (caller?.aborted) throw new ApiError('ABORTED', 0)
  if (timedOut) throw new ApiError('TIMEOUT', 0)
  if (error instanceof DOMException && error.name === 'AbortError') {
    throw new ApiError('TIMEOUT', 0)
  }
  if (error instanceof Error && error.name === 'AbortError') {
    throw new ApiError('TIMEOUT', 0)
  }
  throw new ApiError('NETWORK', 0)
}

function managementRequest(command: ManagementCommand): {path: string; body: unknown} {
  const body = {input: command.input, reason: command.reason}
  switch (command.kind) {
    case 'employee-create': return {path: `${API_PREFIX}/employees`, body}
    case 'project-create': return {path: `${API_PREFIX}/projects`, body}
    case 'employee-update': return {path: `${API_PREFIX}/employees/${requireSafeId(command.id, 'id')}/update`, body}
    case 'employee-enable': return {path: `${API_PREFIX}/employees/${requireSafeId(command.id, 'id')}/enable`, body}
    case 'project-update': return {path: `${API_PREFIX}/projects/${requireSafeId(command.id, 'id')}/update`, body}
    case 'project-archive': return {path: `${API_PREFIX}/projects/${requireSafeId(command.id, 'id')}/archive`, body}
    default: throw new ApiError('INVALID_REQUEST', 400)
  }
}
function assertManagementResult(value: unknown): ManagementResult {
  if (!isRecord(value) || typeof value.replayed !== 'boolean') failInvalidResponse()
  if (value.kind === 'employee') {assertEmployee(value.employee); return value as unknown as ManagementResult}
  if (value.kind === 'project') {assertProject(value.project); return value as unknown as ManagementResult}
  return failInvalidResponse()
}
function assertManagementHistory(value: unknown): {items: ManagementAudit[]} {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > 100) failInvalidResponse()
  const actions = new Set(['employee-create','employee-update','employee-enable','project-create','project-update','project-archive'])
  for (const entry of value.items) {
    if (!isRecord(entry)) failInvalidResponse()
    for (const key of ['id','actorId','workspaceId','resourceId','reason','createdAt']) requireStringField(entry,key)
    if ((entry.kind !== 'employee' && entry.kind !== 'project') || typeof entry.action !== 'string' || !actions.has(entry.action)) failInvalidResponse()
    if (entry.beforeVersion !== null && (!Number.isSafeInteger(entry.beforeVersion) || Number(entry.beforeVersion) < 1)) failInvalidResponse()
    if (!Number.isSafeInteger(entry.afterVersion) || Number(entry.afterVersion) < 1) failInvalidResponse()
  }
  return value as unknown as {items: ManagementAudit[]}
}

export function createApiClient(token: string): ApiClient {
  if (typeof token !== 'string' || !TOKEN_HEX.test(token)) {
    throw new ApiError('INVALID_REQUEST', 400)
  }
  const authorization = `Bearer ${token}`

  async function request<T>(
    path: string,
    init: {
      method: 'GET' | 'POST'
      body?: unknown
      idempotencyKey?: string
      signal?: AbortSignal
      parse: (value: unknown) => T
      okStatuses: ReadonlySet<number>
    },
  ): Promise<T> {
    if (init.signal?.aborted) {
      throw new ApiError('ABORTED', 0)
    }

    const controller = new AbortController()
    let timedOut = false
    const timeoutId = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, REQUEST_TIMEOUT_MS)

    const onCallerAbort = (): void => {
      controller.abort()
    }
    if (init.signal) {
      init.signal.addEventListener('abort', onCallerAbort)
    }

    try {
      try {
        const headers: Record<string, string> = {
          Authorization: authorization,
          Accept: 'application/json',
        }
        if (init.idempotencyKey !== undefined) {
          headers['Idempotency-Key'] = init.idempotencyKey
        }
        if (init.body !== undefined) {
          headers['Content-Type'] = 'application/json'
        }

        const response = await fetch(path, {
          method: init.method,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
        })

        const text = await readBoundedText(response, controller.signal)
        if (!init.okStatuses.has(response.status)) {
          const body = text.length === 0 ? undefined : parseJson(text)
          throw new ApiError(errorCodeFromBody(body), response.status)
        }
        if (text.length === 0) failInvalidResponse()
        return init.parse(parseJson(text))
      } catch (error) {
        return mapRequestFailure(error, init.signal, timedOut)
      }
    } finally {
      clearTimeout(timeoutId)
      if (init.signal) {
        init.signal.removeEventListener('abort', onCallerAbort)
      }
    }
  }

  const client: ApiClient = {
    changes: createChangeStreamClient({open: ({cursor,signal}) => {
      const headers = new Headers()
      headers.set('Authorization',authorization)
      headers.set('Accept','text/event-stream')
      if(cursor !== undefined) headers.set('Last-Event-ID',cursor)
      return fetch(`${API_PREFIX}/events`, {method:'GET',headers,signal,cache:'no-store',credentials:'omit',redirect:'error'})
    }}),
    verification: createVerificationApi({request}),
    async executions(options = {}, signal) {
      const params = new URLSearchParams()
      for (const key of Object.keys(options)) if (!['limit','beforeRowid','states','projectId','employeeId','ticketId'].includes(key)) throw new ApiError('INVALID_REQUEST',400)
      for (const key of ['limit','beforeRowid'] as const) {
        const value = options[key]
        if (value !== undefined) {if(!Number.isSafeInteger(value) || value < 1 || key === 'limit' && value > 200) throw new ApiError('INVALID_REQUEST',400);params.set(key,String(value))}
      }
      for (const key of ['projectId','employeeId','ticketId'] as const) if(options[key] !== undefined) params.set(key,requireSafeId(options[key],key))
      if(options.states !== undefined) {
        if(!Array.isArray(options.states) || options.states.length === 0 || new Set(options.states).size !== options.states.length || options.states.some(state => !EXECUTION_STATE_SET.has(state))) throw new ApiError('INVALID_REQUEST',400)
        params.set('states',options.states.join(','))
      }
      return request(`${API_PREFIX}/executions${params.size ? `?${params}` : ''}`, {method:'GET',signal,okStatuses:new Set([200]),parse(value) {
        if(!isRecord(value) || !Array.isArray(value.items) || value.items.length > 200) return failInvalidResponse()
        for(const item of value.items) assertExecution(item)
        if(value.nextCursor !== undefined && (!Number.isSafeInteger(value.nextCursor) || Number(value.nextCursor) < 1)) return failInvalidResponse()
        return value as unknown as ProductExecutionListResult
      }})
    },
    async manage(key, command, signal) {
      const idempotencyKey = requireSafeKey(key)
      const input = managementRequest(command)
      return request(input.path, {method:'POST',body:input.body,idempotencyKey,signal,okStatuses:new Set([200,201]),parse:assertManagementResult})
    },
    async managementHistory(kind, id, signal) {
      if (kind !== 'employee' && kind !== 'project') throw new ApiError('INVALID_REQUEST',400)
      return request(`${API_PREFIX}/${kind === 'employee' ? 'employees' : 'projects'}/${requireSafeId(id,'id')}/history`, {method:'GET',signal,okStatuses:new Set([200]),parse:assertManagementHistory})
    },
    async me(signal) {
      return request(`${API_PREFIX}/me`, {
        method: 'GET',
        signal,
        okStatuses: new Set([200]),
        parse: assertPrincipal,
      })
    },
    async overview(signal) {
      return request(`${API_PREFIX}/overview`, {
        method: 'GET',
        signal,
        okStatuses: new Set([200]),
        parse: assertOverview,
      })
    },
    async employees(signal) {
      return request(`${API_PREFIX}/employees`, {
        method: 'GET',
        signal,
        okStatuses: new Set([200]),
        parse: assertEmployeeList,
      })
    },
    async projects(signal) {
      return request(`${API_PREFIX}/projects`, {
        method: 'GET',
        signal,
        okStatuses: new Set([200]),
        parse: assertProjectList,
      })
    },
    async tasks(options, signal) {
      return request(`${API_PREFIX}/tasks${buildTasksQuery(options)}`, {
        method: 'GET',
        signal,
        okStatuses: new Set([200]),
        parse: assertTaskList,
      })
    },
    async task(id, signal) {
      const ticketId = requireSafeId(id, 'ticketId')
      return request(`${API_PREFIX}/tasks/${encodeURIComponent(ticketId)}`, {
        method: 'GET',
        signal,
        okStatuses: new Set([200]),
        parse: assertTaskDetail,
      })
    },
    async execution(id, signal) {
      const executionId = requireSafeId(id, 'executionId')
      return request(`${API_PREFIX}/executions/${encodeURIComponent(executionId)}`, {
        method: 'GET',
        signal,
        okStatuses: new Set([200]),
        parse: assertExecution,
      })
    },
    async logs(ticketId, options, signal) {
      const id = requireSafeId(ticketId, 'ticketId')
      return request(`${API_PREFIX}/tasks/${encodeURIComponent(id)}/logs${buildLogsQuery(options)}`, {
        method: 'GET',
        signal,
        okStatuses: new Set([200]),
        parse: assertLogs,
      })
    },
    async command(key, command, signal) {
      const idempotencyKey = requireSafeKey(key)
      return request(commandPath(command), {
        method: 'POST',
        body: commandBody(command),
        idempotencyKey,
        signal,
        okStatuses: new Set([200, 201]),
        parse: assertCommandResult,
      })
    },
  }

  return Object.freeze(client)
}
