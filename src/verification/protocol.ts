/**
 * Private verification wrapper protocol: immutable launch input and MAC-bound terminal results.
 * Provenance within the same-user boundary; not a sandbox against hostile check binaries.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import type { VerificationCheckResult, VerificationReport } from './local-checks.ts'
import type { VerificationJobPlan, VerificationJobRequest } from './model.ts'
import {
  parseVerificationRequest,
  verificationCanonicalJson,
  verificationRequestSha256,
} from './request.ts'

const SECRET = /^[0-9a-f]{64}$/
const FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const MODE_BITS = 0o7777
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIR_MODE = 0o700
const TRUSTED_DARWIN_ALIASES = new Set(['/var', '/tmp', '/etc'])

export const VERIFICATION_MAX_INPUT_BYTES = 256 * 1024
export const VERIFICATION_MAX_RESULT_BYTES = 8 * 1024 * 1024
export const VERIFICATION_MAX_PROGRESS_BYTES = 16 * 1024

const MAX_INPUT_BYTES = VERIFICATION_MAX_INPUT_BYTES
const MAX_RESULT_BYTES = VERIFICATION_MAX_RESULT_BYTES

export type VerificationTerminalStatus = 'completed' | 'cancelled' | 'failed'

export interface VerificationWorkerInput {
  version: 1
  request: VerificationJobRequest
  requestSha256: string
  secret: string
  dataDir: string
}

export interface SignedVerificationResult {
  version: 1
  verificationId: string
  requestSha256: string
  request?: VerificationJobRequest
  status: VerificationTerminalStatus
  terminalConfirmed: true
  report?: VerificationReport
  failureCode?: string
  mac: string
}

export interface CollectedVerificationResult {
  status: VerificationTerminalStatus
  terminalConfirmed: true
  reportSha256: string
  report?: VerificationReport
  failureCode?: string
}

const INPUT_KEYS = ['version', 'request', 'requestSha256', 'secret', 'dataDir'] as const
const RESULT_KEYS = [
  'version',
  'verificationId',
  'requestSha256',
  'status',
  'terminalConfirmed',
  'mac',
] as const
const RESULT_OPTIONAL = ['request', 'report', 'failureCode'] as const
const REPORT_KEYS = [
  'verificationId',
  'executionId',
  'artifactId',
  'artifactRevision',
  'state',
  'checks',
  'createdAt',
] as const
const REPORT_OPTIONAL = ['waiveReason'] as const
const CHECK_RESULT_KEYS = ['id', 'exitCode', 'signal', 'durationMs', 'stdout', 'stderr'] as const
const CHECK_RESULT_OPTIONAL = ['reason'] as const

function fail(message: string): never {
  throw new Error(message)
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional])
  const keys = Object.keys(value)
  if (keys.some(key => !allowed.has(key))) fail(`${label} contains unknown fields`)
  if (required.some(key => !Object.hasOwn(value, key))) fail(`${label} is missing required fields`)
}

function assertSecret(value: unknown): string {
  if (typeof value !== 'string' || !SECRET.test(value)) fail('Invalid verification secret')
  return value
}

function assertFailureCode(value: unknown): string {
  if (typeof value !== 'string' || !FAILURE_CODE.test(value)) fail('Invalid verification failure code')
  return value
}

function assertSha256(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(`Invalid ${label}`)
  return value
}

function assertAbsoluteDataDir(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || !isAbsolute(value)) {
    fail('Verification dataDir must be an absolute path')
  }
  return resolve(value)
}

function digestEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function assertExactMode(mode: number | bigint, expected: number): void {
  if (process.platform !== 'win32' && (Number(mode) & MODE_BITS) !== expected) {
    fail('Verification path mode mismatch')
  }
}

function assertCurrentOwner(uid: number | bigint): void {
  if (typeof process.getuid === 'function' && Number(uid) !== process.getuid()) {
    fail('Verification path must be owned by the current user')
  }
}

function sameIdentity(
  left: { dev: number | bigint; ino: number | bigint },
  right: { dev: number | bigint; ino: number | bigint },
): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function isTrustedDarwinAlias(current: string, canonical: string): boolean {
  return process.platform === 'darwin'
    && TRUSTED_DARWIN_ALIASES.has(current)
    && canonical === `/private${current}`
}

/** Reject symlink path components except trusted macOS aliases and already-canonical input. */
export function rejectVerificationSymlinkComponents(path: string, allowMissingFinal = false): void {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  const parts = absolute.slice(root.length).split(sep).filter(Boolean)
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!)
    let info: Stats
    try {
      info = lstatSync(current)
    } catch (error) {
      if (allowMissingFinal && isErrno(error, 'ENOENT') && index === parts.length - 1) return
      throw error
    }
    if (info.isSymbolicLink()) {
      const canonical = realpathSync(current)
      if (!isTrustedDarwinAlias(current, canonical)) {
        fail(`Symbolic link path component is unsupported: ${current}`)
      }
    }
  }
}

