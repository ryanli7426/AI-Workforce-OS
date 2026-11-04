/** Local loopback API credentials and owner Bearer authentication. Node builtins only. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'

export const API_AUTH_SCHEMA_VERSION = 1 as const
export const API_AUTH_FILE_NAME = 'api-auth.json' as const
export const DEFAULT_API_WORKSPACE_ID = 'local' as const

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const TOKEN_HEX = /^[0-9a-f]{64}$/
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const MAX_CREDENTIAL_BYTES = 4 * 1024
const MAX_AUTH_HEADER_BYTES = 256
const PRIVATE_FILE_MODE = 0o600
const PRIVATE_DIR_MODE = 0o700
/** Permission + setuid/setgid/sticky; excludes file-type bits from st_mode. */
const MODE_BITS = 0o7777
const TRUSTED_DARWIN_ALIASES = new Set(['/var', '/tmp'])
const CREDENTIAL_FIELDS = ['schemaVersion', 'token', 'createdAt'] as const
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export type ApiAuthErrorCode =
  | 'UNAUTHORIZED'
  | 'INVALID_AUTH_CONFIG'
  | 'FORBIDDEN_ORIGIN'
  | 'INVALID_HOST'

const ERROR_MESSAGES: Record<ApiAuthErrorCode, string> = {
  UNAUTHORIZED: 'Unauthorized',
  INVALID_AUTH_CONFIG: 'Invalid API auth configuration',
  FORBIDDEN_ORIGIN: 'Forbidden origin',
  INVALID_HOST: 'Invalid host',
}

export class ApiAuthError extends Error {
  readonly code: ApiAuthErrorCode

  constructor(code: ApiAuthErrorCode) {
    super(ERROR_MESSAGES[code])
    this.name = 'ApiAuthError'
    this.code = code
  }
}

export interface LocalApiCredentialsCreated {
  path: string
  createdAt: string
}

export interface OwnerAuthenticator {
  authenticate(header: unknown): { ownerId: string; workspaceId: string }
}

export interface CreateOwnerAuthenticatorInput {
  token: string
  ownerId: string
  workspaceId?: string
}

export interface LoadLocalApiAuthenticatorInput {
  dataDir: string
  ownerId: string
  workspaceId?: string
}

export interface AssertLocalRequestInput {
  host: unknown
  origin: unknown
  allowedOrigins: readonly string[]
}

interface CredentialFile {
  schemaVersion: typeof API_AUTH_SCHEMA_VERSION
  token: string
  createdAt: string
}

function failConfig(): never {
  throw new ApiAuthError('INVALID_AUTH_CONFIG')
}

function failUnauthorized(): never {
  throw new ApiAuthError('UNAUTHORIZED')
}

function failHost(): never {
  throw new ApiAuthError('INVALID_HOST')
}

function failOrigin(): never {
  throw new ApiAuthError('FORBIDDEN_ORIGIN')
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code
}

function requireSafeId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) failConfig()
}

function requireToken(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !TOKEN_HEX.test(value)) failConfig()
}

function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest()
}

function digestsEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right)
}

function isTrustedDarwinAlias(current: string, canonical: string): boolean {
  return process.platform === 'darwin'
    && TRUSTED_DARWIN_ALIASES.has(current)
    && canonical === `/private${current}`
}

/** Reject symlink path components except trusted macOS /var,/tmp aliases. */
function rejectSymlinkComponents(path: string, allowMissingFinal: boolean): void {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  const parts = absolute.slice(root.length).split(sep).filter(Boolean)
  for (let index = 0; index < parts.length; index++) {
    current = join(current, parts[index]!)
    let info
    try {
      info = lstatSync(current)
    } catch (error) {
      if (allowMissingFinal && isErrno(error, 'ENOENT') && index === parts.length - 1) return
      if (isErrno(error, 'ENOENT')) failConfig()
      throw error
    }
    if (info.isSymbolicLink()) {
      const canonical = realpathSync(current)
      if (!isTrustedDarwinAlias(current, canonical)) {
        failConfig()
      }
    }
  }
}

function assertAbsoluteDataDir(dataDir: unknown): string {
  if (typeof dataDir !== 'string' || !dataDir || dataDir.includes('\0') || !isAbsolute(dataDir)) {
    failConfig()
  }
  return resolve(dataDir)
}

