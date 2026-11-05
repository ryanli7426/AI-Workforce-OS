import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  createApiClient,
  newCommandKey,
  type ApiClient,
  type Employee,
  type ExecutionRecord,
  type LocalTaskCommand,
  type ProductTaskListResult,
  type Project,
} from './api.ts'

type FetchCall = {
  input: RequestInfo | URL
  init?: RequestInit
}

const TOKEN = 'a'.repeat(64)
let fetchCalls: FetchCall[] = []
let fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const EXECUTION_FIXTURE: ExecutionRecord = {
  executionId: 'exec-1',
  assignmentId: 'assign-1',
  ticketId: 'ticket-1',
  agentId: 'emp-1',
  runtime: 'claude-code',
  generation: 1,
  cwd: '/tmp/work',
  inputRevision: 'rev-in',
  policyVersion: 'policy-1',
  state: 'SUCCEEDED',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:01:00.000Z',
  lastSequence: 2,
  exitCode: 0,
  finishedAt: '2026-01-01T00:01:00.000Z',
}

const EMPLOYEE_FIXTURE: Employee = {
  id: 'emp-1',
  workspaceId: 'local',
  name: '工程师',
  role: 'implementer',
  responsibilities: ['code'],
  capabilities: ['typescript'],
  runtimeId: 'claude-code',
  projectIds: ['proj-1'],
  maxConcurrency: 1,
  timeoutMs: 60_000,
  enabled: true,
  version: 1,
}

const PROJECT_FIXTURE: Project = {
  id: 'proj-1',
  workspaceId: 'local',
  name: '演示项目',
  ownerId: 'owner-1',
  repositoryPath: '/tmp/repo',
  worktreeRoot: '/tmp/worktrees',
  allowedTaskTypes: ['implement'],
  archived: false,
  version: 1,
}

const TICKET_FIXTURE = {
  id: 'ticket-1',
  title: '任务标题',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  lifecycle: { status: 'WAITING_APPROVAL' as const, version: 3 },
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const text = JSON.stringify(body)
  return new Response(text, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': String(new TextEncoder().encode(text).length),
      ...headers,
    },
  })
}

function chunkedResponse(status: number, chunks: Uint8Array[], headers: Record<string, string> = {}): Response {
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(chunks[index]!)
      index += 1
    },
  })
  return new Response(stream, {
    status,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
  })
}

function installFetch(): void {
  fetchCalls = []
  fetchImpl = async () => jsonResponse(500, { error: { code: 'INTERNAL_ERROR', message: 'x' } })
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ input, init })
    return fetchImpl(input, init)
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  fetchCalls = []
})

function client(): ApiClient {
  return createApiClient(TOKEN)
}

function lastCall(): FetchCall {
  const call = fetchCalls.at(-1)
  if (!call) throw new Error('expected fetch call')
  return call
}

function assertAuthHeaders(init?: RequestInit): void {
  const headers = new Headers(init?.headers)
  expect(headers.get('Authorization')).toBe(`Bearer ${TOKEN}`)
  expect(headers.get('Accept')).toBe('application/json')
  expect(urlOf(lastCall().input)).not.toContain(TOKEN)
  expect(urlOf(lastCall().input)).not.toMatch(/token=/i)
}

describe('newCommandKey', () => {
  it('uses browser crypto.randomUUID', () => {
    const key = newCommandKey()
    expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    expect(newCommandKey()).not.toBe(key)
  })
})

