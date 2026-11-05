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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOwnerAuthenticator } from '../src/api/auth.ts'
import { createApiServer } from '../src/api/server.ts'
import { initializeCommandSchema } from '../src/application/task-commands.ts'
import { LocalTaskService } from '../src/application/tasks.ts'
import type { Rule } from '../src/assessor/rules.ts'
import { createSettings, defaultSettings, type LocalSettings } from '../src/config/settings.ts'
import { ExecutionRepository } from '../src/execution/repository.ts'
import type { ExecutionSpec } from '../src/execution/model.ts'
import { ProjectRepository, type ProjectCreateInput } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LocalStore } from '../src/storage/store.ts'
import { EmployeeRepository, type EmployeeCreateInput } from '../src/workforce/employees.ts'

const TOKEN = randomBytes(32).toString('hex')
const OWNER = 'owner-1'
const ORIGIN = 'http://127.0.0.1:8787'
const HOST = '127.0.0.1:8787'
const ALLOWED = [ORIGIN] as const

const opened: { close(): void | Promise<void> }[] = []
let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'api-server-')))
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
  git(dir, ['config', 'user.email', 'api-server@example.com'])
  git(dir, ['config', 'user.name', 'API Server'])
  writeFileSync(join(dir, 'README'), 'fixture\n', { mode: 0o600 })
  git(dir, ['add', 'README'])
  git(dir, ['commit', '-m', 'init'])
  return resolve(dir)
}

function rules(overrides: Partial<Rule> = {}): Rule[] {
  return [{
    id: 'docs',
    enabled: true,
    taskTypes: ['docs'],
    priority: 10,
    approvalRequired: true,
    reviewRequired: true,
    retryLimit: 1,
    ...overrides,
  }]
}

function settingsFor(ownerId = OWNER, ruleList: Rule[] = rules()): LocalSettings {
  const base = defaultSettings({ ownerId })
  return {
    ...base,
    rules: ruleList.map(rule => ({ ...rule, taskTypes: [...rule.taskTypes] })),
  }
}

function authenticatorFor(ownerId = OWNER, token = TOKEN) {
  return createOwnerAuthenticator({ token, ownerId, workspaceId: 'local' })
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

async function fixture(options: {
  ownerId?: string
  ruleList?: Rule[]
  initializeCommand?: boolean
} = {}) {
  const ownerId = options.ownerId ?? OWNER
  const dataDir = join(root, `data-${randomBytes(4).toString('hex')}`)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  chmodSync(dataDir, 0o700)
  const settings = settingsFor(ownerId, options.ruleList ?? rules())
  createSettings(join(dataDir, 'settings.json'), settings)
  const dbPath = join(dataDir, 'workforce.sqlite')
  const store = new LocalStore(dbPath)
  opened.push(store)
  initializeApplicationSchema(store)
  if (options.initializeCommand !== false) initializeCommandSchema(store.db)
  chmodSync(dbPath, 0o600)

  const repositoryPath = initGitRepo(join(root, `repo-${randomBytes(4).toString('hex')}`))
  const worktreeRoot = join(root, `worktrees-${randomBytes(4).toString('hex')}`)
  mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 })
  const projectInput: ProjectCreateInput = {
    id: 'proj-1',
    workspaceId: 'local',
    name: 'Docs',
    ownerId,
    repositoryPath,
    worktreeRoot,
    allowedTaskTypes: ['docs'],
  }
  new ProjectRepository(store.db).create(projectInput)

  const employeeInput: EmployeeCreateInput = {
    id: 'emp-1',
    workspaceId: 'local',
    name: 'Writer',
    role: 'Writer',
    responsibilities: ['docs'],
    capabilities: ['editing'],
    runtimeId: 'claude-local',
    projectIds: ['proj-1'],
    maxConcurrency: 1,
    timeoutMs: 60_000,
  }
  new EmployeeRepository(store.db).create(employeeInput)

  const authenticator = authenticatorFor(ownerId)
  const app = createApiServer({
    store,
    settings,
    authenticator,
    allowedOrigins: ALLOWED,
    dataDir,
  })
  opened.push(app)
  await app.ready()

  return { dataDir, dbPath, store, settings, authenticator, app, ownerId }
}

