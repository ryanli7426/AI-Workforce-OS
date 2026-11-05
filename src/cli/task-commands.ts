/** User-operable Task CLI commands. Parent routes these before the legacy sync CLI. */
import { randomBytes } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { join, parse, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalOrchestrator } from '../application/local-orchestrator.ts'
import { composeController } from '../application/controller.ts'
import { acquireControllerLease } from '../application/controller-lease.ts'
import { LocalTaskService } from '../application/tasks.ts'
import { createSettings, defaultSettings, loadSettings, type LocalSettings } from '../config/settings.ts'
import { ArtifactStore } from '../artifacts/snapshots.ts'
import { validateRuntimeEnvironment } from '../runner/environment.ts'
import { redact } from '../security/redaction.ts'
import { applicationRepositories } from '../storage/application-store.ts'
import { LAO_SCHEMA_VERSION, LocalStore } from '../storage/store.ts'
import { LocalVerifier } from '../verification/local-checks.ts'

export interface TaskCliIO {
  stdout: { write(value: string): unknown }
  stderr: { write(value: string): unknown }
}

const COMMANDS = [
  'configure',
  'task-create',
  'task-approve',
  'task-reject',
  'task-cancel',
  'task-retry',
  'task-review',
  'task-verify',
  'run-once',
  'executions',
] as const

type CommandName = (typeof COMMANDS)[number]

const MAX_JSON_BYTES = 128 * 1024
const CREATE_FIELDS = ['project', 'issue', 'title', 'description', 'taskType', 'priority'] as const
const CREATE_REQUIRED = ['project', 'issue', 'title', 'description', 'taskType'] as const
const CHECK_FIELDS = ['id', 'command', 'args', 'timeoutMs'] as const
const SAFE_OWNER = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
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

interface BaseParsed {
  command: CommandName
  dataDir: string
}

interface ConfigureCommand extends BaseParsed {
  command: 'configure'
  claudeCommand: string
}

interface TaskCreateCommand extends BaseParsed {
  command: 'task-create'
  file: string
}

interface TaskIdReasonCommand extends BaseParsed {
  command: 'task-approve' | 'task-reject' | 'task-cancel' | 'task-retry'
  id: string
  reason: string
}

interface TaskReviewCommand extends BaseParsed {
  command: 'task-review'
  id: string
  executionId: string
  artifactRevision: string
  decision: 'approved' | 'rejected'
  reason: string
}

interface TaskVerifyCommand extends BaseParsed {
  command: 'task-verify'
  id: string
  reason: string
  checksFile?: string
  waive: boolean
}

interface DataDirOnlyCommand extends BaseParsed {
  command: 'run-once' | 'executions'
}

type ParsedTaskCommand =
  | ConfigureCommand
  | TaskCreateCommand
  | TaskIdReasonCommand
  | TaskReviewCommand
  | TaskVerifyCommand
  | DataDirOnlyCommand

function fail(message: string): never {
  throw new Error(message)
}

function isCommandName(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value)
}

function localOwnerId(): string {
  if (typeof process.getuid === 'function') return `local-${process.getuid()}`
  const username = process.env.USERNAME ?? process.env.USER ?? ''
  if (SAFE_OWNER.test(username)) return `local-${username}`
  return 'local-owner'
}

function databasePath(dataDir: string): string {
  return resolve(dataDir, 'workforce.sqlite')
}

function settingsPath(dataDir: string): string {
  return resolve(dataDir, 'settings.json')
}

