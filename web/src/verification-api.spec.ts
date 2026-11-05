import { describe, expect, it, vi } from 'vitest'
import { ApiError } from './api.ts'
import {
  applicationLabel,
  createVerificationApi,
  decodeVerificationCommandResult,
  decodeVerificationDetail,
  decodeVerificationJob,
  decodeVerificationJobList,
  decodeVerificationPlanList,
  type AuthenticatedJsonRequest,
  type VerificationJobView,
  type VerificationPlanMeta,
  type VerificationRequestClient,
} from './verification-api.ts'

const ARTIFACT_REV = 'a'.repeat(64)
const REPORT_SHA = 'b'.repeat(64)

function planMeta(overrides: Partial<VerificationPlanMeta> = {}): VerificationPlanMeta {
  return {
    id: 'plan-default',
    revision: 'rev-1',
    checks: [{ id: 'check-1', timeoutMs: 30_000 }],
    ...overrides,
  }
}

function jobFixture(overrides: Partial<VerificationJobView> = {}): VerificationJobView {
  return {
    request: {
      verificationId: 'ver-1',
      workspaceId: 'local',
      ownerId: 'owner-1',
      ticketId: 'task-1',
      expectedTaskVersion: 4,
      policyVersion: 'policy-1',
      executionId: 'exec-1',
      artifactId: 'artifact-exec-1',
      artifactRevision: ARTIFACT_REV,
      plan: planMeta(),
      reason: 'verify login',
      createdAt: '2026-11-05T01:00:00.000Z',
    },
    status: 'QUEUED',
    version: 1,
    lastSequence: 0,
    createdAt: '2026-11-05T01:00:00.000Z',
    updatedAt: '2026-11-05T01:00:00.000Z',
    ...overrides,
  }
}

function completedJob(overrides: Partial<VerificationJobView> = {}): VerificationJobView {
  return jobFixture({
    status: 'COMPLETED',
    outcome: 'passed',
    reportSha256: REPORT_SHA,
    application: 'applied',
    finishedAt: '2026-11-05T02:00:00.000Z',
    ...overrides,
  })
}

function mockClient(handler?: AuthenticatedJsonRequest): VerificationRequestClient {
  const request = vi.fn(async <T>(
    path: string,
    init: {
      method: 'GET' | 'POST'
      body?: unknown
      idempotencyKey?: string
      signal?: AbortSignal
      parse: (value: unknown) => T
      okStatuses: ReadonlySet<number>
    },
  ): Promise<T> => {
    if (handler) return handler(path, init)
    throw new Error(`unexpected request ${init.method} ${path}`)
  }) as AuthenticatedJsonRequest
  return { request }
}