async function inject(
  app: Awaited<ReturnType<typeof fixture>>['app'],
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

describe('createApiServer factory', () => {
  it('requires initialized application and command schemas and does not migrate', () => {
    const dataDir = join(root, 'uninit')
    mkdirSync(dataDir, { mode: 0o700 })
    const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
    opened.push(store)
    const settings = settingsFor()
    const authenticator = authenticatorFor()
    expect(() => createApiServer({
      store, settings, authenticator, allowedOrigins: ALLOWED, dataDir,
    })).toThrow(/not initialized|Application module/i)

    initializeApplicationSchema(store)
    initializeCommandSchema(store.db)
    const before = createHash('sha256').update(readFileSync(join(dataDir, 'workforce.sqlite'))).digest('hex')
    const server = createApiServer({
      store, settings, authenticator, allowedOrigins: ALLOWED, dataDir,
    })
    opened.push(server)
    const after = createHash('sha256').update(readFileSync(join(dataDir, 'workforce.sqlite'))).digest('hex')
    expect(after).toBe(before)
  })

  it('rejects relative dataDir and non-loopback allowedOrigins without FS init', () => {
    const dataDir = join(root, 'cfg')
    mkdirSync(dataDir, { mode: 0o700 })
    const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
    opened.push(store)
    initializeApplicationSchema(store)
    initializeCommandSchema(store.db)
    const settings = settingsFor()
    const authenticator = authenticatorFor()
    expect(() => createApiServer({
      store, settings, authenticator, allowedOrigins: ALLOWED, dataDir: 'relative-data',
    })).toThrow(/dataDir/i)
    expect(() => createApiServer({
      store, settings, authenticator, allowedOrigins: ['http://evil.example'], dataDir,
    })).toThrow(/allowedOrigins/i)
    expect(() => createApiServer({
      store,
      settings: { ...settings, token: TOKEN } as never,
      authenticator,
      allowedOrigins: ALLOWED,
      dataDir,
    })).toThrow(/Unknown settings field/)
    expect(() => createApiServer({
      store,
      settings: { ...settings, token: TOKEN } as never,
      authenticator,
      allowedOrigins: ALLOWED,
      dataDir,
    })).not.toThrow(new RegExp(TOKEN))
  })

  it('snapshots settings, allowedOrigins, and bound authenticate against later mutation', async () => {
    const { app, settings } = await fixture()
    const mutableOrigins = [...ALLOWED] as string[]
    const store = new LocalStore(join(root, 'snap.sqlite'))
    opened.push(store)
    initializeApplicationSchema(store)
    initializeCommandSchema(store.db)
    const mutableSettings = settingsFor()
    const trusted = authenticatorFor()
    const mutableAuthenticator = {
      authenticate: (header: unknown) => trusted.authenticate(header),
    }
    mkdirSync(join(root, 'snap-data'), { mode: 0o700 })
    const server = createApiServer({
      store,
      settings: mutableSettings,
      authenticator: mutableAuthenticator,
      allowedOrigins: mutableOrigins,
      dataDir: join(root, 'snap-data'),
    })
    opened.push(server)
    await server.ready()
    mutableSettings.ownerId = 'mutated-owner'
    mutableOrigins[0] = 'http://evil.example'
    settings.ownerId = 'also-mutated'
    mutableAuthenticator.authenticate = () => ({ ownerId: 'mutated-owner', workspaceId: 'local' })
    const ok = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: authHeaders(),
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json()).toEqual({ ready: true, workspaceId: 'local' })
    await app.close()
  })
})

