/** Local application settings: non-secret JSON config. Credentials come from an explicit secret provider in memory. */
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path'
import { RuleAssessor, type Rule } from '../assessor/rules.ts'

export const SETTINGS_SCHEMA_VERSION = 1 as const
export const LOCAL_WORKSPACE_ID = 'local' as const

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
/** Safe config field names only; hyphenated/token-shaped keys are not echoed in errors. */
const SAFE_FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const MAX_SETTINGS_BYTES = 128 * 1024
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 86_400_000
const MIN_OUTPUT_BYTES = 4 * 1024
const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024
const MIN_GRACE_MS = 1_000
const MAX_GRACE_MS = 60_000
const MIN_POLL_MS = 100
const MAX_POLL_MS = 60_000
const MIN_CONCURRENCY = 1
const MAX_CONCURRENCY = 64
const DEFAULT_TIMEOUT_MS = 3_600_000
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_GRACE_MS = 5_000
const DEFAULT_POLL_MS = 1_000
const DEFAULT_CONCURRENCY = 1
const PRIVATE_FILE_MODE = 0o600
/** Permission + setuid/setgid/sticky; excludes file-type bits from st_mode. */
const MODE_BITS = 0o7777
const TRUSTED_DARWIN_ALIASES = new Set(['/var', '/tmp', '/etc'])

const TOP_LEVEL_FIELDS = [
  'schemaVersion',
  'workspaceId',
  'ownerId',
  'runtime',
  'scheduler',
  'rules',
] as const

const RUNTIME_FIELDS = [
  'id',
  'driver',
  'command',
  'timeoutMs',
  'maxOutputBytes',
  'graceMs',
] as const

const SCHEDULER_FIELDS = ['pollIntervalMs', 'maxConcurrency'] as const

const RULE_FIELDS = [
  'id',
  'enabled',
  'taskTypes',
  'priority',
  'approvalRequired',
  'reviewRequired',
  'retryLimit',
] as const

const DEFAULT_INPUT_FIELDS = ['ownerId', 'claudeCommand'] as const

export interface LocalRuntimeSettings {
  id: 'claude-local'
  driver: 'claude-code'
  /** Absolute Claude CLI path, or null when not configured (cannot start Runtime). */
  command: string | null
  timeoutMs: number
  maxOutputBytes: number
  graceMs: number
}

export interface LocalSchedulerSettings {
  pollIntervalMs: number
  maxConcurrency: number
}

export interface LocalSettings {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION
  workspaceId: typeof LOCAL_WORKSPACE_ID
  ownerId: string
  runtime: LocalRuntimeSettings
  scheduler: LocalSchedulerSettings
  rules: Rule[]
}

