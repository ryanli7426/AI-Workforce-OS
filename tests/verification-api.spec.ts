import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assertLocalRequest, ApiAuthError, createOwnerAuthenticator } from '../src/api/auth.ts'
import { registerVerificationRoutes } from '../src/api/verification-routes.ts'
import { LocalTaskService } from '../src/application/tasks.ts'
import type { Rule } from '../src/assessor/rules.ts'
import { createSettings, defaultSettings, type LocalSettings } from '../src/config/settings.ts'
import { createVerificationPlans } from '../src/config/verification-plans.ts'
import { ProjectRepository } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import {
  VERIFICATION_SCHEMA_KEY,
  requireVerificationSchema,
} from '../src/storage/verification-jobs.ts'
import { LocalStore } from '../src/storage/store.ts'

const TOKEN = randomBytes(32).toString('hex')
const OWNER = 'owner-1'
const WORKSPACE = 'local'
const ORIGIN = 'http://127.0.0.1:8787'
const HOST = '127.0.0.1:8787'
const ALLOWED = [ORIGIN] as const
const ARTIFACT_REVISION = 'a'.repeat(64)
const PLAN_COMMAND = process.execPath

const opened: { close(): void | Promise<void> }[] = []
let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'verification-api-')))
  chmodSync(root, 0o700)
})

afterEach(async () => {
  for (const item of opened.splice(0)) {
    try { await item.close() } catch { /* already closed */ }
  }
  rmSync(root, { recursive: true, force: true })
})

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: gitEnv(), stdio: 'ignore', timeout: 15_000 })
}

function initGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'verification-api@example.com'])
  git(dir, ['config', 'user.name', 'Verification API'])
  writeFileSync(join(dir, 'README'), 'fixture\n', { mode: 0o600 })
  git(dir, ['add', 'README'])
  git(dir, ['commit', '-m', 'init'])
  return resolve(dir)
}

function rules(): Rule[] {
  return [{
    id: 'docs',
    enabled: true,
    taskTypes: ['docs'],
    priority: 10,
    approvalRequired: false,
    reviewRequired: true,
    retryLimit: 1,
  }]
}

function settingsFor(ownerId = OWNER): LocalSettings {
  const base = defaultSettings({ ownerId })
  return {
    ...base,
    rules: rules().map(rule => ({ ...rule, taskTypes: [...rule.taskTypes] })),
  }
}

function authenticatorFor(ownerId = OWNER, token = TOKEN) {
  return createOwnerAuthenticator({ token, ownerId, workspaceId: WORKSPACE })
}

function authHeaders(extra: Record<string, string | string[]> = {}) {
  return {
    host: HOST,
    origin: ORIGIN,
    authorization: `Bearer ${TOKEN}`,
    ...extra,
  }
}

function expectNoTokenLeak(value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  expect(text).not.toContain(TOKEN)
  expect(text).not.toMatch(/Bearer\s+[0-9a-f]{64}/i)
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
  if (Array.isArray(value)) throw new ApiAuthError('UNAUTHORIZED')
  if (typeof value !== 'string') throw new ApiAuthError('UNAUTHORIZED')
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
      const error = new Error('Invalid request') as Error & { statusCode: number; code: string }
      error.statusCode = 400
      error.code = 'INVALID_REQUEST'
      throw error
    }
    if (!key || seen.has(key)) {
      const error = new Error('Invalid request') as Error & { statusCode: number; code: string }
      error.statusCode = 400
      error.code = 'INVALID_REQUEST'
      throw error
    }
    seen.add(key)
  }
}

