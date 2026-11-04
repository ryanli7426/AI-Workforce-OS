/** Single local control-plane owner lease via private controller.lock; no DB/network/shell. */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'
import { redact } from '../security/redaction.ts'

export const CONTROLLER_LEASE_VERSION = 1 as const

const LOCK_DIR_NAME = 'controller.lock'
const OWNER_FILE = 'owner.json'
const STOP_FILE = 'stop.json'
const RECOVERY_CLAIM = 'recovery.claim'
const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const MODE_BITS = 0o7777
const MAX_OWNER_BYTES = 4 * 1024
const MAX_STOP_BYTES = 4 * 1024
const MAX_CLAIM_BYTES = 4 * 1024
const TOKEN_PATTERN = /^[0-9a-f]{64}$/
const TRUSTED_DARWIN_ALIASES = new Set(['/var', '/tmp'])
const OWNER_FIELDS = ['version', 'pid', 'token', 'startedAt'] as const
const STOP_FIELDS = ['version', 'token', 'requestedAt'] as const
const CLAIM_FIELDS = ['version', 'pid', 'nonce', 'createdAt'] as const

export type ControllerInspectState = 'stopped' | 'running' | 'unknown'

export interface ControllerInspectResult {
  state: ControllerInspectState
  pid?: number
}

export interface ControllerLease {
  shouldStop(): boolean
  release(): void
}

interface OwnerRecord {
  version: typeof CONTROLLER_LEASE_VERSION
  pid: number
  token: string
  startedAt: string
}

interface StopRecord {
  version: typeof CONTROLLER_LEASE_VERSION
  token: string
  requestedAt: string
}

interface RecoveryClaim {
  version: typeof CONTROLLER_LEASE_VERSION
  pid: number
  nonce: string
  createdAt: string
}

interface PathIdentity {
  dev: Stats['dev']
  ino: Stats['ino']
}

interface HeldLease {
  dataDir: string
  lockDir: string
  ownerPath: string
  stopPath: string
  owner: OwnerRecord
  lockIdentity: PathIdentity
  ownerIdentity: PathIdentity
  released: boolean
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error'
}

/** Strip accidental token-shaped hex from messages before rethrowing. */
function redactSecrets(message: string): string {
  return redact(message).replace(/[0-9a-f]{64}/gi, '[redacted]')
}

function fail(message: string): never {
  throw new Error(redactSecrets(message))
}

function ownershipLost(detail: string): never {
  fail(`Controller lease ownership was lost: ${detail}`)
}

function ownershipUnknown(detail: string): never {
  fail(`Controller lease ownership is unknown: ${detail}`)
}

function isTrustedDarwinAlias(current: string, canonical: string): boolean {
  return process.platform === 'darwin'
    && TRUSTED_DARWIN_ALIASES.has(current)
    && canonical === `/private${current}`
}

function rejectSymlinkComponents(path: string, allowMissingFinal: boolean): void {
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

function requireAbsolutePath(path: unknown, label: string): string {
  if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path)) {
    fail(`${label} must be an absolute path`)
  }
  return resolve(path)
}

function assertCurrentOwner(uid: number | bigint): void {
  if (typeof process.getuid === 'function' && Number(uid) !== process.getuid()) {
    fail('Path must be owned by the current user')
  }
}

function assertPrivateDirMode(mode: number | bigint): void {
  if (process.platform !== 'win32' && (Number(mode) & 0o077) !== 0) {
    fail('Directory must be private (0700); choose a dedicated directory')
  }
}

function assertExactPrivateFileMode(mode: number | bigint): void {
  if (process.platform !== 'win32' && (Number(mode) & MODE_BITS) !== PRIVATE_FILE_MODE) {
    fail('File must be mode 0600')
  }
}

function sameIdentity(left: PathIdentity, right: PathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function identityOf(stats: Stats): PathIdentity {
  return { dev: stats.dev, ino: stats.ino }
}

function assertPrivateDirectory(path: string, label: string): Stats {
  try {
    rejectSymlinkComponents(path, false)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) fail(`${label} does not exist`)
    throw error
  }
  let info: Stats
  try {
    info = lstatSync(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) fail(`${label} does not exist`)
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) fail(`${label} must be a real directory`)
  assertPrivateDirMode(info.mode)
  assertCurrentOwner(info.uid)
  return info
}

function assertExistingDataDir(dataDir: string): string {
  const absolute = requireAbsolutePath(dataDir, 'dataDir')
  assertPrivateDirectory(absolute, 'Data directory')
  return absolute
}

