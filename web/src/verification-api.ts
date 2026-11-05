/**
 * Browser verification HTTP client.
 *
 * Parent handoff: keep `request` private inside `createApiClient`. Compose with
 * optional `verification?: VerificationApi` and
 * `client.verification = createVerificationApi({ request })` closing over the
 * existing authenticated transport. Do not export `request` publicly, mint a
 * second token, or ship fake production fixtures from this module.
 */
import { ApiError } from './api.ts'

const API_PREFIX = '/api/v1'
/** Ticket / verification / execution / artifact / idempotency — no dots. */
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
/** Plan / check / revision metadata — matches shared parser (dots allowed). */
const PLAN_META_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ARTIFACT_REVISION = /^[a-f0-9]{64}$/
const MAX_REASON = 4096
const MAX_LIST_LIMIT = 200
const MAX_PLAN_REGISTRY = 64
const MAX_PLAN_CHECKS = 32
const MAX_CHECK_TIMEOUT_MS = 3_600_000
const MAX_HISTORY = 100

export const VERIFICATION_JOB_STATES = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'UNKNOWN',
] as const

export type VerificationJobState = (typeof VERIFICATION_JOB_STATES)[number]

export const ACTIVE_VERIFICATION_STATES = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'UNKNOWN',
] as const satisfies readonly VerificationJobState[]

const JOB_STATE_SET = new Set<string>(VERIFICATION_JOB_STATES)
const ACTIVE_STATE_SET = new Set<string>(ACTIVE_VERIFICATION_STATES)
const OUTCOME_SET = new Set(['passed', 'failed'])
const APPLICATION_SET = new Set(['pending', 'applied', 'superseded'])

const PLAN_CHECK_KEYS = ['id', 'timeoutMs'] as const
const PLAN_META_KEYS = ['id', 'revision', 'checks'] as const
const PLAN_LIST_KEYS = ['items'] as const
const CANCEL_REQUESTED_KEYS = ['actorId', 'reason', 'at'] as const
const JOB_REQUEST_KEYS = [
  'verificationId',
  'workspaceId',
  'ownerId',
  'ticketId',
  'expectedTaskVersion',
  'policyVersion',
  'executionId',
  'artifactId',
  'artifactRevision',
  'plan',
  'reason',
  'createdAt',
] as const
const JOB_REQUIRED_KEYS = [
  'request',
  'status',
  'version',
  'lastSequence',
  'createdAt',
  'updatedAt',
] as const
const JOB_OPTIONAL_KEYS = [
  'runnerId',
  'runnerPid',
  'processId',
  'outcome',
  'reportSha256',
  'application',
  'cancelRequested',
  'finishedAt',
  'failureCode',
] as const
const JOB_LIST_REQUIRED_KEYS = ['items'] as const
const JOB_LIST_OPTIONAL_KEYS = ['nextCursor'] as const
const HISTORY_REQUIRED_KEYS = ['id', 'verificationId', 'action', 'at'] as const
const HISTORY_OPTIONAL_KEYS = ['from', 'to', 'actorId', 'reasonCode', 'sequence'] as const
const DETAIL_KEYS = ['job', 'history'] as const
const COMMAND_RESULT_KEYS = ['verificationId', 'replayed'] as const

export interface VerificationPlanCheckMeta {
  id: string
  timeoutMs: number
}

export interface VerificationPlanMeta {
  id: string
  revision: string
  checks: VerificationPlanCheckMeta[]
}

export interface VerificationPlanList {
  items: VerificationPlanMeta[]
}

export interface VerificationJobRequestView {
  verificationId: string
  workspaceId: string
  ownerId: string
  ticketId: string
  expectedTaskVersion: number
  policyVersion: string
  executionId: string
  artifactId: string
  artifactRevision: string
  plan: VerificationPlanMeta
  reason: string
  createdAt: string
}

export interface VerificationCancelRequestedView {
  actorId: string
  reason: string
  at: string
}