function assertCurrentOwner(uid: number | bigint): void {
  if (typeof process.getuid === 'function' && Number(uid) !== process.getuid()) {
    failConfig()
  }
}

function assertExactMode(mode: number | bigint, expected: number): void {
  if (process.platform !== 'win32' && (Number(mode) & MODE_BITS) !== expected) {
    failConfig()
  }
}

function assertPrivateDataDir(dataDir: string): void {
  let info
  try {
    info = lstatSync(dataDir)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) failConfig()
    throw error
  }
  if (info.isSymbolicLink()) failConfig()
  if (!info.isDirectory()) failConfig()
  assertExactMode(info.mode, PRIVATE_DIR_MODE)
  assertCurrentOwner(info.uid)
}

function credentialPathFor(dataDir: string): string {
  return join(dataDir, API_AUTH_FILE_NAME)
}

function unlinkOwnInode(path: string, identity: { dev: number | bigint; ino: number | bigint }): void {
  try {
    const info = lstatSync(path)
    if (info.isSymbolicLink()) return
    if (info.dev === identity.dev && info.ino === identity.ino) {
      unlinkSync(path)
    }
  } catch {
    /* only own inode */
  }
}

/** Drain a write buffer with short-write support; zero/invalid counts fail closed. */
function writeAll(fd: number, data: Buffer): void {
  let offset = 0
  let writes = 0
  while (offset < data.length) {
    if (++writes > data.length) failConfig()
    const remaining = data.length - offset
    const written = writeSync(fd, data, offset, remaining)
    if (!Number.isInteger(written) || written <= 0 || written > remaining) failConfig()
    offset += written
  }
}

function assertPrivateCredentialFd(info: ReturnType<typeof fstatSync>): void {
  if (!info.isFile()) failConfig()
  if (Number(info.size) > MAX_CREDENTIAL_BYTES) failConfig()
  assertExactMode(info.mode, PRIVATE_FILE_MODE)
  assertCurrentOwner(info.uid)
}

function assertSameIdentity(
  info: { dev: number | bigint; ino: number | bigint },
  expected: { dev: number | bigint; ino: number | bigint },
): void {
  if (info.dev !== expected.dev || info.ino !== expected.ino) failConfig()
}

function assertPrivateCredentialPath(
  path: string,
  expectedIdentity?: { dev: number | bigint; ino: number | bigint },
): void {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) failConfig()
    throw error
  }
  if (info.isSymbolicLink()) failConfig()
  if (!info.isFile()) failConfig()
  if (expectedIdentity !== undefined) assertSameIdentity(info, expectedIdentity)
  assertExactMode(info.mode, PRIVATE_FILE_MODE)
  assertCurrentOwner(info.uid)
  if (info.size > MAX_CREDENTIAL_BYTES) failConfig()
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) failConfig()
  return value as Record<string, unknown>
}

function requireOnlyFields(value: Record<string, unknown>, fields: readonly string[]): void {
  const allowed = new Set(fields)
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) failConfig()
  }
}

function requireCanonicalTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value)) failConfig()
  const parsed = Date.parse(value)
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) failConfig()
}

function validateCredentialFile(value: unknown): CredentialFile {
  const raw = requireObject(value)
  requireOnlyFields(raw, CREDENTIAL_FIELDS)
  if (raw.schemaVersion !== API_AUTH_SCHEMA_VERSION) failConfig()
  requireToken(raw.token)
  requireCanonicalTimestamp(raw.createdAt)
  return {
    schemaVersion: API_AUTH_SCHEMA_VERSION,
    token: raw.token,
    createdAt: raw.createdAt,
  }
}

function readCredentialFile(path: string): CredentialFile {
  rejectSymlinkComponents(path, false)
  assertPrivateCredentialPath(path)
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(fd)
    assertPrivateCredentialFd(before)
    const bytes = Buffer.alloc(MAX_CREDENTIAL_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    const buffer = bytes.subarray(0, length)
    const after = fstatSync(fd)
    assertPrivateCredentialFd(after)
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.uid !== after.uid
      || before.mode !== after.mode
    ) {
      failConfig()
    }
    if (buffer.byteLength > MAX_CREDENTIAL_BYTES) failConfig()
    let parsed: unknown
    try {
      parsed = JSON.parse(buffer.toString('utf8')) as unknown
    } catch {
      failConfig()
    }
    return validateCredentialFile(parsed)
  } finally {
    closeSync(fd)
  }
}

