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
import { createSettings, defaultSettings, type LocalSettings } from '../src/config/settings.ts'
import type { Rule } from '../src/assessor/rules.ts'
import { initializeManagementSchema } from '../src/storage/management-commands.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LocalStore } from '../src/storage/store.ts'
import { EmployeeRepository } from '../src/workforce/employees.ts'
import { ProjectRepository } from '../src/projects/projects.ts'

const TOKEN = randomBytes(32).toString('hex')
const OWNER = 'owner-1'
const ORIGIN = 'http://127.0.0.1:8787'
const HOST = '127.0.0.1:8787'
const ALLOWED = [ORIGIN] as const

const opened: { close(): void | Promise<void> }[] = []
let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'management-routes-')))
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
  git(dir, ['config', 'user.email', 'management-routes@example.com'])
  git(dir, ['config', 'user.name', 'Management Routes'])
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
    approvalRequired: true,
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
  initializeManagement?: boolean
  seedProject?: boolean
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
  initializeCommandSchema(store.db)
  if (options.initializeManagement !== false) initializeManagementSchema(store.db)
  chmodSync(dbPath, 0o600)

  let repositoryPath: string | undefined
  let worktreeRoot: string | undefined
  if (options.seedProject !== false && options.initializeManagement !== false) {
    repositoryPath = initGitRepo(join(root, `repo-${randomBytes(4).toString('hex')}`))
    worktreeRoot = join(root, `worktrees-${randomBytes(4).toString('hex')}`)
    mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 })
    new ProjectRepository(store.db).create({
      id: 'proj-1',
      workspaceId: 'local',
      name: 'Docs',
      ownerId: OWNER,
      repositoryPath,
      worktreeRoot,
      allowedTaskTypes: ['docs'],
    })
  }

  const authenticator = authenticatorFor()
  const app = createApiServer({
    store,
    settings,
    authenticator,
    allowedOrigins: ALLOWED,
    dataDir,
  })
  opened.push(app)
  await app.ready()

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

function employeeCreateInput(overrides: Record<string, unknown> = {}) {
  return {
    id: 'emp-new',
    name: 'Writer',
    role: 'Writer',
    responsibilities: ['docs'],
    capabilities: ['editing'],
    runtimeId: 'claude-local',
    projectIds: ['proj-1'],
    maxConcurrency: 1,
    timeoutMs: 60_000,
    ...overrides,
  }
}

function projectCreateInput(
  repositoryPath: string,
  worktreeRoot: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: 'proj-new',
    name: 'New Docs',
    ownerId: OWNER,
    repositoryPath,
    worktreeRoot,
    allowedTaskTypes: ['docs'],
    ...overrides,
  }
}

describe('registerManagementRoutes preflight', () => {
  it('fails closed when management schema is missing and does not migrate', async () => {
    const dataDir = join(root, 'uninit')
    mkdirSync(dataDir, { mode: 0o700 })
    const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
    opened.push(store)
    initializeApplicationSchema(store)
    initializeCommandSchema(store.db)
    const settings = settingsFor()
    const authenticator = authenticatorFor()
    store.db.prepare('DELETE FROM kv WHERE key = ?').run('management-schema')
    const before = createHash('sha256').update(readFileSync(join(dataDir, 'workforce.sqlite'))).digest('hex')
    expect(() => createApiServer({store,settings,authenticator,allowedOrigins:ALLOWED,dataDir}))
      .toThrow(/Management schema is not initialized|not initialized/i)
    const after = createHash('sha256').update(readFileSync(join(dataDir, 'workforce.sqlite'))).digest('hex')
    expect(after).toBe(before)
  })
})

