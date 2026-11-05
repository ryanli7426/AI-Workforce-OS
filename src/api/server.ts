/** Authenticated local HTTP application transport. Factory never listens, migrates, or starts Runtime. */
import { isAbsolute } from 'node:path'
import { registerManagementRoutes } from './management-routes.ts'
import { loadWebAssets } from './web-assets.ts'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { assertLocalRequest, ApiAuthError } from './auth.ts'
import { ProductQueries } from '../application/product-queries.ts'
import {
  COMMAND_SCHEMA_KEY,
  COMMAND_SCHEMA_VERSION,
  LocalTaskCommands,
  TaskCommandError,
} from '../application/task-commands.ts'
import { validateSettings, type LocalSettings } from '../config/settings.ts'
import { EXECUTION_STATES, type ExecutionState } from '../execution/model.ts'
import { TASK_STATES, type TaskState } from '../core/lifecycle-model.ts'
import { readExecutionLogs } from '../observability/execution-logs.ts'
import { applicationRepositories } from '../storage/application-store.ts'
import type { LocalStore } from '../storage/store.ts'

const BODY_LIMIT = 128 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const CONNECTION_TIMEOUT_MS = 10_000
const MAX_ERROR_MESSAGE = 256
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const SAFE_FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const CREDENTIAL_FIELD = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pat|credential)/i
const IDEMPOTENCY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const POSITIVE_INT_STRING = /^[1-9][0-9]{0,15}$/
const TASK_STATE_SET = new Set<string>(TASK_STATES)
const MAX_TASK_LIMIT = 200

export interface ApiAuthenticator {
  authenticate(header: unknown): { ownerId: string; workspaceId: string }
}

export interface CreateApiServerOptions {
  store: LocalStore
  settings: LocalSettings
  authenticator: ApiAuthenticator
  allowedOrigins: readonly string[]
  dataDir: string
  webRoot?: string
}

interface ApiErrorBody {
  error: { code: string; message: string }
}

class HttpApiError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.name = 'HttpApiError'
    this.statusCode = statusCode
    this.code = code
  }
}

function failRequest(statusCode: number, code: string, message: string): never {
  throw new HttpApiError(statusCode, code, message)
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function requireNonemptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw new Error(`Invalid ${label}`)
  return value
}

function requireAbsoluteDataDir(value: unknown): string {
  const dataDir = requireNonemptyString(value, 'dataDir')
  if (!isAbsolute(dataDir)) throw new Error('Invalid dataDir')
  return dataDir
}

function snapshotAllowedOrigins(value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new Error('Invalid allowedOrigins')
  const origins = value.map(origin => {
    if (typeof origin !== 'string' || !origin || origin.includes('\0')) {
      throw new Error('Invalid allowedOrigins')
    }
    return origin
  })
  // Validate allowlist shape via actual assertLocalRequest (CLI: localhost host, no Origin).
  try {
    assertLocalRequest({ host: 'localhost', origin: undefined, allowedOrigins: origins })
  } catch (error) {
    if (error instanceof ApiAuthError) throw new Error('Invalid allowedOrigins')
    throw error
  }
  for (const origin of origins) {
    try {
      assertLocalRequest({ host: 'localhost', origin, allowedOrigins: origins })
    } catch (error) {
      if (error instanceof ApiAuthError) throw new Error('Invalid allowedOrigins')
      throw error
    }
  }
  return Object.freeze([...origins])
}

function sanitizeMessage(message: string, fallback: string): string {
  const trimmed = message.trim()
  if (!trimmed || trimmed.length > MAX_ERROR_MESSAGE) return fallback
  if (CREDENTIAL_FIELD.test(trimmed) || /Bearer\s+[0-9a-fA-F]{16,}|[0-9a-f]{64}/i.test(trimmed)) {
    return fallback
  }
  return trimmed
}

function headerNameCount(rawHeaders: readonly string[], name: string): number {
  const target = name.toLowerCase()
  let count = 0
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if ((rawHeaders[index] ?? '').toLowerCase() === target) count += 1
  }
  return count
}

function singleHeader(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) failRequest(400, 'INVALID_REQUEST', 'Invalid request')
  if (typeof value !== 'string') failRequest(400, 'INVALID_REQUEST', 'Invalid request')
  return value
}