describe('createApiClient', () => {
  it('requires exactly 64 lowercase hex and freezes the client', () => {
    expect(() => createApiClient('')).toThrow(ApiError)
    expect(() => createApiClient('A'.repeat(64))).toThrow(ApiError)
    expect(() => createApiClient('g'.repeat(64))).toThrow(ApiError)
    expect(() => createApiClient('a'.repeat(63))).toThrow(ApiError)
    expect(() => createApiClient('a'.repeat(65))).toThrow(ApiError)
    const api = createApiClient(TOKEN) as ApiClient & { token?: string }
    expect(Object.isFrozen(api)).toBe(true)
    expect(api.token).toBeUndefined()
    expect(Object.prototype.hasOwnProperty.call(api, 'token')).toBe(false)
  })

  it('ApiError never accepts arbitrary external text', () => {
    const error = new ApiError('UNAUTHORIZED', 401)
    expect(error.message).toBe('未授权，请重新连接。')
    expect(error).toMatchObject({ code: 'UNAUTHORIZED', status: 401 })
    const unknown = new ApiError('DROP_TABLE', 500)
    expect(unknown.code).toBe('INTERNAL_ERROR')
    expect(unknown.message).toBe('服务暂时不可用。')
    expect(unknown.message).not.toContain('DROP_TABLE')
  })
})

