/** Foreground controller and logs CLI. Parent routes these before the legacy sync CLI. */
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from 'node:fs'
import { join, parse, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  runControlLoop,
  type ControlLoopEvent,
} from '../application/control-loop.ts'
import {
  acquireControllerLease,
  inspectController,
  requestControllerStop,
} from '../application/controller-lease.ts'
import { LocalOrchestrator } from '../application/local-orchestrator.ts'
import { composeController } from '../application/controller.ts'
import { LocalTaskService } from '../application/tasks.ts'
import { loadSettings, type LocalSettings } from '../config/settings.ts'
import { readExecutionLogs } from '../observability/execution-logs.ts'
import { validateRuntimeEnvironment } from '../runner/environment.ts'
import { redact } from '../security/redaction.ts'
import { applicationRepositories } from '../storage/application-store.ts'
import { LAO_SCHEMA_VERSION, LocalStore } from '../storage/store.ts'

export interface ControllerCliIO {
  stdout: { write(value: string): unknown }
  stderr: { write(value: string): unknown }
}

const COMMANDS = ['start', 'stop', 'controller-status', 'logs'] as const
type CommandName = (typeof COMMANDS)[number]

const TRUSTED_DARWIN_ALIASES = new Set(['/var', '/tmp'])
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

const EVENT_FILE_NAME = 'controller-events.jsonl'
const MAX_EVENT_FILE_BYTES = 16 * 1024 * 1024
const MAX_EVENT_ROTATIONS = 2
const STOP_POLL_MS = 75
const MIN_TAIL_BYTES = 1
const MAX_TAIL_BYTES = 1024 * 1024
const PRIVATE_FILE_MODE = 0o600
const MODE_BITS = 0o7777
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

interface BaseParsed {
  command: CommandName
  dataDir: string
}

interface StartCommand extends BaseParsed {
  command: 'start'
  foreground: true
}

interface StopCommand extends BaseParsed {
  command: 'stop'
}

interface StatusCommand extends BaseParsed {
  command: 'controller-status'
}

interface LogsCommand extends BaseParsed {
  command: 'logs'
  ticketId: string
  executionId?: string
  tailBytes?: number
}

type ParsedControllerCommand = StartCommand | StopCommand | StatusCommand | LogsCommand

type AbortCause = 'signal' | 'stop-requested' | 'lease-loss' | 'malformed-stop'

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

function eventLogPath(dataDir: string): string {
  return resolve(dataDir, EVENT_FILE_NAME)
}

