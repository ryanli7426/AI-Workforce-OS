import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOwnerAuthenticator } from '../src/api/auth.ts'
import { createApiServer } from '../src/api/server.ts'
import { LocalTaskService } from '../src/application/tasks.ts'
import type { Rule } from '../src/assessor/rules.ts'
import { defaultSettings, type LocalSettings } from '../src/config/settings.ts'
import { ExecutionRepository } from '../src/execution/repository.ts'
import { ProjectRepository } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { ChangeFeedRepository } from '../src/storage/change-feed.ts'
import { LocalStore } from '../src/storage/store.ts'
import { VerificationJobRepository } from '../src/storage/verification-jobs.ts'
import { EmployeeRepository } from '../src/workforce/employees.ts'

const OWNER = 'owner-acceptance'
const WORKSPACE = 'local'
const TOKEN = 'a'.repeat(64)
const TEST_TIMEOUT = 30_000
const IO_TIMEOUT = 4_000

interface SseFrame {
  event: string
  id: string
  data: unknown
}

interface ReviewedResources {
  ticketId: string
  executionId: string
  verificationId: string
}

const apps = new Set<FastifyInstance>()
const stores = new Set<LocalStore>()
const streams = new Set<SseConnection>()
let root: string

function rules(): Rule[] {
  return [{
    id: 'acceptance-documentation',
    enabled: true,
    taskTypes: ['documentation'],
    priority: 10,
    approvalRequired: false,
    reviewRequired: true,
    retryLimit: 1,
  }]
}

function settingsFor(): LocalSettings {
  const settings = defaultSettings({ ownerId: OWNER })
  return { ...settings, rules: rules() }
}

function gitEnvironment(): NodeJS.ProcessEnv {
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

function initializeGitRepository(name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const git = (args: string[]) => execFileSync('/usr/bin/git', ['-C', path, ...args], {
    env: gitEnvironment(),
    stdio: 'ignore',
    timeout: 10_000,
  })
  git(['init', '--quiet'])
  git(['config', 'user.name', 'Realtime Acceptance'])
  git(['config', 'user.email', 'realtime-acceptance@example.test'])
  writeFileSync(join(path, 'README.md'), 'acceptance fixture\n', { mode: 0o600 })
  git(['add', '--', 'README.md'])
  git(['commit', '--quiet', '-m', 'fixture baseline'])
  return realpathSync(path)
}

function openStore(path: string): LocalStore {
  const store = new LocalStore(path)
  stores.add(store)
  return store
}

function closeStore(store: LocalStore): void {
  if (!stores.delete(store)) return
  store.close()
}

async function closeApp(app: FastifyInstance): Promise<void> {
  if (!apps.has(app)) return
  await app.close()
  apps.delete(app)
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = IO_TIMEOUT): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

class SseConnection {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly decoder = new TextDecoder()
  private buffer = ''

  private constructor(
    private readonly controller: AbortController,
    response: Response,
  ) {
    if (!response.body) throw new Error('SSE response has no body')
    this.reader = response.body.getReader()
  }

  static async open(baseUrl: string, token: string, cursor?: string): Promise<SseConnection> {
    const controller = new AbortController()
    const response = await withTimeout(fetch(`${baseUrl}/api/v1/events`, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(cursor === undefined ? {} : { 'last-event-id': cursor }),
      },
      signal: controller.signal,
    }), 'SSE response headers')
    if (response.status !== 200) {
      controller.abort()
      throw new Error(`Unexpected SSE status ${response.status}: ${await response.text()}`)
    }
    expect(response.headers.get('content-type')).toBe('text/event-stream;charset=utf-8')
    const stream = new SseConnection(controller, response)
    streams.add(stream)
    return stream
  }

  async next(label = 'SSE frame'): Promise<SseFrame> {
    for (;;) {
      const boundary = this.buffer.indexOf('\n\n')
      if (boundary >= 0) {
        const raw = this.buffer.slice(0, boundary)
        this.buffer = this.buffer.slice(boundary + 2)
        if (!raw || raw.startsWith(':')) continue
        const fields = new Map<string, string>()
        for (const line of raw.split('\n')) {
          const separator = line.indexOf(':')
          if (separator < 0) continue
          const key = line.slice(0, separator)
          const value = line.slice(separator + 1).replace(/^ /, '')
          fields.set(key, value)
        }
        const event = fields.get('event')
        const id = fields.get('id')
        const data = fields.get('data')
        if (!event || !id || data === undefined) throw new Error('Malformed acceptance SSE frame')
        return { event, id, data: JSON.parse(data) as unknown }
      }
      if (Buffer.byteLength(this.buffer) > 128 * 1024) throw new Error('Acceptance SSE buffer exceeded bound')
      const result = await withTimeout(this.reader.read(), label)
      if (result.done) throw new Error(`SSE ended before ${label}`)
      this.buffer += this.decoder.decode(result.value, { stream: true }).replace(/\r\n/g, '\n')
    }
  }

  async close(): Promise<void> {
    if (!streams.delete(this)) return
    this.controller.abort()
    try { await this.reader.cancel() } catch { /* the server may already have destroyed the response */ }
  }
}

