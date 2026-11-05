/**
 * Durable verification Owner CLI.
 * Parent routes runVerificationCommand before other dispatchers; do not edit index here.
 *
 * Plans file format for `verification-plans-init --file` (chosen + documented):
 * exact JSON object `{ "plans": [VerificationJobPlan, ...] }` only — not a bare array.
 * Plans are validated through parseVerificationPlan; registration is exclusive local trust
 * (private 0600 nofollow read, no Web). Listing prints compact metadata only.
 */
import {
  existsSync,
  lstatSync,
  realpathSync,
} from 'node:fs'
import { join, parse, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ProductQueries } from '../application/product-queries.ts'
import {
  LocalVerificationCommands,
  VerificationCommandError,
} from '../application/verification-commands.ts'
import { createVerificationPlans, loadVerificationPlans } from '../config/verification-plans.ts'
import { loadSettings } from '../config/settings.ts'
import { redact } from '../security/redaction.ts'
import { applicationRepositories } from '../storage/application-store.ts'
import {
  requireVerificationSchema,
  VerificationJobRepository,
} from '../storage/verification-jobs.ts'
import { LAO_SCHEMA_VERSION, LocalStore } from '../storage/store.ts'
import { readVerificationPrivateFile } from '../verification/protocol.ts'
import { parseVerificationPlan } from '../verification/request.ts'
import type { VerificationJobPlan } from '../verification/model.ts'

export interface VerificationCliIO {
  stdout: { write(value: string): unknown }
  stderr: { write(value: string): unknown }
}

const COMMANDS = [
  'verification-plans-init',
  'verification-plans',
  'verification-create',
  'verification-status',
  'verification-cancel',
] as const

type CommandName = (typeof COMMANDS)[number]

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const ARTIFACT_REVISION = /^[a-f0-9]{64}$/
const TRUSTED_DARWIN_ALIASES = new Set(['/var', '/tmp'])
const PRIVATE_DIR_MASK = 0o077
const MAX_PLANS_FILE_BYTES = 512 * 1024
const MAX_REASON_BYTES = 4096
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

interface PlansInitCommand extends BaseParsed {
  command: 'verification-plans-init'
  file: string
}

interface PlansListCommand extends BaseParsed {
  command: 'verification-plans'
}

interface CreateCommand extends BaseParsed {
  command: 'verification-create'
  ticketId: string
  planId: string
  planRevision: string
  expectedVersion: number
  executionId: string
  artifactRevision: string
  reason: string
  key: string
}

interface StatusCommand extends BaseParsed {
  command: 'verification-status'
  verificationId: string
}

interface CancelCommand extends BaseParsed {
  command: 'verification-cancel'
  verificationId: string
  expectedVersion: number
  reason: string
  key: string
}

type ParsedVerificationCommand =
  | PlansInitCommand
  | PlansListCommand
  | CreateCommand
  | StatusCommand
  | CancelCommand

function fail(message: string): never {
  throw new Error(message)
}

function isCommandName(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value)
}

function localOwnerId(): string {
  if (typeof process.getuid === 'function') return `local-${process.getuid()}`
  const username = process.env.USERNAME ?? process.env.USER ?? ''
  if (SAFE_ID.test(username)) return `local-${username}`
  return 'local-owner'
}

function databasePath(dataDir: string): string {
  return resolve(dataDir, 'workforce.sqlite')
}

function settingsPath(dataDir: string): string {
  return resolve(dataDir, 'settings.json')
}