function writeJson(io: ControllerCliIO, value: unknown): void {
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

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown error'
  try {
    return redact(message, secretValues())
  } catch {
    return redact(message)
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

function parseArgs(argv: readonly string[]): ParsedControllerCommand {
  const [command, ...options] = argv
  if (command === undefined || !isCommandName(command)) fail('internal: unrecognized command')

  let dataDir = resolve(process.cwd(), '.workforce')
  let dataDirSeen = false
  let foreground = false
  let foregroundSeen = false
  let executionId: string | undefined
  let executionSeen = false
  let tailBytes: number | undefined
  let tailSeen = false
  let ticketId: string | undefined

  for (let index = 0; index < options.length; index++) {
    const option = options[index]!
    if (option === '--data-dir') {
      if (dataDirSeen) fail('Option --data-dir may only be provided once')
      dataDir = resolve(process.cwd(), requireOptionValue(options, ++index, '--data-dir'))
      dataDirSeen = true
      continue
    }
    if (option === '--foreground') {
      if (command !== 'start') fail(`Unknown option: ${option}`)
      if (foregroundSeen) fail('Option --foreground may only be provided once')
      foreground = true
      foregroundSeen = true
      continue
    }
    if (option === '--execution-id') {
      if (command !== 'logs') fail(`Unknown option: ${option}`)
      if (executionSeen) fail('Option --execution-id may only be provided once')
      executionId = requireOptionValue(options, ++index, '--execution-id')
      executionSeen = true
      continue
    }
    if (option === '--tail-bytes') {
      if (command !== 'logs') fail(`Unknown option: ${option}`)
      if (tailSeen) fail('Option --tail-bytes may only be provided once')
      const raw = requireOptionValue(options, ++index, '--tail-bytes')
      if (!/^[0-9]+$/.test(raw)) fail('Invalid value for --tail-bytes')
      const value = Number(raw)
      if (!Number.isSafeInteger(value) || value < MIN_TAIL_BYTES || value > MAX_TAIL_BYTES) {
        fail('Invalid value for --tail-bytes')
      }
      tailBytes = value
      tailSeen = true
      continue
    }
    if (option.startsWith('-')) fail(`Unknown option: ${option}`)
    if (command !== 'logs') fail(`Unexpected argument: ${option}`)
    if (ticketId !== undefined) fail(`Unexpected argument: ${option}`)
    ticketId = option
  }

  if (command === 'start') {
    if (!foreground) fail('Missing required option --foreground')
    return { command, dataDir, foreground: true }
  }
  if (command === 'stop' || command === 'controller-status') {
    return { command, dataDir }
  }
  if (!ticketId) fail('Missing ticket id')
  if (!SAFE_ID.test(ticketId)) fail('Invalid ticket id')
  if (executionId !== undefined && !SAFE_ID.test(executionId)) fail('Invalid execution id')
  return {
    command,
    dataDir,
    ticketId,
    ...(executionId !== undefined ? { executionId } : {}),
    ...(tailBytes !== undefined ? { tailBytes } : {}),
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
  if (process.platform !== 'win32' && (entry.mode & 0o077) !== 0) {
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

/** Readonly main + module version validation. Never migrates or creates storage. */
function validateInitializedDataDir(dataDir: string): string {
  assertPrivateRealDataDir(dataDir)
  const path = databasePath(dataDir)
  assertRealDatabaseFile(path)
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    readMainSchema(db)
    applicationRepositories(db)
  } finally {
    db?.close()
  }
  return path
}

function pickRuntimeEnvironment(): Record<string, string> {
  const selected: Record<string, string> = {}
  for (const key of RUNTIME_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string') selected[key] = value
  }
  return validateRuntimeEnvironment(selected)
}

function taskService(store: LocalStore, settings: LocalSettings): LocalTaskService {
  return new LocalTaskService({
    store,
    ownerId: settings.ownerId,
    rules: settings.rules,
    workspaceId: settings.workspaceId,
  })
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function assertOwnedPrivateRegularFile(path: string, label: string): Stats {
  rejectSymlinkComponents(path, false)
  let info: Stats
  try {
    info = lstatSync(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) fail(`${label} does not exist`)
    throw error
  }
  if (info.isSymbolicLink()) fail(`${label} must not be a symbolic link`)
  if (!info.isFile()) fail(`${label} must be a regular file`)
  if (process.platform !== 'win32' && (Number(info.mode) & MODE_BITS) !== PRIVATE_FILE_MODE) {
    fail(`${label} must be mode 0600`)
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    fail(`${label} must be owned by the current user`)
  }
  return info
}

function unlinkOwnedRegularFile(path: string, expected: Stats): void {
  let info: Stats
  try {
    info = lstatSync(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return
    throw error
  }
  // Never delete a foreign replacement that no longer matches the validated identity.
  if (info.isSymbolicLink() || !info.isFile() || !sameIdentity(info, expected)) return
  try {
    unlinkSync(path)
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0
  while (offset < data.byteLength) {
    const written = writeSync(fd, data, offset, data.byteLength - offset)
    if (!Number.isSafeInteger(written) || written <= 0) {
      fail('Controller event write made no progress')
    }
    offset += written
  }
}

function rotateOwnedEventFile(path: string): void {
  // Validate current + all rotations before any mutation.
  const current = assertOwnedPrivateRegularFile(path, 'Controller event file')
  const rotations: Array<{ path: string; stats: Stats }> = []
  for (let index = 1; index <= MAX_EVENT_ROTATIONS; index += 1) {
    const candidate = `${path}.${index}`
    if (!existsSync(candidate)) continue
    rotations.push({
      path: candidate,
      stats: assertOwnedPrivateRegularFile(candidate, 'Controller event rotation file'),
    })
  }

  const oldestPath = `${path}.${MAX_EVENT_ROTATIONS}`
  const oldest = rotations.find(entry => entry.path === oldestPath)
  if (oldest) unlinkOwnedRegularFile(oldest.path, oldest.stats)

  for (let index = MAX_EVENT_ROTATIONS - 1; index >= 1; index -= 1) {
    const from = `${path}.${index}`
    const to = `${path}.${index + 1}`
    const recorded = rotations.find(entry => entry.path === from)
    if (!recorded) continue
    let live: Stats
    try {
      live = lstatSync(from)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) continue
      throw error
    }
    if (live.isSymbolicLink() || !live.isFile() || !sameIdentity(live, recorded.stats)) {
      fail('Controller event rotation identity mismatch')
    }
    renameSync(from, to)
    const renamed = assertOwnedPrivateRegularFile(to, 'Controller event rotation file')
    if (!sameIdentity(renamed, recorded.stats)) {
      fail('Controller event rotation identity mismatch')
    }
  }

  let liveCurrent: Stats
  try {
    liveCurrent = lstatSync(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) fail('Controller event file disappeared during rotation')
    throw error
  }
  if (liveCurrent.isSymbolicLink() || !liveCurrent.isFile() || !sameIdentity(liveCurrent, current)) {
    fail('Controller event rotation identity mismatch')
  }
  renameSync(path, `${path}.1`)
  const rotated = assertOwnedPrivateRegularFile(`${path}.1`, 'Controller event rotation file')
  if (!sameIdentity(rotated, current)) {
    fail('Controller event rotation identity mismatch')
  }
}

function appendControllerEvent(dataDir: string, event: ControlLoopEvent): void {
  const path = eventLogPath(dataDir)
  rejectSymlinkComponents(path, true)
  const line = `${JSON.stringify(event)}\n`
  const payload = Buffer.from(line, 'utf8')
  if (payload.byteLength > MAX_EVENT_FILE_BYTES) fail('Controller event payload exceeds file bound')

  let observed: Stats | undefined
  if (existsSync(path)) {
    // Reject unsafe existing files; never chmodSync(path) to "fix" a shared/replaced target.
    observed = assertOwnedPrivateRegularFile(path, 'Controller event file')
    if (observed.size + payload.byteLength > MAX_EVENT_FILE_BYTES) {
      rotateOwnedEventFile(path)
      observed = undefined
    }
  }

  let fd: number | undefined
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    )
    const opened = fstatSync(fd)
    if (!opened.isFile()) fail('Controller event file must be a regular file')
    if (typeof process.getuid === 'function' && opened.uid !== process.getuid()) {
      fail('Controller event file must be owned by the current user')
    }
    if (observed !== undefined) {
      if (!sameIdentity(opened, observed)) {
        fail('Controller event file identity changed during open')
      }
      // Existing file was already validated private; reject rather than chmod a replaced target.
      if (process.platform !== 'win32' && (Number(opened.mode) & MODE_BITS) !== PRIVATE_FILE_MODE) {
        fail('Controller event file must be mode 0600')
      }
    } else if (process.platform !== 'win32' && (Number(opened.mode) & MODE_BITS) !== PRIVATE_FILE_MODE) {
      if (opened.size > 0) {
        fail('Controller event file must be mode 0600')
      }
      // Fresh create (umask may strip bits): set mode on the FD only, never path chmod.
      fchmodSync(fd, PRIVATE_FILE_MODE)
    }
    if (opened.size + payload.byteLength > MAX_EVENT_FILE_BYTES) {
      fail('Controller event file exceeds 16MiB bound')
    }
    writeAll(fd, payload)
    fsyncSync(fd)
    const after = fstatSync(fd)
    if (process.platform !== 'win32' && (Number(after.mode) & MODE_BITS) !== PRIVATE_FILE_MODE) {
      fail('Controller event file must be mode 0600')
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function dataDirPresent(dataDir: string): boolean {
  try {
    const info = lstatSync(dataDir)
    return !info.isSymbolicLink() && info.isDirectory()
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false
    throw error
  }
}

async function handleStop(parsed: StopCommand, io: ControllerCliIO): Promise<number> {
  const absolute = resolve(parsed.dataDir)
  if (!dataDirPresent(absolute)) {
    writeJson(io, { requested: false, state: 'stopped' })
    return 0
  }
  const result = requestControllerStop(absolute)
  const status = inspectController(absolute)
  writeJson(io, {
    requested: result.requested,
    state: status.state,
    ...(status.pid !== undefined ? { pid: status.pid } : {}),
  })
  return 0
}

async function handleStatus(parsed: StatusCommand, io: ControllerCliIO): Promise<number> {
  const absolute = resolve(parsed.dataDir)
  const status = inspectController(absolute)
  writeJson(io, status)
  return 0
}

async function handleLogs(parsed: LogsCommand, io: ControllerCliIO): Promise<number> {
  const absolute = resolve(parsed.dataDir)
  const result = await readExecutionLogs({
    dataDir: absolute,
    ticketId: parsed.ticketId,
    ...(parsed.executionId !== undefined ? { executionId: parsed.executionId } : {}),
    ...(parsed.tailBytes !== undefined ? { maxBytes: parsed.tailBytes } : {}),
  })
  writeJson(io, result)
  return 0
}

function classifyStopChannelFailure(error: unknown): AbortCause {
  const message = error instanceof Error ? error.message : String(error)
  if (/stop metadata is malformed|stop evidence is malformed|malformed stop/i.test(message)) {
    return 'malformed-stop'
  }
  return 'lease-loss'
}

async function handleStart(parsed: StartCommand, io: ControllerCliIO): Promise<number> {
  const absoluteDataDir = resolve(parsed.dataDir)
  const dbPath = validateInitializedDataDir(absoluteDataDir)
  const settings = loadSettings(settingsPath(absoluteDataDir))
  if (settings.runtime.command === null) fail('Runtime command is not configured')

  const lease = acquireControllerLease({ dataDir: absoluteDataDir })
  let store: LocalStore | undefined
  let abortCause: AbortCause | undefined
  let stopTimer: ReturnType<typeof setInterval> | undefined
  const abort = new AbortController()
  let summary: { ticks: number; errors: number } | undefined
  let runError: unknown
  let releaseError: unknown

  const onSignal = (): void => {
    if (abort.signal.aborted) return
    abortCause = 'signal'
    abort.abort()
  }

  const evaluateStopChannel = (): void => {
    if (abort.signal.aborted) return
    try {
      // shouldStop authenticates the token: absent/mismatched valid stop => false;
      // malformed stop or lost/in-place-mutated ownership => throw (mapped to nonzero).
      if (lease.shouldStop()) {
        abortCause = 'stop-requested'
        abort.abort()
        return
      }
      const status = inspectController(absoluteDataDir)
      if (status.state !== 'running' || status.pid !== process.pid) {
        abortCause = 'lease-loss'
        abort.abort()
      }
    } catch (error) {
      if (abort.signal.aborted) return
      abortCause = classifyStopChannelFailure(error)
      abort.abort()
    }
  }

  try {
    store = new LocalStore(dbPath)
    applicationRepositories(store.db)
    const tasks = taskService(store, settings)
    const orchestrator = new LocalOrchestrator({
      store,
      tasks,
      runtime: {
        id: settings.runtime.id,
      driver: settings.runtime.driver,
        command: settings.runtime.command,
        timeoutMs: settings.runtime.timeoutMs,
        maxOutputBytes: settings.runtime.maxOutputBytes,
        graceMs: settings.runtime.graceMs,
      },
      runnerRoot: resolve(absoluteDataDir, 'runners'),
      artifactRoot: resolve(absoluteDataDir, 'artifacts'),
      maxConcurrency: settings.scheduler.maxConcurrency,
      runtimeEnvironment: pickRuntimeEnvironment(),
    })

    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)
    stopTimer = setInterval(evaluateStopChannel, STOP_POLL_MS)
    if (typeof stopTimer.unref === 'function') stopTimer.unref()
    evaluateStopChannel()

    const onEvent = async (event: ControlLoopEvent): Promise<void> => {
      appendControllerEvent(absoluteDataDir, event)
      io.stdout.write(`${JSON.stringify(event)}\n`)
    }

    summary = await runControlLoop({
      orchestrator: composeController({ execution: orchestrator, store, tasks, settings, dataDir: absoluteDataDir }),
      signal: abort.signal,
      intervalMs: settings.scheduler.pollIntervalMs,
      onEvent,
    })

    if (abortCause === 'lease-loss') fail('Controller lease was lost')
    if (abortCause === 'malformed-stop') fail('Controller stop evidence is malformed')
  } catch (error) {
    runError = error
  } finally {
    if (stopTimer !== undefined) clearInterval(stopTimer)
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    try {
      lease.release()
    } catch (error) {
      releaseError = error
    }
    try {
      store?.close()
    } catch (error) {
      if (runError === undefined) runError = error
    }
    store = undefined
  }

  // Never print success before cleanup, and never hide the original loop error behind release failure.
  if (runError !== undefined) {
    if (releaseError !== undefined) {
      fail(`${redactError(runError)}; additionally, lease release failed: ${redactError(releaseError)}`)
    }
    throw runError instanceof Error ? runError : new Error(redactError(runError))
  }
  if (releaseError !== undefined) {
    fail(`Controller lease release failed: ${redactError(releaseError)}`)
  }
  if (summary === undefined) fail('Controller loop completed without a summary')
  writeJson(io, { ticks: summary.ticks, errors: summary.errors })
  return 0
}

/**
 * Dispatches controller CLI commands. Returns undefined only when the command is unrecognized
 * so the parent can fall through to Task or legacy CLI handlers.
 */
export async function runControllerCommand(
  argv: readonly string[],
  io: ControllerCliIO = process,
): Promise<number | undefined> {
  const command = argv[0]
  if (command === undefined || !isCommandName(command)) return undefined

  try {
    const parsed = parseArgs(argv)
    switch (parsed.command) {
      case 'start':
        return await handleStart(parsed, io)
      case 'stop':
        return await handleStop(parsed, io)
      case 'controller-status':
        return await handleStatus(parsed, io)
      case 'logs':
        return await handleLogs(parsed, io)
    }
  } catch (error) {
    io.stderr.write(`Error: ${redactError(error)}\n`)
    return 1
  }
}