async function nextChange(stream: SseConnection, resourceId: string): Promise<SseFrame> {
  for (let count = 0; count < 100; count++) {
    const frame = await stream.next(`change for ${resourceId}`)
    if (frame.event === 'change'
      && (frame.data as { resourceId?: unknown }).resourceId === resourceId) return frame
  }
  throw new Error(`Too many frames before change for ${resourceId}`)
}

function createProject(store: LocalStore, input: {
  id: string
  workspaceId: string
  ownerId: string
  repository: string
}): void {
  new ProjectRepository(store.db).create({
    id: input.id,
    workspaceId: input.workspaceId,
    name: `Project ${input.id}`,
    ownerId: input.ownerId,
    repositoryPath: input.repository,
    worktreeRoot: join(root, `worktrees-${input.id}`),
    allowedTaskTypes: ['documentation'],
  })
}

function createReviewedResources(
  store: LocalStore,
  ownerId: string,
  workspaceId: string,
  projectId: string,
  suffix: string,
): ReviewedResources {
  const service = new LocalTaskService({ store, ownerId, workspaceId, rules: rules() })
  const task = service.create({
    issueId: `issue-${suffix}`,
    projectId,
    title: `Acceptance ${suffix}`,
    description: 'Deterministic Core REVIEW fixture; no model or Runtime execution is claimed.',
    taskType: 'documentation',
  })
  const assigned = service.engine.assignTask(
    task.id,
    `employee-${suffix}`,
    'acceptance-fixture-no-process',
    join(root, `assignment-${suffix}`),
  )
  const assignment = assigned.assignments.at(-1)
  if (!assignment) throw new Error('Acceptance assignment was not created')
  service.engine.assignmentStarted(task.id, assignment.id)
  const executionId = `execution-${suffix}`
  service.engine.recordExecution(task.id, {
    assignmentId: assignment.id,
    executionId,
    artifactRevision: 'b'.repeat(64),
    exitCode: 0,
    terminal: 'success',
    summary: 'Deterministic fixture reached REVIEW without launching Runtime.',
  })
  const current = service.get(task.id)
  expect(current?.lifecycle?.status).toBe('REVIEW')

  new ExecutionRepository(store.db).reserve({
    executionId,
    assignmentId: assignment.id,
    ticketId: task.id,
    agentId: `employee-${suffix}`,
    runtime: 'acceptance-fixture-no-process',
    generation: 1,
    cwd: join(root, `execution-${suffix}`),
    inputRevision: 'fixture-input-v1',
    policyVersion: service.currentPolicyVersion,
  })

  const verificationId = `verification-${suffix}`
  new VerificationJobRepository(store.db).reserve({
    verificationId,
    workspaceId,
    ownerId,
    ticketId: task.id,
    expectedTaskVersion: current!.lifecycle!.version,
    policyVersion: service.currentPolicyVersion,
    executionId,
    artifactId: `artifact-${suffix}`,
    artifactRevision: 'b'.repeat(64),
    plan: {
      id: `plan-${suffix}`,
      revision: 'r1',
      checks: [{ id: 'not-run', command: process.execPath, args: ['--version'], timeoutMs: 1_000 }],
    },
    reason: 'Storage-only acceptance fixture; verification worker is not launched.',
    createdAt: new Date().toISOString(),
  })
  return { ticketId: task.id, executionId, verificationId }
}