export function assertVerificationPrivateDir(path: string, label: string): string {
  if (typeof path !== 'string' || !path.trim() || path.includes('\0') || !isAbsolute(path)) {
    fail(`${label} must be an absolute path`)
  }
  const absolute = resolve(path)
  rejectVerificationSymlinkComponents(absolute, false)
  let info: Stats
  try {
    info = lstatSync(absolute)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) fail(`${label} is missing`)
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`${label} must be a real directory`)
  assertExactMode(info.mode, PRIVATE_DIR_MODE)
  assertCurrentOwner(info.uid)
  return realpathSync(absolute)
}

function assertPrivateFileStats(info: Stats, maxBytes: number, label: string): void {
  if (!info.isFile()) fail(`${label} must be a regular file`)
  if (info.nlink !== 1) fail(`${label} must not have hard links`)
  assertExactMode(info.mode, PRIVATE_FILE_MODE)
  assertCurrentOwner(info.uid)
  if (info.size <= 0) fail(`${label} is empty`)
  if (info.size > maxBytes) fail(`${label} exceeds size limit`)
}

/**
 * Bounded nofollow FD read: reject symlinks, require private 0600 + owned UID,
 * stable fstat identity, and final path inode match. Never chmods read paths.
 */
export function readVerificationPrivateFile(path: string, maxBytes: number, label = 'verification file'): Buffer {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail(`${label} maxBytes is invalid`)
  if (typeof path !== 'string' || !path.trim() || path.includes('\0') || !isAbsolute(path)) {
    fail(`${label} path must be absolute`)
  }
  const absolute = resolve(path)
  rejectVerificationSymlinkComponents(absolute, false)
  const parentBefore = lstatSync(dirname(absolute))

  let before: Stats
  try {
    before = lstatSync(absolute)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) fail(`${label} is missing`)
    throw error
  }
  if (before.isSymbolicLink()) fail(`${label} must not be a symbolic link`)
  assertPrivateFileStats(before, maxBytes, label)

  const noFollow = constants.O_NOFOLLOW ?? 0
  const fd = openSync(absolute, constants.O_RDONLY | noFollow)
  try {
    const opened = fstatSync(fd)
    assertPrivateFileStats(opened, maxBytes, label)
    if (!sameIdentity(before, opened) || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs
      || opened.ctimeMs !== before.ctimeMs) {
      fail(`${label} identity changed while opening`)
    }

    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    const after = fstatSync(fd)
    assertPrivateFileStats(after, maxBytes, label)
    if (
      !sameIdentity(opened, after)
      || opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs
      || opened.ctimeMs !== after.ctimeMs
      || opened.uid !== after.uid
      || opened.mode !== after.mode
    ) {
      fail(`${label} changed while reading`)
    }
    if (length > maxBytes || length !== Number(after.size)) fail(`${label} exceeds size limit`)

    const finalStat = lstatSync(absolute)
    if (finalStat.isSymbolicLink() || !finalStat.isFile()) fail(`${label} final path is not a regular file`)
    assertExactMode(finalStat.mode, PRIVATE_FILE_MODE)
    assertCurrentOwner(finalStat.uid)
    const parentAfter = lstatSync(dirname(absolute))
    rejectVerificationSymlinkComponents(absolute, false)
    if (!sameIdentity(parentBefore, parentAfter) || parentAfter.isSymbolicLink()
      || !sameIdentity(after, finalStat) || finalStat.nlink !== 1 || finalStat.size !== after.size
      || finalStat.mtimeMs !== after.mtimeMs || finalStat.ctimeMs !== after.ctimeMs) {
      fail(`${label} final path inode identity mismatch`)
    }
    return Buffer.from(buffer.subarray(0, length))
  } finally {
    closeSync(fd)
  }
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0
  let writes = 0
  while (offset < data.length) {
    if (++writes > data.length) fail('Verification write failed to make progress')
    const remaining = data.length - offset
    const written = writeSync(fd, data, offset, remaining)
    if (!Number.isInteger(written) || written <= 0 || written > remaining) {
      fail('Short write while persisting verification file')
    }
    offset += written
  }
}