/**
 * For inspect/stop: missing dataDir is a clean stopped/no-op.
 * Permission, symlink, and type errors stay fail-closed.
 */
function resolveQueryDataDir(dataDir: string): string | undefined {
  const absolute = requireAbsolutePath(dataDir, 'dataDir')
  try {
    rejectSymlinkComponents(absolute, false)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  }
  let info: Stats
  try {
    info = lstatSync(absolute)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory()) fail('Data directory must be a real directory')
  assertPrivateDirMode(info.mode)
  assertCurrentOwner(info.uid)
  return absolute
}

function lockDirPath(dataDir: string): string {
  return join(dataDir, LOCK_DIR_NAME)
}

function openPrivateRead(path: string): number {
  return openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
}

function openPrivateCreateExclusive(path: string): number {
  return openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    PRIVATE_FILE_MODE,
  )
}

function openPrivateDirectory(path: string): number {
  return openSync(
    path,
    constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0),
  )
}

function readBoundedFile(path: string, maxBytes: number): { bytes: Buffer; stats: Stats } {
  const before = lstatSync(path)
  if (before.isSymbolicLink()) fail('Refusing symbolic link file')
  if (!before.isFile()) fail('Path must be a regular file')
  assertExactPrivateFileMode(before.mode)
  assertCurrentOwner(before.uid)
  if (before.size > maxBytes) fail('File exceeds size limit')

  const fd = openPrivateRead(path)
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || !sameIdentity(before, opened)) fail('File identity changed while opening')
    assertExactPrivateFileMode(opened.mode)
    assertCurrentOwner(opened.uid)
    if (opened.size > maxBytes) fail('File exceeds size limit')

    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    const after = fstatSync(fd)
    if (
      !sameIdentity(opened, after)
      || opened.size !== after.size
      || opened.mtimeMs !== after.mtimeMs
      || opened.uid !== after.uid
      || opened.mode !== after.mode
    ) {
      fail('File changed while reading')
    }
    if (length > maxBytes) fail('File exceeds size limit')
    return { bytes: buffer.subarray(0, length), stats: after }
  } finally {
    closeSync(fd)
  }
}

function writeExclusivePrivateFile(path: string, payload: string): Stats {
  const body = Buffer.from(payload, 'utf8')
  if (body.byteLength > MAX_OWNER_BYTES) fail('Payload exceeds size limit')
  let fd: number | undefined
  let createdIdentity: PathIdentity | undefined
  try {
    fd = openPrivateCreateExclusive(path)
    const opened = fstatSync(fd)
    if (!opened.isFile()) fail('Created file is not a regular file')
    createdIdentity = identityOf(opened)
    fchmodSync(fd, PRIVATE_FILE_MODE)
    writeFileSync(fd, body)
    fsyncSync(fd)
    const stats = fstatSync(fd)
    if (!sameIdentity(stats, createdIdentity)) fail('Created file identity mismatch')
    assertExactPrivateFileMode(stats.mode)
    assertCurrentOwner(stats.uid)
    closeSync(fd)
    fd = undefined
    const verified = lstatSync(path)
    if (verified.isSymbolicLink() || !verified.isFile()) fail('Created file is not a regular file')
    assertExactPrivateFileMode(verified.mode)
    assertCurrentOwner(verified.uid)
    if (!sameIdentity(stats, verified)) fail('Created file identity mismatch')
    return verified
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* best-effort */ }
    }
    if (createdIdentity) {
      unlinkOwnedFile(path, createdIdentity)
    }
    throw error
  }
}

function atomicWritePrivateFile(path: string, payload: string, lockDir: string, lockIdentity: PathIdentity): void {
  const body = Buffer.from(payload, 'utf8')
  if (body.byteLength > MAX_STOP_BYTES) fail('Payload exceeds size limit')
  const lockInfo = lstatSync(lockDir)
  if (lockInfo.isSymbolicLink() || !lockInfo.isDirectory() || !sameIdentity(lockInfo, lockIdentity)) {
    fail('Lock directory identity mismatch')
  }
  const tmp = join(lockDir, `.stop.${process.pid}.${randomBytes(8).toString('hex')}.tmp`)
  let fd: number | undefined
  let createdIdentity: PathIdentity | undefined
  try {
    fd = openPrivateCreateExclusive(tmp)
    const opened = fstatSync(fd)
    if (!opened.isFile()) fail('Created file is not a regular file')
    createdIdentity = identityOf(opened)
    fchmodSync(fd, PRIVATE_FILE_MODE)
    writeFileSync(fd, body)
    fsyncSync(fd)
    const stats = fstatSync(fd)
    if (!sameIdentity(stats, createdIdentity)) fail('Created file identity mismatch')
    assertExactPrivateFileMode(stats.mode)
    assertCurrentOwner(stats.uid)
    closeSync(fd)
    fd = undefined
    renameSync(tmp, path)
    createdIdentity = undefined
    const written = lstatSync(path)
    if (written.isSymbolicLink() || !written.isFile()) fail('Stop file is not a regular file')
    assertExactPrivateFileMode(written.mode)
    assertCurrentOwner(written.uid)
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* best-effort */ }
    }
    if (createdIdentity) {
      unlinkOwnedFile(tmp, createdIdentity)
    }
    throw error
  }
}