function writeJson(io: VerificationCliIO, value: unknown): void {
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

function parseSafeId(raw: string, label: string): string {
  const pattern = label === '--plan' || label === '--plan-revision' ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/ : SAFE_ID
  if (!pattern.test(raw)) fail(`Invalid value for ${label}`)
  return raw
}

function parsePositiveVersion(raw: string, label: string): number {
  if (!/^[1-9][0-9]*$/.test(raw)) fail(`Invalid value for ${label}`)
  const parsed = Number(raw)
  if (!Number.isSafeInteger(parsed)) fail(`Invalid value for ${label}`)
  return parsed
}

function parseReason(raw: string): string {
  if (!raw.trim() || raw.includes('\0') || Buffer.byteLength(raw) > MAX_REASON_BYTES) {
    fail('Invalid value for --reason')
  }
  return raw.trim()
}

function parseArtifactRevision(raw: string): string {
  if (!ARTIFACT_REVISION.test(raw)) fail('Invalid value for --artifact-revision')
  return raw
}

function parseArgs(argv: readonly string[]): ParsedVerificationCommand {
  const [command, ...options] = argv
  if (command === undefined || !isCommandName(command)) fail('internal: unrecognized command')

  let dataDir = resolve(process.cwd(), '.workforce')
  let dataDirSeen = false
  let file: string | undefined
  let fileSeen = false
  let planId: string | undefined
  let planSeen = false
  let planRevision: string | undefined
  let planRevisionSeen = false
  let expectedVersion: number | undefined
  let expectedVersionSeen = false
  let executionId: string | undefined
  let executionSeen = false
  let artifactRevision: string | undefined
  let artifactSeen = false
  let reason: string | undefined
  let reasonSeen = false
  let key: string | undefined
  let keySeen = false
  let positional: string | undefined

  for (let index = 0; index < options.length; index++) {
    const option = options[index]!
    if (option === '--data-dir') {
      if (dataDirSeen) fail('Option --data-dir may only be provided once')
      dataDir = resolve(process.cwd(), requireOptionValue(options, ++index, '--data-dir'))
      dataDirSeen = true
      continue
    }
    if (option === '--file') {
      if (command !== 'verification-plans-init') fail('Unknown option')
      if (fileSeen) fail('Option --file may only be provided once')
      file = resolve(process.cwd(), requireOptionValue(options, ++index, '--file'))
      fileSeen = true
      continue
    }
    if (option === '--plan') {
      if (command !== 'verification-create') fail('Unknown option')
      if (planSeen) fail('Option --plan may only be provided once')
      planId = parseSafeId(requireOptionValue(options, ++index, '--plan'), '--plan')
      planSeen = true
      continue
    }
    if (option === '--plan-revision') {
      if (command !== 'verification-create') fail('Unknown option')
      if (planRevisionSeen) fail('Option --plan-revision may only be provided once')
      planRevision = parseSafeId(requireOptionValue(options, ++index, '--plan-revision'), '--plan-revision')
      planRevisionSeen = true
      continue
    }
    if (option === '--expected-version') {
      if (command !== 'verification-create' && command !== 'verification-cancel') fail('Unknown option')
      if (expectedVersionSeen) fail('Option --expected-version may only be provided once')
      expectedVersion = parsePositiveVersion(
        requireOptionValue(options, ++index, '--expected-version'),
        '--expected-version',
      )
      expectedVersionSeen = true
      continue
    }
    if (option === '--execution-id') {
      if (command !== 'verification-create') fail('Unknown option')
      if (executionSeen) fail('Option --execution-id may only be provided once')
      executionId = parseSafeId(requireOptionValue(options, ++index, '--execution-id'), '--execution-id')
      executionSeen = true
      continue
    }
    if (option === '--artifact-revision') {
      if (command !== 'verification-create') fail('Unknown option')
      if (artifactSeen) fail('Option --artifact-revision may only be provided once')
      artifactRevision = parseArtifactRevision(requireOptionValue(options, ++index, '--artifact-revision'))
      artifactSeen = true
      continue
    }
    if (option === '--reason') {
      if (command !== 'verification-create' && command !== 'verification-cancel') fail('Unknown option')
      if (reasonSeen) fail('Option --reason may only be provided once')
      reason = parseReason(requireOptionValue(options, ++index, '--reason'))
      reasonSeen = true
      continue
    }
    if (option === '--key') {
      if (command !== 'verification-create' && command !== 'verification-cancel') fail('Unknown option')
      if (keySeen) fail('Option --key may only be provided once')
      key = parseSafeId(requireOptionValue(options, ++index, '--key'), '--key')
      keySeen = true
      continue
    }
    // Never echo arbitrary argv: idempotency keys and revisions must not leak to stderr.
    if (option.startsWith('-')) fail('Unknown option')
    if (
      command !== 'verification-create'
      && command !== 'verification-status'
      && command !== 'verification-cancel'
    ) {
      fail('Unexpected argument')
    }
    if (positional !== undefined) fail('Unexpected argument')
    positional = option
  }

  if (command === 'verification-plans-init') {
    if (!file) fail('Missing required option --file')
    return { command, dataDir, file }
  }
  if (command === 'verification-plans') {
    return { command, dataDir }
  }
  if (command === 'verification-create') {
    if (!positional) fail('Missing ticket id')
    const ticketId = parseSafeId(positional, 'ticket id')
    if (!planId) fail('Missing required option --plan')
    if (!planRevision) fail('Missing required option --plan-revision')
    if (expectedVersion === undefined) fail('Missing required option --expected-version')
    if (!executionId) fail('Missing required option --execution-id')
    if (!artifactRevision) fail('Missing required option --artifact-revision')
    if (!reason) fail('Missing required option --reason')
    if (!key) fail('Missing required option --key')
    return {
      command,
      dataDir,
      ticketId,
      planId,
      planRevision,
      expectedVersion,
      executionId,
      artifactRevision,
      reason,
      key,
    }
  }
  if (command === 'verification-status') {
    if (!positional) fail('Missing verification id')
    return { command, dataDir, verificationId: parseSafeId(positional, 'verification id') }
  }
  if (!positional) fail('Missing verification id')
  if (expectedVersion === undefined) fail('Missing required option --expected-version')
  if (!reason) fail('Missing required option --reason')
  if (!key) fail('Missing required option --key')
  return {
    command: 'verification-cancel',
    dataDir,
    verificationId: parseSafeId(positional, 'verification id'),
    expectedVersion,
    reason,
    key,
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

/**
 * Readonly main + module + verification schema validation. Never migrates or creates storage.
 */
function validateInitializedDataDir(dataDir: string): string {
  assertPrivateRealDataDir(dataDir)
  const path = databasePath(dataDir)
  assertRealDatabaseFile(path)
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    readMainSchema(db)
    applicationRepositories(db)
    requireVerificationSchema(db)
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'Verification schema is not initialized') {
        fail('Verification schema is not initialized; run init first')
      }
      if (error.message.startsWith('Unsupported verification schema version:')) {
        fail(`Unsupported verification schema version; expected schema 1`)
      }
      if (
        error.message === 'Verification schema is incomplete'
        || error.message === 'Verification schema is corrupt'
        || error.message === 'Unversioned verification schema; refusing implicit migration'
      ) {
        fail(error.message)
      }
    }
    throw error
  } finally {
    db?.close()
  }
  return path
}