function unlinkOwnInode(path: string, identity: { dev: number | bigint; ino: number | bigint }): void {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) return
    if (sameIdentity(info, identity)) unlinkSync(path)
  } catch {
    /* only own inode */
  }
}

function writeExclusivePrivateBytes(path: string, payload: Buffer, maxBytes: number, label: string): void {
  if (payload.byteLength > maxBytes) fail(`${label} payload exceeds size limit`)
  const absolute = resolve(path)
  rejectVerificationSymlinkComponents(absolute, true)
  rejectVerificationSymlinkComponents(dirname(absolute), false)

  let fd: number | undefined
  let createdIdentity: { dev: number | bigint; ino: number | bigint } | undefined
  const noFollow = constants.O_NOFOLLOW ?? 0
  try {
    fd = openSync(
      absolute,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      PRIVATE_FILE_MODE,
    )
    const opened = fstatSync(fd)
    if (!opened.isFile()) fail(`${label} created path is not a regular file`)
    createdIdentity = { dev: opened.dev, ino: opened.ino }
    fchmodSync(fd, PRIVATE_FILE_MODE)
    assertExactMode(fstatSync(fd).mode, PRIVATE_FILE_MODE)
    writeAll(fd, payload)
    fsyncSync(fd)
    const afterWrite = fstatSync(fd)
    if (!sameIdentity(afterWrite, createdIdentity) || Number(afterWrite.size) !== payload.byteLength) {
      fail(`${label} identity mismatch after write`)
    }
    assertExactMode(afterWrite.mode, PRIVATE_FILE_MODE)
    assertCurrentOwner(afterWrite.uid)
    closeSync(fd)
    fd = undefined

    const finalStat = lstatSync(absolute)
    if (finalStat.isSymbolicLink() || !finalStat.isFile()) fail(`${label} final path is not a regular file`)
    assertExactMode(finalStat.mode, PRIVATE_FILE_MODE)
    assertCurrentOwner(finalStat.uid)
    if (!sameIdentity(finalStat, createdIdentity) || Number(finalStat.size) !== payload.byteLength) {
      fail(`${label} final path inode identity mismatch`)
    }
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* best-effort */ }
    }
    if (createdIdentity !== undefined) unlinkOwnInode(absolute, createdIdentity)
    throw error
  }
}

/** Exclusive publication: never overwrites existing evidence. */
export function writeVerificationExclusiveJson(path: string, value: unknown, maxBytes: number): void {
  const payload = Buffer.from(`${JSON.stringify(value)}\n`)
  writeExclusivePrivateBytes(path, payload, maxBytes, 'verification exclusive json')
}

/**
 * Atomic replace via unique temp + rename. Never blindly removes an existing .tmp;
 * only unlinks the inode this call created.
 */