function parseOwner(bytes: Buffer): OwnerRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    fail('Controller owner metadata is malformed')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('Controller owner metadata is malformed')
  }
  const raw = parsed as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!(OWNER_FIELDS as readonly string[]).includes(key)) fail('Controller owner metadata is malformed')
  }
  for (const field of OWNER_FIELDS) {
    if (!(field in raw)) fail('Controller owner metadata is malformed')
  }
  if (raw.version !== CONTROLLER_LEASE_VERSION) fail('Controller owner metadata is malformed')
  if (!Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 1) fail('Controller owner metadata is malformed')
  if (typeof raw.token !== 'string' || !TOKEN_PATTERN.test(raw.token)) fail('Controller owner metadata is malformed')
  if (typeof raw.startedAt !== 'string' || !Number.isFinite(Date.parse(raw.startedAt))) {
    fail('Controller owner metadata is malformed')
  }
  return {
    version: CONTROLLER_LEASE_VERSION,
    pid: raw.pid as number,
    token: raw.token,
    startedAt: raw.startedAt,
  }
}

function parseStop(bytes: Buffer): StopRecord {
  let parsed: unknown
  try {
    parsed = JSON.parse(bytes.toString('utf8')) as unknown
  } catch {
    fail('Controller stop metadata is malformed')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    fail('Controller stop metadata is malformed')
  }
  const raw = parsed as Record<string, unknown>
  for (const key of Object.keys(raw)) {
    if (!(STOP_FIELDS as readonly string[]).includes(key)) fail('Controller stop metadata is malformed')
  }
  for (const field of STOP_FIELDS) {
    if (!(field in raw)) fail('Controller stop metadata is malformed')
  }
  if (raw.version !== CONTROLLER_LEASE_VERSION) fail('Controller stop metadata is malformed')
  if (typeof raw.token !== 'string' || !TOKEN_PATTERN.test(raw.token)) {
    fail('Controller stop metadata is malformed')
  }
  if (typeof raw.requestedAt !== 'string' || !Number.isFinite(Date.parse(raw.requestedAt))) {
    fail('Controller stop metadata is malformed')
  }
  return {
    version: CONTROLLER_LEASE_VERSION,
    token: raw.token,
    requestedAt: raw.requestedAt,
  }
}

function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}

function ownersEqual(left: OwnerRecord, right: OwnerRecord): boolean {
  return left.version === right.version
    && left.pid === right.pid
    && left.startedAt === right.startedAt
    && tokensEqual(left.token, right.token)
}

/**
 * Probe controller PID liveness without signaling for stop.
 * live | eperm preserves the lock; esrch is confirmed dead; invalid is uncertain.
 */
function probePid(pid: number): 'live' | 'dead' | 'eperm' | 'invalid' {
  if (!Number.isSafeInteger(pid) || pid <= 1) return 'invalid'
  try {
    process.kill(pid, 0)
    return 'live'
  } catch (error) {
    if (isErrno(error, 'ESRCH')) return 'dead'
    if (isErrno(error, 'EPERM')) return 'eperm'
    return 'invalid'
  }
}

function readOwnerFile(ownerPath: string): { owner: OwnerRecord; stats: Stats } {
  try {
    const { bytes, stats } = readBoundedFile(ownerPath, MAX_OWNER_BYTES)
    return { owner: parseOwner(bytes), stats }
  } catch (error) {
    if (isErrno(error, 'ENOENT')) fail('Controller owner metadata is missing')
    throw error
  }
}