function compactPlanMetadata(plan: VerificationJobPlan): {
  id: string
  revision: string
  checkIds: string[]
  timeouts: number[]
} {
  return {
    id: plan.id,
    revision: plan.revision,
    checkIds: plan.checks.map(check => check.id),
    timeouts: plan.checks.map(check => check.timeoutMs),
  }
}

function readTrustedPlansFile(path: string): VerificationJobPlan[] {
  let raw: unknown
  try {
    raw = JSON.parse(readVerificationPrivateFile(path, MAX_PLANS_FILE_BYTES, 'verification plans file').toString('utf8'))
  } catch (error) {
    if (error instanceof Error && (
      error.message.startsWith('verification plans file')
      || error.message.includes('Symbolic link')
      || error.message.includes('must be')
      || error.message.includes('exceeds')
      || error.message.includes('missing')
      || error.message.includes('empty')
      || error.message.includes('absolute')
    )) {
      fail('Verification plans file could not be read as a private local file')
    }
    fail('Verification plans file is not valid JSON')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail('Verification plans file must be an object with a plans array')
  }
  const record = raw as Record<string, unknown>
  if (Object.keys(record).length !== 1 || !Array.isArray(record.plans)) {
    fail('Verification plans file must be exactly { "plans": [VerificationJobPlan, ...] }')
  }
  if (record.plans.length < 1 || record.plans.length > 64) {
    fail('Verification plans file must include 1..64 plans')
  }
  try {
    const seen = new Set<string>()
    return record.plans.map(item => {
      const plan = parseVerificationPlan(item)
      const key = JSON.stringify([plan.id, plan.revision])
      if (seen.has(key)) fail('Verification plans file contains duplicate plan id/revision')
      seen.add(key)
      return plan
    })
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Verification plans file')) throw error
    fail('Verification plans file failed trusted plan validation')
  }
}

function withLocalStore<T>(
  dataDir: string,
  operation: (commands: LocalVerificationCommands) => T,
): T {
  const path = validateInitializedDataDir(dataDir)
  const absoluteDataDir = resolve(dataDir)
  const settings = loadSettings(settingsPath(absoluteDataDir))
  let store: LocalStore | undefined
  try {
    store = new LocalStore(path)
    applicationRepositories(store.db)
    requireVerificationSchema(store.db)
    const registered = loadVerificationPlans(absoluteDataDir, {
      ownerId: settings.ownerId,
      workspaceId: settings.workspaceId,
    })
    const commands = new LocalVerificationCommands({
      store,
      ownerId: settings.ownerId,
      workspaceId: settings.workspaceId,
      rules: settings.rules,
      plans: registered,
    })
    return operation(commands)
  } finally {
    store?.close()
  }
}