function rejectDuplicateQueryKeys(url: string): void {
  const question = url.indexOf('?')
  if (question < 0) return
  const query = url.slice(question + 1).split('#', 1)[0] ?? ''
  if (!query) return
  const seen = new Set<string>()
  for (const part of query.split('&')) {
    if (!part) continue
    const rawKey = part.split('=', 1)[0] ?? ''
    let key: string
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '))
    } catch {
      failRequest(400, 'INVALID_REQUEST', 'Invalid request')
    }
    if (!key || seen.has(key)) failRequest(400, 'INVALID_REQUEST', 'Invalid request')
    seen.add(key)
  }
}

function readCommandSchemaVersion(db: LocalStore['db']): number {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(COMMAND_SCHEMA_KEY) as
    | { value: string }
    | undefined
  if (!row) throw new Error('Command schema is not initialized')
  let version: unknown
  try {
    version = JSON.parse(row.value) as unknown
  } catch {
    throw new Error('Invalid command schema metadata')
  }
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) {
    throw new Error('Invalid command schema metadata')
  }
  return version
}

function parseLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !POSITIVE_INT_STRING.test(value)) {
    failRequest(400, 'INVALID_REQUEST', 'Invalid request')
  }
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TASK_LIMIT) {
    failRequest(400, 'INVALID_REQUEST', 'Invalid request')
  }
  return limit
}

function parseBeforeRowid(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !POSITIVE_INT_STRING.test(value)) {
    failRequest(400, 'INVALID_REQUEST', 'Invalid request')
  }
  const beforeRowid = Number(value)
  if (!Number.isSafeInteger(beforeRowid) || beforeRowid < 1) {
    failRequest(400, 'INVALID_REQUEST', 'Invalid request')
  }
  return beforeRowid
}

function parseStates(value: unknown): TaskState[] | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !value) failRequest(400, 'INVALID_REQUEST', 'Invalid request')
  const parts = value.split(',')
  if (parts.length === 0 || parts.some(part => !part || !TASK_STATE_SET.has(part))) {
    failRequest(400, 'INVALID_REQUEST', 'Invalid request')
  }
  const seen = new Set<string>()
  for (const part of parts) {
    if (seen.has(part)) failRequest(400, 'INVALID_REQUEST', 'Invalid request')
    seen.add(part)
  }
  return parts as TaskState[]
}

function parseOptionalSafeId(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    failRequest(400, 'INVALID_REQUEST', `Invalid ${label}`)
  }
  return value
}

function requireIdempotencyKey(value: unknown): string {
  const key = singleHeader(value)
  if (key === undefined || !IDEMPOTENCY_KEY.test(key)) {
    failRequest(400, 'INVALID_REQUEST', 'Invalid Idempotency-Key')
  }
  return key
}

function setSecurityHeaders(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store')
  reply.header('X-Content-Type-Options', 'nosniff')
}

function sendError(reply: FastifyReply, statusCode: number, code: string, message: string): void {
  setSecurityHeaders(reply)
  const body: ApiErrorBody = { error: { code, message } }
  void reply.status(statusCode).send(body)
}

function mapUnknownError(error: unknown): { statusCode: number; code: string; message: string } {
  if (error instanceof HttpApiError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message }
  }
  if (error instanceof ApiAuthError) {
    if (error.code === 'UNAUTHORIZED') {
      return { statusCode: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' }
    }
    if (error.code === 'INVALID_HOST' || error.code === 'FORBIDDEN_ORIGIN') {
      return { statusCode: 403, code: error.code, message: error.message }
    }
    return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' }
  }
  if (error instanceof TaskCommandError) {
    switch (error.code) {
      case 'INVALID_COMMAND':
        return {
          statusCode: 400,
          code: 'INVALID_REQUEST',
          message: sanitizeMessage(error.message, 'Invalid request'),
        }
      case 'NOT_FOUND':
        return { statusCode: 404, code: 'NOT_FOUND', message: 'Not found' }
      case 'VERSION_CONFLICT':
      case 'IDEMPOTENCY_CONFLICT':
      case 'STATE_CONFLICT':
        return {
          statusCode: 409,
          code: error.code,
          message: sanitizeMessage(error.message, error.code),
        }
    }
  }
  if (typeof error === 'object' && error !== null) {
    const err = error as { validation?: unknown; statusCode?: unknown; code?: unknown }
    const code = typeof err.code === 'string' ? err.code : undefined
    if (
      err.validation !== undefined
      || code === 'FST_ERR_VALIDATION'
      || code === 'FST_ERR_CTP_INVALID_JSON_BODY'
      || code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
      || code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH'
    ) {
      return { statusCode: 400, code: 'INVALID_REQUEST', message: 'Invalid request' }
    }
    if (code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return { statusCode: 413, code: 'REQUEST_TOO_LARGE', message: 'Request too large' }
    }
    if (code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported media type' }
    }
    if (err.statusCode === 404 || code === 'FST_ERR_NOT_FOUND') {
      return { statusCode: 404, code: 'NOT_FOUND', message: 'Not found' }
    }
  }
  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' }
}

const errorResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['error'],
  properties: {
    error: {
      type: 'object',
      additionalProperties: false,
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
} as const

const ticketIdParams = {
  type: 'object',
  additionalProperties: false,
  required: ['ticketId'],
  properties: {
    ticketId: { type: 'string', pattern: SAFE_ID.source },
  },
} as const

const executionIdParams = {
  type: 'object',
  additionalProperties: false,
  required: ['executionId'],
  properties: {
    executionId: { type: 'string', pattern: SAFE_ID.source },
  },
} as const

const createTaskBody = {
  type: 'object',
  additionalProperties: false,
  required: ['projectId', 'issueId', 'title', 'description', 'taskType'],
  properties: {
    projectId: { type: 'string', pattern: SAFE_ID.source },
    issueId: { type: 'string', pattern: SAFE_ID.source },
    title: { type: 'string', minLength: 1, maxLength: 512 },
    description: { type: 'string', minLength: 1, maxLength: 8192 },
    taskType: { type: 'string', pattern: SAFE_ID.source },
    priority: { type: 'number', minimum: 0 },
  },
} as const

const reasonActionBody = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion', 'reason'],
  properties: {
    expectedVersion: { type: 'integer', minimum: 0 },
    reason: { type: 'string', minLength: 1, maxLength: 8192 },
  },
} as const

const reviewBody = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion', 'executionId', 'artifactRevision', 'approved', 'reason'],
  properties: {
    expectedVersion: { type: 'integer', minimum: 0 },
    executionId: { type: 'string', minLength: 1, maxLength: 512 },
    artifactRevision: { type: 'string', minLength: 1, maxLength: 512 },
    approved: { type: 'boolean' },
    reason: { type: 'string', minLength: 1, maxLength: 8192 },
  },
} as const

const tasksQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'string', pattern: POSITIVE_INT_STRING.source },
    beforeRowid: { type: 'string', pattern: POSITIVE_INT_STRING.source },
    states: { type: 'string', minLength: 1, maxLength: 512 },
    projectId: { type: 'string', pattern: SAFE_ID.source },
    employeeId: { type: 'string', pattern: SAFE_ID.source },
  },
} as const

const logsQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    executionId: { type: 'string', pattern: SAFE_ID.source },
    maxBytes: { type: 'string', pattern: POSITIVE_INT_STRING.source },
  },
} as const

const emptyQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const

/**
 * Build an authenticated Fastify application over an already-initialized store.
 * Does not listen, migrate schemas, start Runtime/controller, or alter process environment.
 */