function writeJson(io: TaskCliIO, value: unknown): void {
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

function parseArgs(argv: readonly string[]): ParsedTaskCommand {
  const [command, ...options] = argv
  if (command === undefined || !isCommandName(command)) fail('internal: unrecognized command')

  let dataDir = resolve(process.cwd(), '.workforce')
  let dataDirSeen = false
  let claudeCommand: string | undefined
  let claudeSeen = false
  let file: string | undefined
  let fileSeen = false
  let reason: string | undefined
  let reasonSeen = false
  let executionId: string | undefined
  let executionSeen = false
  let artifactRevision: string | undefined
  let artifactSeen = false
  let decision: 'approved' | 'rejected' | undefined
  let decisionSeen = false
  let checksFile: string | undefined
  let checksSeen = false
  let waive = false
  let waiveSeen = false
  let id: string | undefined

  for (let index = 0; index < options.length; index++) {
    const option = options[index]!
    if (option === '--data-dir') {
      if (dataDirSeen) fail('Option --data-dir may only be provided once')
      dataDir = resolve(process.cwd(), requireOptionValue(options, ++index, '--data-dir'))
      dataDirSeen = true
      continue
    }
    if (option === '--claude-command') {
      if (command !== 'configure') fail(`Unknown option: ${option}`)
      if (claudeSeen) fail('Option --claude-command may only be provided once')
      claudeCommand = requireOptionValue(options, ++index, '--claude-command')
      claudeSeen = true
      continue
    }
    if (option === '--file') {
      if (command !== 'task-create') fail(`Unknown option: ${option}`)
      if (fileSeen) fail('Option --file may only be provided once')
      file = resolve(process.cwd(), requireOptionValue(options, ++index, '--file'))
      fileSeen = true
      continue
    }
    if (option === '--reason') {
      if (!['task-approve', 'task-reject', 'task-cancel', 'task-retry', 'task-review', 'task-verify'].includes(command)) {
        fail(`Unknown option: ${option}`)
      }
      if (reasonSeen) fail('Option --reason may only be provided once')
      reason = requireOptionValue(options, ++index, '--reason')
      reasonSeen = true
      continue
    }
    if (option === '--execution-id') {
      if (command !== 'task-review') fail(`Unknown option: ${option}`)
      if (executionSeen) fail('Option --execution-id may only be provided once')
      executionId = requireOptionValue(options, ++index, '--execution-id')
      executionSeen = true
      continue
    }
    if (option === '--artifact-revision') {
      if (command !== 'task-review') fail(`Unknown option: ${option}`)
      if (artifactSeen) fail('Option --artifact-revision may only be provided once')
      artifactRevision = requireOptionValue(options, ++index, '--artifact-revision')
      artifactSeen = true
      continue
    }
    if (option === '--decision') {
      if (command !== 'task-review') fail(`Unknown option: ${option}`)
      if (decisionSeen) fail('Option --decision may only be provided once')
      const value = requireOptionValue(options, ++index, '--decision')
      if (value !== 'approved' && value !== 'rejected') fail('Invalid value for --decision')
      decision = value
      decisionSeen = true
      continue
    }
    if (option === '--checks-file') {
      if (command !== 'task-verify') fail(`Unknown option: ${option}`)
      if (checksSeen) fail('Option --checks-file may only be provided once')
      checksFile = resolve(process.cwd(), requireOptionValue(options, ++index, '--checks-file'))
      checksSeen = true
      continue
    }
    if (option === '--waive') {
      if (command !== 'task-verify') fail(`Unknown option: ${option}`)
      if (waiveSeen) fail('Option --waive may only be provided once')
      waive = true
      waiveSeen = true
      continue
    }
    if (option.startsWith('-')) fail(`Unknown option: ${option}`)
    if (!['task-approve', 'task-reject', 'task-cancel', 'task-retry', 'task-review', 'task-verify'].includes(command)) {
      fail(`Unexpected argument: ${option}`)
    }
    if (id !== undefined) fail(`Unexpected argument: ${option}`)
    id = option
  }

  if (command === 'configure') {
    if (!claudeCommand) fail('Missing required option --claude-command')
    return { command, dataDir, claudeCommand }
  }
  if (command === 'task-create') {
    if (!file) fail('Missing required option --file')
    return { command, dataDir, file }
  }
  if (command === 'task-approve' || command === 'task-reject' || command === 'task-cancel' || command === 'task-retry') {
    if (!id) fail('Missing task id')
    if (reason === undefined) fail('Missing required option --reason')
    return { command, dataDir, id, reason }
  }
  if (command === 'task-review') {
    if (!id) fail('Missing task id')
    if (!executionId) fail('Missing required option --execution-id')
    if (!artifactRevision) fail('Missing required option --artifact-revision')
    if (!decision) fail('Missing required option --decision')
    if (reason === undefined) fail('Missing required option --reason')
    return { command, dataDir, id, executionId, artifactRevision, decision, reason }
  }
  if (command === 'task-verify') {
    if (!id) fail('Missing task id')
    if (reason === undefined) fail('Missing required option --reason')
    if (waive === checksSeen) fail('Provide exactly one of --checks-file or --waive')
    if (waive && (!reason.trim() || reason.includes('\0'))) fail('Invalid reason')
    return {
      command,
      dataDir,
      id,
      reason,
      waive,
      ...(checksFile !== undefined ? { checksFile } : {}),
    }
  }
  return { command, dataDir }
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

function readMainSchema(db: DatabaseSync): number {
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
  return schema as number
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

async function withLocalStore<T>(
  dataDir: string,
  operation: (store: LocalStore, settings: LocalSettings) => T | Promise<T>,
): Promise<T> {
  const path = validateInitializedDataDir(dataDir)
  const settings = loadSettings(settingsPath(dataDir))
  let store: LocalStore | undefined
  try {
    store = new LocalStore(path)
    applicationRepositories(store.db)
    return await operation(store, settings)
  } finally {
    store?.close()
  }
}

function taskService(store: LocalStore, settings: LocalSettings): LocalTaskService {
  return new LocalTaskService({
    store,
    ownerId: settings.ownerId,
    rules: settings.rules,
    workspaceId: settings.workspaceId,
  })
}

function readBoundedRegularFile(path: string, label: string): Buffer {
  try {
    rejectSymlinkComponents(path, false)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) fail(`${label} does not exist`)
    throw error
  }
  let metadata
  try {
    metadata = lstatSync(path)
  } catch {
    fail(`${label} does not exist`)
  }
  if (metadata.isSymbolicLink()) fail(`${label} must not be a symbolic link`)
  if (!metadata.isFile()) fail(`${label} must be a regular file`)
  if (metadata.size > MAX_JSON_BYTES) fail(`${label} exceeds 128KiB limit`)
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    fail(`${label} must be owned by the current user`)
  }

  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const before = fstatSync(fd)
    if (!before.isFile()) fail(`${label} must be a regular file`)
    if (before.size > MAX_JSON_BYTES) fail(`${label} exceeds 128KiB limit`)
    // Bound the read itself so a post-lstat size race cannot load unbounded bytes.
    const buffer = Buffer.allocUnsafe(MAX_JSON_BYTES + 1)
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_JSON_BYTES) fail(`${label} exceeds 128KiB limit`)
    const after = fstatSync(fd)
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
    ) {
      fail(`${label} changed while reading`)
    }
    return Buffer.from(buffer.subarray(0, bytesRead))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(label)) throw error
    throw new Error(`${label} could not be read`)
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function readJsonObjectFile(path: string): Record<string, unknown> {
  const bytes = readBoundedRegularFile(path, 'JSON file')
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('JSON file is not valid JSON')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('JSON file must contain an object')
  return value as Record<string, unknown>
}