function readOwnerFileOptional(ownerPath: string): { owner: OwnerRecord; stats: Stats } | 'missing' | 'corrupt' {
  try {
    if (!existsSync(ownerPath)) return 'missing'
    const before = lstatSync(ownerPath)
    if (before.isSymbolicLink() || !before.isFile()) return 'corrupt'
    const { bytes, stats } = readBoundedFile(ownerPath, MAX_OWNER_BYTES)
    return { owner: parseOwner(bytes), stats }
  } catch {
    return 'corrupt'
  }
}

function claimPresent(lockDir: string): boolean {
  try {
    const claimPath = join(lockDir, RECOVERY_CLAIM)
    if (!existsSync(claimPath)) return false
    const info = lstatSync(claimPath)
    return info.isFile() || info.isSymbolicLink()
  } catch {
    return true
  }
}

function newToken(): string {
  return randomBytes(32).toString('hex')
}

function ownerPayload(owner: OwnerRecord): string {
  return `${JSON.stringify({
    version: owner.version,
    pid: owner.pid,
    token: owner.token,
    startedAt: owner.startedAt,
  })}\n`
}

function createOwnerRecord(): OwnerRecord {
  return {
    version: CONTROLLER_LEASE_VERSION,
    pid: process.pid,
    token: newToken(),
    startedAt: new Date().toISOString(),
  }
}

function installOwner(lockDir: string, owner: OwnerRecord): { ownerPath: string; stats: Stats } {
  const ownerPath = join(lockDir, OWNER_FILE)
  const stats = writeExclusivePrivateFile(ownerPath, ownerPayload(owner))
  return { ownerPath, stats }
}

function mkdirPrivateLock(lockDir: string): Stats {
  mkdirSync(lockDir, { mode: PRIVATE_DIR_MODE })
  let created: Stats
  try {
    created = lstatSync(lockDir)
  } catch (error) {
    throw error
  }
  if (created.isSymbolicLink() || !created.isDirectory()) {
    fail('Lock path must be a real directory')
  }
  let fd: number | undefined
  try {
    fd = openPrivateDirectory(lockDir)
    const opened = fstatSync(fd)
    if (!opened.isDirectory() || !sameIdentity(opened, created)) {
      fail('Lock directory identity mismatch after create')
    }
    fchmodSync(fd, PRIVATE_DIR_MODE)
    const stats = fstatSync(fd)
    if (!sameIdentity(stats, created)) fail('Lock directory identity mismatch after create')
    assertPrivateDirMode(stats.mode)
    assertCurrentOwner(stats.uid)
    closeSync(fd)
    fd = undefined
    const verified = lstatSync(lockDir)
    if (verified.isSymbolicLink() || !verified.isDirectory() || !sameIdentity(verified, stats)) {
      fail('Lock path must be a real directory')
    }
    assertPrivateDirMode(verified.mode)
    assertCurrentOwner(verified.uid)
    return verified
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* best-effort */ }
    }
    rmdirOwned(lockDir, identityOf(created))
    throw error
  }
}

