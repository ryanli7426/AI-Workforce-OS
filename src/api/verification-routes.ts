/** Independent verification HTTP routes. No listen, migrate, controller, Runtime, or worker startup. */
import { isAbsolute } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import {
  LocalVerificationCommands,
  VerificationCommandError,
  type CancelVerificationInput,
  type CreateVerificationInput,
  type VerificationCommandResult,
} from '../application/verification-commands.ts'
import { validateSettings, type LocalSettings } from '../config/settings.ts'
import { loadVerificationPlans } from '../config/verification-plans.ts'
import { requireVerificationSchema } from '../storage/verification-jobs.ts'
import type { LocalStore } from '../storage/store.ts'
import type { VerificationJob, VerificationJobAuditEntry } from '../verification/model.ts'

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const SAFE_FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const CREDENTIAL_FIELD = /(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd|pat|credential)/i
const IDEMPOTENCY_KEY = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const POSITIVE_INT_STRING = /^[1-9][0-9]{0,15}$/
const ARTIFACT_REVISION = /^[a-f0-9]{64}$/
const PLAN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const MAX_ERROR_MESSAGE = 256
const MAX_REASON = 4096
const MAX_LIST_LIMIT = 200

export interface RegisterVerificationRoutesOptions {
  store: LocalStore
  settings: LocalSettings
  dataDir: string
}

class VerificationHttpError extends Error {
  readonly statusCode: number
  readonly code: string

  constructor(statusCode: number, code: string, message: string) {
    super(message)
    this.name = 'VerificationHttpError'
    this.statusCode = statusCode
    this.code = code
  }
}

