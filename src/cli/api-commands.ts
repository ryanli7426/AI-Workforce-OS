/** Local HTTP API credential init and foreground serve CLI. Parent routes these before other dispatchers. */
import {
  lstatSync,
  realpathSync,
} from 'node:fs'
import type { AddressInfo } from 'node:net'
import { join, parse, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  ApiAuthError,
  assertLocalRequest,
  createLocalApiCredentials,
  loadLocalApiAuthenticator,
} from '../api/auth.ts'
import { createApiServer } from '../api/server.ts'
import { loadSettings } from '../config/settings.ts'
import { redact } from '../security/redaction.ts'
import { applicationRepositories } from '../storage/application-store.ts'
import { requireCommandSchema } from '../storage/command-receipts.ts'
import { LAO_SCHEMA_VERSION, LocalStore } from '../storage/store.ts'

export interface ApiCliIO {
  stdout: { write(value: string): unknown }
  stderr: { write(value: string): unknown }
}

const COMMANDS = ['api-init', 'api-serve'] as const
type CommandName = (typeof COMMANDS)[number]

const DEFAULT_PORT = 4310
/** Bound wait for Fastify close before force-closing only this server's connections. */
const CLOSE_GRACE_MS = 1_500
const OPAQUE_TOKEN_PATTERN = /\b[0-9a-fA-F]{64}\b/g
const TRUSTED_DARWIN_ALIASES = new Set(['/var', '/tmp'])
const PRIVATE_DIR_MASK = 0o077
const RUNTIME_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const

interface BaseParsed {
  command: CommandName
  dataDir: string
}

interface ApiInitCommand extends BaseParsed {
  command: 'api-init'
}

interface ApiServeCommand extends BaseParsed {
  command: 'api-serve'
  port: number
  allowOrigin?: string
}

type ParsedApiCommand = ApiInitCommand | ApiServeCommand

function fail(message: string): never {
  throw new Error(message)
}

function isCommandName(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value)
}

function databasePath(dataDir: string): string {
  return resolve(dataDir, 'workforce.sqlite')
}

function settingsPath(dataDir: string): string {
  return resolve(dataDir, 'settings.json')
}