function unlinkOwnedFile(path: string, expected: PathIdentity): void {
  let info: Stats
  try {
    info = lstatSync(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return
    throw error
  }
  if (info.isSymbolicLink() || !info.isFile() || !sameIdentity(info, expected)) return
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
  // Confirm we did not race-delete a replacement: if a different file appeared, leave it.
  try {
    const after = lstatSync(path)
    if (!after.isSymbolicLink() && after.isFile() && sameIdentity(after, expected)) {
      fail('Owned file still present after unlink')
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
}

function rmdirOwned(path: string, expected: PathIdentity): void {
  let info: Stats
  try {
    info = lstatSync(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return
    throw error
  }
  if (info.isSymbolicLink() || !info.isDirectory() || !sameIdentity(info, expected)) return
  try {
    rmdirSync(path)
  } catch (error) {
    // Non-empty or replaced directory: leave foreign contents untouched.
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTEMPTY') || isErrno(error, 'EEXIST')) return
    throw error
  }
}

function assertHeldOwnership(held: HeldLease): void {
  let lockInfo: Stats
  try {
    lockInfo = lstatSync(held.lockDir)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) ownershipLost('lock directory missing')
    ownershipUnknown(errorMessage(error))
  }
  if (lockInfo.isSymbolicLink() || !lockInfo.isDirectory() || !sameIdentity(lockInfo, held.lockIdentity)) {
    ownershipLost('lock directory replaced')
  }
  assertPrivateDirMode(lockInfo.mode)
  assertCurrentOwner(lockInfo.uid)

  let ownerInfo: Stats
  try {
    ownerInfo = lstatSync(held.ownerPath)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) ownershipLost('owner metadata missing')
    ownershipUnknown(errorMessage(error))
  }
  if (ownerInfo.isSymbolicLink() || !ownerInfo.isFile() || !sameIdentity(ownerInfo, held.ownerIdentity)) {
    ownershipLost('owner identity replaced')
  }
  assertExactPrivateFileMode(ownerInfo.mode)
  assertCurrentOwner(ownerInfo.uid)

  const current = readOwnerFile(held.ownerPath)
  if (!sameIdentity(current.stats, held.ownerIdentity) || !ownersEqual(current.owner, held.owner)) {
    ownershipLost('owner metadata no longer matches this lease')
  }
}

function holdLease(
  dataDir: string,
  lockDir: string,
  lockIdentity: PathIdentity,
  owner: OwnerRecord,
  ownerPath: string,
  ownerIdentity: PathIdentity,
): ControllerLease {
  const held: HeldLease = {
    dataDir,
    lockDir,
    ownerPath,
    stopPath: join(lockDir, STOP_FILE),
    owner,
    lockIdentity,
    ownerIdentity,
    released: false,
  }

  return {
    shouldStop(): boolean {
      if (held.released) return false
      try {
        assertHeldOwnership(held)

        let stopRead: { bytes: Buffer; stats: Stats }
        try {
          stopRead = readBoundedFile(held.stopPath, MAX_STOP_BYTES)
        } catch (error) {
          if (isErrno(error, 'ENOENT')) return false
          throw error
        }
        const stop = parseStop(stopRead.bytes)
        return tokensEqual(stop.token, held.owner.token)
      } catch (error) {
        const message = errorMessage(error)
        if (/ownership was lost|ownership is unknown|stop metadata is malformed|owner metadata is malformed/i.test(message)) {
          throw error instanceof Error ? error : new Error(redactSecrets(message))
        }
        ownershipUnknown(message)
      }
    },

    release(): void {
      if (held.released) return
      try {
        let lockInfo: Stats
        try {
          lockInfo = lstatSync(held.lockDir)
        } catch (error) {
          if (isErrno(error, 'ENOENT')) ownershipLost('lock directory missing')
          throw error
        }
        if (lockInfo.isSymbolicLink() || !lockInfo.isDirectory() || !sameIdentity(lockInfo, held.lockIdentity)) {
          ownershipLost('lock directory replaced')
        }
        assertPrivateDirMode(lockInfo.mode)
        assertCurrentOwner(lockInfo.uid)

        let ownerInfo: Stats
        try {
          ownerInfo = lstatSync(held.ownerPath)
        } catch (error) {
          if (isErrno(error, 'ENOENT')) ownershipLost('owner metadata missing')
          throw error
        }
        if (ownerInfo.isSymbolicLink() || !ownerInfo.isFile() || !sameIdentity(ownerInfo, held.ownerIdentity)) {
          ownershipLost('owner identity replaced')
        }
        assertExactPrivateFileMode(ownerInfo.mode)
        assertCurrentOwner(ownerInfo.uid)

        // Re-read to ensure content still matches this lease before deleting.
        const current = readOwnerFile(held.ownerPath)
        if (!sameIdentity(current.stats, held.ownerIdentity) || !ownersEqual(current.owner, held.owner)) {
          ownershipLost('owner metadata no longer matches this lease')
        }

        const contents = readdirSync(held.lockDir)
        if (contents.some(name => name !== OWNER_FILE && name !== STOP_FILE))
          ownershipUnknown('unrecognized evidence prevents safe release')
        if (contents.includes(STOP_FILE)) {
          const stopRead = readBoundedFile(held.stopPath, MAX_STOP_BYTES)
          const stop = parseStop(stopRead.bytes)
          if (!tokensEqual(stop.token, held.owner.token)) ownershipUnknown('stop evidence belongs to another lease')
          unlinkOwnedFile(held.stopPath, identityOf(stopRead.stats))
        }

        unlinkOwnedFile(held.ownerPath, held.ownerIdentity)
        rmdirOwned(held.lockDir, held.lockIdentity)
        if (existsSync(held.lockDir)) ownershipUnknown('lease directory could not be safely removed')
        held.released = true
      } catch (error) {
        const message = errorMessage(error)
        if (/ownership was lost|ownership is unknown/i.test(message)) {
          throw error instanceof Error ? error : new Error(redactSecrets(message))
        }
        fail(`Controller lease release failed: ${message}`)
      }
    },
  }
}

function quarantineName(claimNonce: string): string {
  return `${OWNER_FILE}.quarantine.${claimNonce}`
}

function writeRecoveryClaim(lockDir: string): { path: string; claim: RecoveryClaim; stats: Stats } {
  const claim: RecoveryClaim = {
    version: CONTROLLER_LEASE_VERSION,
    pid: process.pid,
    nonce: randomBytes(16).toString('hex'),
    createdAt: new Date().toISOString(),
  }
  const path = join(lockDir, RECOVERY_CLAIM)
  const payload = `${JSON.stringify({
    version: claim.version,
    pid: claim.pid,
    nonce: claim.nonce,
    createdAt: claim.createdAt,
  })}\n`
  if (Buffer.byteLength(payload, 'utf8') > MAX_CLAIM_BYTES) fail('Recovery claim exceeds size limit')
  try {
    const stats = writeExclusivePrivateFile(path, payload)
    return { path, claim, stats }
  } catch (error) {
    if (isErrno(error, 'EEXIST')) {
      fail('Controller lease recovery is already in progress or left uncertain; explicit intervention required')
    }
    throw error
  }
}

function readRecoveryClaim(path: string): { claim: RecoveryClaim; stats: Stats } | undefined {
  try {
    const { bytes, stats } = readBoundedFile(path, MAX_CLAIM_BYTES)
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const raw = parsed as Record<string, unknown>
    for (const key of Object.keys(raw)) {
      if (!(CLAIM_FIELDS as readonly string[]).includes(key)) return undefined
    }
    if (raw.version !== CONTROLLER_LEASE_VERSION) return undefined
    if (!Number.isSafeInteger(raw.pid) || (raw.pid as number) <= 1) return undefined
    if (typeof raw.nonce !== 'string' || !/^[0-9a-f]{32}$/.test(raw.nonce)) return undefined
    if (typeof raw.createdAt !== 'string' || !Number.isFinite(Date.parse(raw.createdAt))) return undefined
    return {
      claim: {
        version: CONTROLLER_LEASE_VERSION,
        pid: raw.pid as number,
        nonce: raw.nonce,
        createdAt: raw.createdAt,
      },
      stats,
    }
  } catch {
    return undefined
  }
}

/** Remove only a verified stop that authenticated the observed dead owner; otherwise fail closed. */
function removeVerifiedStaleStop(lockDir: string, deadOwner: OwnerRecord): void {
  const stopPath = join(lockDir, STOP_FILE)
  let info: Stats
  try {
    info = lstatSync(stopPath)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return
    fail(`Controller stale stop could not be inspected: ${errorMessage(error)}`)
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    fail('Controller stale stop is unsafe; recovery blocked')
  }
  let stopRead: { bytes: Buffer; stats: Stats }
  try {
    stopRead = readBoundedFile(stopPath, MAX_STOP_BYTES)
  } catch (error) {
    fail(`Controller stale stop is unsafe; recovery blocked: ${errorMessage(error)}`)
  }
  const stop = parseStop(stopRead.bytes)
  if (!tokensEqual(stop.token, deadOwner.token)) {
    fail('Controller stale stop does not match dead owner; recovery blocked')
  }
  unlinkOwnedFile(stopPath, identityOf(stopRead.stats))
  if (existsSync(stopPath)) {
    fail('Controller stale stop remained after verified removal')
  }
}

function recoverDeadOwner(dataDir: string, lockDir: string, observed: OwnerRecord, observedStats: Stats): ControllerLease {
  const lockInfo = assertPrivateDirectory(lockDir, 'Controller lock directory')
  if (claimPresent(lockDir)) {
    fail('Controller lease recovery is already in progress or left uncertain; explicit intervention required')
  }

  const liveness = probePid(observed.pid)
  if (liveness === 'live' || liveness === 'eperm') {
    fail('Controller lease is held by a live owner')
  }
  if (liveness !== 'dead') {
    fail('Controller owner process state is uncertain')
  }

  const { path: claimPath, claim, stats: claimStats } = writeRecoveryClaim(lockDir)
  try {
    // Revalidate identity and liveness before quarantine.
    const lockAgain = lstatSync(lockDir)
    if (lockAgain.isSymbolicLink() || !lockAgain.isDirectory() || !sameIdentity(lockAgain, lockInfo)) {
      fail('Controller lock directory was replaced during recovery')
    }
    const ownerPath = join(lockDir, OWNER_FILE)
    const current = readOwnerFile(ownerPath)
    if (!sameIdentity(current.stats, observedStats) || !ownersEqual(current.owner, observed)) {
      fail('Controller owner was replaced during recovery')
    }
    const again = probePid(current.owner.pid)
    if (again === 'live' || again === 'eperm') {
      fail('Controller lease is held by a live owner')
    }
    if (again !== 'dead') {
      fail('Controller owner process state is uncertain')
    }

    const ownedClaim = readRecoveryClaim(claimPath)
    if (!ownedClaim || !sameIdentity(ownedClaim.stats, claimStats) || ownedClaim.claim.nonce !== claim.nonce) {
      fail('Controller recovery claim was replaced')
    }

    const quarantinePath = join(lockDir, quarantineName(claim.nonce))
    try {
      renameSync(ownerPath, quarantinePath)
    } catch (error) {
      fail(`Controller owner quarantine failed: ${errorMessage(error)}`)
    }

    // Confirm quarantine landed on the same inode we observed.
    const quarantined = lstatSync(quarantinePath)
    if (quarantined.isSymbolicLink() || !quarantined.isFile() || !sameIdentity(quarantined, observedStats)) {
      fail('Controller owner quarantine identity mismatch')
    }
    if (existsSync(ownerPath)) {
      fail('Controller owner still present after quarantine')
    }

    // Before replacement: clear only a stop authenticated for this dead owner+inode.
    removeVerifiedStaleStop(lockDir, observed)

    const replacement = createOwnerRecord()
    const installed = installOwner(lockDir, replacement)

    // Remove only our quarantined stale file and our claim.
    unlinkOwnedFile(quarantinePath, identityOf(quarantined))
    unlinkOwnedFile(claimPath, claimStats)

    return holdLease(dataDir, lockDir, identityOf(lockAgain), replacement, installed.ownerPath, identityOf(installed.stats))
  } catch (error) {
    // Uncertain mid-recovery: leave claim/quarantine for explicit intervention; do not roll forward.
    fail(`Controller lease recovery failed closed: ${errorMessage(error)}`)
  }
}

function acquireExistingLock(dataDir: string, lockDir: string): ControllerLease {
  const lockInfo = assertPrivateDirectory(lockDir, 'Controller lock directory')
  if (claimPresent(lockDir)) {
    fail('Controller owner metadata is unknown; lease acquisition blocked')
  }

  const ownerPath = join(lockDir, OWNER_FILE)
  const observed = readOwnerFileOptional(ownerPath)
  if (observed === 'missing' || observed === 'corrupt') {
    fail('Controller owner metadata is unknown; lease acquisition blocked')
  }

  const liveness = probePid(observed.owner.pid)
  if (liveness === 'live' || liveness === 'eperm') {
    fail('Controller lease is held by a live owner')
  }
  if (liveness === 'invalid') {
    fail('Controller owner process state is uncertain')
  }
  // Confirmed dead: recover inside the existing lock directory.
  void lockInfo
  return recoverDeadOwner(dataDir, lockDir, observed.owner, observed.stats)
}

/**
 * Acquire exclusive local control-plane ownership under dataDir/controller.lock.
 * Never creates the data directory or a database. Fail closed on uncertain ownership.
 */
export function acquireControllerLease(input: { dataDir: string }): ControllerLease {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('Invalid acquireControllerLease input')
  }
  const dataDir = assertExistingDataDir(input.dataDir)
  const lockDir = lockDirPath(dataDir)
  rejectSymlinkComponents(lockDir, true)

  try {
    const lockInfo = mkdirPrivateLock(lockDir)
    try {
      const owner = createOwnerRecord()
      const installed = installOwner(lockDir, owner)
      return holdLease(dataDir, lockDir, identityOf(lockInfo), owner, installed.ownerPath, identityOf(installed.stats))
    } catch (error) {
      // Partial create: only remove empty lock dir matching the inode we created.
      rmdirOwned(lockDir, identityOf(lockInfo))
      throw error
    }
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) {
      fail(`Controller lease acquisition failed: ${errorMessage(error)}`)
    }
    return acquireExistingLock(dataDir, lockDir)
  }
}