function readChecksFile(path: string): Array<{ id: string; command: string; args: string[]; timeoutMs: number }> {
  const bytes = readBoundedRegularFile(path, 'Checks file')
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    fail('Checks file is not valid JSON')
  }
  if (!Array.isArray(value)) fail('Checks file must contain a JSON array')
  if (value.length === 0) {
    fail('Checks file must include at least one check; use --waive with --reason to waive verification')
  }
  return value.map((item, index) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) fail(`Invalid check at index ${index}`)
    const record = item as Record<string, unknown>
    const keys = Object.keys(record).sort()
    const expected = [...CHECK_FIELDS].sort()
    if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) {
      // Do not echo untrusted key names (may contain credential-like material).
      fail(`Checks entry contains unknown or missing fields at index ${index}`)
    }
    if (typeof record.id !== 'string' || typeof record.command !== 'string') fail(`Invalid check at index ${index}`)
    if (!Array.isArray(record.args) || !record.args.every(arg => typeof arg === 'string')) {
      fail(`Invalid check args at index ${index}`)
    }
    if (typeof record.timeoutMs !== 'number' || !Number.isSafeInteger(record.timeoutMs) || record.timeoutMs < 1) {
      fail(`Invalid check timeoutMs at index ${index}`)
    }
    return {
      id: record.id,
      command: record.command,
      args: [...record.args],
      timeoutMs: record.timeoutMs,
    }
  })
}