function snapshotWorkspaceId(workspaceId: string | undefined): string {
  if (workspaceId === undefined) return DEFAULT_API_WORKSPACE_ID
  requireSafeId(workspaceId)
  return workspaceId
}

function buildAuthenticator(token: string, ownerId: string, workspaceId: string): OwnerAuthenticator {
  const expectedDigest = tokenDigest(token)
  const frozenOwnerId = ownerId
  const frozenWorkspaceId = workspaceId

  const authenticator: OwnerAuthenticator = {
    authenticate(header: unknown): { ownerId: string; workspaceId: string } {
      if (typeof header !== 'string') failUnauthorized()
      if (Buffer.byteLength(header, 'utf8') > MAX_AUTH_HEADER_BYTES) failUnauthorized()
      if (!header.startsWith('Bearer ')) failUnauthorized()
      const presented = header.slice('Bearer '.length)
      if (!TOKEN_HEX.test(presented)) failUnauthorized()
      const presentedDigest = tokenDigest(presented)
      if (!digestsEqual(presentedDigest, expectedDigest)) failUnauthorized()
      return { ownerId: frozenOwnerId, workspaceId: frozenWorkspaceId }
    },
  }

  Object.defineProperty(authenticator, 'toJSON', {
    value() {
      return { ownerId: frozenOwnerId, workspaceId: frozenWorkspaceId }
    },
    enumerable: false,
  })

  return Object.freeze(authenticator)
}

function isValidPort(portText: string): boolean {
  if (!/^\d{1,5}$/.test(portText)) return false
  if (portText.length > 1 && portText.startsWith('0')) return false
  const port = Number(portText)
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}

/** Plain loopback Host: localhost / 127.0.0.1 / [::1] with optional valid port. */
function isValidLoopbackHost(host: string): boolean {
  if (!host || host.includes('\0') || /[@/?#\\]/.test(host) || /\s/.test(host)) return false

  if (host.startsWith('[')) {
    const match = /^\[(::1)\](?::(\d{1,5}))?$/.exec(host)
    if (!match) return false
    if (match[2] !== undefined && !isValidPort(match[2])) return false
    return true
  }

  const match = /^(localhost|127\.0\.0\.1)(?::(\d{1,5}))?$/.exec(host)
  if (!match) return false
  if (match[2] !== undefined && !isValidPort(match[2])) return false
  return true
}

/**
 * Trusted loopback Origin: http(s) only, loopback host, optional port, path empty or `/`,
 * no credentials/query/fragment/wildcard/null.
 */
function isValidLoopbackOrigin(origin: string): boolean {
  if (typeof origin !== 'string' || !origin || origin === 'null' || origin === '*') return false
  if (origin.includes('\0') || /\s/.test(origin)) return false

  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  if (url.search !== '' || url.hash !== '') return false
  if (url.pathname !== '/' && url.pathname !== '') return false
  if (!LOOPBACK_HOSTS.has(url.hostname)) return false

  // Reject forms URL accepts but browsers would not send as exact Origin (e.g. backslash).
  const authority = url.host
  const pathSuffix = origin.endsWith('/') && url.pathname === '/' ? '/' : ''
  const expected = `${url.protocol}//${authority}${pathSuffix}`
  return origin === expected
}

/**
 * Explicit exclusive creation of private `api-auth.json` under an existing self-owned 0700 dataDir.
 * Never creates dataDir/DB, never returns or logs the token, never alters HOME/PATH.
 */
export function createLocalApiCredentials(dataDir: string): LocalApiCredentialsCreated {
  try {
    return createLocalApiCredentialsInner(dataDir)
  } catch (error) {
    if (error instanceof ApiAuthError) throw error
    failConfig()
  }
}

function createLocalApiCredentialsInner(dataDir: string): LocalApiCredentialsCreated {
  const absoluteDir = assertAbsoluteDataDir(dataDir)
  rejectSymlinkComponents(absoluteDir, false)
  assertPrivateDataDir(absoluteDir)

  const path = credentialPathFor(absoluteDir)
  rejectSymlinkComponents(path, true)
  if (existsSync(path)) failConfig()

  const createdAt = new Date().toISOString()
  const token = randomBytes(32).toString('hex')
  const payload = `${JSON.stringify({
    schemaVersion: API_AUTH_SCHEMA_VERSION,
    token,
    createdAt,
  } satisfies CredentialFile)}\n`
  if (Buffer.byteLength(payload, 'utf8') > MAX_CREDENTIAL_BYTES) failConfig()

  let fd: number | undefined
  let createdIdentity: { dev: number | bigint; ino: number | bigint } | undefined
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    )
    const opened = fstatSync(fd)
    createdIdentity = { dev: opened.dev, ino: opened.ino }
    fchmodSync(fd, PRIVATE_FILE_MODE)
    assertPrivateCredentialFd(fstatSync(fd))
    writeAll(fd, Buffer.from(payload, 'utf8'))
    fsyncSync(fd)
    const afterWrite = fstatSync(fd)
    assertPrivateCredentialFd(afterWrite)
    assertSameIdentity(afterWrite, createdIdentity)
    closeSync(fd)
    fd = undefined
    // Path must still name the inode we created; reject replaced regular 0600 files too.
    assertPrivateCredentialPath(path, createdIdentity)
    return { path, createdAt }
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* best-effort */ }
    }
    if (createdIdentity !== undefined) {
      unlinkOwnInode(path, createdIdentity)
    }
    if (error instanceof ApiAuthError) throw error
    if (isErrno(error, 'EEXIST')) failConfig()
    throw error
  }
}