/**
 * Query controller liveness. Does not create roots, lock files, or databases.
 * Never returns or logs the owner token.
 */
export function inspectController(dataDir: string): ControllerInspectResult {
  const absolute = resolveQueryDataDir(dataDir)
  if (absolute === undefined) return { state: 'stopped' }

  const lockDir = lockDirPath(absolute)
  try {
    rejectSymlinkComponents(lockDir, true)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { state: 'stopped' }
    throw error
  }

  let lockInfo: Stats
  try {
    lockInfo = lstatSync(lockDir)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { state: 'stopped' }
    throw error
  }
  if (lockInfo.isSymbolicLink() || !lockInfo.isDirectory()) return { state: 'unknown' }
  try {
    assertPrivateDirMode(lockInfo.mode)
    assertCurrentOwner(lockInfo.uid)
  } catch {
    return { state: 'unknown' }
  }

  if (claimPresent(lockDir)) return { state: 'unknown' }

  const observed = readOwnerFileOptional(join(lockDir, OWNER_FILE))
  if (observed === 'missing' || observed === 'corrupt') return { state: 'unknown' }

  const liveness = probePid(observed.owner.pid)
  if (liveness === 'live') return { state: 'running', pid: observed.owner.pid }
  if (liveness === 'dead') return { state: 'stopped', pid: observed.owner.pid }
  return { state: 'unknown', pid: observed.owner.pid }
}