function runCompiledCli(args: string[]): unknown {
  const stdout = execFileSync(process.execPath, [resolve('dist/cli/index.js'), ...args], {
    cwd: root,
    env: gitEnvironment(),
    encoding: 'utf8',
    timeout: 10_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(stdout) as unknown
}

function rawGet(baseUrl: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return withTimeout(new Promise((resolvePromise, reject) => {
    const req = request(`${baseUrl}/api/v1/events`, { method: 'GET', headers }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolvePromise({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    req.end()
  }), 'finite rejected HTTP response')
}

async function startApi(store: LocalStore, settings: LocalSettings, dataDir: string): Promise<{
  app: FastifyInstance
  baseUrl: string
}> {
  const app = createApiServer({
    store,
    settings,
    authenticator: createOwnerAuthenticator({ token: TOKEN, ownerId: OWNER, workspaceId: WORKSPACE }),
    allowedOrigins: [],
    dataDir,
  })
  apps.add(app)
  await app.listen({ host: '127.0.0.1', port: 0 })
  const address = app.server.address() as AddressInfo
  return { app, baseUrl: `http://127.0.0.1:${address.port}` }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'realtime-acceptance-')))
  chmodSync(root, 0o700)
})

afterEach(async () => {
  for (const stream of [...streams]) await stream.close()
  for (const app of [...apps]) {
    const closing = closeApp(app)
    try {
      await withTimeout(closing, 'normal test cleanup', 500)
    } catch {
      // Failure-path cleanup stays bounded even when the assertion above proves graceful
      // preClose did not terminate its owned socket in time.
      app.server.closeAllConnections()
      try { await withTimeout(closing, 'forced test cleanup', 2_000) } catch { /* test already reports the lifecycle defect */ }
    }
  }
  for (const store of [...stores]) {
    try { closeStore(store) } catch { /* already closed */ }
  }
  rmSync(root, { recursive: true, force: true })
})

describe('realtime durable acceptance: actual SQLite + TCP + compiled CLI', () => {
  it('streams scoped cross-connection commits, resumes after restart, expires pruned cursors, and closes deterministically', async () => {
    const dataDir = join(root, 'data')
    mkdirSync(dataDir, { mode: 0o700 })
    const dbPath = join(dataDir, 'workforce.sqlite')
    const settings = settingsFor()
    const apiStore = openStore(dbPath)
    initializeApplicationSchema(apiStore)
    const writerStore = openStore(dbPath)
    const ownerRepository = initializeGitRepository('owner-project')
    createProject(writerStore, { id: 'project-owner', workspaceId: WORKSPACE, ownerId: OWNER, repository: ownerRepository })

    let { app, baseUrl } = await startApi(apiStore, settings, dataDir)

    const rejected = await Promise.all([
      rawGet(baseUrl, { host: new URL(baseUrl).host }),
      rawGet(baseUrl, { host: new URL(baseUrl).host, authorization: `Bearer ${TOKEN}`, origin: 'https://evil.example' }),
      rawGet(baseUrl, { host: 'evil.example', authorization: `Bearer ${TOKEN}` }),
    ])
    expect(rejected.map(item => item.status)).toEqual([401, 403, 403])
    for (const item of rejected) {
      expect(item.body).not.toContain('event:')
      expect(item.body).not.toContain('data:')
    }

    let stream = await SseConnection.open(baseUrl, TOKEN)
    expect(await stream.next('initial reset')).toMatchObject({ event: 'reset', data: { reason: 'initial' } })
    const initialReady = await stream.next('initial ready')
    expect(initialReady).toMatchObject({ event: 'ready', data: {} })

    const sharedRepository = initializeGitRepository('shared-project')
    createProject(writerStore, {
      id: 'project-shared',
      workspaceId: WORKSPACE,
      ownerId: 'foreign-business-owner',
      repository: sharedRepository,
    })
    const sameWorkspaceForeign = createReviewedResources(
      writerStore,
      'foreign-owner',
      WORKSPACE,
      'project-shared',
      'foreign-owner',
    )
    const otherRepository = initializeGitRepository('other-workspace-project')
    createProject(writerStore, {
      id: 'project-other-workspace',
      workspaceId: 'other-workspace',
      ownerId: 'foreign-owner',
      repository: otherRepository,
    })
    const otherWorkspace = createReviewedResources(
      writerStore,
      'foreign-owner',
      'other-workspace',
      'project-other-workspace',
      'other-workspace',
    )
    const visible = createReviewedResources(
      writerStore,
      OWNER,
      WORKSPACE,
      'project-owner',
      'visible-owner',
    )

    const observed: SseFrame[] = []
    for (let count = 0; count < 100; count++) {
      const frame = await stream.next('scoped durable changes')
      if (frame.event !== 'change') continue
      observed.push(frame)
      if ((frame.data as { resourceId?: unknown }).resourceId === visible.verificationId) break
    }
    const notices = observed.map(frame => frame.data as { entity: string; resourceId: string; ticketId?: string })
    expect(notices).toEqual(expect.arrayContaining([
      expect.objectContaining({ entity: 'project', resourceId: 'project-shared' }),
      expect.objectContaining({ entity: 'task', resourceId: visible.ticketId }),
      expect.objectContaining({ entity: 'execution', resourceId: visible.executionId, ticketId: visible.ticketId }),
      expect.objectContaining({ entity: 'verification', resourceId: visible.verificationId, ticketId: visible.ticketId }),
    ]))
    const forbiddenIds = new Set([
      sameWorkspaceForeign.ticketId,
      sameWorkspaceForeign.executionId,
      sameWorkspaceForeign.verificationId,
      otherWorkspace.ticketId,
      otherWorkspace.executionId,
      otherWorkspace.verificationId,
      'project-other-workspace',
    ])
    expect(notices.some(notice => forbiddenIds.has(notice.resourceId) || (notice.ticketId && forbiddenIds.has(notice.ticketId)))).toBe(false)

    const employeeFile = join(root, 'employee.json')
    writeFileSync(employeeFile, JSON.stringify({
      id: 'employee-cli',
      name: 'CLI Employee',
      role: 'documentation',
      responsibilities: ['documentation'],
      capabilities: ['typescript'],
      runtimeId: 'acceptance-fixture-no-process',
      projectIds: ['project-owner'],
      maxConcurrency: 1,
      timeoutMs: 60_000,
    }), { mode: 0o600 })
    expect(runCompiledCli(['employee-create', '--data-dir', dataDir, '--file', employeeFile])).toMatchObject({
      id: 'employee-cli', version: 1, enabled: false,
    })
    const createdFrame = await nextChange(stream, 'employee-cli')
    expect(createdFrame.data).toMatchObject({ entity: 'employee', resourceId: 'employee-cli' })

    const employees = new EmployeeRepository(writerStore.db)
    expect(employees.update('employee-cli', { expectedVersion: 1, role: 'reviewer' })).toMatchObject({ version: 2 })
    await nextChange(stream, 'employee-cli')
    expect(runCompiledCli(['employee-enable', 'employee-cli', '--data-dir', dataDir, '--version', '2'])).toMatchObject({
      id: 'employee-cli', version: 3, enabled: true,
    })
    const enabledFrame = await nextChange(stream, 'employee-cli')
    const resumeCursor = enabledFrame.id

    await stream.close()
    await withTimeout(closeApp(app), 'first API shutdown')
    employees.update('employee-cli', { expectedVersion: 3, role: 'restarted-api-observer' })

    ;({ app, baseUrl } = await startApi(apiStore, settings, dataDir))
    stream = await SseConnection.open(baseUrl, TOKEN, resumeCursor)
    const replayed = await stream.next('replayed change before ready')
    expect(replayed).toMatchObject({ event: 'change', data: { entity: 'employee', resourceId: 'employee-cli' } })
    const replayReady = await stream.next('ready after replay')
    expect(replayReady.event).toBe('ready')
    expect(replayReady.id).toBe(replayed.id)

    const rowsBeforeRollback = Number(writerStore.db.prepare('SELECT COUNT(*) AS count FROM change_feed').get()!.count)
    const rollbackProgram = [
      "import { DatabaseSync } from 'node:sqlite'",
      'const db = new DatabaseSync(process.argv[1])',
      "db.exec('BEGIN IMMEDIATE')",
      "const row = db.prepare('SELECT version, config_json FROM employee WHERE id = ?').get(process.argv[2])",
      'const value = JSON.parse(String(row.config_json))',
      "value.role = 'rolled-back-cross-process'",
      'value.version = Number(row.version) + 1',
      "db.prepare('UPDATE employee SET version = ?, config_json = ? WHERE id = ?').run(value.version, JSON.stringify(value), process.argv[2])",
      "db.exec('ROLLBACK')",
      'db.close()',
    ].join(';')
    execFileSync(process.execPath, ['--input-type=module', '-e', rollbackProgram, dbPath, 'employee-cli'], {
      cwd: root,
      env: gitEnvironment(),
      stdio: 'ignore',
      timeout: 10_000,
    })
    expect(Number(writerStore.db.prepare('SELECT COUNT(*) AS count FROM change_feed').get()!.count)).toBe(rowsBeforeRollback)
    expect(employees.update('employee-cli', { expectedVersion: 4, role: 'committed-cross-process-control' })).toMatchObject({ version: 5 })
    const committed = await nextChange(stream, 'employee-cli')
    const staleCursor = committed.id

    employees.update('employee-cli', { expectedVersion: 5, role: 'retention-1' })
    employees.update('employee-cli', { expectedVersion: 6, role: 'retention-2' })
    employees.update('employee-cli', { expectedVersion: 7, role: 'retention-current' })
    const feed = new ChangeFeedRepository({ db: writerStore.db, ownerId: OWNER, workspaceId: WORKSPACE })
    expect(feed.prune(1).removed).toBeGreaterThan(0)

    const expired = await SseConnection.open(baseUrl, TOKEN, staleCursor)
    expect(await expired.next('expired reset')).toMatchObject({ event: 'reset', data: { reason: 'expired' } })
    expect((await expired.next('ready after expired reset')).event).toBe('ready')
    await expired.close()

    const metaBeforeQuery = writerStore.db.prepare('SELECT epoch, pruned_through FROM change_feed_meta').get()
    const truthResponse = await fetch(`${baseUrl}/api/v1/employees`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    })
    expect(truthResponse.status).toBe(200)
    const truth = await truthResponse.json() as Array<{ id: string; role: string; version: number; enabled: boolean }>
    expect(truth).toContainEqual(expect.objectContaining({
      id: 'employee-cli', role: 'retention-current', version: 8, enabled: true,
    }))
    expect(writerStore.db.prepare('SELECT epoch, pruned_through FROM change_feed_meta').get()).toEqual(metaBeforeQuery)

    await stream.close()
    const shutdownStream = await SseConnection.open(baseUrl, TOKEN)
    await shutdownStream.next('shutdown initial reset')
    await shutdownStream.next('shutdown initial ready')
    await withTimeout(closeApp(app), 'API shutdown with an open SSE response', 2_000)
    await shutdownStream.close()
    expect(() => closeStore(apiStore)).not.toThrow()
    expect(() => closeStore(writerStore)).not.toThrow()
  }, TEST_TIMEOUT)

  it('keeps compiled CLI queries read-only when storage has not been initialized', () => {
    const absentDataDir = join(root, 'absent-data')
    expect(existsSync(absentDataDir)).toBe(false)
    expect(() => runCompiledCli(['employees', '--data-dir', absentDataDir])).toThrow()
    expect(existsSync(absentDataDir)).toBe(false)
  })
})