describe('authentication on management routes', () => {
  const routes: Array<{ method: string; url: string; payload?: unknown }> = [
    {
      method: 'POST',
      url: '/api/v1/employees',
      payload: { input: employeeCreateInput(), reason: 'create employee' },
    },
    {
      method: 'POST',
      url: '/api/v1/employees/emp-1/update',
      payload: { input: { expectedVersion: 1, name: 'X' }, reason: 'rename' },
    },
    {
      method: 'POST',
      url: '/api/v1/employees/emp-1/enable',
      payload: { input: { expectedVersion: 1, enabled: true }, reason: 'enable' },
    },
    {
      method: 'POST',
      url: '/api/v1/projects',
      payload: {
        input: {
          id: 'proj-x', name: 'X', ownerId: OWNER,
          repositoryPath: '/tmp/x', worktreeRoot: '/tmp/y', allowedTaskTypes: ['docs'],
        },
        reason: 'create project',
      },
    },
    {
      method: 'POST',
      url: '/api/v1/projects/proj-1/update',
      payload: { input: { expectedVersion: 1, name: 'Y' }, reason: 'rename' },
    },
    {
      method: 'POST',
      url: '/api/v1/projects/proj-1/archive',
      payload: { input: { expectedVersion: 1 }, reason: 'archive' },
    },
    { method: 'GET', url: '/api/v1/employees/emp-1/history' },
    { method: 'GET', url: '/api/v1/projects/proj-1/history' },
  ]

  it('rejects every management endpoint without a valid bearer', async () => {
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

  it('rejects duplicate Authorization/Host/Origin on management routes', async () => {
    const { app } = await fixture()
    const url = '/api/v1/employees/emp-1/history'
    const duplicateAuth = await app.inject({
      method: 'GET',
      url,
      headers: authHeaders({ authorization: [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`] }),
    })
    expect(duplicateAuth.statusCode).toBe(401)

    const duplicateHost = await app.inject({
      method: 'GET',
      url,
      headers: authHeaders({ host: [HOST, HOST] }),
    })
    expect(duplicateHost.statusCode).toBe(403)

    const duplicateOrigin = await app.inject({
      method: 'GET',
      url,
      headers: authHeaders({ origin: [ORIGIN, ORIGIN] }),
    })
    expect(duplicateOrigin.statusCode).toBe(403)
  })
})

describe('employee and project management mutations', () => {
  it('creates disabled employees, enables, updates, and returns scoped history', async () => {
    const { app } = await fixture()

    const created = await inject(app, {
      method: 'POST',
      url: '/api/v1/employees',
      headers: { 'idempotency-key': 'emp-create-1' },
      payload: { input: employeeCreateInput(), reason: 'Provision documentation writer' },
    })
    expect(created.statusCode).toBe(201)
    expect(created.headers['idempotency-replayed']).toBe('false')
    expect(created.json()).toMatchObject({
      kind: 'employee',
      replayed: false,
      employee: {
        id: 'emp-new',
        workspaceId: 'local',
        enabled: false,
        runtimeId: 'claude-local',
        version: 1,
      },
    })

    const enabled = await inject(app, {
      method: 'POST',
      url: '/api/v1/employees/emp-new/enable',
      headers: { 'idempotency-key': 'emp-enable-1' },
      payload: {
        input: { expectedVersion: 1, enabled: true },
        reason: 'Enable after owner review',
      },
    })
    expect(enabled.statusCode).toBe(200)
    expect(enabled.json().employee.enabled).toBe(true)
    expect(enabled.json().employee.version).toBe(2)

    const renamed = await inject(app, {
      method: 'POST',
      url: '/api/v1/employees/emp-new/update',
      headers: { 'idempotency-key': 'emp-rename-1' },
      payload: {
        input: { expectedVersion: 2, name: 'Docs Writer' },
        reason: 'Rename for clarity',
      },
    })
    expect(renamed.statusCode).toBe(200)
    expect(renamed.json().employee.name).toBe('Docs Writer')

    const history = await inject(app, {
      method: 'GET',
      url: '/api/v1/employees/emp-new/history',
    })
    expect(history.statusCode).toBe(200)
    expect(history.json().items.length).toBeGreaterThanOrEqual(3)
    expect(history.json().items.every((item: { resourceId: string; actorId: string; workspaceId: string }) => (
      item.resourceId === 'emp-new'
      && item.actorId === OWNER
      && item.workspaceId === 'local'
    ))).toBe(true)
    expect(JSON.stringify(history.json())).not.toMatch(/api[_-]?key|password|credential|Bearer/i)
  })

  it('creates/updates/archives projects with immutable path handling and history', async () => {
    const { app } = await fixture({ seedProject: false })
    const repositoryPath = initGitRepo(join(root, `repo-${randomBytes(4).toString('hex')}`))
    const worktreeRoot = join(root, `worktrees-${randomBytes(4).toString('hex')}`)
    mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 })

    const created = await inject(app, {
      method: 'POST',
      url: '/api/v1/projects',
      headers: { 'idempotency-key': 'proj-create-1' },
      payload: {
        input: projectCreateInput(repositoryPath, worktreeRoot),
        reason: 'Add documentation project',
      },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json()).toMatchObject({
      kind: 'project',
      replayed: false,
      project: {
        id: 'proj-new',
        workspaceId: 'local',
        archived: false,
        repositoryPath,
        worktreeRoot,
        version: 1,
      },
    })

    const updated = await inject(app, {
      method: 'POST',
      url: '/api/v1/projects/proj-new/update',
      headers: { 'idempotency-key': 'proj-update-1' },
      payload: {
        input: { expectedVersion: 1, name: 'Docs Space', ownerId: OWNER },
        reason: 'Rename project',
      },
    })
    expect(updated.statusCode).toBe(200)
    expect(updated.json().project.name).toBe('Docs Space')
    expect(updated.json().project.repositoryPath).toBe(repositoryPath)

    const pathInject = await inject(app, {
      method: 'POST',
      url: '/api/v1/projects/proj-new/update',
      headers: { 'idempotency-key': 'proj-path-inject' },
      payload: {
        input: {
          expectedVersion: 2,
          name: 'Docs Space',
          repositoryPath: '/evil/path',
        },
        reason: 'attempt path change',
      },
    })
    expect(pathInject.statusCode).toBe(400)
    expect(pathInject.json().error.code).toBe('INVALID_REQUEST')

    const archived = await inject(app, {
      method: 'POST',
      url: '/api/v1/projects/proj-new/archive',
      headers: { 'idempotency-key': 'proj-archive-1' },
      payload: { input: { expectedVersion: 2 }, reason: 'Archive completed project' },
    })
    expect(archived.statusCode).toBe(200)
    expect(archived.json().project.archived).toBe(true)

    const history = await inject(app, { method: 'GET', url: '/api/v1/projects/proj-new/history' })
    expect(history.statusCode).toBe(200)
    expect(history.json().items.length).toBeGreaterThanOrEqual(3)
  })

  it('replays identical mutations after database reopen and conflicts on changed hash', async () => {
    const first = await fixture()
    const payload = {
      input: employeeCreateInput({ id: 'emp-replay' }),
      reason: 'Create for replay',
    }
    const created = await inject(first.app, {
      method: 'POST',
      url: '/api/v1/employees',
      headers: { 'idempotency-key': 'emp-replay-key' },
      payload,
    })
    expect(created.statusCode).toBe(201)
    const employee = created.json().employee

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

    const replay = await inject(app, {
      method: 'POST',
      url: '/api/v1/employees',
      headers: { 'idempotency-key': 'emp-replay-key' },
      payload,
    })
    expect(replay.statusCode).toBe(201)
    expect(replay.headers['idempotency-replayed']).toBe('true')
    expect(replay.json().replayed).toBe(true)
    expect(replay.json().employee).toEqual(employee)

    const conflict = await inject(app, {
      method: 'POST',
      url: '/api/v1/employees',
      headers: { 'idempotency-key': 'emp-replay-key' },
      payload: {
        input: employeeCreateInput({ id: 'emp-replay', name: 'Different' }),
        reason: 'Create for replay',
      },
    })
    expect(conflict.statusCode).toBe(409)
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT')

    const history = await inject(app, { method: 'GET', url: '/api/v1/employees/emp-replay/history' })
    expect(history.statusCode).toBe(200)
    expect(history.json().items).toHaveLength(1)
  })

  it('maps version and enabled-state conflicts without secret echoes', async () => {
    const { app } = await fixture()
    const created = await inject(app, {
      method: 'POST',
      url: '/api/v1/employees',
      headers: { 'idempotency-key': 'emp-conflict' },
      payload: { input: employeeCreateInput({ id: 'emp-conflict' }), reason: 'create' },
    })
    expect(created.statusCode).toBe(201)

    const enabled = await inject(app, {
      method: 'POST',
      url: '/api/v1/employees/emp-conflict/enable',
      headers: { 'idempotency-key': 'emp-conflict-enable' },
      payload: { input: { expectedVersion: 1, enabled: true }, reason: 'enable' },
    })
    expect(enabled.statusCode).toBe(200)

    const stale = await inject(app, {
      method: 'POST',
      url: '/api/v1/employees/emp-conflict/update',
      headers: { 'idempotency-key': 'emp-stale' },
      payload: {
        input: { expectedVersion: 1, name: 'Stale' },
        reason: 'stale version',
      },
    })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error.code).toBe('VERSION_CONFLICT')

    const sensitive = await inject(app, {
      method: 'POST',
      url: '/api/v1/employees/emp-conflict/update',
      headers: { 'idempotency-key': 'emp-sensitive' },
      payload: {
        input: { expectedVersion: 2, runtimeId: 'claude-local', maxConcurrency: 2 },
        reason: 'sensitive while enabled',
      },
    })
    expect(sensitive.statusCode).toBe(409)
    expect(sensitive.json().error.code).toBe('STATE_CONFLICT')
    expectNoTokenLeak(sensitive.body)
  })
})

describe('management route validation and scope gates', () => {
  it('rejects invalid ids, queries, missing keys, unknown/credential fields, and coercion', async () => {
    const { app } = await fixture()

    const badId = await inject(app, {
      method: 'GET',
      url: '/api/v1/employees/bad.id/history',
    })
    expect(badId.statusCode).toBe(400)

    const query = await inject(app, {
      method: 'GET',
      url: '/api/v1/employees/emp-1/history?limit=1',
    })
    expect(query.statusCode).toBe(400)

    const missingKey = await inject(app, {
      method: 'POST',
      url: '/api/v1/employees',
      payload: { input: employeeCreateInput(), reason: 'missing key' },
    })
    expect(missingKey.statusCode).toBe(400)

    const duplicateKey = await inject(app, {
      method: 'POST',
      url: '/api/v1/employees',
      headers: { 'idempotency-key': ['dup-1', 'dup-1'] },
      payload: { input: employeeCreateInput(), reason: 'duplicate key header' },
    })
    expect(duplicateKey.statusCode).toBe(400)

    const unknown = await inject(app, {
      method: 'POST',
      url: '/api/v1/employees',
      headers: { 'idempotency-key': 'unknown-field' },
      payload: {
        input: employeeCreateInput({ workspaceId: 'injected', actor: 'evil' }),
        reason: 'inject workspace',
        api_token: TOKEN,
      },
    })
    expect(unknown.statusCode).toBe(400)
    expect(unknown.json().error.code).toBe('INVALID_REQUEST')
    expect(JSON.stringify(unknown.json())).not.toMatch(/api_token|workspaceId|actor/i)
    expectNoTokenLeak(unknown.body)

    const coerced = await inject(app, {
      method: 'POST',
      url: '/api/v1/employees/emp-1/enable',
      headers: { 'idempotency-key': 'coerce' },
      payload: { input: { expectedVersion: '1', enabled: 'true' }, reason: 'no coercion' },
    })
    expect(coerced.statusCode).toBe(400)

    const missingHistory = await inject(app, {
      method: 'GET',
      url: '/api/v1/employees/missing-emp/history',
    })
    expect(missingHistory.statusCode).toBe(404)
  })

  it('rejects foreign project references, unknown runtime, and relative project paths', async () => {
    const { app, store } = await fixture()

    new ProjectRepository(store.db).create({
      id: 'proj-foreign',
      workspaceId: 'other',
      name: 'Foreign',
      ownerId: OWNER,
      repositoryPath: initGitRepo(join(root, `repo-foreign-${randomBytes(4).toString('hex')}`)),
      worktreeRoot: (() => {
        const path = join(root, `worktrees-foreign-${randomBytes(4).toString('hex')}`)
        mkdirSync(path, { recursive: true, mode: 0o700 })
        return path
      })(),
      allowedTaskTypes: ['docs'],
    })

    const foreign = await inject(app, {
      method: 'POST',
      url: '/api/v1/employees',
      headers: { 'idempotency-key': 'foreign-proj' },
      payload: {
        input: employeeCreateInput({ id: 'emp-foreign', projectIds: ['proj-foreign'] }),
        reason: 'foreign project binding',
      },
    })
    expect(foreign.statusCode).toBe(400)
    expect(foreign.json().error.code).toBe('INVALID_REQUEST')

    const runtime = await inject(app, {
      method: 'POST',
      url: '/api/v1/employees',
      headers: { 'idempotency-key': 'bad-runtime' },
      payload: {
        input: employeeCreateInput({ id: 'emp-runtime', runtimeId: 'other-runtime' }),
        reason: 'runtime injection',
      },
    })
    expect(runtime.statusCode).toBe(400)
    expect(runtime.json().error.code).toBe('INVALID_REQUEST')

    const relative = await inject(app, {
      method: 'POST',
      url: '/api/v1/projects',
      headers: { 'idempotency-key': 'relative-path' },
      payload: {
        input: projectCreateInput('relative/repo', 'relative/worktrees', { id: 'proj-rel' }),
        reason: 'relative paths',
      },
    })
    expect(relative.statusCode).toBe(400)
    expect(relative.json().error.code).toBe('INVALID_REQUEST')
  })

  it('maps malformed JSON, unsupported media, and oversize bodies without echoing secrets', async () => {
    const { app } = await fixture()

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/employees',
      headers: authHeaders({
        'content-type': 'application/json',
        'idempotency-key': 'malformed-json',
      }),
      payload: `{"reason":"leak-${TOKEN}","not":`,
    })
    expect(malformed.statusCode).toBe(400)
    expect(malformed.json()).toEqual({ error: { code: 'INVALID_REQUEST', message: 'Invalid request' } })
    expectNoTokenLeak(malformed.body)

    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/v1/employees',
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
      url: '/api/v1/employees',
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

  it('does not launch Runtime and keeps employee create disabled by default', async () => {
    const { app, store } = await fixture()
    const created = await inject(app, {
      method: 'POST',
      url: '/api/v1/employees',
      headers: { 'idempotency-key': 'disabled-create' },
      payload: {
        input: employeeCreateInput({ id: 'emp-disabled', enabled: true } as never),
        reason: 'must ignore enabled injection',
      },
    })
    // unknown enabled field rejected by schema, or create stays disabled
    if (created.statusCode === 400) {
      expect(created.json().error.code).toBe('INVALID_REQUEST')
      const viaRepo = new EmployeeRepository(store.db).list('local')
      expect(viaRepo.some(employee => employee.id === 'emp-disabled')).toBe(false)
    } else {
      expect(created.statusCode).toBe(201)
      expect(created.json().employee.enabled).toBe(false)
    }
  })
})


describe('management validation error classification', () => {
 it('rejects empty employee patches and invalid filesystem paths as invalid requests without receipts', async () => {
  const {app,store} = await fixture()
  const empty = await inject(app,{method:'POST',url:'/api/v1/employees/missing/update',headers:{'idempotency-key':'empty-patch'},payload:{input:{expectedVersion:1},reason:'No fields'}})
  expect(empty.statusCode).toBe(400)
  const plainFile=join(root,'plain-file');writeFileSync(plainFile,'fixture')
  for(const [index,repositoryPath] of [join(root,'does-not-exist'),join(plainFile,'child')].entries()) {
   const response=await inject(app,{method:'POST',url:'/api/v1/projects',headers:{'idempotency-key':`invalid-path-${index}`},payload:{input:{id:`bad-project-${index}`,name:`Bad project ${index}`,ownerId:OWNER,repositoryPath,worktreeRoot:join(root,`bad-worktrees-${index}`),allowedTaskTypes:['docs']},reason:'Validate actual path'}})
   expect(response.statusCode).toBe(400)
   expect(response.json().error.code).toBe('INVALID_REQUEST')
   expect(response.body).not.toContain(repositoryPath)
  }
  expect(store.db.prepare('SELECT count(*) AS n FROM management_command_receipt').get()?.n).toBe(0)
  expect(store.db.prepare('SELECT count(*) AS n FROM management_audit').get()?.n).toBe(0)
 })
})