function mapUnknownError(error: unknown): { statusCode: number; code: string; message: string } {
  if (error instanceof ApiAuthError) {
    if (error.code === 'UNAUTHORIZED') {
      return { statusCode: 401, code: 'UNAUTHORIZED', message: 'Unauthorized' }
    }
    if (error.code === 'INVALID_HOST' || error.code === 'FORBIDDEN_ORIGIN') {
      return { statusCode: 403, code: error.code, message: error.message }
    }
    return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' }
  }
  if (typeof error === 'object' && error !== null) {
    const err = error as { validation?: unknown; statusCode?: unknown; code?: unknown; message?: unknown }
    const code = typeof err.code === 'string' ? err.code : undefined
    if (
      err.validation !== undefined
      || code === 'FST_ERR_VALIDATION'
      || code === 'FST_ERR_CTP_INVALID_JSON_BODY'
      || code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
      || code === 'FST_ERR_CTP_INVALID_CONTENT_LENGTH'
      || code === 'INVALID_REQUEST'
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
    if (typeof err.statusCode === 'number' && typeof code === 'string' && typeof err.message === 'string') {
      return { statusCode: err.statusCode, code, message: err.message }
    }
  }
  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' }
}

function planChecks() {
  return [{
    id: 'unit',
    command: PLAN_COMMAND,
    args: ['-e', 'process.exit(0)'],
    timeoutMs: 5_000,
  }]
}

async function buildApp(options: {
  store: LocalStore
  settings: LocalSettings
  dataDir: string
  authenticator?: ReturnType<typeof authenticatorFor>
}): Promise<FastifyInstance> {
  const authenticator = options.authenticator ?? authenticatorFor()
  const authenticate = authenticator.authenticate.bind(authenticator)
  const settings = options.settings
  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: 128 * 1024,
    ajv: {
      customOptions: {
        removeAdditional: false,
        coerceTypes: false,
        useDefaults: false,
        allErrors: false,
      },
    },
  })

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    rejectDuplicateQueryKeys(request.url)

    const rawHeaders = request.raw.rawHeaders
    if (headerNameCount(rawHeaders, 'authorization') > 1) {
      throw Object.assign(new Error('Unauthorized'), { statusCode: 401, code: 'UNAUTHORIZED' })
    }
    if (headerNameCount(rawHeaders, 'host') > 1) {
      throw Object.assign(new Error('Invalid host'), { statusCode: 403, code: 'INVALID_HOST' })
    }
    if (headerNameCount(rawHeaders, 'origin') > 1) {
      throw Object.assign(new Error('Forbidden origin'), { statusCode: 403, code: 'FORBIDDEN_ORIGIN' })
    }

    const host = singleHeader(request.headers.host)
    const origin = singleHeader(request.headers.origin)
    assertLocalRequest({ host, origin, allowedOrigins: ALLOWED })

    const authorization = singleHeader(request.headers.authorization)
    const principal = authenticate(authorization)
    if (principal.ownerId !== settings.ownerId || principal.workspaceId !== settings.workspaceId) {
      throw new ApiAuthError('UNAUTHORIZED')
    }
  })

  app.setNotFoundHandler((_request, reply) => {
    void reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } })
  })

  app.setErrorHandler((error, _request, reply) => {
    const mapped = mapUnknownError(error)
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    void reply.status(mapped.statusCode).send({ error: { code: mapped.code, message: mapped.message } })
  })

  registerVerificationRoutes(app, {
    store: options.store,
    settings,
    dataDir: options.dataDir,
  })

  opened.push(app)
  await app.ready()
  return app
}

async function fixture(options: {
  withPlans?: boolean
  initializeVerification?: boolean
} = {}) {
  const dataDir = join(root, `data-${randomBytes(4).toString('hex')}`)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  chmodSync(dataDir, 0o700)
  const settings = settingsFor()
  createSettings(join(dataDir, 'settings.json'), settings)
  const dbPath = join(dataDir, 'workforce.sqlite')
  const store = new LocalStore(dbPath)
  opened.push(store)
  initializeApplicationSchema(store)
  chmodSync(dbPath, 0o600)

  if (options.initializeVerification === false) {
    store.db.exec(`
      DROP TABLE IF EXISTS verification_job_receipt;
      DROP TABLE IF EXISTS verification_job_audit;
      DROP TABLE IF EXISTS verification_job_event;
      DROP TABLE IF EXISTS verification_job;
    `)
    store.db.prepare('DELETE FROM kv WHERE key = ?').run(VERIFICATION_SCHEMA_KEY)
  }

  const repositoryPath = initGitRepo(join(root, `repo-${randomBytes(4).toString('hex')}`))
  const worktreeRoot = join(root, `worktrees-${randomBytes(4).toString('hex')}`)
  mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 })
  new ProjectRepository(store.db).create({
    id: 'proj-1',
    workspaceId: WORKSPACE,
    name: 'Docs',
    ownerId: OWNER,
    repositoryPath,
    worktreeRoot,
    allowedTaskTypes: ['docs'],
  })

  if (options.withPlans !== false && options.initializeVerification !== false) {
    createVerificationPlans(dataDir, { ownerId: OWNER, workspaceId: WORKSPACE }, [{
      id: 'default',
      revision: 'r1',
      checks: planChecks(),
    }])
  }

  const authenticator = authenticatorFor()
  let app: FastifyInstance | undefined
  if (options.initializeVerification !== false) {
    app = await buildApp({ store, settings, dataDir, authenticator })
  }

  return {
    dataDir,
    dbPath,
    store,
    settings,
    authenticator,
    app,
    repositoryPath,
    worktreeRoot,
  }
}