describe('authentication and local request gates', () => {
  const routes: Array<{ method: string; url: string; payload?: unknown }> = [
    { method: 'GET', url: '/api/v1/health' },
    { method: 'GET', url: '/api/v1/me' },
    { method: 'GET', url: '/api/v1/overview' },
    { method: 'GET', url: '/api/v1/employees' },
    { method: 'GET', url: '/api/v1/projects' },
    { method: 'GET', url: '/api/v1/tasks' },
    { method: 'GET', url: '/api/v1/tasks/ticket-1' },
    { method: 'GET', url: '/api/v1/executions/exec-1' },
    { method: 'GET', url: '/api/v1/tasks/ticket-1/logs' },
    {
      method: 'POST',
      url: '/api/v1/tasks',
      payload: {
        projectId: 'proj-1', issueId: 'issue-1', title: 't', description: 'd', taskType: 'docs',
      },
    },
    { method: 'POST', url: '/api/v1/tasks/ticket-1/approve', payload: { expectedVersion: 1, reason: 'ok' } },
    { method: 'POST', url: '/api/v1/tasks/ticket-1/reject', payload: { expectedVersion: 1, reason: 'no' } },
    { method: 'POST', url: '/api/v1/tasks/ticket-1/cancel', payload: { expectedVersion: 1, reason: 'stop' } },
    { method: 'POST', url: '/api/v1/tasks/ticket-1/retry', payload: { expectedVersion: 1, reason: 'again' } },
    {
      method: 'POST',
      url: '/api/v1/tasks/ticket-1/review',
      payload: {
        expectedVersion: 1,
        executionId: 'exec-1',
        artifactRevision: 'rev-1',
        approved: true,
        reason: 'ship',
      },
    },
  ]

  it('rejects every endpoint without a valid bearer', async () => {
    const { app } = await fixture()
    for (const route of routes) {
      const response = await app.inject({
        method: route.method,
        url: route.url,
        headers: { host: HOST, origin: ORIGIN },
        payload: route.payload as never,
      })
      expect(response.statusCode, route.url).toBe(401)
      expect(response.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } })
      expectNoTokenLeak(response.body)
    }
  })

  it('rejects wrong tokens, duplicate authorization, and invalid host/origin', async () => {
    const { app } = await fixture()
    const wrong = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: authHeaders({ authorization: `Bearer ${'a'.repeat(64)}` }),
    })
    expect(wrong.statusCode).toBe(401)
    expectNoTokenLeak(wrong.body)

    const duplicate = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: authHeaders({ authorization: [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`] }),
    })
    expect(duplicate.statusCode).toBe(401)
    expectNoTokenLeak(duplicate.body)

    const badHost = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: authHeaders({ host: 'evil.example' }),
    })
    expect(badHost.statusCode).toBe(403)
    expect(badHost.json().error.code).toMatch(/INVALID_HOST|FORBIDDEN_ORIGIN/)

    const badOrigin = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: authHeaders({ origin: 'http://evil.example' }),
    })
    expect(badOrigin.statusCode).toBe(403)
    expect(badOrigin.json().error.code).toBe('FORBIDDEN_ORIGIN')
    expectNoTokenLeak(badOrigin.body)
  })

  it('accepts authenticated CLI requests without Origin and returns /me as owner', async () => {
    const { app } = await fixture()
    const health = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { host: HOST, authorization: `Bearer ${TOKEN}` },
    })
    expect(health.statusCode).toBe(200)
    expect(health.json()).toEqual({ ready: true, workspaceId: 'local' })

    const me = await inject(app, { method: 'GET', url: '/api/v1/me' })
    expect(me.statusCode).toBe(200)
    expect(me.json()).toEqual({ ownerId: OWNER, workspaceId: 'local', role: 'owner' })
  })

  it('rejects unknown and duplicate query keys on every route', async () => {
    const { app } = await fixture()
    const getTargets = [
      '/api/v1/health',
      '/api/v1/me',
      '/api/v1/overview',
      '/api/v1/employees',
      '/api/v1/projects',
      '/api/v1/tasks/ticket-1',
      '/api/v1/executions/exec-1',
      '/api/v1/tasks/ticket-1/logs',
    ]
    for (const url of getTargets) {
      const unknown = await inject(app, {
        method: 'GET',
        url: `${url}?ownerId=${OWNER}&api_token=${TOKEN}`,
      })
      expect(unknown.statusCode, url).toBe(400)
      expect(unknown.json().error.code).toBe('INVALID_REQUEST')
      expectNoTokenLeak(unknown.body)

      const duplicate = await inject(app, { method: 'GET', url: `${url}?x=1&x=2` })
      expect(duplicate.statusCode, url).toBe(400)
      expect(duplicate.json().error.code).toBe('INVALID_REQUEST')
    }

    const postUnknown = await inject(app, {
      method: 'POST',
      url: '/api/v1/tasks?actor=evil',
      headers: { 'idempotency-key': 'query-post' },
      payload: {
        projectId: 'proj-1', issueId: 'q-1', title: 't', description: 'd', taskType: 'docs',
      },
    })
    expect(postUnknown.statusCode).toBe(400)
    expect(postUnknown.json().error.code).toBe('INVALID_REQUEST')

    const actionUnknown = await inject(app, {
      method: 'POST',
      url: '/api/v1/tasks/ticket-1/approve?ownerId=owner-1',
      headers: { 'idempotency-key': 'query-approve' },
      payload: { expectedVersion: 1, reason: 'nope' },
    })
    expect(actionUnknown.statusCode).toBe(400)
    expect(actionUnknown.json().error.code).toBe('INVALID_REQUEST')
  })
})

describe('queries and mutations', () => {
  it('serves overview/employees/projects and scoped task list filters', async () => {
    const { app, store } = await fixture()
    const overview = await inject(app, { method: 'GET', url: '/api/v1/overview' })
    expect(overview.statusCode).toBe(200)
    expect(overview.json().employees.configured).toBe(1)
    expect(overview.json().projects ?? overview.json().tasks.total).toBeDefined()

    const employees = await inject(app, { method: 'GET', url: '/api/v1/employees' })
    expect(employees.statusCode).toBe(200)
    expect(employees.json()).toHaveLength(1)
    expect(employees.json()[0].id).toBe('emp-1')

    const projects = await inject(app, { method: 'GET', url: '/api/v1/projects' })
    expect(projects.statusCode).toBe(200)
    expect(projects.json()).toHaveLength(1)
    expect(projects.json()[0].id).toBe('proj-1')

    const created = await inject(app, {
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'idempotency-key': 'create-1' },
      payload: {
        projectId: 'proj-1',
        issueId: 'issue-1',
        title: 'Fix docs',
        description: 'Tighten wording',
        taskType: 'docs',
      },
    })
    expect(created.statusCode).toBe(201)
    expect(created.headers['idempotency-replayed']).toBe('false')
    expect(created.json().replayed).toBe(false)
    expect(created.json().ticket.lifecycle.status).toBe('WAITING_APPROVAL')

    const listed = await inject(app, {
      method: 'GET',
      url: '/api/v1/tasks?states=WAITING_APPROVAL&projectId=proj-1&limit=10',
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().items).toHaveLength(1)

    const badStates = await inject(app, { method: 'GET', url: '/api/v1/tasks?states=WAITING_APPROVAL,WAITING_APPROVAL' })
    expect(badStates.statusCode).toBe(400)
    expect(badStates.json().error.code).toBe('INVALID_REQUEST')

    const duplicateQuery = await inject(app, { method: 'GET', url: '/api/v1/tasks?limit=1&limit=2' })
    expect(duplicateQuery.statusCode).toBe(400)

    const unknownQuery = await inject(app, { method: 'GET', url: '/api/v1/tasks?ownerId=owner-1' })
    expect(unknownQuery.statusCode).toBe(400)

    const detail = await inject(app, {
      method: 'GET',
      url: `/api/v1/tasks/${created.json().ticket.id}`,
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().ticket.id).toBe(created.json().ticket.id)

    const missing = await inject(app, { method: 'GET', url: '/api/v1/tasks/missing-ticket' })
    expect(missing.statusCode).toBe(404)

    void store
  })

  it('creates and approves with idempotent replay after database reopen', async () => {
    const first = await fixture()
    const createPayload = {
      projectId: 'proj-1',
      issueId: 'issue-replay',
      title: 'Replay docs',
      description: 'Idempotent create',
      taskType: 'docs',
    }
    const created = await inject(first.app, {
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'idempotency-key': 'create-replay' },
      payload: createPayload,
    })
    expect(created.statusCode).toBe(201)
    const ticketId = created.json().ticket.id as string
    const version = created.json().ticket.lifecycle.version as number

    const approved = await inject(first.app, {
      method: 'POST',
      url: `/api/v1/tasks/${ticketId}/approve`,
      headers: { 'idempotency-key': 'approve-replay' },
      payload: { expectedVersion: version, reason: 'Owner approved scoped docs edits' },
    })
    expect(approved.statusCode).toBe(200)
    expect(approved.json().ticket.lifecycle.status).toBe('QUEUED')
    expect(approved.headers['idempotency-replayed']).toBe('false')

    await first.app.close()
    first.store.close()
    opened.splice(opened.indexOf(first.app), 1)
    opened.splice(opened.indexOf(first.store), 1)

    const store = new LocalStore(first.dbPath)
    opened.push(store)
    const app = createApiServer({
      store,
      settings: first.settings,
      authenticator: first.authenticator,
      allowedOrigins: ALLOWED,
      dataDir: first.dataDir,
    })
    opened.push(app)
    await app.ready()

    const createAgain = await inject(app, {
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'idempotency-key': 'create-replay' },
      payload: createPayload,
    })
    expect(createAgain.statusCode).toBe(201)
    expect(createAgain.json().replayed).toBe(true)
    expect(createAgain.headers['idempotency-replayed']).toBe('true')
    expect(createAgain.json().ticket.id).toBe(ticketId)

    const approveAgain = await inject(app, {
      method: 'POST',
      url: `/api/v1/tasks/${ticketId}/approve`,
      headers: { 'idempotency-key': 'approve-replay' },
      payload: { expectedVersion: version, reason: 'Owner approved scoped docs edits' },
    })
    expect(approveAgain.statusCode).toBe(200)
    expect(approveAgain.json().replayed).toBe(true)
    expect(approveAgain.json().ticket.lifecycle.status).toBe('QUEUED')

    const conflict = await inject(app, {
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'idempotency-key': 'create-replay' },
      payload: { ...createPayload, title: 'Different title' },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT')

    const stale = await inject(app, {
      method: 'POST',
      url: `/api/v1/tasks/${ticketId}/approve`,
      headers: { 'idempotency-key': 'approve-stale' },
      payload: { expectedVersion: version, reason: 'stale version' },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('VERSION_CONFLICT')
  })

  it('rejects malformed bodies, missing idempotency keys, and unknown fields', async () => {
    const { app } = await fixture()
    const missingKey = await inject(app, {
      method: 'POST',
      url: '/api/v1/tasks',
      payload: {
        projectId: 'proj-1', issueId: 'issue-1', title: 't', description: 'd', taskType: 'docs',
      },
    })
    expect(missingKey.statusCode).toBe(400)

    const unknownField = await inject(app, {
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'idempotency-key': 'bad-body' },
      payload: {
        projectId: 'proj-1',
        issueId: 'issue-1',
        title: 't',
        description: 'd',
        taskType: 'docs',
        actor: 'evil',
        api_token: TOKEN,
      },
    })
    expect(unknownField.statusCode).toBe(400)
    expect(unknownField.json().error.code).toBe('INVALID_REQUEST')
    expectNoTokenLeak(unknownField.body)
    expect(JSON.stringify(unknownField.json())).not.toMatch(/api_token|actor/i)

    const coerced = await inject(app, {
      method: 'POST',
      url: '/api/v1/tasks/ticket-1/approve',
      headers: { 'idempotency-key': 'coerce' },
      payload: { expectedVersion: '1', reason: 'no coercion' },
    })
    expect(coerced.statusCode).toBe(400)
  })

  it('maps malformed JSON, unsupported media, and oversize bodies without echoing secrets', async () => {
    const { app } = await fixture()
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: authHeaders({
        'content-type': 'application/json',
        'idempotency-key': 'malformed-json',
      }),
      payload: `{"title":"leak-${TOKEN}","not":`,
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json()).toEqual({ error: { code: 'INVALID_REQUEST', message: 'Invalid request' } })
    expectNoTokenLeak(malformed.body)

    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: authHeaders({
        'content-type': 'application/xml',
        'idempotency-key': 'bad-media',
      }),
      payload: `<secret>${TOKEN}</secret>`,
    })
    expect(unsupported.statusCode).toBe(415)
    expect(unsupported.json()).toEqual({
      error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported media type' },
    })
    expectNoTokenLeak(unsupported.body)

    const oversize = await app.inject({
      method: 'POST',
      url: '/api/v1/tasks',
      headers: authHeaders({
        'content-type': 'application/json',
        'idempotency-key': 'too-large',
      }),
      payload: `{"token":"${TOKEN}","pad":"${'x'.repeat(130 * 1024)}"}`,
    })
    expect(oversize.statusCode).toBe(413)
    expect(oversize.json()).toEqual({
      error: { code: 'REQUEST_TOO_LARGE', message: 'Request too large' },
    })
    expectNoTokenLeak(oversize.body)
  })

  it('maps receipt INSERT abort to HTTP 500 with transaction rollback versus STATE_CONFLICT 409', async () => {
    const { app, store } = await fixture()
    store.db.exec(`CREATE TRIGGER abort_receipt_insert BEFORE INSERT ON task_command_receipt
      BEGIN SELECT RAISE(ABORT, 'injected receipt failure'); END`)

    const aborted = await inject(app, {
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'idempotency-key': 'abort-create' },
      payload: {
        projectId: 'proj-1',
        issueId: 'abort-1',
        title: 'Abort create',
        description: 'must roll back',
        taskType: 'docs',
      },
    })
    expect(aborted.statusCode).toBe(500)
    expect(aborted.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    })
    expectNoTokenLeak(aborted.body)

    const listed = await inject(app, { method: 'GET', url: '/api/v1/tasks?limit=50' })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().items).toHaveLength(0)
    const receiptCount = store.db.prepare(
      'SELECT count(*) AS n FROM task_command_receipt WHERE command_key = ?',
    ).get('abort-create') as { n: number }
    expect(receiptCount.n).toBe(0)

    store.db.exec('DROP TRIGGER abort_receipt_insert')

    const created = await inject(app, {
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'idempotency-key': 'state-create' },
      payload: {
        projectId: 'proj-1',
        issueId: 'state-1',
        title: 'State conflict',
        description: 'premature review',
        taskType: 'docs',
      },
    })
    expect(created.statusCode).toBe(201)
    const ticketId = created.json().ticket.id as string
    const version = created.json().ticket.lifecycle.version as number

    const conflict = await inject(app, {
      method: 'POST',
      url: `/api/v1/tasks/${ticketId}/review`,
      headers: { 'idempotency-key': 'state-review' },
      payload: {
        expectedVersion: version,
        executionId: 'exec-missing',
        artifactRevision: 'rev-1',
        approved: true,
        reason: 'not verified',
      },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error.code).toBe('STATE_CONFLICT')
    expect(store.tickets.get(ticketId)?.lifecycle?.status).toBe('WAITING_APPROVAL')
  })

  it('excludes cross-owner tasks before pagination and masks foreign tickets', async () => {
    const primary = await fixture()
    const mine = await inject(primary.app, {
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'idempotency-key': 'mine' },
      payload: {
        projectId: 'proj-1', issueId: 'mine-1', title: 'Mine', description: 'owned', taskType: 'docs',
      },
    })
    expect(mine.statusCode).toBe(201)

    const foreign = new LocalTaskService({
      store: primary.store,
      ownerId: 'owner-2',
      workspaceId: 'local',
      rules: rules(),
    })
    const other = foreign.create({
      projectId: 'proj-1',
      issueId: 'foreign-1',
      title: 'Foreign',
      description: 'other owner',
      taskType: 'docs',
    })

    const listed = await inject(primary.app, { method: 'GET', url: '/api/v1/tasks?limit=50' })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().items.map((item: { id: string }) => item.id)).toEqual([mine.json().ticket.id])
    expect(listed.json().items.map((item: { id: string }) => item.id)).not.toContain(other.id)

    const hidden = await inject(primary.app, { method: 'GET', url: `/api/v1/tasks/${other.id}` })
    expect(hidden.statusCode).toBe(404)

    const approveForeign = await inject(primary.app, {
      method: 'POST',
      url: `/api/v1/tasks/${other.id}/approve`,
      headers: { 'idempotency-key': 'approve-foreign' },
      payload: { expectedVersion: 1, reason: 'nope' },
    })
    expect(approveForeign.statusCode).toBe(404)
  })

  it('blocks premature review and unsupported routes', async () => {
    const { app, store } = await fixture({ ruleList: rules({ approvalRequired: false }) })
    const created = await inject(app, {
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'idempotency-key': 'review-create' },
      payload: {
        projectId: 'proj-1', issueId: 'review-1', title: 't', description: 'd', taskType: 'docs',
      },
    })
    expect(created.statusCode).toBe(201)
    const ticketId = created.json().ticket.id as string
    const version = created.json().ticket.lifecycle.version as number

    const premature = await inject(app, {
      method: 'POST',
      url: `/api/v1/tasks/${ticketId}/review`,
      headers: { 'idempotency-key': 'review-early' },
      payload: {
        expectedVersion: version,
        executionId: 'exec-1',
        artifactRevision: 'rev-1',
        approved: true,
        reason: 'skip verification',
      },
    })
    expect(premature.statusCode).toBe(409)
    expect(premature.json().error.code).toBe('STATE_CONFLICT')
    expect(store.tickets.get(ticketId)?.lifecycle?.status).not.toBe('DONE')

    const unknown = await inject(app, { method: 'GET', url: '/api/v1/runtime/start' })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json().error.code).toBe('NOT_FOUND')
  })

  it('returns scoped execution records and task logs only for owned tickets', async () => {
    const { app, store, dataDir } = await fixture({ ruleList: rules({ approvalRequired: false }) })
    const created = await inject(app, {
      method: 'POST',
      url: '/api/v1/tasks',
      headers: { 'idempotency-key': 'exec-create' },
      payload: {
        projectId: 'proj-1', issueId: 'exec-1', title: 't', description: 'd', taskType: 'docs',
      },
    })
    const ticketId = created.json().ticket.id as string
    const cwd = join(root, 'cwd-exec')
    mkdirSync(cwd, { recursive: true, mode: 0o700 })
    const spec: ExecutionSpec = {
      executionId: 'execution-1',
      assignmentId: 'assign-1',
      ticketId,
      agentId: 'emp-1',
      runtime: 'fixture',
      generation: 1,
      cwd,
      inputRevision: 'rev-1',
      policyVersion: 'policy-1',
    }
    new ExecutionRepository(store.db).reserve(spec)
    const runnersRoot = join(dataDir, 'runners')
    mkdirSync(runnersRoot, { recursive: true, mode: 0o700 })
    chmodSync(runnersRoot, 0o700)
    const runners = join(runnersRoot, 'execution-1')
    mkdirSync(runners, { recursive: true, mode: 0o700 })
    chmodSync(runners, 0o700)
    writeFileSync(join(runners, 'stdout.log'), 'hello\n', { mode: 0o600 })
    writeFileSync(join(runners, 'stderr.log'), 'warn\n', { mode: 0o600 })
    chmodSync(join(runners, 'stdout.log'), 0o600)
    chmodSync(join(runners, 'stderr.log'), 0o600)

    const execution = await inject(app, { method: 'GET', url: '/api/v1/executions/execution-1' })
    expect(execution.statusCode).toBe(200)
    expect(execution.json().executionId).toBe('execution-1')
    expect(execution.json().ticketId).toBe(ticketId)
    const page = await inject(app,{method:'GET',url:`/api/v1/executions?limit=1&ticketId=${ticketId}&states=STARTING&employeeId=emp-1&projectId=proj-1`})
    expect(page.statusCode).toBe(200)
    expect(page.json().items.map((item: {executionId:string})=>item.executionId)).toEqual(['execution-1'])
    expect((await inject(app,{method:'GET',url:'/api/v1/executions?states=NOT_REAL'})).statusCode).toBe(400)
    expect((await inject(app,{method:'GET',url:'/api/v1/executions?states=RUNNING,RUNNING'})).statusCode).toBe(400)
    expect((await inject(app,{method:'GET',url:'/api/v1/executions?ownerId=other'})).statusCode).toBe(400)
    expect((await inject(app,{method:'GET',url:'/api/v1/executions?ticketId=missing-ticket'})).json().items).toEqual([])
    expect((await app.inject({url:'/api/v1/executions',headers:{host:HOST}})).statusCode).toBe(401)


    const missingExec = await inject(app, { method: 'GET', url: '/api/v1/executions/missing-exec' })
    expect(missingExec.statusCode).toBe(404)

    const logs = await inject(app, { method: 'GET', url: `/api/v1/tasks/${ticketId}/logs` })
    expect(logs.statusCode).toBe(200)
    expect(logs.json().ticketId).toBe(ticketId)
    expect(logs.json().executions[0].executionId).toBe('execution-1')

    const foreignLogs = await inject(app, { method: 'GET', url: '/api/v1/tasks/missing-ticket/logs' })
    expect(foreignLogs.statusCode).toBe(404)
  })
})