export interface VerificationJobView {
  request: VerificationJobRequestView
  status: VerificationJobState
  version: number
  lastSequence: number
  createdAt: string
  updatedAt: string
  runnerId?: string
  runnerPid?: number
  processId?: number
  outcome?: 'passed' | 'failed'
  reportSha256?: string
  application?: 'pending' | 'applied' | 'superseded'
  cancelRequested?: VerificationCancelRequestedView
  finishedAt?: string
  failureCode?: string
}

export interface VerificationJobList {
  items: VerificationJobView[]
  nextCursor?: number
}

export interface VerificationHistoryEntry {
  id: string
  verificationId: string
  action: string
  from?: string
  to?: string
  at: string
  actorId?: string
  reasonCode?: string
  sequence?: number
}

export interface VerificationDetail {
  job: VerificationJobView
  history: VerificationHistoryEntry[]
}

/** Actual backend POST create/cancel 202 body — compact ID receipt, not a job projection. */
export interface VerificationCommandResult {
  verificationId: string
  replayed: boolean
}

export interface CreateVerificationBody {
  expectedVersion: number
  executionId: string
  artifactRevision: string
  planId: string
  planRevision: string
  reason: string
}

export interface CancelVerificationBody {
  expectedVersion: number
  reason: string
}

export interface VerificationListOptions {
  limit?: number
  beforeRowid?: number
}

/** Same shape as the private request helper inside createApiClient. */
export type AuthenticatedJsonRequest = <T>(
  path: string,
  init: {
    method: 'GET' | 'POST'
    body?: unknown
    idempotencyKey?: string
    signal?: AbortSignal
    parse: (value: unknown) => T
    okStatuses: ReadonlySet<number>
  },
) => Promise<T>

export interface VerificationRequestClient {
  request: AuthenticatedJsonRequest
}

export interface VerificationApi {
  plans(signal?: AbortSignal): Promise<VerificationPlanList>
  list(ticketId: string, options?: VerificationListOptions, signal?: AbortSignal): Promise<VerificationJobList>
  get(verificationId: string, signal?: AbortSignal): Promise<VerificationDetail>
  create(ticketId: string, key: string, body: CreateVerificationBody, signal?: AbortSignal): Promise<VerificationCommandResult>
  cancel(verificationId: string, key: string, body: CancelVerificationBody, signal?: AbortSignal): Promise<VerificationCommandResult>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function failInvalidResponse(): never {
  throw new ApiError('INVALID_RESPONSE', 0)
}

function assertExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set<string>([...required, ...optional])
  const keys = Object.keys(record)
  if (keys.length > allowed.size) failInvalidResponse()
  for (const key of keys) {
    if (!allowed.has(key)) failInvalidResponse()
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) failInvalidResponse()
  }
}

function requireStringField(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') failInvalidResponse()
  return value
}

function requireNumberField(record: Record<string, unknown>, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) failInvalidResponse()
  return value
}

function requireCanonicalIso(value: unknown): string {
  if (typeof value !== 'string' || !value) failInvalidResponse()
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) failInvalidResponse()
  return value
}

function requireSafeIdValue(value: unknown): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) failInvalidResponse()
  return value
}

function requirePlanMetaIdValue(value: unknown): string {
  if (typeof value !== 'string' || !PLAN_META_ID.test(value) || value === '.' || value === '..') {
    failInvalidResponse()
  }
  return value
}

function requireSafeId(value: unknown, _label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    throw new ApiError('INVALID_REQUEST', 400)
  }
  return value
}

function requirePlanMetaId(value: unknown, _label: string): string {
  if (typeof value !== 'string' || !PLAN_META_ID.test(value) || value === '.' || value === '..') {
    throw new ApiError('INVALID_REQUEST', 400)
  }
  return value
}

function requireSafeKey(value: string): string {
  return requireSafeId(value, 'idempotencyKey')
}