function seedReviewTask(store: LocalStore, settings: LocalSettings): {
  ticketId: string
  executionId: string
  artifactRevision: string
  expectedVersion: number
} {
  const tasks = new LocalTaskService({
    store,
    ownerId: settings.ownerId,
    workspaceId: settings.workspaceId,
    rules: settings.rules,
  })
  const created = tasks.create({
    issueId: 'issue-1',
    projectId: 'proj-1',
    title: 'Update docs',
    description: 'Clarify verification API',
    taskType: 'docs',
  })
  const assigned = tasks.engine.assignTask(
    created.id,
    'claude-local',
    'claude-code',
    join(root, 'work', created.id),
  )
  const assignmentId = assigned.assignments.at(-1)!.id
  tasks.engine.assignmentStarted(created.id, assignmentId)
  const executionId = `execution-${assignmentId}`
  const reviewed = tasks.engine.recordExecution(created.id, {
    assignmentId,
    executionId,
    artifactRevision: ARTIFACT_REVISION,
    exitCode: 0,
    terminal: 'success',
    summary: 'Updated README',
  })
  expect(reviewed.lifecycle?.status).toBe('REVIEW')
  return {
    ticketId: created.id,
    executionId,
    artifactRevision: ARTIFACT_REVISION,
    expectedVersion: reviewed.lifecycle!.version,
  }
}

async function inject(
  app: FastifyInstance,
  request: {
    method: string
    url: string
    headers?: Record<string, string | string[]>
    payload?: unknown
  },
) {
  const response = await app.inject({
    method: request.method,
    url: request.url,
    headers: authHeaders(request.headers ?? {}),
    payload: request.payload as never,
  })
  expectNoTokenLeak(response.body)
  expect(response.headers['cache-control']).toBe('no-store')
  expect(response.headers['x-content-type-options']).toBe('nosniff')
  return response
}

function createBody(
  seed: ReturnType<typeof seedReviewTask>,
  overrides: Record<string, unknown> = {},
) {
  return {
    expectedVersion: seed.expectedVersion,
    executionId: seed.executionId,
    artifactRevision: seed.artifactRevision,
    planId: 'default',
    planRevision: 'r1',
    reason: 'Owner requested async verification',
    ...overrides,
  }
}

describe('registerVerificationRoutes preflight', () => {
  it('fails closed when verification schema is missing and does not migrate', async () => {
    const { store, settings, dataDir, dbPath } = await fixture({ initializeVerification: false })
    const before = createHash('sha256').update(readFileSync(dbPath)).digest('hex')
    expect(() => registerVerificationRoutes(Fastify({ logger: false }), { store, settings, dataDir }))
      .toThrow(/Verification schema is not initialized|not initialized/i)
    expect(() => requireVerificationSchema(store.db)).toThrow(/not initialized/i)
    const after = createHash('sha256').update(readFileSync(dbPath)).digest('hex')
    expect(after).toBe(before)
  })
})