function writeJson(io: ApiCliIO, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value)}\n`)
}

function secretValues(): string[] {
  const values: string[] = []
  for (const key of RUNTIME_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string' && value.length > 0) values.push(value)
  }
  return values
}

/** Scrub opaque 64-hex token-like values that generic redact does not mask as bare literals. */
function scrubOpaqueTokens(message: string): string {
  return message.replace(OPAQUE_TOKEN_PATTERN, '[REDACTED]')
}

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error'
  try {
    return scrubOpaqueTokens(redact(message, secretValues()))
  } catch {
    return scrubOpaqueTokens(redact(message))
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && (error as NodeJS.ErrnoException).code === code
}

function isTrustedDarwinAlias(current: string, canonical: string): boolean {
  return process.platform === 'darwin'
    && TRUSTED_DARWIN_ALIASES.has(current)
    && canonical === `/private${current}`
}

/** Reject symlink path components except trusted macOS /tmp and /var aliases. */
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
      throw error
    }
    if (info.isSymbolicLink()) {
      const canonical = realpathSync(current)
      if (!isTrustedDarwinAlias(current, canonical)) {
        fail('Symbolic link path component is unsupported')
      }
    }
  }
}

function requireOptionValue(options: readonly string[], index: number, name: string): string {
  const value = options[index]
  if (!value || value.startsWith('-')) fail(`Missing value for ${name}`)
  return value
}

function parsePort(raw: string): number {
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) fail('Invalid value for --port')
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) fail('Invalid value for --port')
  return port
}

function parseArgs(argv: readonly string[]): ParsedApiCommand {
  const [command, ...options] = argv
  if (command === undefined || !isCommandName(command)) fail('internal: unrecognized command')

  let dataDir = resolve(process.cwd(), '.workforce')
  let dataDirSeen = false
  let port = DEFAULT_PORT
  let portSeen = false
  let allowOrigin: string | undefined
  let allowOriginSeen = false

  for (let index = 0; index < options.length; index++) {
    const option = options[index]!
    if (option === '--data-dir') {
      if (dataDirSeen) fail('Option --data-dir may only be provided once')
      dataDir = resolve(process.cwd(), requireOptionValue(options, ++index, '--data-dir'))
      dataDirSeen = true
      continue
    }
    if (option === '--port') {
      if (command !== 'api-serve') fail('Unknown option')
      if (portSeen) fail('Option --port may only be provided once')
      port = parsePort(requireOptionValue(options, ++index, '--port'))
      portSeen = true
      continue
    }
    if (option === '--allow-origin') {
      if (command !== 'api-serve') fail('Unknown option')
      if (allowOriginSeen) fail('Option --allow-origin may only be provided once')
      allowOrigin = requireOptionValue(options, ++index, '--allow-origin')
      allowOriginSeen = true
      continue
    }
    // Never echo arbitrary argv into stderr: tokens are 64-hex bare values.
    if (option.startsWith('-')) fail('Unknown option')
    fail('Unexpected argument')
  }

  if (command === 'api-init') {
    return { command, dataDir }
  }
  if (allowOrigin !== undefined) {
    // Validate before any filesystem or listen side effects.
    resolveAllowedOrigins(port, allowOrigin)
  }
  return {
    command,
    dataDir,
    port,
    ...(allowOrigin !== undefined ? { allowOrigin } : {}),
  }
}

function assertPrivateRealDataDir(dataDir: string): void {
  try {
    rejectSymlinkComponents(dataDir, false)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      fail(`Database is not initialized at ${databasePath(dataDir)}; run init first`)
    }
    throw error
  }
  let entry
  try {
    entry = lstatSync(dataDir)
  } catch {
    fail(`Database is not initialized at ${databasePath(dataDir)}; run init first`)
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail('Data directory must be a real directory')
  if (process.platform !== 'win32' && (entry.mode & PRIVATE_DIR_MASK) !== 0) {
    fail('Existing data directory must be private (0700); choose a dedicated directory')
  }
  if (typeof process.getuid === 'function' && entry.uid !== process.getuid()) {
    fail('Data directory must be owned by the current user')
  }
}

function assertRealDatabaseFile(path: string): void {
  try {
    rejectSymlinkComponents(path, false)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) fail(`Database is not initialized at ${path}; run init first`)
    throw error
  }
  let entry
  try {
    entry = lstatSync(path)
  } catch {
    fail(`Database is not initialized at ${path}; run init first`)
  }
  if (entry.isSymbolicLink()) fail('Database path must not be a symbolic link')
  if (!entry.isFile()) fail(`Database is not initialized at ${path}; run init first`)
  if (typeof process.getuid === 'function' && entry.uid !== process.getuid()) {
    fail('Database file must be owned by the current user')
  }
}

function readMainSchema(db: DatabaseSync): void {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('kv', 'ticket')").all()
    .map(row => String(row.name)))
  if (!tables.has('kv')) fail('Database is not initialized: schema metadata is missing')

  const row = db.prepare("SELECT value FROM kv WHERE key = 'schema'").get()
  if (!row) fail('Database is not initialized: schema version is missing')
  let schema: unknown
  try {
    schema = JSON.parse(String(row.value))
  } catch {
    fail('Database is not initialized: schema version is invalid')
  }
  if (!Number.isInteger(schema)) fail('Database is not initialized: schema version is invalid')
  if (schema === 11) {
    fail(`Legacy LAO schema 11 cannot be queried; explicitly migrate it to schema ${LAO_SCHEMA_VERSION}`)
  }
  if (schema !== LAO_SCHEMA_VERSION) {
    fail(`Unsupported LAO schema ${String(schema)}; expected schema ${LAO_SCHEMA_VERSION}`)
  }
  if (!tables.has('ticket')) fail(`Database schema ${LAO_SCHEMA_VERSION} is incomplete: ticket table is missing`)
}

/** Readonly main + module + command schema validation. Never migrates or creates storage. */
function validateInitializedDataDir(dataDir: string): string {
  assertPrivateRealDataDir(dataDir)
  const path = databasePath(dataDir)
  assertRealDatabaseFile(path)
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    readMainSchema(db)
    applicationRepositories(db)
    requireCommandSchema(db)
  } finally {
    db?.close()
  }
  return path
}

function defaultAllowedOrigins(port: number): readonly string[] {
  if (port === 0) return Object.freeze([])
  return Object.freeze([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ])
}

function resolveAllowedOrigins(port: number, allowOrigin: string | undefined): readonly string[] {
  if (allowOrigin === undefined) return defaultAllowedOrigins(port)
  try {
    assertLocalRequest({
      host: '127.0.0.1',
      origin: allowOrigin,
      allowedOrigins: [allowOrigin],
    })
  } catch (error) {
    if (error instanceof ApiAuthError) fail('Invalid value for --allow-origin')
    throw error
  }
  return Object.freeze([allowOrigin])
}

function sanitizeServeFailure(error: unknown): string {
  if (isErrno(error, 'EADDRINUSE')) return 'API listen address is already in use'
  if (error instanceof ApiAuthError) {
    if (error.code === 'UNAUTHORIZED') return 'Unauthorized'
    if (error.code === 'INVALID_AUTH_CONFIG') return 'Invalid API auth configuration'
    if (error.code === 'FORBIDDEN_ORIGIN') return 'Forbidden origin'
    if (error.code === 'INVALID_HOST') return 'Invalid host'
  }
  const message = redactError(error)
  if (/Bearer\s+[0-9a-fA-F]{16,}|[0-9a-f]{64}|api-auth|Authorization/i.test(message)) {
    return 'API serve failed'
  }
  return message || 'API serve failed'
}

/** Prefer a full http:// URL from the bound socket; otherwise stable host:port. */
function formatListeningAddress(
  listeningAddress: string,
  server: { address(): string | AddressInfo | null },
): string {
  const addressInfo = server.address()
  if (typeof addressInfo === 'object' && addressInfo !== null) {
    const host = addressInfo.address === '::' || addressInfo.address === '::1'
      ? '127.0.0.1'
      : addressInfo.address
    return `http://${host}:${addressInfo.port}`
  }
  if (/^https?:\/\//i.test(listeningAddress)) return listeningAddress
  return String(listeningAddress).replace(/^https?:\/\//, '')
}

/**
 * Graceful Fastify close with a bound wait, then Node 22 force-close of only this
 * HTTP server's connections so a partial request cannot pin the process forever.
 */
async function closeApiServer(
  app: Awaited<ReturnType<typeof createApiServer>>,
): Promise<void> {
  const server = app.server
  const forceTimer = setTimeout(() => {
    try {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections()
      }
    } catch {
      // Best-effort; close() result still awaited below.
    }
  }, CLOSE_GRACE_MS)
  try {
    await app.close()
  } finally {
    clearTimeout(forceTimer)
  }
}