function requirePositiveInt(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ApiError('INVALID_REQUEST', 400)
  }
  void label
  return value
}

function requireReason(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > MAX_REASON) {
    throw new ApiError('INVALID_REQUEST', 400)
  }
  return value
}

function requireArtifactRevision(value: unknown): string {
  if (typeof value !== 'string' || !ARTIFACT_REVISION.test(value)) {
    throw new ApiError('INVALID_REQUEST', 400)
  }
  return value
}

function requirePositivePid(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) failInvalidResponse()
  return value
}

function assertPlanCheck(value: unknown, seen: Set<string>): VerificationPlanCheckMeta {
  if (!isRecord(value)) failInvalidResponse()
  assertExactKeys(value, PLAN_CHECK_KEYS)
  const id = requirePlanMetaIdValue(value.id)
  if (seen.has(id)) failInvalidResponse()
  seen.add(id)
  const timeoutMs = requireNumberField(value, 'timeoutMs')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_CHECK_TIMEOUT_MS) {
    failInvalidResponse()
  }
  return { id, timeoutMs }
}

export function decodeVerificationPlanMeta(value: unknown): VerificationPlanMeta {
  if (!isRecord(value)) failInvalidResponse()
  assertExactKeys(value, PLAN_META_KEYS)
  const id = requirePlanMetaIdValue(value.id)
  const revision = requirePlanMetaIdValue(value.revision)
  if (!Array.isArray(value.checks) || value.checks.length < 1 || value.checks.length > MAX_PLAN_CHECKS) {
    failInvalidResponse()
  }
  const seen = new Set<string>()
  return {
    id,
    revision,
    checks: value.checks.map(check => assertPlanCheck(check, seen)),
  }
}

export function decodeVerificationPlanList(value: unknown): VerificationPlanList {
  if (!isRecord(value)) failInvalidResponse()
  assertExactKeys(value, PLAN_LIST_KEYS)
  if (!Array.isArray(value.items) || value.items.length > MAX_PLAN_REGISTRY) failInvalidResponse()
  return { items: value.items.map(decodeVerificationPlanMeta) }
}

function decodeCancelRequested(value: unknown): VerificationCancelRequestedView {
  if (!isRecord(value)) failInvalidResponse()
  assertExactKeys(value, CANCEL_REQUESTED_KEYS)
  return {
    actorId: requireSafeIdValue(value.actorId),
    reason: requireStringField(value, 'reason'),
    at: requireCanonicalIso(value.at),
  }
}

function decodeJobRequest(value: unknown): VerificationJobRequestView {
  if (!isRecord(value)) failInvalidResponse()
  assertExactKeys(value, JOB_REQUEST_KEYS)
  const verificationId = requireSafeIdValue(value.verificationId)
  const workspaceId = requireSafeIdValue(value.workspaceId)
  const ownerId = requireSafeIdValue(value.ownerId)
  const ticketId = requireSafeIdValue(value.ticketId)
  const executionId = requireSafeIdValue(value.executionId)
  const artifactId = requireSafeIdValue(value.artifactId)
  const artifactRevision = requireStringField(value, 'artifactRevision')
  const policyVersion = requireSafeIdValue(value.policyVersion)
  const reason = requireStringField(value, 'reason')
  if (!reason || reason.includes('\0') || reason.length > MAX_REASON) failInvalidResponse()
  const createdAt = requireCanonicalIso(value.createdAt)
  const expectedTaskVersion = requireNumberField(value, 'expectedTaskVersion')
  if (!Number.isSafeInteger(expectedTaskVersion) || expectedTaskVersion < 1) failInvalidResponse()
  if (!ARTIFACT_REVISION.test(artifactRevision)) failInvalidResponse()
  return {
    verificationId,
    workspaceId,
    ownerId,
    ticketId,
    expectedTaskVersion,
    policyVersion,
    executionId,
    artifactId,
    artifactRevision,
    plan: decodeVerificationPlanMeta(value.plan),
    reason,
    createdAt,
  }
}

