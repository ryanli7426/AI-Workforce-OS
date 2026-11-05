/** Independent employee/project management HTTP routes. No listen, migrate, controller, or Runtime. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  LocalManagementCommands,
  ManagementCommandError,
  type ManagementCommand,
  type ManagementResult,
} from '../application/management-commands.ts'
import { validateSettings, type LocalSettings } from '../config/settings.ts'
import type {
  ProjectArchiveInput,
  ProjectCreateInput,
  ProjectUpdateInput,
} from '../projects/projects.ts'
import { requireManagementSchema } from '../storage/management-commands.ts'
import type { LocalStore } from '../storage/store.ts'
import type {
  EmployeeCreateInput,
  EmployeeEnableInput,
  EmployeeUpdateInput,
} from '../workforce/employees.ts'

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const SAFE_FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const CREDENTIAL_FIELD = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pat|credential)/i
const IDEMPOTENCY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const MAX_ERROR_MESSAGE = 256
const MAX_REASON = 4096
const MAX_NAME_LENGTH = 256
const MAX_ROLE_LENGTH = 256
const MAX_LIST_ITEMS = 256
const MAX_ITEM_LENGTH = 512
const MAX_CONCURRENCY = 1024
const MAX_TIMEOUT_MS = 86_400_000
const MAX_PATH_LENGTH = 4096

export interface RegisterManagementRoutesOptions {
  store: LocalStore
  settings: LocalSettings
}

class ManagementHttpError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.name = 'ManagementHttpError'
    this.statusCode = statusCode
    this.code = code
  }
}

function failRequest(statusCode: number, code: string, message: string): never {
  throw new ManagementHttpError(statusCode, code, message)
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function sanitizeMessage(message: string, fallback: string): string {
  const trimmed = message.trim()
  if (!trimmed || trimmed.length > MAX_ERROR_MESSAGE) return fallback
  if (CREDENTIAL_FIELD.test(trimmed) || /Bearer\s+[0-9a-fA-F]{16,}|[0-9a-f]{64}/i.test(trimmed)) {
    return fallback
  }
  return trimmed
}

function singleHeader(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) failRequest(400, 'INVALID_REQUEST', 'Invalid request')
  if (typeof value !== 'string') failRequest(400, 'INVALID_REQUEST', 'Invalid request')
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
  void reply.status(statusCode).send({ error: { code, message } })
}

function mapManagedError(error: ManagementHttpError | ManagementCommandError): {
  statusCode: number
  code: string
  message: string
} {
  if (error instanceof ManagementHttpError) {
    return { statusCode: error.statusCode, code: error.code, message: error.message }
  }
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

async function withManagedErrors(
  reply: FastifyReply,
  operation: () => Promise<unknown> | unknown,
): Promise<unknown> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof ManagementHttpError || error instanceof ManagementCommandError) {
      const mapped = mapManagedError(error)
      sendError(reply, mapped.statusCode, mapped.code, mapped.message)
      return reply
    }
    throw error
  }
}

const emptyQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {},
} as const

const idParams = {
  type: 'object',
  additionalProperties: false,
  required: ['id'],
  properties: {
    id: { type: 'string', pattern: SAFE_ID.source },
  },
} as const

const stringListSchema = {
  type: 'array',
  maxItems: MAX_LIST_ITEMS,
  items: { type: 'string', minLength: 1, maxLength: MAX_ITEM_LENGTH },
} as const

const safeIdListSchema = {
  type: 'array',
  maxItems: MAX_LIST_ITEMS,
  items: { type: 'string', pattern: SAFE_ID.source },
} as const

const reasonSchema = { type: 'string', minLength: 1, maxLength: MAX_REASON } as const

const employeeCreateInput = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'role',
    'responsibilities',
    'capabilities',
    'runtimeId',
    'projectIds',
    'maxConcurrency',
    'timeoutMs',
  ],
  properties: {
    id: { type: 'string', pattern: SAFE_ID.source },
    name: { type: 'string', minLength: 1, maxLength: MAX_NAME_LENGTH },
    role: { type: 'string', minLength: 1, maxLength: MAX_ROLE_LENGTH },
    responsibilities: stringListSchema,
    capabilities: stringListSchema,
    runtimeId: { type: 'string', pattern: SAFE_ID.source },
    projectIds: safeIdListSchema,
    maxConcurrency: { type: 'integer', minimum: 1, maximum: MAX_CONCURRENCY },
    timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS },
  },
} as const

const employeeUpdateInput = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion'],
  properties: {
    expectedVersion: { type: 'integer', minimum: 0 },
    name: { type: 'string', minLength: 1, maxLength: MAX_NAME_LENGTH },
    role: { type: 'string', minLength: 1, maxLength: MAX_ROLE_LENGTH },
    responsibilities: stringListSchema,
    capabilities: stringListSchema,
    runtimeId: { type: 'string', pattern: SAFE_ID.source },
    projectIds: safeIdListSchema,
    maxConcurrency: { type: 'integer', minimum: 1, maximum: MAX_CONCURRENCY },
    timeoutMs: { type: 'integer', minimum: 1, maximum: MAX_TIMEOUT_MS },
  },
} as const

const employeeEnableInput = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion', 'enabled'],
  properties: {
    expectedVersion: { type: 'integer', minimum: 0 },
    enabled: { type: 'boolean' },
  },
} as const

const projectCreateInput = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'ownerId',
    'repositoryPath',
    'worktreeRoot',
    'allowedTaskTypes',
  ],
  properties: {
    id: { type: 'string', pattern: SAFE_ID.source },
    name: { type: 'string', minLength: 1, maxLength: MAX_NAME_LENGTH },
    ownerId: { type: 'string', pattern: SAFE_ID.source },
    repositoryPath: { type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH },
    worktreeRoot: { type: 'string', minLength: 1, maxLength: MAX_PATH_LENGTH },
    allowedTaskTypes: stringListSchema,
  },
} as const

const projectUpdateInput = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion'],
  properties: {
    expectedVersion: { type: 'integer', minimum: 0 },
    name: { type: 'string', minLength: 1, maxLength: MAX_NAME_LENGTH },
    ownerId: { type: 'string', pattern: SAFE_ID.source },
    allowedTaskTypes: stringListSchema,
  },
} as const

const projectArchiveInput = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion'],
  properties: {
    expectedVersion: { type: 'integer', minimum: 0 },
  },
} as const

function mutationBody(inputSchema: object) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['input', 'reason'],
    properties: {
      input: inputSchema,
      reason: reasonSchema,
    },
  } as const
}

/**
 * Register governed employee/project management routes onto an already-authenticated Fastify app.
 * Requires current management schema; does not initialize, listen, migrate, or start Runtime.
 */