function parseCreateInput(raw: Record<string, unknown>): {
  issueId: string
  projectId: string
  title: string
  description: string
  taskType: string
  priority?: number
} {
  for (const field of Object.keys(raw)) {
    if (!(CREATE_FIELDS as readonly string[]).includes(field)) {
      // Never echo untrusted key names — they may contain credential-like data.
      fail('Create input contains an unknown field')
    }
  }
  for (const field of CREATE_REQUIRED) {
    if (!(field in raw)) fail(`Missing create field: ${field}`)
  }
  if (typeof raw.project !== 'string') fail('Invalid project')
  if (typeof raw.issue !== 'string') fail('Invalid issue')
  if (typeof raw.title !== 'string') fail('Invalid title')
  if (typeof raw.description !== 'string') fail('Invalid description')
  if (typeof raw.taskType !== 'string') fail('Invalid taskType')
  const priority = raw.priority
  if (priority !== undefined && (typeof priority !== 'number' || !Number.isFinite(priority) || priority < 0)) {
    fail('Invalid priority')
  }
  // Pass actual strings through; LocalTaskService enforces safe ids and nonblank text.
  return {
    projectId: raw.project,
    issueId: raw.issue,
    title: raw.title,
    description: raw.description,
    taskType: raw.taskType,
    ...(priority === undefined ? {} : { priority }),
  }
}

function pickRuntimeEnvironment(): Record<string, string> {
  const selected: Record<string, string> = {}
  for (const key of RUNTIME_ENV_KEYS) {
    const value = process.env[key]
    if (typeof value === 'string') selected[key] = value
  }
  return validateRuntimeEnvironment(selected)
}

async function handleConfigure(parsed: ConfigureCommand, io: TaskCliIO): Promise<number> {
  validateInitializedDataDir(parsed.dataDir)
  const settings = defaultSettings({
    ownerId: localOwnerId(),
    claudeCommand: parsed.claudeCommand,
  })
  const created = createSettings(settingsPath(parsed.dataDir), settings)
  writeJson(io, created)
  return 0
}

async function handleTaskCreate(parsed: TaskCreateCommand, io: TaskCliIO): Promise<number> {
  const input = parseCreateInput(readJsonObjectFile(parsed.file))
  const ticket = await withLocalStore(parsed.dataDir, (store, settings) =>
    taskService(store, settings).create(input))
  writeJson(io, ticket)
  return 0
}

async function handleTaskReason(
  parsed: TaskIdReasonCommand,
  io: TaskCliIO,
): Promise<number> {
  const ticket = await withLocalStore(parsed.dataDir, (store, settings) => {
    const tasks = taskService(store, settings)
    switch (parsed.command) {
      case 'task-approve': return tasks.approve(parsed.id, parsed.reason)
      case 'task-reject': return tasks.reject(parsed.id, parsed.reason)
      case 'task-cancel': return tasks.cancel(parsed.id, parsed.reason)
      case 'task-retry': return tasks.retry(parsed.id, parsed.reason)
    }
  })
  writeJson(io, ticket)
  return 0
}

async function handleTaskReview(parsed: TaskReviewCommand, io: TaskCliIO): Promise<number> {
  const ticket = await withLocalStore(parsed.dataDir, (store, settings) =>
    taskService(store, settings).review(parsed.id, {
      executionId: parsed.executionId,
      artifactRevision: parsed.artifactRevision,
      approved: parsed.decision === 'approved',
      reason: parsed.reason,
    }))
  writeJson(io, ticket)
  return 0
}

async function handleTaskVerify(parsed: TaskVerifyCommand, io: TaskCliIO): Promise<number> {
  const absoluteDataDir = resolve(parsed.dataDir)
  const path = validateInitializedDataDir(absoluteDataDir)
  const settings = loadSettings(settingsPath(absoluteDataDir))
  let store: LocalStore | undefined
  try {
    store = new LocalStore(path)
    applicationRepositories(store.db)
    const tasks = taskService(store, settings)
    const ticket = tasks.get(parsed.id)
    if (!ticket?.lifecycle) fail('Unknown ticket')
    const result = ticket.lifecycle.result
    if (!result) fail('Task has no current execution result to verify')
    const executionId = result.executionId
    const artifactRevision = result.artifactRevision
    const artifactId = `artifact-${executionId}`
    const checks = parsed.waive ? [] : readChecksFile(parsed.checksFile!)
    const verifier = new LocalVerifier({
      root: resolve(absoluteDataDir, 'verifications'),
      artifactStore: new ArtifactStore({ root: resolve(absoluteDataDir, 'artifacts') }),
    })
    const verificationId = `v-${randomBytes(8).toString('hex')}`
    const report = await verifier.verify({
      verificationId,
      executionId,
      artifactId,
      artifactRevision,
      checks,
      authorized: true,
      ...(parsed.waive ? { waiveReason: parsed.reason } : {}),
    })
    tasks.verify(parsed.id, {
      executionId,
      artifactRevision,
      state: report.state,
      reason: parsed.reason,
    })
    writeJson(io, report)
    return 0
  } finally {
    store?.close()
  }
}