function handlePlansInit(parsed: PlansInitCommand, io: VerificationCliIO): number {
  const absoluteDataDir = resolve(parsed.dataDir)
  validateInitializedDataDir(absoluteDataDir)
  const settings = loadSettings(settingsPath(absoluteDataDir))
  const registryPath = join(absoluteDataDir, 'verification-plans.json')
  if (existsSync(registryPath)) fail('Verification plans registry already exists')
  const plans = readTrustedPlansFile(parsed.file)
  let created: { path: string }
  try {
    created = createVerificationPlans(absoluteDataDir, {
      ownerId: settings.ownerId,
      workspaceId: settings.workspaceId,
    }, plans)
  } catch {
    fail('Verification plans registry could not be created')
  }
  writeJson(io, {
    path: created.path,
    schemaVersion: 1,
    planCount: plans.length,
    plans: plans.map(compactPlanMetadata),
  })
  return 0
}

function handlePlansList(parsed: PlansListCommand, io: VerificationCliIO): number {
  const absoluteDataDir = resolve(parsed.dataDir)
  validateInitializedDataDir(absoluteDataDir)
  const settings = loadSettings(settingsPath(absoluteDataDir))
  const plans = loadVerificationPlans(absoluteDataDir, {
    ownerId: settings.ownerId,
    workspaceId: settings.workspaceId,
  })
  writeJson(io, plans.map(compactPlanMetadata))
  return 0
}

function handleCreate(parsed: CreateCommand, io: VerificationCliIO): number {
  const result = withLocalStore(parsed.dataDir, commands => {
    try {
      return commands.create(parsed.key, parsed.ticketId, {
        expectedVersion: parsed.expectedVersion,
        executionId: parsed.executionId,
        artifactRevision: parsed.artifactRevision,
        planId: parsed.planId,
        planRevision: parsed.planRevision,
        reason: parsed.reason,
      })
    } catch (error) {
      if (error instanceof VerificationCommandError) fail(error.message)
      throw error
    }
  })
  writeJson(io, result)
  return 0
}

function handleStatus(parsed: StatusCommand, io: VerificationCliIO): number {
  const absoluteDataDir = resolve(parsed.dataDir)
  const path = validateInitializedDataDir(absoluteDataDir)
  const settings = loadSettings(settingsPath(absoluteDataDir))
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    requireVerificationSchema(db)
    const repository = new VerificationJobRepository(db)
    const job = repository.get(parsed.verificationId)
    if (
      !job
      || job.request.ownerId !== settings.ownerId
      || job.request.workspaceId !== settings.workspaceId
    ) {
      fail('Verification resource not found')
    }
    const ticket = ProductQueries({ db, ownerId: settings.ownerId, workspaceId: settings.workspaceId }).task(job.request.ticketId)
    if (!ticket) {
      fail('Verification resource not found')
    }
    writeJson(io, { job: { ...job, request: { ...job.request, plan: compactPlanMetadata(job.request.plan) } },
      history: repository.history(parsed.verificationId) })
    return 0
  } finally {
    db?.close()
  }
}

function handleCancel(parsed: CancelCommand, io: VerificationCliIO): number {
  const result = withLocalStore(parsed.dataDir, commands => {
    try {
      return commands.cancel(parsed.key, parsed.verificationId, {
        expectedVersion: parsed.expectedVersion,
        reason: parsed.reason,
      })
    } catch (error) {
      if (error instanceof VerificationCommandError) fail(error.message)
      throw error
    }
  })
  writeJson(io, result)
  return 0
}

/**
 * Dispatches durable verification CLI commands. Returns undefined only when the command
 * is unrecognized so the parent can fall through to API/controller/task/legacy handlers.
 */
export function runVerificationCommand(
  argv: readonly string[],
  io: VerificationCliIO = process,
): number | undefined {
  const command = argv[0]
  if (command === undefined || !isCommandName(command)) return undefined

  try {
    const parsed = parseArgs(argv)
    switch (parsed.command) {
      case 'verification-plans-init':
        return handlePlansInit(parsed, io)
      case 'verification-plans':
        return handlePlansList(parsed, io)
      case 'verification-create':
        return handleCreate(parsed, io)
      case 'verification-status':
        return handleStatus(parsed, io)
      case 'verification-cancel':
        return handleCancel(parsed, io)
    }
  } catch (error) {
    io.stderr.write(`Error: ${redactError(error)}\n`)
    return 1
  }
}

/** Exported for tests that need the canonical owner id used with loadSettings scope. */
export function verificationCliOwnerIdForTests(): string {
  return localOwnerId()
}