function assertSafeExistingStop(stopPath: string): void {
  let info: Stats
  try {
    info = lstatSync(stopPath)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return
    fail(`Controller stop could not be inspected: ${errorMessage(error)}`)
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    fail('Controller stop path is unsafe; stop request blocked')
  }
  try {
    const { bytes } = readBoundedFile(stopPath, MAX_STOP_BYTES)
    parseStop(bytes)
  } catch (error) {
    fail(`Controller stop is unsafe or malformed; stop request blocked: ${errorMessage(error)}`)
  }
}

/**
 * Request graceful stop by writing an authenticated private stop file.
 * Does not signal by PID. Does not create missing roots or databases.
 */
export function requestControllerStop(dataDir: string): { requested: boolean } {
  const absolute = resolveQueryDataDir(dataDir)
  if (absolute === undefined) return { requested: false }

  const lockDir = lockDirPath(absolute)
  try {
    rejectSymlinkComponents(lockDir, true)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { requested: false }
    throw error
  }

  let lockInfo: Stats
  try {
    lockInfo = lstatSync(lockDir)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { requested: false }
    throw error
  }
  if (lockInfo.isSymbolicLink() || !lockInfo.isDirectory()) {
    fail('Controller lock path is not a usable directory')
  }
  assertPrivateDirMode(lockInfo.mode)
  assertCurrentOwner(lockInfo.uid)

  if (claimPresent(lockDir)) {
    fail('Controller state is unknown; stop request blocked')
  }

  const ownerPath = join(lockDir, OWNER_FILE)
  const observed = readOwnerFileOptional(ownerPath)
  if (observed === 'missing' || observed === 'corrupt') {
    fail('Controller owner metadata is unknown; stop request blocked')
  }

  const liveness = probePid(observed.owner.pid)
  if (liveness === 'dead') return { requested: false }
  if (liveness !== 'live' && liveness !== 'eperm') {
    fail('Controller owner process state is uncertain; stop request blocked')
  }

  const stopPath = join(lockDir, STOP_FILE)
  assertSafeExistingStop(stopPath)

  // Re-check owner identity+contents immediately before write.
  const before = readOwnerFile(ownerPath)
  if (!sameIdentity(before.stats, observed.stats) || !ownersEqual(before.owner, observed.owner)) {
    fail('Controller owner was replaced during stop request')
  }
  const lockBefore = lstatSync(lockDir)
  if (lockBefore.isSymbolicLink() || !lockBefore.isDirectory() || !sameIdentity(lockBefore, lockInfo)) {
    fail('Controller lock directory was replaced during stop request')
  }

  const payload = `${JSON.stringify({
    version: CONTROLLER_LEASE_VERSION,
    token: before.owner.token,
    requestedAt: new Date().toISOString(),
  })}\n`
  atomicWritePrivateFile(stopPath, payload, lockDir, identityOf(lockInfo))

  // After write: owner must still be the same lease; otherwise do not report success.
  const after = readOwnerFile(ownerPath)
  if (!sameIdentity(after.stats, before.stats) || !ownersEqual(after.owner, before.owner)) {
    fail('Controller owner was replaced during stop request')
  }
  const lockAfter = lstatSync(lockDir)
  if (lockAfter.isSymbolicLink() || !lockAfter.isDirectory() || !sameIdentity(lockAfter, lockInfo)) {
    fail('Controller lock directory was replaced during stop request')
  }

  return { requested: true }
}