function failRequest(statusCode: number, code: string, message: string): never {
  throw new VerificationHttpError(statusCode, code, message)
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

function mapVerificationError(error: VerificationHttpError | VerificationCommandError): {
  statusCode: number
  code: string
  message: string
} {
  if (error instanceof VerificationHttpError) {
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

async function withVerificationErrors(
  reply: FastifyReply,
  operation: () => Promise<unknown> | unknown,
): Promise<unknown> {
  try {
    return await operation()
  } catch (error) {
    if (error instanceof VerificationHttpError || error instanceof VerificationCommandError) {
      const mapped = mapVerificationError(error)
      sendError(reply, mapped.statusCode, mapped.code, mapped.message)
      return reply
    }
    // Operational / unexpected errors propagate to the parent server generic 500 handler.
    throw error
  }
}

function parseLimit(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !POSITIVE_INT_STRING.test(value)) {
    failRequest(400, 'INVALID_REQUEST', 'Invalid request')
  }
  const limit = Number(value)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
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

/** Public plan metadata only — never expose command/args/env/authorized. */
function projectPlanMetadata(plan: { id: string; revision: string; checks: ReadonlyArray<{ id: string; timeoutMs: number }> }) {
  return {
    id: plan.id,
    revision: plan.revision,
    checks: plan.checks.map(check => ({
      id: check.id,
      timeoutMs: check.timeoutMs,
    })),
  }
}

/** Public job projection: strip raw plan commands, secrets, signed proof, and unauthorized fields. */
function projectJob(job: VerificationJob): Record<string, unknown> {
  const request = job.request
  const projected: Record<string, unknown> = {
    request: {
      verificationId: request.verificationId,
      workspaceId: request.workspaceId,
      ownerId: request.ownerId,
      ticketId: request.ticketId,
      expectedTaskVersion: request.expectedTaskVersion,
      policyVersion: request.policyVersion,
      executionId: request.executionId,
      artifactId: request.artifactId,
      artifactRevision: request.artifactRevision,
      plan: projectPlanMetadata(request.plan),
      reason: request.reason,
      createdAt: request.createdAt,
    },
    status: job.status,
    version: job.version,
    lastSequence: job.lastSequence,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
  if (job.runnerId !== undefined) projected.runnerId = job.runnerId
  if (job.runnerPid !== undefined) projected.runnerPid = job.runnerPid
  if (job.processId !== undefined) projected.processId = job.processId
  if (job.outcome !== undefined) projected.outcome = job.outcome
  if (job.reportSha256 !== undefined) projected.reportSha256 = job.reportSha256
  if (job.application !== undefined) projected.application = job.application
  if (job.cancelRequested !== undefined) {
    projected.cancelRequested = {
      actorId: job.cancelRequested.actorId,
      reason: job.cancelRequested.reason,
      at: job.cancelRequested.at,
    }
  }
  if (job.finishedAt !== undefined) projected.finishedAt = job.finishedAt
  if (job.failureCode !== undefined) projected.failureCode = job.failureCode
  return projected
}

function projectHistory(entries: readonly VerificationJobAuditEntry[]): VerificationJobAuditEntry[] {
  return entries.map(entry => ({
    id: entry.id,
    verificationId: entry.verificationId,
    action: entry.action,
    ...(entry.from !== undefined ? { from: entry.from } : {}),
    ...(entry.to !== undefined ? { to: entry.to } : {}),
    at: entry.at,
    ...(entry.actorId !== undefined ? { actorId: entry.actorId } : {}),
    ...(entry.reasonCode !== undefined ? { reasonCode: entry.reasonCode } : {}),
    ...(entry.sequence !== undefined ? { sequence: entry.sequence } : {}),
  }))
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

const listQuery = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'string', pattern: POSITIVE_INT_STRING.source },
    beforeRowid: { type: 'string', pattern: POSITIVE_INT_STRING.source },
  },
} as const

const createVerificationBody = {
  type: 'object',
  additionalProperties: false,
  required: [
    'expectedVersion',
    'executionId',
    'artifactRevision',
    'planId',
    'planRevision',
    'reason',
  ],
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
    executionId: { type: 'string', pattern: SAFE_ID.source },
    artifactRevision: { type: 'string', pattern: ARTIFACT_REVISION.source },
    planId: { type: 'string', pattern: PLAN_ID.source },
    planRevision: { type: 'string', pattern: PLAN_ID.source },
    reason: { type: 'string', minLength: 1, maxLength: MAX_REASON },
  },
} as const

const cancelVerificationBody = {
  type: 'object',
  additionalProperties: false,
  required: ['expectedVersion', 'reason'],
  properties: {
    expectedVersion: { type: 'integer', minimum: 1 },
    reason: { type: 'string', minLength: 1, maxLength: MAX_REASON },
  },
} as const

/**
 * Register Owner verification routes onto an already-authenticated Fastify app.
 * Requires current verification schema; does not initialize, listen, migrate, or start Runtime/worker.
 */
export function registerVerificationRoutes(
  app: FastifyInstance,
  options: RegisterVerificationRoutesOptions,
): void {
  const input = requireObject(options, 'registerVerificationRoutes options')
  const allowed = new Set(['store', 'settings', 'dataDir'])
  for (const field of Object.keys(input)) {
    if (!allowed.has(field)) {
      if (SAFE_FIELD_NAME.test(field) && !CREDENTIAL_FIELD.test(field)) {
        throw new Error(`Unknown registerVerificationRoutes option: ${field}`)
      }
      throw new Error('Unknown registerVerificationRoutes option')
    }
  }

  const store = input.store as LocalStore
  if (!store?.db || typeof store.db.prepare !== 'function') throw new Error('Invalid store')
  const settings = validateSettings(input.settings)
  const dataDir = requireAbsoluteDataDir(input.dataDir)

  // Preflight only: refuse incomplete/future/unversioned verification schema; never initialize.
  requireVerificationSchema(store.db)

  const plans = loadVerificationPlans(dataDir, {
    ownerId: settings.ownerId,
    workspaceId: settings.workspaceId,
  })

  const commands = new LocalVerificationCommands({
    store,
    ownerId: settings.ownerId,
    workspaceId: settings.workspaceId,
    rules: settings.rules,
    plans,
  })

  app.get('/api/v1/verification-plans', {
    schema: { querystring: emptyQuery },
  }, async (_request, reply) => withVerificationErrors(reply, () => {
    setSecurityHeaders(reply)
    return {
      items: commands.plans().map(projectPlanMetadata),
    }
  }))

  app.post('/api/v1/tasks/:id/verifications', {
    schema: {
      params: idParams,
      querystring: emptyQuery,
      body: createVerificationBody,
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => withVerificationErrors(reply, () => {
    const key = requireIdempotencyKey(request.headers['idempotency-key'])
    const { id } = request.params as { id: string }
    const body = request.body as CreateVerificationInput
    const result: VerificationCommandResult = commands.create(key, id, body)
    setSecurityHeaders(reply)
    reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false')
    return reply.status(202).send(result)
  }))

  app.get('/api/v1/tasks/:id/verifications', {
    schema: {
      params: idParams,
      querystring: listQuery,
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => withVerificationErrors(reply, () => {
    const { id } = request.params as { id: string }
    const query = request.query as { limit?: string; beforeRowid?: string }
    const limit = parseLimit(query.limit)
    const beforeRowid = parseBeforeRowid(query.beforeRowid)
    const listed = commands.list(id, {
      ...(limit === undefined ? {} : { limit }),
      ...(beforeRowid === undefined ? {} : { beforeRowid }),
    })
    setSecurityHeaders(reply)
    return {
      items: listed.items.map(projectJob),
      ...(listed.nextCursor !== undefined ? { nextCursor: listed.nextCursor } : {}),
    }
  }))

  app.get('/api/v1/verifications/:id', {
    schema: {
      params: idParams,
      querystring: emptyQuery,
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => withVerificationErrors(reply, () => {
    const { id } = request.params as { id: string }
    const job = commands.get(id)
    if (!job) failRequest(404, 'NOT_FOUND', 'Not found')
    const history = commands.history(id)
    setSecurityHeaders(reply)
    return {
      job: projectJob(job),
      history: projectHistory(history),
    }
  }))

  app.post('/api/v1/verifications/:id/cancel', {
    schema: {
      params: idParams,
      querystring: emptyQuery,
      body: cancelVerificationBody,
    },
  }, async (request: FastifyRequest, reply: FastifyReply) => withVerificationErrors(reply, () => {
    const key = requireIdempotencyKey(request.headers['idempotency-key'])
    const { id } = request.params as { id: string }
    const body = request.body as CancelVerificationInput
    const result: VerificationCommandResult = commands.cancel(key, id, body)
    setSecurityHeaders(reply)
    reply.header('Idempotency-Replayed', result.replayed ? 'true' : 'false')
    return reply.status(202).send(result)
  }))
}