async function handleRunOnce(parsed: DataDirOnlyCommand, io: TaskCliIO): Promise<number> {
  const absoluteDataDir = resolve(parsed.dataDir)
  const path = validateInitializedDataDir(absoluteDataDir)
  const settings = loadSettings(settingsPath(absoluteDataDir))
  if (settings.runtime.command === null) fail('Runtime command is not configured')
  const lease = acquireControllerLease({ dataDir: absoluteDataDir })
  let store: LocalStore | undefined
  try {
    store = new LocalStore(path)
    applicationRepositories(store.db)
    const tasks = taskService(store, settings)
    // graceMs is forwarded for the parent-updated LocalOrchestrator runtime contract.
    const runtime = {
      id: settings.runtime.id,
      command: settings.runtime.command,
      timeoutMs: settings.runtime.timeoutMs,
      maxOutputBytes: settings.runtime.maxOutputBytes,
      graceMs: settings.runtime.graceMs,
    }
    const orchestrator = new LocalOrchestrator({
      store,
      tasks,
      runtime,
      runnerRoot: resolve(absoluteDataDir, 'runners'),
      artifactRoot: resolve(absoluteDataDir, 'artifacts'),
      maxConcurrency: settings.scheduler.maxConcurrency,
      runtimeEnvironment: pickRuntimeEnvironment(),
    })
    const controller = composeController({ execution: orchestrator, store, tasks, settings, dataDir: absoluteDataDir })
    await controller.reconcile()
    const counters = await controller.tick()
    writeJson(io, counters)
    return 0
  } finally {
    try { lease.release() } finally { store?.close() }
  }
}

async function handleExecutions(parsed: DataDirOnlyCommand, io: TaskCliIO): Promise<number> {
  const path = validateInitializedDataDir(parsed.dataDir)
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    readMainSchema(db)
    const repos = applicationRepositories(db)
    writeJson(io, repos.executions.list())
    return 0
  } finally {
    db?.close()
  }
}

/**
 * Dispatches Task CLI commands. Returns undefined only when the command is unrecognized
 * so the parent can fall through to the legacy sync CLI.
 */
export async function runTaskCommand(
  argv: readonly string[],
  io: TaskCliIO = process,
): Promise<number | undefined> {
  const command = argv[0]
  if (command === undefined || !isCommandName(command)) return undefined

  try {
    const parsed = parseArgs(argv)
    switch (parsed.command) {
      case 'configure':
        return await handleConfigure(parsed, io)
      case 'task-create':
        return await handleTaskCreate(parsed, io)
      case 'task-approve':
      case 'task-reject':
      case 'task-cancel':
      case 'task-retry':
        return await handleTaskReason(parsed, io)
      case 'task-review':
        return await handleTaskReview(parsed, io)
      case 'task-verify':
        return await handleTaskVerify(parsed, io)
      case 'run-once':
        return await handleRunOnce(parsed, io)
      case 'executions':
        return await handleExecutions(parsed, io)
    }
  } catch (error) {
    io.stderr.write(`Error: ${redactError(error)}\n`)
    return 1
  }
}

/** Exported for tests that need to resolve the canonical owner id used by configure. */
export function taskCliOwnerIdForTests(): string {
  return localOwnerId()
}

/** Exported so tests can assert the store stays open across awaited work. */
export async function withLocalStoreForTests<T>(
  dataDir: string,
  operation: (store: LocalStore, settings: LocalSettings) => T | Promise<T>,
): Promise<T> {
  return withLocalStore(dataDir, operation)
}