export function registerManagementRoutes(
  app: FastifyInstance,
  options: RegisterManagementRoutesOptions,
): void {
  const input = requireObject(options, 'registerManagementRoutes options')
  const allowed = new Set(['store', 'settings'])
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) throw new Error('Unknown registerManagementRoutes option')
  }

  const store = input.store as LocalStore
  if (!store?.db || typeof store.db.prepare !== 'function') throw new Error('Invalid store')
  const settings = validateSettings(input.settings)

  // Preflight only: refuse incomplete/future/unversioned management schema; never initialize.
  requireManagementSchema(store.db)

  const commands = new LocalManagementCommands({
    store,
    ownerId: settings.ownerId,
    workspaceId: settings.workspaceId,
    runtimeIds: [settings.runtime.id],
  })

  const registerMutation = (
    methodPath: string,
    bodySchema: object,
    statusCode: 200 | 201,
    buildCommand: (id: string | undefined, body: { input: Record<string, unknown>; reason: string }) => ManagementCommand,
    withId: boolean,
  ): void => {
    app.post(methodPath, {
      schema: {
        ...(withId ? { params: idParams } : {}),
        querystring: emptyQuery,
        body: bodySchema,
      },
    }, async (request: FastifyRequest, reply: FastifyReply) => withManagedErrors(reply, () => {
      const key = requireIdempotencyKey(request.headers['idempotency-key'])
      const params = request.params as { id?: string }
      const body = request.body as { input: unknown; reason: string }
      const result: ManagementResult = commands.execute(key, buildCommand(params.id, {
        input: body.input as Record<string, unknown>,
        reason: body.reason,
      }))
      setSecurityHeaders(reply)
      reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false')
      return reply.status(statusCode).send(result)
    }))
  }

  registerMutation(
    '/api/v1/employees',
    mutationBody(employeeCreateInput),
    201,
    (_id, body) => ({
      kind: 'employee-create',
      input: body.input as unknown as Omit<EmployeeCreateInput, 'workspaceId'>,
      reason: body.reason,
    }),
    false,
  )

  registerMutation(
    '/api/v1/employees/:id/update',
    mutationBody(employeeUpdateInput),
    200,
    (id, body) => ({
      kind: 'employee-update',
      id: id!,
      input: body.input as unknown as EmployeeUpdateInput,
      reason: body.reason,
    }),
    true,
  )

  registerMutation(
    '/api/v1/employees/:id/enable',
    mutationBody(employeeEnableInput),
    200,
    (id, body) => ({
      kind: 'employee-enable',
      id: id!,
      input: body.input as unknown as EmployeeEnableInput,
      reason: body.reason,
    }),
    true,
  )

  registerMutation(
    '/api/v1/projects',
    mutationBody(projectCreateInput),
    201,
    (_id, body) => ({
      kind: 'project-create',
      input: body.input as unknown as Omit<ProjectCreateInput, 'workspaceId'>,
      reason: body.reason,
    }),
    false,
  )

  registerMutation(
    '/api/v1/projects/:id/update',
    mutationBody(projectUpdateInput),
    200,
    (id, body) => ({
      kind: 'project-update',
      id: id!,
      input: body.input as unknown as ProjectUpdateInput,
      reason: body.reason,
    }),
    true,
  )

  registerMutation(
    '/api/v1/projects/:id/archive',
    mutationBody(projectArchiveInput),
    200,
    (id, body) => ({
      kind: 'project-archive',
      id: id!,
      input: body.input as unknown as ProjectArchiveInput,
      reason: body.reason,
    }),
    true,
  )

  const registerHistory = (path: string, kind: 'employee' | 'project'): void => {
    app.get(path, {
      schema: {
        params: idParams,
        querystring: emptyQuery,
      },
    }, async (request, reply) => withManagedErrors(reply, () => {
      const { id } = request.params as { id: string }
      return { items: commands.history(kind, id) }
    }))
  }

  registerHistory('/api/v1/employees/:id/history', 'employee')
  registerHistory('/api/v1/projects/:id/history', 'project')
}