describe('createVerificationApi transport contract', () => {
  it('calls actual verification paths with idempotency and decodes backend 202 {verificationId,replayed}', async () => {
    const calls: Array<{ path: string; init: Record<string, unknown> }> = []
    const job = jobFixture()
    const client = mockClient(async (path, init) => {
      calls.push({ path, init: init as unknown as Record<string, unknown> })
      if (path === '/api/v1/verification-plans') {
        return init.parse({ items: [planMeta({ id: 'plan.with.dots', revision: 'rev.1.0' })] })
      }
      if (path === '/api/v1/tasks/task-1/verifications' && init.method === 'POST') {
        expect(init.okStatuses.has(202)).toBe(true)
        expect(init.idempotencyKey).toBe('create-key-1')
        expect(init.body).toEqual({
          expectedVersion: 4,
          executionId: 'exec-1',
          artifactRevision: ARTIFACT_REV,
          planId: 'plan.with.dots',
          planRevision: 'rev.1.0',
          reason: 'verify login',
        })
        // Actual backend 202 DTO fixture — compact receipt only.
        return init.parse({ verificationId: 'ver-1', replayed: false })
      }
      if (path === '/api/v1/tasks/task-1/verifications?limit=20') {
        return init.parse({ items: [job], nextCursor: 9 })
      }
      if (path === '/api/v1/verifications/ver-1') {
        return init.parse({
          job: jobFixture({ status: 'RUNNING', runnerId: 'runner-1', runnerPid: 42 }),
          history: [{ id: 'h1', verificationId: 'ver-1', action: 'launch', at: '2026-11-05T01:01:00.000Z' }],
        })
      }
      if (path === '/api/v1/verifications/ver-1/cancel') {
        expect(init.okStatuses.has(202)).toBe(true)
        expect(init.idempotencyKey).toBe('cancel-key-1')
        expect(init.body).toEqual({ expectedVersion: 2, reason: 'stop checks' })
        return init.parse({ verificationId: 'ver-1', replayed: true })
      }
      throw new Error(`unexpected ${init.method} ${path}`)
    })

    const api = createVerificationApi(client)
    expect(await api.plans()).toEqual({
      items: [planMeta({ id: 'plan.with.dots', revision: 'rev.1.0' })],
    })
    expect(await api.create('task-1', 'create-key-1', {
      expectedVersion: 4,
      executionId: 'exec-1',
      artifactRevision: ARTIFACT_REV,
      planId: 'plan.with.dots',
      planRevision: 'rev.1.0',
      reason: 'verify login',
    })).toEqual({ verificationId: 'ver-1', replayed: false })
    expect(await api.list('task-1', { limit: 20 })).toEqual({ items: [job], nextCursor: 9 })
    expect(await api.get('ver-1')).toMatchObject({ job: { status: 'RUNNING' }, history: [{ id: 'h1' }] })
    expect(await api.cancel('ver-1', 'cancel-key-1', { expectedVersion: 2, reason: 'stop checks' })).toEqual({
      verificationId: 'ver-1',
      replayed: true,
    })
    expect(calls.map(call => call.path)).toEqual([
      '/api/v1/verification-plans',
      '/api/v1/tasks/task-1/verifications',
      '/api/v1/tasks/task-1/verifications?limit=20',
      '/api/v1/verifications/ver-1',
      '/api/v1/verifications/ver-1/cancel',
    ])
  })

  it('rejects unsafe ids and bodies before transport', async () => {
    const request = vi.fn()
    const api = createVerificationApi({ request })
    await expect(api.list('../private')).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(api.create('task-1', 'key', {
      expectedVersion: 0,
      executionId: 'exec-1',
      artifactRevision: ARTIFACT_REV,
      planId: 'plan-default',
      planRevision: 'rev-1',
      reason: 'x',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(api.create('task-1', 'key', {
      expectedVersion: 1,
      executionId: 'exec-1',
      artifactRevision: 'not-a-sha',
      planId: 'plan-default',
      planRevision: 'rev-1',
      reason: 'x',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    await expect(api.create('task-1', 'key', {
      expectedVersion: 1,
      executionId: 'exec.with.dots',
      artifactRevision: ARTIFACT_REV,
      planId: 'plan-default',
      planRevision: 'rev-1',
      reason: 'x',
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(request).not.toHaveBeenCalled()
  })

  it('requires an authenticated request transport from the shared client', () => {
    expect(() => createVerificationApi({ request: undefined as unknown as AuthenticatedJsonRequest })).toThrow(ApiError)
  })
})

describe('verification DTO decoders', () => {
  it('accepts actual backend 202 receipt and rejects invented {job,replayed} shape', () => {
    expect(decodeVerificationCommandResult({ verificationId: 'ver-1', replayed: false })).toEqual({
      verificationId: 'ver-1',
      replayed: false,
    })
    expect(decodeVerificationCommandResult({ verificationId: 'ver-1', replayed: true })).toEqual({
      verificationId: 'ver-1',
      replayed: true,
    })
    expect(() => decodeVerificationCommandResult({ job: jobFixture(), replayed: false })).toThrow(ApiError)
    expect(() => decodeVerificationCommandResult({ verificationId: 'ver-1', replayed: false, job: jobFixture() })).toThrow(ApiError)
    expect(() => decodeVerificationCommandResult({ verificationId: 'ver-1' })).toThrow(ApiError)
    expect(() => decodeVerificationCommandResult({ replayed: false })).toThrow(ApiError)
  })

  it('accepts dotted plan metadata and rejects dotted ticket/verification ids', () => {
    const dotted = decodeVerificationPlanList({
      items: [planMeta({ id: 'plan.core.v1', revision: '1.2.3', checks: [{ id: 'lint.style', timeoutMs: 1000 }] })],
    })
    expect(dotted.items[0]?.id).toBe('plan.core.v1')
    expect(dotted.items[0]?.checks[0]?.id).toBe('lint.style')

    expect(() => decodeVerificationJob(jobFixture({
      request: { ...jobFixture().request, verificationId: 'ver.with.dots' },
    }))).toThrow(ApiError)
    expect(() => decodeVerificationJob(jobFixture({
      request: { ...jobFixture().request, ticketId: 'task.with.dots' },
    }))).toThrow(ApiError)
  })

  it('enforces exact keys, plan bounds, and rejects unknown command/secret fields', () => {
    expect(decodeVerificationPlanList({ items: [planMeta()] }).items).toHaveLength(1)
    expect(() => decodeVerificationPlanList({ items: [{ id: 'plan', revision: 'r', checks: [] }] })).toThrow(ApiError)
    expect(() => decodeVerificationPlanList({ items: 'nope' })).toThrow(ApiError)
    expect(() => decodeVerificationPlanList({
      items: [planMeta()],
      extra: true,
    })).toThrow(ApiError)
    expect(() => decodeVerificationPlanList({
      items: [{
        id: 'plan',
        revision: 'r',
        checks: [{ id: 'c1', timeoutMs: 1, command: '/bin/true' }],
      }],
    })).toThrow(ApiError)
    expect(() => decodeVerificationPlanList({
      items: [{
        id: 'plan',
        revision: 'r',
        checks: [{ id: 'c1', timeoutMs: 1 }],
        secret: 'leak',
      }],
    })).toThrow(ApiError)
    expect(() => decodeVerificationPlanList({
      items: [{
        id: 'plan',
        revision: 'r',
        checks: [
          { id: 'dup', timeoutMs: 1 },
          { id: 'dup', timeoutMs: 2 },
        ],
      }],
    })).toThrow(ApiError)
    expect(() => decodeVerificationPlanList({
      items: [{
        id: 'plan',
        revision: 'r',
        checks: [{ id: 'c1', timeoutMs: 3_600_001 }],
      }],
    })).toThrow(ApiError)
    expect(() => decodeVerificationPlanList({
      items: Array.from({ length: 65 }, (_, index) => planMeta({ id: `plan-${index}` })),
    })).toThrow(ApiError)

    const job = decodeVerificationJob(completedJob())
    expect(applicationLabel(job)).toBe('applied')
    expect(applicationLabel(completedJob({ application: 'superseded' }))).toBe('superseded')
    expect(applicationLabel(jobFixture())).toBe('unknown')

    expect(() => decodeVerificationJob({ ...jobFixture(), status: 'DONE' })).toThrow(ApiError)
    expect(() => decodeVerificationJob({
      ...jobFixture(),
      request: { ...jobFixture().request, artifactRevision: 'short' },
    })).toThrow(ApiError)
    expect(() => decodeVerificationJob({
      ...jobFixture(),
      args: ['--secret'],
    })).toThrow(ApiError)
    expect(() => decodeVerificationJobList({ items: [jobFixture()], nextCursor: 0 })).toThrow(ApiError)
    expect(() => decodeVerificationDetail({ job: jobFixture(), history: 'bad' })).toThrow(ApiError)
  })

  it('validates canonical ISO dates, positive PIDs, and meaningful state cross-fields', () => {
    expect(() => decodeVerificationJob(jobFixture({
      createdAt: '2026-11-05T01:00:00Z',
    }))).toThrow(ApiError)
    expect(() => decodeVerificationJob(jobFixture({
      runnerPid: 0,
    }))).toThrow(ApiError)
    expect(() => decodeVerificationJob(jobFixture({
      processId: -1,
    }))).toThrow(ApiError)
    expect(() => decodeVerificationJob(jobFixture({
      request: { ...jobFixture().request, ownerId: 'bad owner' },
    }))).toThrow(ApiError)
    expect(() => decodeVerificationJob(jobFixture({
      request: { ...jobFixture().request, workspaceId: '../x' },
    }))).toThrow(ApiError)

    expect(() => decodeVerificationJob(jobFixture({
      status: 'COMPLETED',
      outcome: 'passed',
      reportSha256: REPORT_SHA,
      // missing application + finishedAt
    }))).toThrow(ApiError)
    expect(() => decodeVerificationJob(completedJob({ failureCode: 'X' }))).toThrow(ApiError)

    expect(() => decodeVerificationJob(jobFixture({
      status: 'FAILED',
      failureCode: 'RUNNER_CRASH',
      finishedAt: '2026-11-05T02:00:00.000Z',
      outcome: 'failed',
    }))).toThrow(ApiError)
    expect(() => decodeVerificationJob(jobFixture({
      status: 'FAILED',
      finishedAt: '2026-11-05T02:00:00.000Z',
    }))).toThrow(ApiError)
    expect(decodeVerificationJob(jobFixture({
      status: 'FAILED',
      failureCode: 'RUNNER_CRASH',
      finishedAt: '2026-11-05T02:00:00.000Z',
    })).failureCode).toBe('RUNNER_CRASH')

    expect(() => decodeVerificationJob(jobFixture({
      status: 'RUNNING',
      outcome: 'passed',
    }))).toThrow(ApiError)
    expect(() => decodeVerificationJob(jobFixture({
      status: 'QUEUED',
      finishedAt: '2026-11-05T02:00:00.000Z',
    }))).toThrow(ApiError)

    expect(decodeVerificationJob(jobFixture({
      status: 'CANCELLED',
      finishedAt: '2026-11-05T02:00:00.000Z',
      failureCode: 'CANCELLED',
    })).status).toBe('CANCELLED')
    expect(() => decodeVerificationJob(jobFixture({
      status: 'CANCELLED',
      finishedAt: '2026-11-05T02:00:00.000Z',
      outcome: 'failed',
    }))).toThrow(ApiError)

    expect(() => decodeVerificationDetail({
      job: jobFixture(),
      history: [{ id: 'h1', verificationId: 'ver-1', action: 'launch', at: 'not-iso' }],
    })).toThrow(ApiError)
    expect(decodeVerificationDetail({
      job: completedJob(),
      history: [{
        id: 'h1',
        verificationId: 'ver-1',
        action: 'complete',
        from: 'RUNNING',
        to: 'COMPLETED',
        at: '2026-11-05T02:00:00.000Z',
        actorId: 'owner-1',
        sequence: 3,
      }],
    }).history).toHaveLength(1)
  })
})