export function writeVerificationAtomicJson(path: string, value: unknown, maxBytes: number): void {
  const absolute = resolve(path)
  rejectVerificationSymlinkComponents(dirname(absolute), false)
  rejectVerificationSymlinkComponents(absolute, true)
  const payload = Buffer.from(`${JSON.stringify(value)}\n`)
  if (payload.byteLength > maxBytes) fail('verification atomic json payload exceeds size limit')

  const temporary = join(
    dirname(absolute),
    `.${parse(absolute).base}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`,
  )
  let fd: number | undefined
  let createdIdentity: { dev: number | bigint; ino: number | bigint } | undefined
  const noFollow = constants.O_NOFOLLOW ?? 0
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      PRIVATE_FILE_MODE,
    )
    const opened = fstatSync(fd)
    if (!opened.isFile()) fail('verification temp path is not a regular file')
    createdIdentity = { dev: opened.dev, ino: opened.ino }
    fchmodSync(fd, PRIVATE_FILE_MODE)
    writeAll(fd, payload)
    fsyncSync(fd)
    const afterWrite = fstatSync(fd)
    if (!sameIdentity(afterWrite, createdIdentity) || Number(afterWrite.size) !== payload.byteLength) {
      fail('verification temp identity mismatch after write')
    }
    closeSync(fd)
    fd = undefined
    renameSync(temporary, absolute)
    createdIdentity = undefined

    const finalStat = lstatSync(absolute)
    if (finalStat.isSymbolicLink() || !finalStat.isFile()) fail('verification atomic json final path invalid')
    assertExactMode(finalStat.mode, PRIVATE_FILE_MODE)
    assertCurrentOwner(finalStat.uid)
    if (Number(finalStat.size) !== payload.byteLength) fail('verification atomic json size mismatch')
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* best-effort */ }
    }
    if (createdIdentity !== undefined) unlinkOwnInode(temporary, createdIdentity)
    throw error
  }
}

export function fsyncVerificationDirectory(path: string): void {
  const absolute = assertVerificationPrivateDir(path, 'verification directory')
  const fd = openSync(absolute, constants.O_RDONLY)
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function unsignedResultPayload(result: Omit<SignedVerificationResult, 'mac'>): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    version: result.version,
    verificationId: result.verificationId,
    requestSha256: result.requestSha256,
    status: result.status,
    terminalConfirmed: result.terminalConfirmed,
  }
  if (result.request !== undefined) payload.request = result.request
  if (result.report !== undefined) payload.report = result.report
  if (result.failureCode !== undefined) payload.failureCode = result.failureCode
  return payload
}

function parseCheckResult(value: unknown, expectedId: string, label: string): VerificationCheckResult {
  assertObject(value, label)
  assertExactKeys(value, CHECK_RESULT_KEYS, CHECK_RESULT_OPTIONAL, label)
  if (typeof value.id !== 'string' || value.id !== expectedId) fail(`${label} id mismatch`)
  if (value.exitCode !== null && (typeof value.exitCode !== 'number' || !Number.isSafeInteger(value.exitCode))) {
    fail(`${label} exitCode is invalid`)
  }
  if (value.signal !== null && (typeof value.signal !== 'string' || !value.signal)) {
    fail(`${label} signal is invalid`)
  }
  if (typeof value.durationMs !== 'number' || !Number.isFinite(value.durationMs) || value.durationMs < 0) {
    fail(`${label} durationMs is invalid`)
  }
  if (typeof value.stdout !== 'string' || typeof value.stderr !== 'string') fail(`${label} output must be strings`)
  let reason: string | undefined
  if (value.reason !== undefined) {
    if (typeof value.reason !== 'string' || !value.reason.trim()) fail(`${label} reason is invalid`)
    reason = value.reason
  }
  return {
    id: expectedId,
    exitCode: value.exitCode as number | null,
    signal: value.signal as NodeJS.Signals | null,
    durationMs: value.durationMs,
    stdout: value.stdout,
    stderr: value.stderr,
    ...(reason !== undefined ? { reason } : {}),
  }
}

function checkPassed(result: VerificationCheckResult): boolean {
  return result.exitCode === 0 && result.signal === null && result.reason === undefined
}

function checkFailed(result: VerificationCheckResult): boolean {
  return !checkPassed(result)
}

