import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  VERIFICATION_SCHEMA_KEY,
  VERIFICATION_SCHEMA_VERSION,
  VerificationJobRepository,
  initializeVerificationSchema,
  requireVerificationSchema,
} from '../src/storage/verification-jobs.ts'
import {
  VERIFICATION_JOB_STATES,
  type VerificationJobEvent,
  type VerificationJobRequest,
} from '../src/verification/model.ts'

let directory: string
const databases: DatabaseSync[] = []

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'verification-jobs-'))
})

afterEach(() => {
  for (const database of databases.splice(0)) {
    try { database.close() } catch { /* ignore */ }
  }
  rmSync(directory, { recursive: true, force: true })
})

function open(path = join(directory, 'store.sqlite')): DatabaseSync {
  const database = new DatabaseSync(path)
  database.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;')
  databases.push(database)
  return database
}

function close(database: DatabaseSync): void {
  database.close()
  const index = databases.indexOf(database)
  if (index >= 0) databases.splice(index, 1)
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function request(overrides: Partial<VerificationJobRequest> = {}): VerificationJobRequest {
  return {
    verificationId: 'verify-1',
    workspaceId: 'workspace-1',
    ownerId: 'owner-1',
    ticketId: 'ticket-1',
    expectedTaskVersion: 1,
    policyVersion: 'policy-1',
    executionId: 'execution-1',
    artifactId: 'artifact-execution-1',
    artifactRevision: sha('artifact-revision-1'),
    plan: {
      id: 'plan-1',
      revision: 'plan-rev-1',
      checks: [{
        id: 'check-1',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 5_000,
      }],
    },
    reason: 'owner requested verification',
    createdAt: '2026-11-05T12:00:00.000Z',
    ...overrides,
  }
}

function event(
  sequence: number,
  status: VerificationJobEvent['status'],
  overrides: Partial<VerificationJobEvent> = {},
): VerificationJobEvent {
  return {
    verificationId: 'verify-1',
    sequence,
    runnerId: 'runner-1',
    runnerPid: 4242,
    status,
    at: new Date(Date.UTC(2026, 10, 5, 12, 0, sequence)).toISOString(),
    ...overrides,
  }
}

function completed(sequence: number, overrides: Partial<VerificationJobEvent> = {}): VerificationJobEvent {
  return event(sequence, 'COMPLETED', {
    processId: 5151,
    outcome: 'passed',
    reportSha256: sha('report-1'),
    terminalConfirmed: true,
    ...overrides,
  })
}

function repo(database = open()): VerificationJobRepository {
  initializeVerificationSchema(database)
  return new VerificationJobRepository(database)
}

describe('verification schema', () => {
  it('does not initialize from repository construction or reads', () => {
    const database = open()
    expect(() => new VerificationJobRepository(database)).toThrow(/not initialized/)
    expect(() => requireVerificationSchema(database)).toThrow(/not initialized/)
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'verification_job'").get()).toBeUndefined()
  })

  it('installs schema atomically, is idempotent, and indexes an explicit rowid column', () => {
    const database = open()
    database.exec('BEGIN')
    initializeVerificationSchema(database)
    expect(database.prepare('SELECT value FROM kv WHERE key = ?').get(VERIFICATION_SCHEMA_KEY)?.value)
      .toBe(JSON.stringify(VERIFICATION_SCHEMA_VERSION))
    database.exec('ROLLBACK')
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'verification_job'").get()).toBeUndefined()

    initializeVerificationSchema(database)
    initializeVerificationSchema(database)
    requireVerificationSchema(database)

    const indexSql = String(database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'verification_job_scope_rowid'",
    ).get()?.sql)
    expect(indexSql).toMatch(/workspace_id,\s*owner_id,\s*rowid/)
    const tableSql = String(database.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'verification_job'",
    ).get()?.sql)
    expect(tableSql).toMatch(/rowid INTEGER PRIMARY KEY AUTOINCREMENT/)
    expect(tableSql).not.toMatch(/WITHOUT ROWID/)
  })

  it('fails closed for future, unversioned, and corrupt schema metadata', () => {
    const future = open()
    future.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    future.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(VERIFICATION_SCHEMA_KEY, '2')
    expect(() => initializeVerificationSchema(future)).toThrow(/Unsupported verification schema version/)
    expect(() => requireVerificationSchema(future)).toThrow(/Unsupported verification schema version/)
    expect(future.prepare("SELECT name FROM sqlite_master WHERE name = 'verification_job'").get()).toBeUndefined()

    const unversioned = open(join(directory, 'unversioned.sqlite'))
    unversioned.exec(`CREATE TABLE verification_job (
      verification_id TEXT PRIMARY KEY, workspace_id TEXT, owner_id TEXT, ticket_id TEXT, status TEXT,
      version INTEGER, last_sequence INTEGER, created_at TEXT, updated_at TEXT, request_json TEXT, record_json TEXT
    )`)
    expect(() => initializeVerificationSchema(unversioned)).toThrow(/Unversioned verification schema/)
    expect(() => requireVerificationSchema(unversioned)).toThrow(/not initialized/)

    const corrupt = open(join(directory, 'corrupt.sqlite'))
    corrupt.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    corrupt.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(VERIFICATION_SCHEMA_KEY, '"not-a-number"')
    expect(() => requireVerificationSchema(corrupt)).toThrow(/Invalid verification schema metadata/)
  })
})