function assertJobStateFields(job: VerificationJobView, raw: Record<string, unknown>): void {
  const status = job.status
  if (status === 'COMPLETED') {
    if (job.outcome === undefined || job.reportSha256 === undefined || job.application === undefined || job.finishedAt === undefined) {
      failInvalidResponse()
    }
    if (job.failureCode !== undefined) failInvalidResponse()
    return
  }
  if (status === 'FAILED') {
    if (job.failureCode === undefined || typeof raw.failureCode !== 'string' || !raw.failureCode) failInvalidResponse()
    if (job.outcome !== undefined || job.reportSha256 !== undefined || job.application !== undefined) {
      failInvalidResponse()
    }
    if (job.finishedAt === undefined) failInvalidResponse()
    return
  }
  if (status === 'CANCELLED') {
    if (job.finishedAt === undefined) failInvalidResponse()
    if (job.outcome !== undefined || job.reportSha256 !== undefined || job.application !== undefined) {
      failInvalidResponse()
    }
    return
  }
  if (ACTIVE_STATE_SET.has(status)) {
    if (job.finishedAt !== undefined || job.outcome !== undefined) failInvalidResponse()
    if (job.reportSha256 !== undefined || job.application !== undefined) failInvalidResponse()
  }
}

export function decodeVerificationJob(value: unknown): VerificationJobView {
  if (!isRecord(value)) failInvalidResponse()
  assertExactKeys(value, JOB_REQUIRED_KEYS, JOB_OPTIONAL_KEYS)
  const status = requireStringField(value, 'status')
  if (!JOB_STATE_SET.has(status)) failInvalidResponse()
  const version = requireNumberField(value, 'version')
  const lastSequence = requireNumberField(value, 'lastSequence')
  if (!Number.isSafeInteger(version) || version < 1) failInvalidResponse()
  if (!Number.isSafeInteger(lastSequence) || lastSequence < 0) failInvalidResponse()

  const job: VerificationJobView = {
    request: decodeJobRequest(value.request),
    status: status as VerificationJobState,
    version,
    lastSequence,
    createdAt: requireCanonicalIso(value.createdAt),
    updatedAt: requireCanonicalIso(value.updatedAt),
  }

  if (value.runnerId !== undefined) {
    job.runnerId = requireSafeIdValue(value.runnerId)
  }
  if (value.runnerPid !== undefined) {
    job.runnerPid = requirePositivePid(value.runnerPid)
  }
  if (value.processId !== undefined) {
    job.processId = requirePositivePid(value.processId)
  }
  if (value.outcome !== undefined) {
    if (typeof value.outcome !== 'string' || !OUTCOME_SET.has(value.outcome)) failInvalidResponse()
    job.outcome = value.outcome as 'passed' | 'failed'
  }
  if (value.reportSha256 !== undefined) {
    if (typeof value.reportSha256 !== 'string' || !ARTIFACT_REVISION.test(value.reportSha256)) failInvalidResponse()
    job.reportSha256 = value.reportSha256
  }
  if (value.application !== undefined) {
    if (typeof value.application !== 'string' || !APPLICATION_SET.has(value.application)) failInvalidResponse()
    job.application = value.application as 'pending' | 'applied' | 'superseded'
  }
  if (value.cancelRequested !== undefined) {
    job.cancelRequested = decodeCancelRequested(value.cancelRequested)
  }
  if (value.finishedAt !== undefined) {
    job.finishedAt = requireCanonicalIso(value.finishedAt)
  }
  if (value.failureCode !== undefined) {
    if (typeof value.failureCode !== 'string' || !value.failureCode || !SAFE_ID.test(value.failureCode)) {
      failInvalidResponse()
    }
    job.failureCode = value.failureCode
  }

  assertJobStateFields(job, value)
  return job
}