function handleInit(parsed: ApiInitCommand, io: ApiCliIO): number {
  validateInitializedDataDir(parsed.dataDir)
  const created = createLocalApiCredentials(parsed.dataDir)
  writeJson(io, { path: created.path, createdAt: created.createdAt })
  return 0
}

async function handleServe(parsed: ApiServeCommand, io: ApiCliIO): Promise<number> {
  const absoluteDataDir = resolve(parsed.dataDir)
  const dbPath = validateInitializedDataDir(absoluteDataDir)
  const settings = loadSettings(settingsPath(absoluteDataDir))
  const authenticator = loadLocalApiAuthenticator({
    dataDir: absoluteDataDir,
    ownerId: settings.ownerId,
    workspaceId: settings.workspaceId,
  })
  const allowedOrigins = resolveAllowedOrigins(parsed.port, parsed.allowOrigin)

  let store: LocalStore | undefined
  let app: Awaited<ReturnType<typeof createApiServer>> | undefined
  let onSignal: (() => void) | undefined
  let resolveStop: (() => void) | undefined
  let serveError: unknown

  const stopPromise = new Promise<void>(resolvePromise => {
    resolveStop = resolvePromise
  })

  try {
    // Own this process's stop channel before listen so SIGTERM during startup cannot
    // fall through to Node's default exit while LocalStore is open.
    onSignal = () => {
      resolveStop?.()
      resolveStop = undefined
    }
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)

    store = new LocalStore(dbPath)
    app = createApiServer({
      store,
      settings,
      authenticator,
      allowedOrigins,
      dataDir: absoluteDataDir,
    })
    const listeningAddress = await app.listen({
      host: '127.0.0.1',
      port: parsed.port,
    })
    writeJson(io, {
      listening: true,
      address: formatListeningAddress(listeningAddress, app.server),
      workspaceId: settings.workspaceId,
    })

    await stopPromise
  } catch (error) {
    serveError = error
  } finally {
    if (onSignal !== undefined) {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
      onSignal = undefined
    }
    resolveStop = undefined

    if (app !== undefined) {
      try {
        await closeApiServer(app)
      } catch (error) {
        if (serveError === undefined) serveError = error
      }
      app = undefined
    }
    if (store !== undefined) {
      try {
        store.close()
      } catch (error) {
        if (serveError === undefined) serveError = error
      }
      store = undefined
    }
  }

  if (serveError !== undefined) {
    fail(sanitizeServeFailure(serveError))
  }
  return 0
}

/**
 * Dispatches API CLI commands. Returns undefined only when the command is unrecognized
 * so the parent can fall through to controller/task/legacy handlers.
 */
export async function runApiCommand(
  argv: readonly string[],
  io: ApiCliIO = process,
): Promise<number | undefined> {
  const command = argv[0]
  if (command === undefined || !isCommandName(command)) return undefined

  try {
    const parsed = parseArgs(argv)
    switch (parsed.command) {
      case 'api-init':
        return handleInit(parsed, io)
      case 'api-serve':
        return await handleServe(parsed, io)
    }
  } catch (error) {
    io.stderr.write(`Error: ${redactError(error)}\n`)
    return 1
  }
}