describe('ApiClient routes', () => {
  it('composes verification with the same private authenticated transport and the actual 202 receipt', async () => {
    installFetch()
    fetchImpl = async () => jsonResponse(202,{verificationId:'v-real-receipt',replayed:false})
    const verification=client().verification!
    await expect(verification.create('ticket-1','verify-command-1',{
      expectedVersion:5,executionId:'exec-1',artifactRevision:'a'.repeat(64),planId:'docs.content',planRevision:'v1.0',reason:'Independent artifact checks',
    })).resolves.toEqual({verificationId:'v-real-receipt',replayed:false})
    expect(urlOf(lastCall().input)).toBe('/api/v1/tasks/ticket-1/verifications')
    expect(new Headers(lastCall().init?.headers).get('Idempotency-Key')).toBe('verify-command-1')
    assertAuthHeaders(lastCall().init)
    fetchImpl = async () => jsonResponse(202,{job:{},replayed:false})
    await expect(verification.cancel('v-real-receipt','cancel-1',{expectedVersion:2,reason:'Stop'})).rejects.toMatchObject({code:'INVALID_RESPONSE'})
  })
  it('GET /api/v1/me', async () => {
    installFetch()
    fetchImpl = async () => jsonResponse(200, { ownerId: 'owner-1', workspaceId: 'ws-1', role: 'owner' })
    await expect(client().me()).resolves.toEqual({ ownerId: 'owner-1', workspaceId: 'ws-1', role: 'owner' })
    expect(urlOf(lastCall().input)).toBe('/api/v1/me')
    expect(lastCall().init?.method).toBe('GET')
    expect(lastCall().init?.redirect).toBe('error')
    expect(lastCall().init?.credentials).toBe('omit')
    expect(lastCall().init?.cache).toBe('no-store')
    assertAuthHeaders(lastCall().init)
  })

  it('GET /api/v1/overview', async () => {
    installFetch()
    const overview = {
      tasks: { total: 1, byStatus: { NEW: 1 } },
      employees: { configured: 1, enabled: 1, busy: 0 },
      executions: { total: 0, active: 0, unknown: 0 },
    }
    fetchImpl = async () => jsonResponse(200, overview)
    await expect(client().overview()).resolves.toEqual(overview)
    expect(urlOf(lastCall().input)).toBe('/api/v1/overview')
    assertAuthHeaders(lastCall().init)
  })

  it('GET /api/v1/employees and /api/v1/projects', async () => {
    installFetch()
    fetchImpl = async (input) => {
      const path = urlOf(input)
      if (path === '/api/v1/employees') return jsonResponse(200, [EMPLOYEE_FIXTURE])
      if (path === '/api/v1/projects') return jsonResponse(200, [PROJECT_FIXTURE])
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'x' } })
    }
    await expect(client().employees()).resolves.toEqual([EMPLOYEE_FIXTURE])
    await expect(client().projects()).resolves.toEqual([PROJECT_FIXTURE])
    expect(fetchCalls.map((call) => urlOf(call.input))).toEqual([
      '/api/v1/employees',
      '/api/v1/projects',
    ])
  })

  it('GET /api/v1/tasks encodes only contract query fields', async () => {
    installFetch()
    const list: ProductTaskListResult = {
      items: [{
        id: 'ticket-1',
        title: '任务',
        status: 'WAITING_APPROVAL',
        updatedAt: '2026-01-01T00:00:00.000Z',
        priority: 1,
        source: 'manual:owner:proj-1',
        rowid: 12,
      }],
      nextCursor: 12,
    }
    fetchImpl = async () => jsonResponse(200, list)
    await client().tasks({
      limit: 10,
      beforeRowid: 99,
      states: ['WAITING_APPROVAL', 'REVIEW'],
      projectId: 'proj-1',
      employeeId: 'emp-1',
    })
    const url = new URL(urlOf(lastCall().input), 'http://local.test')
    expect(url.pathname).toBe('/api/v1/tasks')
    expect(url.searchParams.get('limit')).toBe('10')
    expect(url.searchParams.get('beforeRowid')).toBe('99')
    expect(url.searchParams.get('states')).toBe('WAITING_APPROVAL,REVIEW')
    expect(url.searchParams.get('projectId')).toBe('proj-1')
    expect(url.searchParams.get('employeeId')).toBe('emp-1')
    expect([...url.searchParams.keys()].sort()).toEqual([
      'beforeRowid',
      'employeeId',
      'limit',
      'projectId',
      'states',
    ])
    assertAuthHeaders(lastCall().init)
  })

  it('rejects unknown task/log option keys, limit>200, invalid/duplicate states', async () => {
    installFetch()
    const api = client()
    await expect(api.tasks({ limit: 201 } as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    await expect(api.tasks({ states: ['NOT_A_STATE'] } as never)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      status: 400,
    })
    await expect(api.tasks({ states: ['NEW', 'NEW'] })).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    await expect(api.tasks({ cursor: 1 } as never)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    await expect(api.logs('ticket-1', { offset: 1 } as never)).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      status: 400,
    })
    expect(fetchCalls).toHaveLength(0)
  })

  it('GET /api/v1/tasks/:id, executions/:id, and logs with query', async () => {
    installFetch()
    fetchImpl = async (input) => {
      const path = urlOf(input)
      if (path.startsWith('/api/v1/tasks/ticket-1/logs')) {
        return jsonResponse(200, {
          ticketId: 'ticket-1',
          executions: [{
            executionId: 'exec-1',
            state: 'SUCCEEDED',
            stdout: 'ok',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
          }],
        })
      }
      if (path === '/api/v1/tasks/ticket-1') {
        return jsonResponse(200, {
          ticket: TICKET_FIXTURE,
          executions: [EXECUTION_FIXTURE],
          history: [],
          historyTruncated: false,
          executionsTruncated: false,
        })
      }
      if (path === '/api/v1/executions/exec-1') {
        return jsonResponse(200, EXECUTION_FIXTURE)
      }
      return jsonResponse(404, { error: { code: 'NOT_FOUND', message: 'x' } })
    }
    const api = client()
    await expect(api.task('ticket-1')).resolves.toMatchObject({ ticket: { id: 'ticket-1' } })
    await expect(api.execution('exec-1')).resolves.toEqual(EXECUTION_FIXTURE)
    await expect(api.logs('ticket-1', { executionId: 'exec-1', maxBytes: 2048 })).resolves.toMatchObject({
      ticketId: 'ticket-1',
      executions: [{ executionId: 'exec-1' }],
    })
    expect(urlOf(fetchCalls[0]!.input)).toBe('/api/v1/tasks/ticket-1')
    expect(urlOf(fetchCalls[1]!.input)).toBe('/api/v1/executions/exec-1')
    const logsUrl = new URL(urlOf(fetchCalls[2]!.input), 'http://local.test')
    expect(logsUrl.pathname).toBe('/api/v1/tasks/ticket-1/logs')
    expect(logsUrl.searchParams.get('executionId')).toBe('exec-1')
    expect(logsUrl.searchParams.get('maxBytes')).toBe('2048')
  })

  it('rejects success payload that uses id instead of executionId', async () => {
    installFetch()
    fetchImpl = async () => jsonResponse(200, { id: 'exec-1', state: 'SUCCEEDED' })
    await expect(client().execution('exec-1')).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 0 })
  })

  it('rejects unsafe ids before fetch', async () => {
    installFetch()
    const api = client()
    await expect(api.task('../evil')).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    await expect(api.execution('bad id')).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    await expect(api.logs('ticket/1')).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    await expect(api.tasks({ projectId: 'a/b' })).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    await expect(api.logs('ticket-1', { executionId: '../../x' })).rejects.toMatchObject({
      code: 'INVALID_REQUEST',
      status: 400,
    })
    expect(fetchCalls).toHaveLength(0)
  })
})