export function decodeVerificationJobList(value: unknown): VerificationJobList {
  if (!isRecord(value)) failInvalidResponse()
  assertExactKeys(value, JOB_LIST_REQUIRED_KEYS, JOB_LIST_OPTIONAL_KEYS)
  if (!Array.isArray(value.items) || value.items.length > MAX_LIST_LIMIT) failInvalidResponse()
  const items = value.items.map(decodeVerificationJob)
  if (value.nextCursor !== undefined) {
    if (typeof value.nextCursor !== 'number' || !Number.isSafeInteger(value.nextCursor) || value.nextCursor < 1) {
      failInvalidResponse()
    }
    return { items, nextCursor: value.nextCursor }
  }
  return { items }
}

export function decodeVerificationHistoryEntry(value: unknown): VerificationHistoryEntry {
  if (!isRecord(value)) failInvalidResponse()
  assertExactKeys(value, HISTORY_REQUIRED_KEYS, HISTORY_OPTIONAL_KEYS)
  const entry: VerificationHistoryEntry = {
    id: requireSafeIdValue(value.id),
    verificationId: requireSafeIdValue(value.verificationId),
    action: requireSafeIdValue(value.action),
    at: requireCanonicalIso(value.at),
  }
  if (value.from !== undefined) {
    if (typeof value.from !== 'string' || !JOB_STATE_SET.has(value.from)) failInvalidResponse()
    entry.from = value.from
  }
  if (value.to !== undefined) {
    if (typeof value.to !== 'string' || !JOB_STATE_SET.has(value.to)) failInvalidResponse()
    entry.to = value.to
  }
  if (value.actorId !== undefined) {
    entry.actorId = requireSafeIdValue(value.actorId)
  }
  if (value.reasonCode !== undefined) {
    entry.reasonCode = requireSafeIdValue(value.reasonCode)
  }
  if (value.sequence !== undefined) {
    if (typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 0) {
      failInvalidResponse()
    }
    entry.sequence = value.sequence
  }
  return entry
}

export function decodeVerificationDetail(value: unknown): VerificationDetail {
  if (!isRecord(value)) failInvalidResponse()
  assertExactKeys(value, DETAIL_KEYS)
  if (!Array.isArray(value.history) || value.history.length > MAX_HISTORY) failInvalidResponse()
  return {
    job: decodeVerificationJob(value.job),
    history: value.history.map(decodeVerificationHistoryEntry),
  }
}

export function decodeVerificationCommandResult(value: unknown): VerificationCommandResult {
  if (!isRecord(value)) failInvalidResponse()
  assertExactKeys(value, COMMAND_RESULT_KEYS)
  if (typeof value.replayed !== 'boolean') failInvalidResponse()
  // Reject invented {job,replayed} shapes — backend returns compact ID receipt only.
  if (Object.prototype.hasOwnProperty.call(value, 'job')) failInvalidResponse()
  return {
    verificationId: requireSafeIdValue(value.verificationId),
    replayed: value.replayed,
  }
}

/** Distinguish Core application of a completed job vs still-unknown/pending. */
export function applicationLabel(job: VerificationJobView): 'applied' | 'superseded' | 'unknown' {
  if (job.application === 'applied') return 'applied'
  if (job.application === 'superseded') return 'superseded'
  return 'unknown'
}

export function isActiveVerificationStatus(status: VerificationJobState): boolean {
  return (ACTIVE_VERIFICATION_STATES as readonly string[]).includes(status)
}

export function isTerminalApplication(job: VerificationJobView): boolean {
  return job.application === 'applied' || job.application === 'superseded'
}