/** Build an owner authenticator from an in-memory token. Config is snapshotted; token stays private. */
export function createOwnerAuthenticator(input: CreateOwnerAuthenticatorInput): OwnerAuthenticator {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) failConfig()
  const token = input.token
  const ownerId = input.ownerId
  requireToken(token)
  requireSafeId(ownerId)
  const workspaceId = snapshotWorkspaceId(input.workspaceId)
  return buildAuthenticator(token, ownerId, workspaceId)
}

/**
 * Load credentials from an existing private file and return an authenticator.
 * Never creates or migrates credentials; never exposes the token.
 */
export function loadLocalApiAuthenticator(input: LoadLocalApiAuthenticatorInput): OwnerAuthenticator {
  try {
    return loadLocalApiAuthenticatorInner(input)
  } catch (error) {
    if (error instanceof ApiAuthError) throw error
    failConfig()
  }
}

function loadLocalApiAuthenticatorInner(input: LoadLocalApiAuthenticatorInput): OwnerAuthenticator {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) failConfig()
  const absoluteDir = assertAbsoluteDataDir(input.dataDir)
  rejectSymlinkComponents(absoluteDir, false)
  assertPrivateDataDir(absoluteDir)
  requireSafeId(input.ownerId)
  const workspaceId = snapshotWorkspaceId(input.workspaceId)

  const path = credentialPathFor(absoluteDir)
  const credentials = readCredentialFile(path)
  return buildAuthenticator(credentials.token, input.ownerId, workspaceId)
}

/**
 * Validate loopback Host and optional Origin for local API requests.
 * Absent Origin is allowed for authenticated CLI; present Origin must exactly match a trusted allowlist entry.
 */
export function assertLocalRequest(input: AssertLocalRequestInput): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) failHost()
  if (!Array.isArray(input.allowedOrigins)) failOrigin()

  const { host, origin } = input
  if (Array.isArray(host)) failHost()
  if (typeof host !== 'string' || !isValidLoopbackHost(host)) failHost()

  if (origin === undefined || origin === null) return
  if (Array.isArray(origin)) failOrigin()
  if (typeof origin !== 'string') failOrigin()

  const trusted = new Set<string>()
  for (const allowed of input.allowedOrigins) {
    if (typeof allowed === 'string' && isValidLoopbackOrigin(allowed)) {
      trusted.add(allowed)
    }
  }
  if (!isValidLoopbackOrigin(origin) || !trusted.has(origin)) failOrigin()
}