export interface DefaultSettingsInput {
  ownerId: string
  claudeCommand?: string
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Invalid ${label}`)
  }
  return value as Record<string, unknown>
}

function unknownFieldMessage(label: string, field: string): string {
  // Keep structural labels (settings/runtime/…); echo only safe field names, never credential-shaped keys.
  if (SAFE_FIELD_NAME.test(field)) return `Unknown ${label} field: ${field}`
  return `Unknown ${label} field`
}

function requireOnlyFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields)
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(unknownFieldMessage(label, field))
  }
}

function requireSafeId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`Invalid ${field}`)
}

function requireBoundInt(value: unknown, field: string, min: number, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`Invalid ${field}`)
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

/** Reject symlink path components except trusted macOS /var,/tmp,/etc aliases. */
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
        throw new Error(`Symbolic link path component is unsupported: ${current}`)
      }
    }
  }
}

function assertAbsolutePath(path: unknown, label: string): string {
  if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path)) {
    throw new Error(`${label} must be an absolute path`)
  }
  return resolve(path)
}

/** True only when the settings file would be a direct child of HOME (not a descendant project path). */
function isDirectlyInHome(absolutePath: string): boolean {
  let home: string
  try {
    home = realpathSync(homedir())
  } catch {
    home = resolve(homedir())
  }
  const parent = dirname(absolutePath)
  return parent === home || parent === resolve(homedir())
}

function assertPrivateParent(parent: string): void {
  let info
  try {
    info = lstatSync(parent)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new Error('Settings parent directory does not exist')
    throw error
  }
  if (info.isSymbolicLink()) {
    const canonical = realpathSync(parent)
    if (!isTrustedDarwinAlias(parent, canonical)) {
      throw new Error('Settings parent directory must not be a symbolic link')
    }
    info = lstatSync(canonical)
  }
  if (!info.isDirectory()) throw new Error('Settings parent must be a directory')
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    throw new Error('Settings parent directory must be private (0700); choose a dedicated directory')
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error('Settings parent directory must be owned by the current user')
  }
}

function cloneRule(rule: Rule): Rule {
  return {
    id: rule.id,
    enabled: rule.enabled,
    taskTypes: [...rule.taskTypes],
    priority: rule.priority,
    approvalRequired: rule.approvalRequired,
    reviewRequired: rule.reviewRequired,
    retryLimit: rule.retryLimit,
  }
}

function validateRuleObject(value: unknown, index: number): Rule {
  const label = `rule[${index}]`
  const raw = requireObject(value, label)
  requireOnlyFields(raw, RULE_FIELDS, label)
  if (typeof raw.id !== 'string') throw new Error(`Invalid ${label}.id`)
  if (typeof raw.enabled !== 'boolean') throw new Error(`Invalid ${label}.enabled`)
  if (!Array.isArray(raw.taskTypes) || !raw.taskTypes.every(item => typeof item === 'string')) {
    throw new Error(`Invalid ${label}.taskTypes`)
  }
  if (typeof raw.priority !== 'number') throw new Error(`Invalid ${label}.priority`)
  if (typeof raw.approvalRequired !== 'boolean') throw new Error(`Invalid ${label}.approvalRequired`)
  if (typeof raw.reviewRequired !== 'boolean') throw new Error(`Invalid ${label}.reviewRequired`)
  if (typeof raw.retryLimit !== 'number') throw new Error(`Invalid ${label}.retryLimit`)
  return {
    id: raw.id,
    enabled: raw.enabled,
    taskTypes: [...raw.taskTypes],
    priority: raw.priority,
    approvalRequired: raw.approvalRequired,
    reviewRequired: raw.reviewRequired,
    retryLimit: raw.retryLimit,
  }
}

function validateRuntime(value: unknown): LocalRuntimeSettings {
  const raw = requireObject(value, 'runtime')
  requireOnlyFields(raw, RUNTIME_FIELDS, 'runtime')
  if (raw.id !== 'claude-local') throw new Error('Invalid runtime.id')
  if (raw.driver !== 'claude-code') throw new Error('Invalid runtime.driver')
  if (raw.command !== null) {
    if (typeof raw.command !== 'string' || !raw.command || raw.command.includes('\0') || !isAbsolute(raw.command)) {
      throw new Error('Invalid runtime.command')
    }
  }
  requireBoundInt(raw.timeoutMs, 'runtime.timeoutMs', MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)
  requireBoundInt(raw.maxOutputBytes, 'runtime.maxOutputBytes', MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES)
  requireBoundInt(raw.graceMs, 'runtime.graceMs', MIN_GRACE_MS, MAX_GRACE_MS)
  return {
    id: 'claude-local',
    driver: 'claude-code',
    command: raw.command,
    timeoutMs: raw.timeoutMs,
    maxOutputBytes: raw.maxOutputBytes,
    graceMs: raw.graceMs,
  }
}

function validateScheduler(value: unknown): LocalSchedulerSettings {
  const raw = requireObject(value, 'scheduler')
  requireOnlyFields(raw, SCHEDULER_FIELDS, 'scheduler')
  requireBoundInt(raw.pollIntervalMs, 'scheduler.pollIntervalMs', MIN_POLL_MS, MAX_POLL_MS)
  requireBoundInt(raw.maxConcurrency, 'scheduler.maxConcurrency', MIN_CONCURRENCY, MAX_CONCURRENCY)
  return {
    pollIntervalMs: raw.pollIntervalMs,
    maxConcurrency: raw.maxConcurrency,
  }
}

/** Returns a cloned validated snapshot; caller mutations of input or result do not affect later validation. */
export function validateSettings(value: unknown): LocalSettings {
  const raw = requireObject(value, 'settings')
  requireOnlyFields(raw, TOP_LEVEL_FIELDS, 'settings')
  if (raw.schemaVersion !== SETTINGS_SCHEMA_VERSION) {
    // Do not echo the supplied value; it may contain credential-shaped material.
    throw new Error('Unsupported settings schemaVersion')
  }
  if (raw.workspaceId !== LOCAL_WORKSPACE_ID) throw new Error('Invalid workspaceId')
  requireSafeId(raw.ownerId, 'ownerId')
  const runtime = validateRuntime(raw.runtime)
  const scheduler = validateScheduler(raw.scheduler)
  if (!Array.isArray(raw.rules)) throw new Error('Invalid rules')
  const rules = raw.rules.map((rule, index) => validateRuleObject(rule, index))
  // RuleAssessor enforces structural/overlap constraints used by LocalTaskService.
  new RuleAssessor(rules)
  return {
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    workspaceId: LOCAL_WORKSPACE_ID,
    ownerId: raw.ownerId,
    runtime: { ...runtime },
    scheduler: { ...scheduler },
    rules: rules.map(cloneRule),
  }
}

/** Defaults keep human approval and review required for the documentation rule. */
export function defaultSettings(input: DefaultSettingsInput): LocalSettings {
  const raw = requireObject(input, 'defaultSettings input')
  requireOnlyFields(raw, DEFAULT_INPUT_FIELDS, 'defaultSettings input')
  requireSafeId(raw.ownerId, 'ownerId')
  let command: string | null = null
  if ('claudeCommand' in raw && raw.claudeCommand !== undefined) {
    if (
      typeof raw.claudeCommand !== 'string'
      || !raw.claudeCommand
      || raw.claudeCommand.includes('\0')
      || !isAbsolute(raw.claudeCommand)
    ) {
      throw new Error('Invalid claudeCommand')
    }
    command = raw.claudeCommand
  }
  return validateSettings({
    schemaVersion: SETTINGS_SCHEMA_VERSION,
    workspaceId: LOCAL_WORKSPACE_ID,
    ownerId: raw.ownerId,
    runtime: {
      id: 'claude-local',
      driver: 'claude-code',
      command,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      graceMs: DEFAULT_GRACE_MS,
    },
    scheduler: {
      pollIntervalMs: DEFAULT_POLL_MS,
      maxConcurrency: DEFAULT_CONCURRENCY,
    },
    rules: [{
      id: 'documentation',
      enabled: true,
      taskTypes: ['documentation'],
      priority: 10,
      approvalRequired: true,
      reviewRequired: true,
      retryLimit: 2,
    }],
  })
}

function assertExactPrivateMode(mode: number | bigint): void {
  const bits = Number(mode) & MODE_BITS
  if (process.platform !== 'win32' && bits !== PRIVATE_FILE_MODE) {
    throw new Error('Settings file must be mode 0600')
  }
}

function assertCurrentOwner(uid: number | bigint): void {
  if (typeof process.getuid === 'function' && Number(uid) !== process.getuid()) {
    throw new Error('Settings file must be owned by the current user')
  }
}

function assertPrivateSettingsFile(path: string): void {
  const info = lstatSync(path)
  if (info.isSymbolicLink()) throw new Error('Settings path must not be a symbolic link')
  if (!info.isFile()) throw new Error('Settings path must be a regular file')
  assertExactPrivateMode(info.mode)
  assertCurrentOwner(info.uid)
  if (info.size > MAX_SETTINGS_BYTES) throw new Error('Settings file exceeds 128KiB limit')
}

function assertPrivateFdStats(info: ReturnType<typeof fstatSync>): void {
  if (!info.isFile()) throw new Error('Settings path must be a regular file')
  if (Number(info.size) > MAX_SETTINGS_BYTES) throw new Error('Settings file exceeds 128KiB limit')
  assertExactPrivateMode(info.mode)
  assertCurrentOwner(info.uid)
}

/** Load existing settings only. Never creates, migrates, or probes auth/CLI. */
export function loadSettings(path: string): LocalSettings {
  const absolute = assertAbsolutePath(path, 'Settings path')
  rejectSymlinkComponents(absolute, false)
  assertPrivateSettingsFile(absolute)
  const fd = openSync(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(fd)
    assertPrivateFdStats(before)
    // Bound the actual read as well as stat size: a concurrent writer may grow the file.
    const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    const buffer = bytes.subarray(0, length)
    const after = fstatSync(fd)
    assertPrivateFdStats(after)
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.uid !== after.uid
      || before.mode !== after.mode
    ) {
      throw new Error('Settings file changed while reading')
    }
    if (buffer.byteLength > MAX_SETTINGS_BYTES) throw new Error('Settings file exceeds 128KiB limit')
    let parsed: unknown
    try {
      parsed = JSON.parse(buffer.toString('utf8')) as unknown
    } catch {
      throw new Error('Settings file is not valid JSON')
    }
    return validateSettings(parsed)
  } finally {
    closeSync(fd)
  }
}

/**
 * Explicitly create a new private settings file (wx/0600 + fsync).
 * Rejects shared existing parents instead of chmod'ing them.
 * Rejects a settings file placed directly in the default user HOME; project-local descendants are allowed.
 */
export function createSettings(path: string, value: unknown): LocalSettings {
  const absolute = assertAbsolutePath(path, 'Settings path')
  if (isDirectlyInHome(absolute)) {
    throw new Error('Settings must not be stored directly in the default user HOME directory')
  }
  rejectSymlinkComponents(absolute, true)
  const parent = dirname(absolute)
  rejectSymlinkComponents(parent, false)
  assertPrivateParent(parent)
  if (existsSync(absolute)) throw new Error('Settings file already exists')

  const settings = validateSettings(value)
  const payload = `${JSON.stringify(settings)}\n`
  if (Buffer.byteLength(payload, 'utf8') > MAX_SETTINGS_BYTES) {
    throw new Error('Settings payload exceeds 128KiB limit')
  }

  let fd: number | undefined
  let created = false
  try {
    fd = openSync(
      absolute,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      PRIVATE_FILE_MODE,
    )
    created = true
    writeFileSync(fd, payload, 'utf8')
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    assertPrivateSettingsFile(absolute)
    return validateSettings(settings)
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* best-effort */ }
    }
    if (created) {
      try { unlinkSync(absolute) } catch { /* only own partial file */ }
    }
    throw error
  }
}