describe('ApiClient commands', () => {
  function mockCommandOk(status: number): void {
    installFetch()
    fetchImpl = async () => jsonResponse(status, { ticket: TICKET_FIXTURE, replayed: false })
  }

  it('POST /api/v1/tasks create body and Idempotency-Key', async () => {
    mockCommandOk(201)
    const input = {
      projectId: 'proj-1',
      issueId: 'issue-1',
      title: '标题',
      description: '描述',
      taskType: 'implement',
      priority: 1,
    }
    await expect(client().command('key-1', { kind: 'create', input })).resolves.toEqual({
      ticket: TICKET_FIXTURE,
      replayed: false,
    })
    expect(urlOf(lastCall().input)).toBe('/api/v1/tasks')
    expect(lastCall().init?.method).toBe('POST')
    const headers = new Headers(lastCall().init?.headers)
    expect(headers.get('Idempotency-Key')).toBe('key-1')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(JSON.parse(String(lastCall().init?.body))).toEqual(input)
    assertAuthHeaders(lastCall().init)
  })

  it.each([
    ['approve', { kind: 'approve', ticketId: 'ticket-1', expectedVersion: 3, reason: 'ok' }],
    ['reject', { kind: 'reject', ticketId: 'ticket-1', expectedVersion: 3, reason: 'no' }],
    ['cancel', { kind: 'cancel', ticketId: 'ticket-1', expectedVersion: 3, reason: 'stop' }],
    ['retry', { kind: 'retry', ticketId: 'ticket-1', expectedVersion: 3, reason: 'again' }],
  ] as const)('POST /api/v1/tasks/:id/%s body', async (action, command) => {
    mockCommandOk(200)
    await client().command(`key-${action}`, command as LocalTaskCommand)
    expect(urlOf(lastCall().input)).toBe(`/api/v1/tasks/ticket-1/${action}`)
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      expectedVersion: 3,
      reason: (command as { reason: string }).reason,
    })
    expect(new Headers(lastCall().init?.headers).get('Idempotency-Key')).toBe(`key-${action}`)
  })

  it('POST /api/v1/tasks/:id/review body', async () => {
    mockCommandOk(200)
    await client().command('key-review', {
      kind: 'review',
      ticketId: 'ticket-1',
      expectedVersion: 4,
      executionId: 'exec-1',
      artifactRevision: 'rev-1',
      approved: true,
      reason: 'pass',
    })
    expect(urlOf(lastCall().input)).toBe('/api/v1/tasks/ticket-1/review')
    expect(JSON.parse(String(lastCall().init?.body))).toEqual({
      expectedVersion: 4,
      executionId: 'exec-1',
      artifactRevision: 'rev-1',
      approved: true,
      reason: 'pass',
    })
  })

  it('does not automatically retry POST; explicit caller retry uses same key', async () => {
    installFetch()
    let attempts = 0
    fetchImpl = async () => {
      attempts += 1
      if (attempts === 1) return jsonResponse(409, { error: { code: 'VERSION_CONFLICT', message: 'server-secret' } })
      return jsonResponse(200, { ticket: TICKET_FIXTURE, replayed: true })
    }
    const api = client()
    const command: LocalTaskCommand = {
      kind: 'approve',
      ticketId: 'ticket-1',
      expectedVersion: 1,
      reason: 'ok',
    }
    await expect(api.command('same-key', command)).rejects.toMatchObject({
      code: 'VERSION_CONFLICT',
      status: 409,
      message: '版本冲突，请刷新后重试。',
    })
    await expect(api.command('same-key', command)).resolves.toEqual({ ticket: TICKET_FIXTURE, replayed: true })
    expect(fetchCalls).toHaveLength(2)
    expect(fetchCalls.every((call) => new Headers(call.init?.headers).get('Idempotency-Key') === 'same-key')).toBe(true)
  })

  it('rejects unsafe command key before fetch', async () => {
    installFetch()
    await expect(
      client().command('bad key', {
        kind: 'approve',
        ticketId: 'ticket-1',
        expectedVersion: 1,
        reason: 'x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(fetchCalls).toHaveLength(0)
  })
})

describe('ApiClient errors and safety', () => {
  it('maps 401 and 409 to static Chinese messages and never surfaces server body', async () => {
    installFetch()
    fetchImpl = async () => jsonResponse(401, {
      error: { code: 'UNAUTHORIZED', message: `leak-${TOKEN}-<script>alert(1)</script>` },
    })
    const unauthorized = await client().me().then(
      () => null,
      (error: unknown) => error,
    )
    expect(unauthorized).toBeInstanceOf(ApiError)
    expect(unauthorized).toMatchObject({ code: 'UNAUTHORIZED', status: 401 })
    expect((unauthorized as ApiError).message).toBe('未授权，请重新连接。')
    expect((unauthorized as ApiError).message).not.toContain(TOKEN)
    expect((unauthorized as ApiError).message).not.toContain('<script>')

    fetchImpl = async () => jsonResponse(409, {
      error: { code: 'IDEMPOTENCY_CONFLICT', message: 'raw-server-html' },
    })
    await expect(
      client().command('key-1', {
        kind: 'approve',
        ticketId: 'ticket-1',
        expectedVersion: 1,
        reason: 'x',
      }),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      status: 409,
      message: '幂等键冲突，请使用新的确认操作。',
    })
  })

  it('rejects malformed success and unknown error codes', async () => {
    installFetch()
    fetchImpl = async () => jsonResponse(200, { ownerId: 'o', workspaceId: 'w', role: 'admin' })
    await expect(client().me()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 0 })

    fetchImpl = async () => jsonResponse(200, { not: 'overview' })
    await expect(client().overview()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })

    fetchImpl = async () => jsonResponse(500, {
      error: { code: 'DROP_TABLE', message: 'should-not-leak' },
    })
    const error = await client().projects().then(
      () => null,
      (err: unknown) => err,
    )
    expect(error).toMatchObject({ code: 'INTERNAL_ERROR', status: 500 })
    expect((error as ApiError).message).toBe('服务暂时不可用。')
    expect((error as ApiError).message).not.toContain('should-not-leak')
  })

  it('does not start fetch when caller signal is already aborted', async () => {
    installFetch()
    const controller = new AbortController()
    controller.abort()
    await expect(client().me(controller.signal)).rejects.toMatchObject({ code: 'ABORTED', status: 0 })
    expect(fetchCalls).toHaveLength(0)
  })

  it('maps caller abort and 15s timeout, including mid-body', async () => {
    installFetch()

    let releaseFetch!: () => void
    const fetchStarted = new Promise<void>((resolve) => {
      releaseFetch = resolve
    })
    fetchImpl = async (_input, init) => {
      releaseFetch()
      const signal = init?.signal
      if (!signal) throw new Error('missing signal')
      await new Promise<void>((_resolve, reject) => {
        const fail = () => {
          const reason = signal.reason
          if (reason instanceof Error) reject(reason)
          else reject(new DOMException('Aborted', 'AbortError'))
        }
        if (signal.aborted) fail()
        else signal.addEventListener('abort', fail, { once: true })
      })
      return jsonResponse(200, {})
    }

    const controller = new AbortController()
    const pending = client().me(controller.signal)
    await fetchStarted
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED', status: 0 })

    let pullCount = 0
    let resolveFirstPull!: () => void
    const firstPull = new Promise<void>((resolve) => {
      resolveFirstPull = resolve
    })
    fetchImpl = async (_input, init) => {
      const signal = init?.signal
      const stream = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          pullCount += 1
          if (pullCount === 1) {
            ctrl.enqueue(new TextEncoder().encode('{"ownerId":"owner-1",'))
            resolveFirstPull()
            return
          }
          return new Promise<void>((_resolve, reject) => {
            const fail = () => reject(new DOMException('Aborted', 'AbortError'))
            if (signal?.aborted) fail()
            else signal?.addEventListener('abort', fail, { once: true })
          })
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }

    const midBody = new AbortController()
    const midPending = client().me(midBody.signal)
    await firstPull
    midBody.abort()
    await expect(midPending).rejects.toMatchObject({ code: 'ABORTED', status: 0 })

    vi.useFakeTimers()
    let timeoutPull = 0
    let resolveTimeoutPull!: () => void
    const timeoutFirstPull = new Promise<void>((resolve) => {
      resolveTimeoutPull = resolve
    })
    fetchImpl = async (_input, init) => {
      const signal = init?.signal
      const stream = new ReadableStream<Uint8Array>({
        pull(ctrl) {
          timeoutPull += 1
          if (timeoutPull === 1) {
            ctrl.enqueue(new TextEncoder().encode('{"tasks":'))
            resolveTimeoutPull()
            return
          }
          return new Promise<void>((_resolve, reject) => {
            const fail = () => reject(new DOMException('Aborted', 'AbortError'))
            if (signal?.aborted) fail()
            else signal?.addEventListener('abort', fail, { once: true })
          })
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const timeoutPending = client().overview()
    const timeoutExpectation = expect(timeoutPending).rejects.toMatchObject({ code: 'TIMEOUT', status: 0 })
    await vi.advanceTimersByTimeAsync(0)
    await timeoutFirstPull
    await vi.advanceTimersByTimeAsync(15_000)
    await timeoutExpectation
    vi.useRealTimers()
  })

  it('uses redirect:error and relative /api/v1 only', async () => {
    installFetch()
    fetchImpl = async () => jsonResponse(200, { items: [] })
    await client().tasks()
    expect(lastCall().init?.redirect).toBe('error')
    expect(urlOf(lastCall().input).startsWith('/api/v1/')).toBe(true)
    expect(urlOf(lastCall().input)).not.toMatch(/^https?:/i)
  })

  it('rejects content-length over 4MiB and chunked oversized bodies without content-length', async () => {
    installFetch()
    fetchImpl = async () => new Response('{}', {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'content-length': String(4 * 1024 * 1024 + 1),
      },
    })
    await expect(client().projects()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })

    const chunk = new Uint8Array(256 * 1024).fill(0x61)
    const chunks = Array.from({ length: 17 }, () => chunk)
    fetchImpl = async () => chunkedResponse(200, chunks)
    await expect(client().projects()).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 0 })
  })

  it('never echoes network error text that could contain secrets', async () => {
    installFetch()
    fetchImpl = async () => {
      throw new Error(`socket failed token=${TOKEN}`)
    }
    const error = await client().me().then(
      () => null,
      (err: unknown) => err,
    )
    expect(error).toMatchObject({ code: 'NETWORK', status: 0 })
    expect((error as ApiError).message).toBe('网络异常，请稍后重试。')
    expect((error as ApiError).message).not.toContain(TOKEN)
  })
})