function validateReportAgainstPlan(report: VerificationReport, plan: VerificationJobPlan): void {
  if (report.state === 'passed') {
    if (plan.checks.length < 1) fail('Passed report requires a nonempty plan')
    if (report.checks.length !== plan.checks.length) fail('Passed report must include exactly all plan checks')
    for (let index = 0; index < plan.checks.length; index++) {
      const expected = plan.checks[index]!
      const actual = report.checks[index]!
      if (actual.id !== expected.id) fail('Passed report check order/id mismatch')
      if (!checkPassed(actual)) fail('Passed report checks must exit 0 with null signal and no reason')
    }
    return
  }

  if (report.state === 'failed') {
    if (report.checks.length < 1) fail('Failed report must include a nonempty check prefix')
    if (report.checks.length > plan.checks.length) fail('Failed report exceeds plan check prefix')
    for (let index = 0; index < report.checks.length; index++) {
      const expected = plan.checks[index]!
      const actual = report.checks[index]!
      if (actual.id !== expected.id) fail('Failed report check order/id mismatch')
      if (index < report.checks.length - 1) {
        if (!checkPassed(actual)) fail('Failed report prefix before last check must be successful')
      } else if (!checkFailed(actual)) {
        fail('Failed report last check must be the actual failure')
      }
    }
    return
  }

  fail('Completed report state must be passed or failed')
}

function parseBoundReport(value: unknown, request: VerificationJobRequest): VerificationReport {
  assertObject(value, 'verification report')
  assertExactKeys(value, REPORT_KEYS, REPORT_OPTIONAL, 'verification report')
  if (value.waiveReason !== undefined) fail('Completed verification report must not include waiveReason')
  if (value.verificationId !== request.verificationId) fail('Report verificationId mismatch')
  if (value.executionId !== request.executionId) fail('Report executionId mismatch')
  if (value.artifactId !== request.artifactId) fail('Report artifactId mismatch')
  if (value.artifactRevision !== request.artifactRevision) fail('Report artifactRevision mismatch')
  if (value.state !== 'passed' && value.state !== 'failed') fail('Completed report state must be passed or failed')
  if (!Array.isArray(value.checks)) fail('Report checks must be an array')
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    fail('Report createdAt is invalid')
  }

  const checks: VerificationCheckResult[] = []
  for (let index = 0; index < value.checks.length; index++) {
    const expectedId = request.plan.checks[index]?.id
    if (expectedId === undefined) fail('Report contains checks beyond the plan')
    checks.push(parseCheckResult(value.checks[index], expectedId, `verification report check[${index}]`))
  }

  const report: VerificationReport = {
    verificationId: request.verificationId,
    executionId: request.executionId,
    artifactId: request.artifactId,
    artifactRevision: request.artifactRevision,
    state: value.state,
    checks,
    createdAt: value.createdAt,
  }
  validateReportAgainstPlan(report, request.plan)
  if (report.state === 'passed' && report.checks.length === 0) fail('Empty passed reports are rejected')
  return report
}

export function createVerificationSecret(): string {
  return randomBytes(32).toString('hex')
}

export function verificationResultMac(
  payload: Omit<SignedVerificationResult, 'mac'>,
  secret: string,
): string {
  assertSecret(secret)
  return createHmac('sha256', secret)
    .update(verificationCanonicalJson(unsignedResultPayload(payload)))
    .digest('hex')
}

export function verificationResultSha256(payload: Omit<SignedVerificationResult, 'mac'>): string {
  return createHash('sha256')
    .update(verificationCanonicalJson(unsignedResultPayload(payload)))
    .digest('hex')
}

export function signVerificationResult(
  payload: Omit<SignedVerificationResult, 'mac'>,
  secret: string,
  request: VerificationJobRequest = payload.request as VerificationJobRequest,
): SignedVerificationResult {
  if (!request) fail('Signing a verification result requires request binding')
  const bound: Omit<SignedVerificationResult, 'mac'> = {
    ...payload,
    verificationId: request.verificationId,
    requestSha256: verificationRequestSha256(request),
  }
  const validated = parseSignedVerificationResult({
    ...bound,
    mac: verificationResultMac(bound, secret),
  }, { secret, request })
  return validated
}