describe('VerificationJobRepository', () => {
  it('reserves QUEUED jobs, clones requests, and rejects mutated caller payloads after reserve', () => {
    const database = open()
    const repository = repo(database)
    const input = request()
    const reserved = repository.reserve(input)
    expect(reserved).toMatchObject({
      status: 'QUEUED',
      version: 1,
      lastSequence: 0,
      request: { verificationId: 'verify-1', ticketId: 'ticket-1' },
    })
    expect(reserved.runnerId).toBeUndefined()

    input.reason = 'mutated after reserve'
    input.plan.checks[0]!.args.push('--mutated')
    reserved.request.reason = 'mutated returned object'
    reserved.request.plan.checks[0]!.command = '/tmp/evil'

    const loaded = repository.get('verify-1')
    expect(loaded?.request.reason).toBe('owner requested verification')
    expect(loaded?.request.plan.checks[0]?.args).toEqual(['-e', 'process.exit(0)'])
    expect(loaded?.request.plan.checks[0]?.command).toBe(process.execPath)
    expect(loaded).toEqual(repository.get('verify-1'))
  })

  it('enforces verificationId uniqueness and active ticket occupancy including UNKNOWN', () => {
    const repository = repo()
    repository.reserve(request())
    expect(() => repository.reserve(request({ verificationId: 'verify-2' }))).toThrow(/active verification/)
    expect(() => repository.reserve(request({
      verificationId: 'verify-1',
      ticketId: 'ticket-2',
    }))).toThrow(/already reserved/)

    repository.beginLaunch('verify-1')
    repository.apply(event(1, 'STARTING', { processId: 100 }))
    repository.markUnknown('verify-1', 'runner_heartbeat_lost')
    expect(repository.get('verify-1')?.status).toBe('UNKNOWN')
    expect(() => repository.reserve(request({ verificationId: 'verify-3' }))).toThrow(/active verification/)

    repository.apply(event(2, 'FAILED', {
      processId: 100,
      terminalConfirmed: true,
      failureCode: 'check_failed',
    }))
    expect(repository.get('verify-1')?.status).toBe('FAILED')
    expect(repository.reserve(request({ verificationId: 'verify-4' })).status).toBe('QUEUED')
  })

  it('releases occupancy only after terminalConfirmed worker proof', () => {
    const repository = repo()
    repository.reserve(request())
    repository.beginLaunch('verify-1')
    repository.apply(event(1, 'RUNNING', { processId: 77 }))

    expect(() => repository.apply(event(2, 'COMPLETED', {
      processId: 77,
      outcome: 'passed',
      reportSha256: sha('report'),
    }))).toThrow(/confirmed evidence/)
    expect(() => repository.apply(event(2, 'FAILED', {
      processId: 77,
      terminalConfirmed: false,
      failureCode: 'boom',
    }))).toThrow(/confirmed evidence/)
    expect(repository.get('verify-1')?.status).toBe('RUNNING')
    expect(() => repository.reserve(request({ verificationId: 'verify-2' }))).toThrow(/active verification/)

    repository.apply(completed(2, { processId: 77, reportSha256: sha('report') }))
    expect(repository.get('verify-1')).toMatchObject({
      status: 'COMPLETED',
      outcome: 'passed',
      application: 'pending',
      reportSha256: sha('report'),
    })
    expect(repository.reserve(request({ verificationId: 'verify-2' })).request.verificationId).toBe('verify-2')
  })

  it('claims launch once, pins runner identity, and rejects gaps/conflicts/duplicates with drift', () => {
    const repository = repo()
    repository.reserve(request())
    const launched = repository.beginLaunch('verify-1')
    expect(launched).toMatchObject({ status: 'STARTING', version: 2 })
    expect(() => repository.beginLaunch('verify-1')).toThrow(/only claim QUEUED/)

    repository.apply(event(1, 'STARTING', { processId: 9 }))
    expect(() => repository.apply(event(3, 'RUNNING', { processId: 9 }))).toThrow(/not contiguous/)
    expect(() => repository.apply(event(2, 'RUNNING', {
      processId: 9,
      runnerId: 'runner-other',
    }))).toThrow(/different runner/)
    expect(() => repository.apply(event(2, 'RUNNING', {
      processId: 9,
      runnerPid: 9999,
    }))).toThrow(/runnerPid/)
    expect(() => repository.apply(event(2, 'RUNNING', { processId: 10 }))).toThrow(/processId/)

    const running = repository.apply(event(2, 'RUNNING', { processId: 9 }))
    expect(running).toMatchObject({ status: 'RUNNING', lastSequence: 2, version: 4, processId: 9 })
    expect(repository.apply(event(2, 'RUNNING', { processId: 9 }))).toEqual(repository.get('verify-1'))
    expect(() => repository.apply(event(2, 'RUNNING', {
      processId: 9,
      at: '2026-11-05T12:59:00.000Z',
    }))).toThrow(/Conflicting duplicate/)
  })

  it('recovers UNKNOWN only for the same authenticated runner and keeps occupancy meanwhile', () => {
    const repository = repo()
    repository.reserve(request())
    repository.beginLaunch('verify-1')
    repository.apply(event(1, 'RUNNING', { processId: 3 }))
    const unknown = repository.markUnknown('verify-1', 'io_uncertain')
    expect(unknown).toMatchObject({
      status: 'UNKNOWN',
      runnerId: 'runner-1',
      runnerPid: 4242,
      processId: 3,
      lastSequence: 1,
      failureCode: 'io_uncertain',
    })
    expect(repository.markUnknown('verify-1', 'io_uncertain')).toEqual(repository.get('verify-1'))
    expect(() => repository.reserve(request({ verificationId: 'verify-x' }))).toThrow(/active verification/)

    expect(() => repository.apply(event(2, 'RUNNING', {
      processId: 3,
      runnerId: 'runner-2',
    }))).toThrow(/same authenticated runner|different runner/)
    const recovered = repository.apply(event(2, 'RUNNING', { processId: 3 }))
    expect(recovered.status).toBe('RUNNING')
    expect(recovered.lastSequence).toBe(2)
  })

  it('recovers unpinned UNKNOWN after lost handshake only via first authentic STARTING', () => {
    const repository = repo()
    repository.reserve(request())
    repository.beginLaunch('verify-1')
    const lost = repository.markUnknown('verify-1', 'handshake_lost')
    expect(lost).toMatchObject({
      status: 'UNKNOWN',
      lastSequence: 0,
      failureCode: 'handshake_lost',
    })
    expect(lost.runnerId).toBeUndefined()
    expect(lost.runnerPid).toBeUndefined()

    expect(() => repository.apply(event(1, 'RUNNING', { processId: 44 }))).toThrow(/first STARTING/)
    expect(() => repository.apply(event(1, 'FAILED', {
      terminalConfirmed: true,
      failureCode: 'too_early',
    }))).toThrow(/first STARTING/)
    expect(() => repository.apply(event(2, 'STARTING', { processId: 44 }))).toThrow(/not contiguous/)

    const pinned = repository.apply(event(1, 'STARTING', { processId: 44 }))
    expect(pinned).toMatchObject({
      status: 'STARTING',
      lastSequence: 1,
      runnerId: 'runner-1',
      runnerPid: 4242,
      processId: 44,
    })
    expect(() => repository.reserve(request({ verificationId: 'verify-late' }))).toThrow(/active verification/)
  })

  it('handles cancel races: QUEUED terminal cancel, STOPPING intent, UNKNOWN retention, version checks', () => {
    const queued = repo()
    queued.reserve(request())
    const cancelled = queued.requestCancel('verify-1', {
      expectedVersion: 1,
      actorId: 'owner-1',
      reason: 'owner changed mind',
      at: '2026-11-05T12:01:00.000Z',
    })
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      failureCode: 'cancelled_before_launch',
      finishedAt: '2026-11-05T12:01:00.000Z',
    })
    expect(() => queued.requestCancel('verify-1', {
      expectedVersion: 2,
      actorId: 'owner-1',
      reason: 'again',
      at: '2026-11-05T12:02:00.000Z',
    })).toThrow(/cannot be cancelled/)

    const repository = repo(open(join(directory, 'cancel.sqlite')))
    repository.reserve(request())
    repository.beginLaunch('verify-1')
    repository.apply(event(1, 'RUNNING', { processId: 8 }))
    expect(() => repository.requestCancel('verify-1', {
      expectedVersion: 1,
      actorId: 'owner-1',
      reason: 'stale',
      at: '2026-11-05T12:03:00.000Z',
    })).toThrow(/version conflict/)
    expect(() => repository.requestCancel('verify-1', {
      expectedVersion: 3,
      actorId: 'intruder',
      reason: 'nope',
      at: '2026-11-05T12:03:00.000Z',
    })).toThrow(/ownerId/)

    const stopping = repository.requestCancel('verify-1', {
      expectedVersion: 3,
      actorId: 'owner-1',
      reason: 'stop please',
      at: '2026-11-05T12:03:00.000Z',
    })
    expect(stopping.status).toBe('STOPPING')
    expect(stopping.cancelRequested).toEqual({
      actorId: 'owner-1',
      reason: 'stop please',
      at: '2026-11-05T12:03:00.000Z',
    })

    repository.markUnknown('verify-1', 'stop_outcome_unknown')
    const unknownCancel = repository.requestCancel('verify-1', {
      expectedVersion: repository.get('verify-1')!.version,
      actorId: 'owner-1',
      reason: 'still stop',
      at: '2026-11-05T12:04:00.000Z',
    })
    expect(unknownCancel.status).toBe('UNKNOWN')
    expect(unknownCancel.cancelRequested?.reason).toBe('still stop')
    expect(() => repository.reserve(request({ verificationId: 'verify-9' }))).toThrow(/active verification/)

    const confirmed = repository.apply(event(2, 'CANCELLED', {
      processId: 8,
      terminalConfirmed: true,
      failureCode: 'cancelled_by_owner',
    }))
    expect(confirmed.status).toBe('CANCELLED')
    expect(() => repository.apply(event(3, 'RUNNING', { processId: 8 }))).toThrow(/immutable/)
  })

  it('keeps STOPPING cancel intent while ingesting late contiguous STARTING/RUNNING before terminal proof', () => {
    const repository = repo()
    repository.reserve(request())
    repository.beginLaunch('verify-1')
    const cancelAt = '2026-11-05T12:05:00.000Z'
    const stopping = repository.requestCancel('verify-1', {
      expectedVersion: 2,
      actorId: 'owner-1',
      reason: 'cancel before first event',
      at: cancelAt,
    })
    expect(stopping).toMatchObject({
      status: 'STOPPING',
      lastSequence: 0,
      cancelRequested: {
        actorId: 'owner-1',
        reason: 'cancel before first event',
        at: cancelAt,
      },
    })
    expect(stopping.runnerId).toBeUndefined()
    expect(() => repository.reserve(request({ verificationId: 'verify-race' }))).toThrow(/active verification/)

    const starting = repository.apply(event(1, 'STARTING', { processId: 88 }))
    expect(starting).toMatchObject({
      status: 'STOPPING',
      lastSequence: 1,
      runnerId: 'runner-1',
      runnerPid: 4242,
      processId: 88,
      cancelRequested: {
        actorId: 'owner-1',
        reason: 'cancel before first event',
        at: cancelAt,
      },
    })

    const running = repository.apply(event(2, 'RUNNING', { processId: 88 }))
    expect(running).toMatchObject({
      status: 'STOPPING',
      lastSequence: 2,
      processId: 88,
      cancelRequested: { at: cancelAt },
    })

    const stillStopping = repository.apply(event(3, 'STOPPING', { processId: 88 }))
    expect(stillStopping).toMatchObject({
      status: 'STOPPING',
      lastSequence: 3,
      cancelRequested: { at: cancelAt },
    })

    const cancelled = repository.apply(event(4, 'CANCELLED', {
      processId: 88,
      terminalConfirmed: true,
      failureCode: 'cancelled_by_owner',
    }))
    expect(cancelled).toMatchObject({
      status: 'CANCELLED',
      lastSequence: 4,
      finishedAt: event(4, 'CANCELLED').at,
      failureCode: 'cancelled_by_owner',
    })
    expect(repository.reserve(request({ verificationId: 'verify-after-cancel' })).status).toBe('QUEUED')
  })

  it('binds application outcomes to completed digest and rejects flips', () => {
    const repository = repo()
    repository.reserve(request())
    repository.beginLaunch('verify-1')
    repository.apply(event(1, 'RUNNING', { processId: 1 }))
    const doneEvent = completed(2, { processId: 1 })
    const done = repository.apply(doneEvent)
    expect(done.application).toBe('pending')

    expect(() => repository.recordApplication('verify-1', {
      expectedVersion: done.version,
      application: 'applied',
      reportSha256: sha('other'),
      at: '2026-11-05T13:00:00.000Z',
    })).toThrow(/digest mismatch/)

    const applicationInput = {
      expectedVersion: done.version,
      application: 'applied' as const,
      reportSha256: sha('report-1'),
      at: '2026-11-05T13:00:00.000Z',
    }
    const applied = repository.recordApplication('verify-1', applicationInput)
    expect(applied.application).toBe('applied')
    const auditsAfterApply = repository.history('verify-1').length

    // Exact original call (pre-bump expectedVersion + identical at) is idempotent.
    expect(repository.recordApplication('verify-1', applicationInput)).toEqual(repository.get('verify-1'))
    expect(() => repository.recordApplication('verify-1', {
      expectedVersion: applied.version,
      application: 'applied',
      reportSha256: sha('report-1'),
      at: '2026-11-05T13:00:00.000Z',
    })).toThrow(/version conflict/)
    expect(repository.history('verify-1')).toHaveLength(auditsAfterApply)

    // Exact terminal event replay after application must not bump version/audit.
    expect(repository.apply(doneEvent)).toEqual(repository.get('verify-1'))
    expect(repository.history('verify-1')).toHaveLength(auditsAfterApply)
    expect(() => repository.apply(completed(2, {
      processId: 1,
      at: '2026-11-05T13:59:00.000Z',
    }))).toThrow(/Conflicting duplicate/)

    expect(() => repository.recordApplication('verify-1', {
      expectedVersion: applied.version,
      application: 'superseded',
      reportSha256: sha('report-1'),
      at: '2026-11-05T13:01:00.000Z',
    })).toThrow(/cannot be flipped/)
    expect(() => repository.recordApplication('verify-1', {
      expectedVersion: done.version,
      application: 'applied',
      reportSha256: sha('report-1'),
      at: '2026-11-05T13:01:00.000Z',
    })).toThrow(/version conflict/)
  })

  it('scopes list pagination to owner/workspace and hides foreign newer rows', () => {
    const repository = repo()
    for (let index = 1; index <= 3; index += 1) {
      repository.reserve(request({
        verificationId: `mine-${index}`,
        ticketId: `ticket-mine-${index}`,
        createdAt: `2026-11-05T12:00:0${index}.000Z`,
      }))
      repository.requestCancel(`mine-${index}`, {
        expectedVersion: 1,
        actorId: 'owner-1',
        reason: 'done',
        at: `2026-11-05T12:10:0${index}.000Z`,
      })
    }
    repository.reserve(request({
      verificationId: 'foreign-1',
      workspaceId: 'workspace-2',
      ownerId: 'owner-2',
      ticketId: 'ticket-foreign',
      createdAt: '2026-11-05T12:00:09.000Z',
    }))

    const first = repository.list({ ownerId: 'owner-1', workspaceId: 'workspace-1', limit: 2 })
    expect(first.items.map(item => item.request.verificationId)).toEqual(['mine-3', 'mine-2'])
    expect(first.nextCursor).toEqual(expect.any(Number))
    const second = repository.list({
      ownerId: 'owner-1',
      workspaceId: 'workspace-1',
      limit: 2,
      beforeRowid: first.nextCursor,
    })
    expect(second.items.map(item => item.request.verificationId)).toEqual(['mine-1'])
    expect(second.items.every(item => item.request.ownerId === 'owner-1')).toBe(true)
    expect(repository.list({ ownerId: 'owner-1', workspaceId: 'workspace-1' }).items)
      .toHaveLength(3)

    expect(() => repository.list({
      ownerId: 'owner-1',
      workspaceId: 'workspace-1',
      unknownOption: true,
    } as Parameters<VerificationJobRepository['list']>[0])).toThrow(/Invalid verification list query/)
    expect(() => repository.list({
      ownerId: 'owner-1',
      workspaceId: 'workspace-1',
      statuses: ['CANCELLED', 'CANCELLED'],
    })).toThrow(/Duplicate statuses/)
  })

  it('rejects secret/forbidden request fields with static messages and strict DTO shapes', () => {
    const repository = repo()
    const secret = {
      ...request(),
      env: { TOKEN: 'super-secret-value' },
    }
    expect(() => repository.reserve(secret as VerificationJobRequest)).toThrow(/forbidden field/)
    try {
      repository.reserve(secret as VerificationJobRequest)
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-value')
      expect(String(error)).not.toContain('TOKEN')
    }

    expect(() => repository.reserve(request({
      artifactRevision: 'not-a-sha',
    }))).toThrow(/Invalid verification request/)
    expect(() => repository.reserve(request({
      plan: {
        id: 'plan-1',
        revision: 'plan-rev-1',
        checks: [{
          id: 'check-1',
          command: 'relative-bin',
          args: [],
          timeoutMs: 1_000,
        }],
      },
    }))).toThrow(/Invalid verification request/)
    expect(() => repository.apply({
      ...event(1, 'RUNNING'),
      password: 'leak',
    } as VerificationJobEvent)).toThrow(/forbidden field|Invalid verification event/)
  })

  it('rolls back audit and events when apply fails inside a savepoint', () => {
    const database = open()
    const repository = repo(database)
    repository.reserve(request())
    repository.beginLaunch('verify-1')
    repository.apply(event(1, 'STARTING', { processId: 5 }))

    const auditsBefore = repository.history('verify-1').length
    const eventsBefore = Number(database.prepare(
      'SELECT count(*) AS n FROM verification_job_event WHERE verification_id = ?',
    ).get('verify-1')?.n)

    expect(() => repository.apply(event(2, 'COMPLETED', {
      processId: 5,
      outcome: 'passed',
      reportSha256: sha('x'),
      // missing terminalConfirmed
    }))).toThrow(/confirmed evidence/)

    expect(repository.history('verify-1')).toHaveLength(auditsBefore)
    expect(Number(database.prepare(
      'SELECT count(*) AS n FROM verification_job_event WHERE verification_id = ?',
    ).get('verify-1')?.n)).toBe(eventsBefore)
    expect(repository.get('verify-1')?.status).toBe('STARTING')
  })

  it('reopens durable state and keeps receipts scoped to owner/workspace', () => {
    const path = join(directory, 'durable.sqlite')
    const first = open(path)
    const repository = repo(first)
    repository.reserve(request())
    repository.beginLaunch('verify-1')
    repository.apply(event(1, 'RUNNING', { processId: 11 }))
    repository.apply(completed(2, { processId: 11 }))
    const receipt = repository.insertReceipt({
      workspaceId: 'workspace-1',
      ownerId: 'owner-1',
      key: 'enqueue:verify-1',
      commandHash: sha('command'),
      verificationId: 'verify-1',
      resultJson: JSON.stringify({ verificationId: 'verify-1', status: 'COMPLETED' }),
      at: '2026-11-05T14:00:00.000Z',
    })
    expect(repository.insertReceipt({
      workspaceId: 'workspace-1',
      ownerId: 'owner-1',
      key: 'enqueue:verify-1',
      commandHash: sha('command'),
      verificationId: 'verify-1',
      resultJson: JSON.stringify({ verificationId: 'verify-1', status: 'COMPLETED' }),
      at: '2026-11-05T14:00:00.000Z',
    })).toEqual(receipt)
    expect(() => repository.insertReceipt({
      workspaceId: 'workspace-1',
      ownerId: 'owner-1',
      key: 'enqueue:verify-1',
      commandHash: sha('other-command'),
      verificationId: 'verify-1',
      resultJson: JSON.stringify({ verificationId: 'verify-1', status: 'COMPLETED' }),
      at: '2026-11-05T14:00:00.000Z',
    })).toThrow(/Conflicting verification receipt/)
    expect(() => repository.insertReceipt({
      workspaceId: 'workspace-2',
      ownerId: 'owner-1',
      key: 'enqueue:foreign',
      commandHash: sha('command'),
      verificationId: 'verify-1',
      resultJson: JSON.stringify({ ok: true }),
      at: '2026-11-05T14:00:00.000Z',
    })).toThrow(/scope does not match/)
    close(first)

    const reopened = open(path)
    const recovered = new VerificationJobRepository(reopened)
    expect(recovered.get('verify-1')).toMatchObject({
      status: 'COMPLETED',
      runnerId: 'runner-1',
      processId: 11,
      lastSequence: 2,
      reportSha256: sha('report-1'),
      application: 'pending',
    })
    expect(recovered.getReceipt({
      workspaceId: 'workspace-1',
      ownerId: 'owner-1',
      key: 'enqueue:verify-1',
    })).toEqual(receipt)
    expect(recovered.getReceipt({
      workspaceId: 'workspace-2',
      ownerId: 'owner-1',
      key: 'enqueue:verify-1',
    })).toBeUndefined()
    expect(recovered.history('verify-1').map(entry => entry.action)).toEqual([
      'reserved',
      'launch_claimed',
      'event_applied',
      'event_applied',
      'receipt_inserted',
    ])
  })

  it('detects mirrored identity drift between scalar columns and JSON record', () => {
    const database = open()
    const repository = repo(database)
    repository.reserve(request())
    database.prepare('UPDATE verification_job SET owner_id = ? WHERE verification_id = ?')
      .run('owner-drift', 'verify-1')
    expect(() => repository.get('verify-1')).toThrow(/inconsistent/)
  })

  it('exports the contracted job state vocabulary', () => {
    expect([...VERIFICATION_JOB_STATES]).toEqual([
      'QUEUED',
      'STARTING',
      'RUNNING',
      'STOPPING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
      'UNKNOWN',
    ])
  })
  it('distinguishes infrastructure failure and pins trusted plan revisions to immutable content', () => {
    const repository = repo()
    repository.reserve(request())
    repository.beginLaunch('verify-1')
    repository.apply(event(1, 'STARTING'))
    expect(() => repository.apply(event(2, 'FAILED', { terminalConfirmed: true }))).toThrow(/failure code/)
    expect(() => repository.apply(event(2, 'FAILED', { terminalConfirmed: true, outcome: 'failed', failureCode: 'PREFLIGHT_FAILED' }))).toThrow(/outcome/)
    repository.apply(event(2, 'FAILED', { terminalConfirmed: true, failureCode: 'PREFLIGHT_FAILED' }))
    const changed = request({ verificationId: 'verify-2' })
    changed.plan.checks[0]!.args = ['-e','process.exit(7)']
    expect(() => repository.reserve(changed)).toThrow(/plan revision/)
    expect(repository.get('verify-2')).toBeUndefined()
    changed.plan.revision = 'plan-rev-2'
    expect(repository.reserve(changed).status).toBe('QUEUED')
  })

})