describe('authentication on verification routes', () => {
  it('rejects endpoints without a valid bearer and duplicate Authorization', async () => {
    const { app, store, settings } = await fixture()
    const seed = seedReviewTask(store, settings)
    const targets: Array<{ method: string; url: string; payload?: unknown }> = [
      { method: 'GET', url: '/api/v1/verification-plans' },
      {
        method: 'POST',
        url: `/api/v1/tasks/${seed.ticketId}/verifications`,
        payload: createBody(seed),
      },
      { method: 'GET', url: `/api/v1/tasks/${seed.ticketId}/verifications` },
      { method: 'GET', url: '/api/v1/verifications/v-missing' },
      {
        method: 'POST',
        url: '/api/v1/verifications/v-missing/cancel',
        payload: { expectedVersion: 1, reason: 'stop' },
      },
    ]
    for (const route of targets) {
      const response = await app!.inject({
        method: route.method,
        url: route.url,
        headers: { host: HOST, origin: ORIGIN },
        payload: route.payload as never,
      })
      expect(response.statusCode, route.url).toBe(401)
      expect(response.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
      expectNoTokenLeak(response.body)
    }

    const duplicate = await app!.inject({
      method: 'GET',
      url: '/api/v1/verification-plans',
      headers: authHeaders({ authorization: [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`] }),
    })
    expect(duplicate.statusCode).toBe(401)
  })
})

describe('verification plans metadata', () => {
  it('lists registered plan metadata without command or args', async () => {
    const { app } = await fixture()
    const response = await inject(app!, { method: 'GET', url: '/api/v1/verification-plans' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({
      items: [{
        id: 'default',
        revision: 'r1',
        checks: [{ id: 'unit', timeoutMs: 5_000 }],
      }],
    })
    const text = JSON.stringify(response.json())
    expect(text).not.toContain(PLAN_COMMAND)
    expect(text).not.toMatch(/"command"|"args"|"authorized"|"env"|"secret"/)
  })

  it('returns empty items when no private plans file exists', async () => {
    const { app } = await fixture({ withPlans: false })
    const response = await inject(app!, { method: 'GET', url: '/api/v1/verification-plans' })
    expect(response.statusCode).toBe(200)
    expect(response.json()).toEqual({ items: [] })
  })
})

describe('verification enqueue, observe, cancel', () => {
  it('enqueues 202 without auto-executing and exposes redacted job/history', async () => {
    const { app, store, settings } = await fixture()
    const seed = seedReviewTask(store, settings)

    const created = await inject(app!, {
      method: 'POST',
      url: `/api/v1/tasks/${seed.ticketId}/verifications`,
      headers: { 'idempotency-key': 'verify-create-1' },
      payload: createBody(seed),
    })
    expect(created.statusCode).toBe(202)
    expect(created.headers['idempotency-replayed']).toBe('false')
    const body = created.json() as { verificationId: string; replayed: boolean }
    expect(body.replayed).toBe(false)
    expect(body.verificationId).toMatch(/^v-[0-9a-f-]{36}$/i)

    const detail = await inject(app!, {
      method: 'GET',
      url: `/api/v1/verifications/${body.verificationId}`,
    })
    expect(detail.statusCode).toBe(200)
    const detailJson = detail.json() as {
      job: {
        status: string
        version: number
        request: { plan: { checks: Array<Record<string, unknown>> } }
      }
      history: Array<{ action: string }>
    }
    expect(detailJson.job.status).toBe('QUEUED')
    expect(detailJson.job.version).toBe(1)
    expect(detailJson.job.request.plan.checks).toEqual([{ id: 'unit', timeoutMs: 5_000 }])
    expect(detailJson.history.length).toBeGreaterThanOrEqual(1)
    const detailText = JSON.stringify(detailJson)
    expect(detailText).not.toContain(PLAN_COMMAND)
    expect(detailText).not.toMatch(/"command"|"args"|"authorized"|"env"|"secret"|"mac"|"terminalConfirmed"/)
    expect(detailText).not.toMatch(/"passed":/)

    const listed = await inject(app!, {
      method: 'GET',
      url: `/api/v1/tasks/${seed.ticketId}/verifications?limit=1`,
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().items).toHaveLength(1)
    expect(listed.json().items[0].status).toBe('QUEUED')
    expect(JSON.stringify(listed.json())).not.toContain(PLAN_COMMAND)
  })

  it('replays identical create after durable reopen and conflicts on changed hash', async () => {
    const first = await fixture()
    const seed = seedReviewTask(first.store, first.settings)
    const payload = createBody(seed)
    const created = await inject(first.app!, {
      method: 'POST',
      url: `/api/v1/tasks/${seed.ticketId}/verifications`,
      headers: { 'idempotency-key': 'verify-replay' },
      payload,
    })
    expect(created.statusCode).toBe(202)
    const verificationId = created.json().verificationId as string

    await first.app!.close()
    first.store.close()
    opened.splice(opened.indexOf(first.app!), 1)
    opened.splice(opened.indexOf(first.store), 1)

    const store = new LocalStore(first.dbPath)
    opened.push(store)
    const app = await buildApp({
      store,
      settings: first.settings,
      dataDir: first.dataDir,
      authenticator: first.authenticator,
    })

    const replay = await inject(app, {
      method: 'POST',
      url: `/api/v1/tasks/${seed.ticketId}/verifications`,
      headers: { 'idempotency-key': 'verify-replay' },
      payload,
    })
    expect(replay.statusCode).toBe(202)
    expect(replay.headers['idempotency-replayed']).toBe('true')
    expect(replay.json()).toEqual({ verificationId, replayed: true })

    const conflict = await inject(app, {
      method: 'POST',
      url: `/api/v1/tasks/${seed.ticketId}/verifications`,
      headers: { 'idempotency-key': 'verify-replay' },
      payload: createBody(seed, { reason: 'Different reason same key' }),
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT')

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/v1/verifications/${verificationId}`,
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().job.status).toBe('QUEUED')
  })

  it('maps stale version and active occupancy conflicts', async () => {
    const { app, store, settings } = await fixture()
    const seed = seedReviewTask(store, settings)

    const created = await inject(app!, {
      method: 'POST',
      url: `/api/v1/tasks/${seed.ticketId}/verifications`,
      headers: { 'idempotency-key': 'verify-active' },
      payload: createBody(seed),
    })
    expect(created.statusCode).toBe(202)

    const stale = await inject(app!, {
      method: 'POST',
      url: `/api/v1/tasks/${seed.ticketId}/verifications`,
      headers: { 'idempotency-key': 'verify-stale' },
      payload: createBody(seed, { expectedVersion: seed.expectedVersion + 10 }),
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('VERSION_CONFLICT')

    const occupied = await inject(app!, {
      method: 'POST',
      url: `/api/v1/tasks/${seed.ticketId}/verifications`,
      headers: { 'idempotency-key': 'verify-occupied' },
      payload: createBody(seed),
    })
    expect(occupied.statusCode).toBe(409)
    expect(occupied.json().error.code).toBe('STATE_CONFLICT')
  })

  it('cancels a queued verification with idempotent replay', async () => {
    const { app, store, settings } = await fixture()
    const seed = seedReviewTask(store, settings)
    const created = await inject(app!, {
      method: 'POST',
      url: `/api/v1/tasks/${seed.ticketId}/verifications`,
      headers: { 'idempotency-key': 'verify-cancel-create' },
      payload: createBody(seed),
    })
    const verificationId = created.json().verificationId as string
    const version = (await inject(app!, {
      method: 'GET',
      url: `/api/v1/verifications/${verificationId}`,
    })).json().job.version as number

    const cancelled = await inject(app!, {
      method: 'POST',
      url: `/api/v1/verifications/${verificationId}/cancel`,
      headers: { 'idempotency-key': 'verify-cancel-1' },
      payload: { expectedVersion: version, reason: 'Owner cancelled before launch' },
    })
    expect(cancelled.statusCode).toBe(202)
    expect(cancelled.headers['idempotency-replayed']).toBe('false')
    expect(cancelled.json()).toEqual({ verificationId, replayed: false })

    const detail = await inject(app!, {
      method: 'GET',
      url: `/api/v1/verifications/${verificationId}`,
    })
    expect(detail.json().job.status).toBe('CANCELLED')

    const replay = await inject(app!, {
      method: 'POST',
      url: `/api/v1/verifications/${verificationId}/cancel`,
      headers: { 'idempotency-key': 'verify-cancel-1' },
      payload: { expectedVersion: version, reason: 'Owner cancelled before launch' },
    })
    expect(replay.statusCode).toBe(202)
    expect(replay.headers['idempotency-replayed']).toBe('true')
    expect(replay.json()).toEqual({ verificationId, replayed: true })
  })
})

describe('verification route validation and scope gates', () => {
  it('rejects unknown fields, coercion, bad queries, missing keys, and missing resources', async () => {
    const { app, store, settings } = await fixture()
    const seed = seedReviewTask(store, settings)

    const unknown = await inject(app!, {
      method: 'POST',
      url: `/api/v1/tasks/${seed.ticketId}/verifications`,
      headers: { 'idempotency-key': 'unknown-field' },
      payload: {
        ...createBody(seed),
        authorized: true,
        env: { SECRET: TOKEN },
        passed: true,
      },
    })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().error.code).toBe('INVALID_REQUEST')
    expect(JSON.stringify(unknown.json())).not.toMatch(/authorized|SECRET|passed/i)
    expectNoTokenLeak(unknown.body)

    const coerced = await inject(app!, {
      method: 'POST',
      url: `/api/v1/tasks/${seed.ticketId}/verifications`,
      headers: { 'idempotency-key': 'coerce' },
      payload: createBody(seed, { expectedVersion: String(seed.expectedVersion) }),
    })
    expect(coerced.statusCode).toBe(400)

    const badQuery = await inject(app!, {
      method: 'GET',
      url: `/api/v1/tasks/${seed.ticketId}/verifications?ownerId=owner-1`,
    })
    expect(badQuery.statusCode).toBe(400)

    const coercedCursor = await inject(app!, {
      method: 'GET',
      url: `/api/v1/tasks/${seed.ticketId}/verifications?beforeRowid=01`,
    })
    expect(coercedCursor.statusCode).toBe(400)

    const missingKey = await inject(app!, {
      method: 'POST',
      url: `/api/v1/tasks/${seed.ticketId}/verifications`,
      payload: createBody(seed),
    })
    expect(missingKey.statusCode).toBe(400)

    const badId = await inject(app!, {
      method: 'GET',
      url: '/api/v1/verifications/bad.id',
    })
    expect(badId.statusCode).toBe(400)

    const missing = await inject(app!, {
      method: 'GET',
      url: '/api/v1/verifications/missing-verification',
    })
    expect(missing.statusCode).toBe(404)

    const missingTask = await inject(app!, {
      method: 'GET',
      url: '/api/v1/tasks/missing-ticket/verifications',
    })
    expect(missingTask.statusCode).toBe(404)

    const unknownPlan = await inject(app!, {
      method: 'POST',
      url: `/api/v1/tasks/${seed.ticketId}/verifications`,
      headers: { 'idempotency-key': 'unknown-plan' },
      payload: createBody(seed, { planId: 'missing-plan' }),
    })
    expect(unknownPlan.statusCode).toBe(400)
    expect(unknownPlan.json().error.code).toBe('INVALID_REQUEST')
  })

  it('paginates with string beforeRowid without mutating job status', async () => {
    const { app, store, settings, dataDir } = await fixture({ withPlans: false })
    createVerificationPlans(dataDir, { ownerId: OWNER, workspaceId: WORKSPACE }, [
      { id: 'default', revision: 'r1', checks: planChecks() },
      { id: 'alt', revision: 'r1', checks: planChecks() },
    ])
    // Rebuild app so construction loads both plans.
    await app!.close()
    opened.splice(opened.indexOf(app!), 1)
    const rebuilt = await buildApp({ store, settings, dataDir })

    const firstSeed = seedReviewTask(store, settings)
    const first = await inject(rebuilt, {
      method: 'POST',
      url: `/api/v1/tasks/${firstSeed.ticketId}/verifications`,
      headers: { 'idempotency-key': 'page-1' },
      payload: createBody(firstSeed),
    })
    expect(first.statusCode).toBe(202)
    const firstId = first.json().verificationId as string
    // Cancel so a second active job can be reserved on the same ticket.
    const firstDetail = await inject(rebuilt, { method: 'GET', url: `/api/v1/verifications/${firstId}` })
    await inject(rebuilt, {
      method: 'POST',
      url: `/api/v1/verifications/${firstId}/cancel`,
      headers: { 'idempotency-key': 'page-cancel' },
      payload: {
        expectedVersion: firstDetail.json().job.version,
        reason: 'Release occupancy for pagination fixture',
      },
    })

    const secondSeed = {
      ...firstSeed,
      expectedVersion: store.tickets.get(firstSeed.ticketId)!.lifecycle!.version,
    }
    const second = await inject(rebuilt, {
      method: 'POST',
      url: `/api/v1/tasks/${secondSeed.ticketId}/verifications`,
      headers: { 'idempotency-key': 'page-2' },
      payload: createBody(secondSeed, { planId: 'alt' }),
    })
    expect(second.statusCode).toBe(202)

    const page = await inject(rebuilt, {
      method: 'GET',
      url: `/api/v1/tasks/${firstSeed.ticketId}/verifications?limit=1`,
    })
    expect(page.statusCode).toBe(200)
    expect(page.json().items).toHaveLength(1)
    expect(page.json().nextCursor).toEqual(expect.any(Number))

    const next = await inject(rebuilt, {
      method: 'GET',
      url: `/api/v1/tasks/${firstSeed.ticketId}/verifications?limit=1&beforeRowid=${page.json().nextCursor}`,
    })
    expect(next.statusCode).toBe(200)
    expect(next.json().items).toHaveLength(1)
    expect(next.json().items[0].request.verificationId).not.toBe(page.json().items[0].request.verificationId)

    const stillQueued = await inject(rebuilt, {
      method: 'GET',
      url: `/api/v1/verifications/${second.json().verificationId}`,
    })
    expect(stillQueued.json().job.status).toBe('QUEUED')
  })
})