export function createApiServer(options: CreateApiServerOptions): FastifyInstance {
  const input = requireObject(options, 'createApiServer options')
  const allowed = new Set(['store', 'settings', 'authenticator', 'allowedOrigins', 'dataDir', 'webRoot'])
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) {
      if (SAFE_FIELD_NAME.test(field) && !CREDENTIAL_FIELD.test(field)) {
        throw new Error(`Unknown createApiServer option: ${field}`)
      }
      throw new Error('Unknown createApiServer option')
    }
  }

  const store = input.store as LocalStore
  if (!store?.db || typeof store.db.prepare !== 'function') throw new Error('Invalid store')
  // validateSettings clones and rejects unknown/credential-shaped fields without echoing secrets.
  const settings = validateSettings(input.settings)

  const authenticator = input.authenticator as ApiAuthenticator
  if (!authenticator || typeof authenticator.authenticate !== 'function') {
    throw new Error('Invalid authenticator')
  }
  // Snapshot the bound method so later object-property mutation cannot swap the trusted provider.
  const authenticate = authenticator.authenticate.bind(authenticator)

  const allowedOrigins = snapshotAllowedOrigins(input.allowedOrigins)
  const dataDir = requireAbsoluteDataDir(input.dataDir)
  const webAssets = input.webRoot === undefined ? undefined : loadWebAssets(requireAbsoluteDataDir(input.webRoot))

  // Factory preflight: require current application modules + command receipts; never initialize.
  applicationRepositories(store.db)
  const commandSchema = readCommandSchemaVersion(store.db)
  if (commandSchema !== COMMAND_SCHEMA_VERSION) {
    throw new Error(`Unsupported command schema ${commandSchema}`)
  }
  const queries = ProductQueries({
    db: store.db,
    ownerId: settings.ownerId,
    workspaceId: settings.workspaceId,
  })
  const commands = new LocalTaskCommands({
    store,
    ownerId: settings.ownerId,
    workspaceId: settings.workspaceId,
    rules: settings.rules,
  })

  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: BODY_LIMIT,
    requestTimeout: REQUEST_TIMEOUT_MS,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
        allErrors: false,
      },
    },
  })

  app.addHook('onRequest', async (request, reply) => {
    setSecurityHeaders(reply)
    rejectDuplicateQueryKeys(request.url)

    const rawHeaders = request.raw.rawHeaders
    if (headerNameCount(rawHeaders, 'authorization') > 1) {
      failRequest(401, 'UNAUTHORIZED', 'Unauthorized')
    }
    if (headerNameCount(rawHeaders, 'host') > 1) {
      failRequest(403, 'INVALID_HOST', 'Invalid host')
    }
    if (headerNameCount(rawHeaders, 'origin') > 1) {
      failRequest(403, 'FORBIDDEN_ORIGIN', 'Forbidden origin')
    }

    const host = singleHeader(request.headers.host)
    const origin = singleHeader(request.headers.origin)
    try {
      // Port 0 is useful for owned browser tests. Derive its same-origin allowlist
      // from the bound socket, never from the incoming Host/forwarded headers.
      const socket = webAssets && allowedOrigins.length === 0 ? app.server.address() : null
      const requestOrigins = socket && typeof socket === 'object'
        ? [`http://127.0.0.1:${socket.port}`, `http://localhost:${socket.port}`]
        : allowedOrigins
      assertLocalRequest({ host, origin, allowedOrigins: requestOrigins })
    } catch (error) {
      if (error instanceof ApiAuthError) throw error
      failRequest(403, 'INVALID_HOST', 'Invalid host')
    }

    // Only exact snapshotted GET/HEAD build assets are public; Host/Origin checks still apply.
    if (webAssets?.isPublicRequest(request.method, request.url)) return

    const authorization = singleHeader(request.headers.authorization)
    let principal: { ownerId: string; workspaceId: string }
    try {
      principal = authenticate(authorization)
    } catch (error) {
      if (error instanceof ApiAuthError) throw error
      failRequest(401, 'UNAUTHORIZED', 'Unauthorized')
    }
    if (
      principal.ownerId !== settings.ownerId
      || principal.workspaceId !== settings.workspaceId
    ) {
      failRequest(401, 'UNAUTHORIZED', 'Unauthorized')
    }
    ;(request as FastifyRequest & { principal: { ownerId: string; workspaceId: string } }).principal = {
      ownerId: principal.ownerId,
      workspaceId: principal.workspaceId,
    }
  })

  app.addHook('onSend', async (_request, reply, payload) => {
    setSecurityHeaders(reply)
    return payload
  })

  app.setNotFoundHandler((_request, reply) => {
    sendError(reply, 404, 'NOT_FOUND', 'Not found')
  })

  app.setErrorHandler((error, _request, reply) => {
    const mapped = mapUnknownError(error)
    sendError(reply, mapped.statusCode, mapped.code, mapped.message)
  })

  registerManagementRoutes(app, {store,settings})
  webAssets?.register(app)

  app.get('/api/v1/health', {
    schema: {
      querystring: emptyQuery,
      response: {
        200: {
          type: 'object',
          additionalProperties: false,
          required: ['ready', 'workspaceId'],
          properties: {
            ready: { type: 'boolean' },
            workspaceId: { type: 'string' },
          },
        },
        401: errorResponseSchema,
        403: errorResponseSchema,
      },
    },
  }, async () => ({ ready: true as const, workspaceId: settings.workspaceId }))

  app.get('/api/v1/me', {
    schema: {
      querystring: emptyQuery,
      response: {
        200: {
          type: 'object',
          additionalProperties: false,
          required: ['ownerId', 'workspaceId', 'role'],
          properties: {
            ownerId: { type: 'string' },
            workspaceId: { type: 'string' },
            role: { type: 'string', enum: ['owner'] },
          },
        },
        401: errorResponseSchema,
        403: errorResponseSchema,
      },
    },
  }, async (request) => {
    const principal = (request as FastifyRequest & {
      principal: { ownerId: string; workspaceId: string }
    }).principal
    return {
      ownerId: principal.ownerId,
      workspaceId: principal.workspaceId,
      role: 'owner' as const,
    }
  })

  app.get('/api/v1/overview', {
    schema: { querystring: emptyQuery },
  }, async () => queries.overview())
  app.get('/api/v1/employees', {
    schema: { querystring: emptyQuery },
  }, async () => queries.employees())
  app.get('/api/v1/projects', {
    schema: { querystring: emptyQuery },
  }, async () => queries.projects())

  app.get('/api/v1/tasks', {
    schema: { querystring: tasksQuery },
  }, async (request) => {
    const query = request.query as {
      limit?: string
      beforeRowid?: string
      states?: string
      projectId?: string
      employeeId?: string
    }
    const limit = parseLimit(query.limit)
    const beforeRowid = parseBeforeRowid(query.beforeRowid)
    const states = parseStates(query.states)
    const projectId = parseOptionalSafeId(query.projectId, 'projectId')
    const employeeId = parseOptionalSafeId(query.employeeId, 'employeeId')
    return queries.tasks({
      ...(limit === undefined ? {} : { limit }),
      ...(beforeRowid === undefined ? {} : { beforeRowid }),
      ...(states === undefined ? {} : { states }),
      ...(projectId === undefined ? {} : { projectId }),
      ...(employeeId === undefined ? {} : { employeeId }),
    })
  })

  app.get('/api/v1/tasks/:ticketId', {
    schema: { params: ticketIdParams, querystring: emptyQuery },
  }, async (request) => {
    const { ticketId } = request.params as { ticketId: string }
    const detail = queries.task(ticketId)
    if (!detail) failRequest(404, 'NOT_FOUND', 'Not found')
    return detail
  })

  app.get('/api/v1/executions', {
    schema: {querystring: {...tasksQuery, properties: {...tasksQuery.properties, ticketId: {type:'string',pattern:SAFE_ID.source}}}},
  }, async request => {
    const query = request.query as {limit?:string;beforeRowid?:string;states?:string;projectId?:string;employeeId?:string;ticketId?:string}
    let states: ExecutionState[] | undefined
    if (query.states !== undefined) {
      const parts = query.states.split(',')
      if (parts.some(state => !EXECUTION_STATES.includes(state as ExecutionState)) || new Set(parts).size !== parts.length) failRequest(400,'INVALID_REQUEST','Invalid request')
      states = parts as ExecutionState[]
    }
    return queries.executions({limit:parseLimit(query.limit),beforeRowid:parseBeforeRowid(query.beforeRowid),states,projectId:parseOptionalSafeId(query.projectId,'projectId'),employeeId:parseOptionalSafeId(query.employeeId,'employeeId'),ticketId:parseOptionalSafeId(query.ticketId,'ticketId')})
  })

  app.get('/api/v1/executions/:executionId', {
    schema: { params: executionIdParams, querystring: emptyQuery },
  }, async (request) => {
    const { executionId } = request.params as { executionId: string }
    const record = queries.execution(executionId)
    if (!record) failRequest(404, 'NOT_FOUND', 'Not found')
    return record
  })

  app.get('/api/v1/tasks/:ticketId/logs', {
    schema: {
      params: ticketIdParams,
      querystring: logsQuery,
    },
  }, async (request) => {
    const { ticketId } = request.params as { ticketId: string }
    const query = request.query as { executionId?: string; maxBytes?: string }
    if (!queries.task(ticketId)) failRequest(404, 'NOT_FOUND', 'Not found')
    const executionId = parseOptionalSafeId(query.executionId, 'executionId')
    let maxBytes: number | undefined
    if (query.maxBytes !== undefined) {
      if (!POSITIVE_INT_STRING.test(query.maxBytes)) {
        failRequest(400, 'INVALID_REQUEST', 'Invalid request')
      }
      maxBytes = Number(query.maxBytes)
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) {
        failRequest(400, 'INVALID_REQUEST', 'Invalid request')
      }
    }
    try {
      return await readExecutionLogs({
        dataDir,
        ticketId,
        ...(executionId === undefined ? {} : { executionId }),
        ...(maxBytes === undefined ? {} : { maxBytes }),
      })
    } catch {
      failRequest(404, 'NOT_FOUND', 'Not found')
    }
  })

  app.post('/api/v1/tasks', {
    schema: { querystring: emptyQuery, body: createTaskBody },
  }, async (request, reply) => {
    const key = requireIdempotencyKey(request.headers['idempotency-key'])
    const body = request.body as {
      projectId: string
      issueId: string
      title: string
      description: string
      taskType: string
      priority?: number
    }
    const result = commands.execute(key, {
      kind: 'create',
      input: {
        projectId: body.projectId,
        issueId: body.issueId,
        title: body.title,
        description: body.description,
        taskType: body.taskType,
        ...(body.priority === undefined ? {} : { priority: body.priority }),
      },
    })
    setSecurityHeaders(reply)
    reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false')
    return reply.status(201).send({ ticket: result.ticket, replayed: result.replayed })
  })

  const registerAction = (
    path: '/api/v1/tasks/:ticketId/approve'
      | '/api/v1/tasks/:ticketId/reject'
      | '/api/v1/tasks/:ticketId/cancel'
      | '/api/v1/tasks/:ticketId/retry',
    kind: 'approve' | 'reject' | 'cancel' | 'retry',
  ): void => {
    app.post(path, {
      schema: {
        params: ticketIdParams,
        querystring: emptyQuery,
        body: reasonActionBody,
      },
    }, async (request, reply) => {
      const key = requireIdempotencyKey(request.headers['idempotency-key'])
      const { ticketId } = request.params as { ticketId: string }
      const body = request.body as { expectedVersion: number; reason: string }
      const result = commands.execute(key, {
        kind,
        ticketId,
        expectedVersion: body.expectedVersion,
        reason: body.reason,
      })
      setSecurityHeaders(reply)
      reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false')
      return reply.status(200).send({ ticket: result.ticket, replayed: result.replayed })
    })
  }

  registerAction('/api/v1/tasks/:ticketId/approve', 'approve')
  registerAction('/api/v1/tasks/:ticketId/reject', 'reject')
  registerAction('/api/v1/tasks/:ticketId/cancel', 'cancel')
  registerAction('/api/v1/tasks/:ticketId/retry', 'retry')

  app.post('/api/v1/tasks/:ticketId/review', {
    schema: {
      params: ticketIdParams,
      querystring: emptyQuery,
      body: reviewBody,
    },
  }, async (request, reply) => {
    const key = requireIdempotencyKey(request.headers['idempotency-key'])
    const { ticketId } = request.params as { ticketId: string }
    const body = request.body as {
      expectedVersion: number
      executionId: string
      artifactRevision: string
      approved: boolean
      reason: string
    }
    const result = commands.execute(key, {
      kind: 'review',
      ticketId,
      expectedVersion: body.expectedVersion,
      executionId: body.executionId,
      artifactRevision: body.artifactRevision,
      approved: body.approved,
      reason: body.reason,
    })
    setSecurityHeaders(reply)
    reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false')
    return reply.status(200).send({ ticket: result.ticket, replayed: result.replayed })
  })

  return app
}