function buildListQuery(options?: VerificationListOptions): string {
  if (options === undefined) return ''
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new ApiError('INVALID_REQUEST', 400)
  }
  for (const key of Object.keys(options)) {
    if (key !== 'limit' && key !== 'beforeRowid') throw new ApiError('INVALID_REQUEST', 400)
  }
  const params = new URLSearchParams()
  const limit = options.limit
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new ApiError('INVALID_REQUEST', 400)
    }
    params.set('limit', String(limit))
  }
  const beforeRowid = options.beforeRowid
  if (beforeRowid !== undefined) {
    if (typeof beforeRowid !== 'number' || !Number.isSafeInteger(beforeRowid) || beforeRowid < 1) {
      throw new ApiError('INVALID_REQUEST', 400)
    }
    params.set('beforeRowid', String(beforeRowid))
  }
  const query = params.toString()
  return query ? `?${query}` : ''
}

function assertCreateBody(body: CreateVerificationBody): CreateVerificationBody {
  if (!isRecord(body)) throw new ApiError('INVALID_REQUEST', 400)
  const allowed = new Set([
    'expectedVersion',
    'executionId',
    'artifactRevision',
    'planId',
    'planRevision',
    'reason',
  ])
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) throw new ApiError('INVALID_REQUEST', 400)
  }
  return {
    expectedVersion: requirePositiveInt(body.expectedVersion, 'expectedVersion'),
    executionId: requireSafeId(body.executionId, 'executionId'),
    artifactRevision: requireArtifactRevision(body.artifactRevision),
    planId: requirePlanMetaId(body.planId, 'planId'),
    planRevision: requirePlanMetaId(body.planRevision, 'planRevision'),
    reason: requireReason(body.reason),
  }
}

function assertCancelBody(body: CancelVerificationBody): CancelVerificationBody {
  if (!isRecord(body)) throw new ApiError('INVALID_REQUEST', 400)
  for (const key of Object.keys(body)) {
    if (key !== 'expectedVersion' && key !== 'reason') throw new ApiError('INVALID_REQUEST', 400)
  }
  return {
    expectedVersion: requirePositiveInt(body.expectedVersion, 'expectedVersion'),
    reason: requireReason(body.reason),
  }
}

export function createVerificationApi(client: VerificationRequestClient): VerificationApi {
  if (!client || typeof client.request !== 'function') {
    throw new ApiError('INVALID_REQUEST', 400)
  }
  const request = client.request.bind(client) as AuthenticatedJsonRequest

  const api: VerificationApi = {
    async plans(signal) {
      return request(`${API_PREFIX}/verification-plans`, {
        method: 'GET',
        signal,
        okStatuses: new Set([200]),
        parse: decodeVerificationPlanList,
      })
    },
    async list(ticketId, options, signal) {
      const id = requireSafeId(ticketId, 'ticketId')
      return request(`${API_PREFIX}/tasks/${encodeURIComponent(id)}/verifications${buildListQuery(options)}`, {
        method: 'GET',
        signal,
        okStatuses: new Set([200]),
        parse: decodeVerificationJobList,
      })
    },
    async get(verificationId, signal) {
      const id = requireSafeId(verificationId, 'verificationId')
      return request(`${API_PREFIX}/verifications/${encodeURIComponent(id)}`, {
        method: 'GET',
        signal,
        okStatuses: new Set([200]),
        parse: decodeVerificationDetail,
      })
    },
    async create(ticketId, key, body, signal) {
      const id = requireSafeId(ticketId, 'ticketId')
      const idempotencyKey = requireSafeKey(key)
      const payload = assertCreateBody(body)
      return request(`${API_PREFIX}/tasks/${encodeURIComponent(id)}/verifications`, {
        method: 'POST',
        body: payload,
        idempotencyKey,
        signal,
        okStatuses: new Set([202]),
        parse: decodeVerificationCommandResult,
      })
    },
    async cancel(verificationId, key, body, signal) {
      const id = requireSafeId(verificationId, 'verificationId')
      const idempotencyKey = requireSafeKey(key)
      const payload = assertCancelBody(body)
      return request(`${API_PREFIX}/verifications/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        body: payload,
        idempotencyKey,
        signal,
        okStatuses: new Set([202]),
        parse: decodeVerificationCommandResult,
      })
    },
  }

  return Object.freeze(api)
}