export function parseVerificationWorkerInput(value: unknown): VerificationWorkerInput {
  assertObject(value, 'verification worker input')
  assertExactKeys(value, INPUT_KEYS, [], 'verification worker input')
  if (value.version !== 1) fail('Unsupported verification worker input version')
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_INPUT_BYTES) fail('Verification worker input is too large')
  const request = parseVerificationRequest(value.request)
  const requestSha256 = assertSha256(value.requestSha256, 'requestSha256')
  const expected = verificationRequestSha256(request)
  if (!digestEqual(requestSha256, expected)) fail('Verification requestSha256 mismatch')
  return {
    version: 1,
    request,
    requestSha256,
    secret: assertSecret(value.secret),
    dataDir: assertAbsoluteDataDir(value.dataDir),
  }
}

export function parseSignedVerificationResult(
  value: unknown,
  options: { secret: string; request?: VerificationJobRequest },
): SignedVerificationResult {
  assertObject(value, 'signed verification result')
  assertExactKeys(value, RESULT_KEYS, RESULT_OPTIONAL, 'signed verification result')
  if (value.version !== 1) fail('Unsupported signed verification result version')
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_RESULT_BYTES) fail('Signed verification result is too large')
  if (value.terminalConfirmed !== true) fail('Signed verification result must be terminalConfirmed')

  const status = value.status
  if (status !== 'completed' && status !== 'cancelled' && status !== 'failed') {
    fail('Invalid signed verification status')
  }

  const requestSha256 = assertSha256(value.requestSha256, 'requestSha256')
  const verificationId = typeof value.verificationId === 'string' ? value.verificationId : fail('Invalid verificationId')

  let binding: VerificationJobRequest
  if (value.request !== undefined && options.request !== undefined) {
    const embedded = parseVerificationRequest(value.request)
    const provided = parseVerificationRequest(options.request)
    if (verificationCanonicalJson(embedded) !== verificationCanonicalJson(provided)) {
      fail('Signed result embedded request does not match options.request')
    }
    binding = provided
  } else if (value.request !== undefined) {
    binding = parseVerificationRequest(value.request)
  } else if (options.request !== undefined) {
    binding = parseVerificationRequest(options.request)
  } else {
    fail('Signed verification result requires request binding')
  }

  if (binding.verificationId !== verificationId) fail('Signed result verificationId mismatch')
  const expectedRequestHash = verificationRequestSha256(binding)
  if (!digestEqual(requestSha256, expectedRequestHash)) fail('Signed result requestSha256 mismatch')

  let report: VerificationReport | undefined
  let failureCode: string | undefined

  if (status === 'completed') {
    if (value.failureCode !== undefined) fail('Completed result must not include failureCode')
    if (value.report === undefined) fail('Completed result requires report')
    report = parseBoundReport(value.report, binding)
  } else {
    failureCode = assertFailureCode(value.failureCode)
    if (value.report !== undefined) {
      report = parseBoundReport(value.report, binding)
      if (report.state === 'passed') fail('Cancelled or failed result cannot carry a passed report')
    }
  }

  const unsigned: Omit<SignedVerificationResult, 'mac'> = {
    version: 1,
    verificationId,
    requestSha256,
    status,
    terminalConfirmed: true,
    ...(value.request !== undefined ? { request: binding } : {}),
    ...(report !== undefined ? { report } : {}),
    ...(failureCode !== undefined ? { failureCode } : {}),
  }

  const expectedMac = verificationResultMac(unsigned, options.secret)
  const mac = assertSha256(value.mac, 'mac')
  if (!digestEqual(mac, expectedMac)) fail('Signed verification result MAC mismatch')

  return { ...unsigned, mac }
}

export function collectFromSignedResult(
  result: SignedVerificationResult,
): CollectedVerificationResult {
  const { mac: _mac, ...unsigned } = result
  return {
    status: result.status,
    terminalConfirmed: true,
    reportSha256: verificationResultSha256(unsigned),
    ...(result.report !== undefined ? { report: result.report } : {}),
    ...(result.failureCode !== undefined ? { failureCode: result.failureCode } : {}),
  }
}
