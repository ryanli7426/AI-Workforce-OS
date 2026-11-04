/** Query-only execution stdout/stderr reader. Never initializes storage or starts Runners. */
import * as fs from 'node:fs'
import { isAbsolute, join, parse, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadSettings, type LocalSettings } from '../config/settings.ts'
import type { Ticket } from '../core/model.ts'
import { applicationRepositories } from '../storage/application-store.ts'
import { LAO_SCHEMA_VERSION } from '../storage/store.ts'
import { StreamingRedactor } from '../security/redaction.ts'

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const DEFAULT_MAX_BYTES = 64 * 1024
const MIN_MAX_BYTES = 1
const MAX_MAX_BYTES = 1024 * 1024
const TRUSTED_DARWIN_ALIASES = new Set(['/var', '/tmp'])
const MODE_BITS = 0o7777
const PRIVATE_DIR_MASK = 0o077
const PRIVATE_FILE_MODE = 0o600
const DATABASE_FILE = 'workforce.sqlite'
const SETTINGS_FILE = 'settings.json'
const RUNNERS_DIR = 'runners'
const STDOUT_FILE = 'stdout.log'
const STDERR_FILE = 'stderr.log'
const NEWLINE = 0x0a

export interface ReadExecutionLogsInput {
  dataDir: string
  ticketId: string
  executionId?: string
  maxBytes?: number
}

export interface ExecutionLogEntry {
  executionId: string
  state: string
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export interface ExecutionLogsResult {
  ticketId: string
  executions: ExecutionLogEntry[]
}

interface Snapshot {
  dataDir: string
  ticketId: string
  executionId: string | undefined
  maxBytes: number
}

/** Intentional query failures; messages stay path-free and credential-free. */
class ExecutionLogsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecutionLogsError'
  }
}

function fail(message: string): never {
  throw new ExecutionLogsError(message)
}

function sanitizeUnknown(error: unknown, fallback: string): never {
  if (error instanceof ExecutionLogsError) throw error
  fail(fallback)
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
      info = fs.lstatSync(current)
    } catch (error) {
      if (allowMissingFinal && isErrno(error, 'ENOENT') && index === parts.length - 1) return
      throw error
    }
    if (info.isSymbolicLink()) {
      const canonical = fs.realpathSync(current)
      if (!isTrustedDarwinAlias(current, canonical)) {
        fail('Symbolic link path component is unsupported')
      }
    }
  }
}

function requireSafeId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) fail(`Invalid ${field}`)
}

function requireAbsoluteDataDir(value: unknown): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || !isAbsolute(value)) {
    fail('dataDir must be an absolute path')
  }
  return resolve(value)
}

function snapshotInput(input: ReadExecutionLogsInput): Snapshot {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    fail('Invalid readExecutionLogs input')
  }
  const dataDir = requireAbsoluteDataDir(input.dataDir)
  requireSafeId(input.ticketId, 'ticketId')
  const ticketId = input.ticketId
  let executionId: string | undefined
  if (input.executionId !== undefined) {
    requireSafeId(input.executionId, 'executionId')
    executionId = input.executionId
  }
  const maxBytes = input.maxBytes === undefined ? DEFAULT_MAX_BYTES : input.maxBytes
  if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_MAX_BYTES || maxBytes > MAX_MAX_BYTES) {
    fail('Invalid maxBytes')
  }
  return { dataDir, ticketId, executionId, maxBytes }
}

function assertOwnerAndPrivateMode(entry: { mode: number; uid: number }, label: string, kind: 'dir' | 'file'): void {
  if (typeof process.getuid === 'function' && entry.uid !== process.getuid()) {
    fail(`${label} must be owned by the current user`)
  }
  if (process.platform === 'win32') return
  if (kind === 'dir') {
    if ((entry.mode & PRIVATE_DIR_MASK) !== 0) fail(`${label} must be private (0700)`)
  } else if ((Number(entry.mode) & MODE_BITS) !== PRIVATE_FILE_MODE) {
    fail(`${label} must be mode 0600`)
  }
}

function assertPrivateRealDirectory(path: string, label: string): void {
  try {
    rejectSymlinkComponents(path, false)
  } catch (error) {
    if (error instanceof ExecutionLogsError) throw error
    if (isErrno(error, 'ENOENT')) fail(`${label} does not exist`)
    sanitizeUnknown(error, `${label} is not accessible`)
  }
  let entry
  try {
    entry = fs.lstatSync(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) fail(`${label} does not exist`)
    sanitizeUnknown(error, `${label} is not accessible`)
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail(`${label} must be a real directory`)
  assertOwnerAndPrivateMode(entry, label, 'dir')
}

function assertRealDatabaseFile(path: string): void {
  try {
    rejectSymlinkComponents(path, false)
  } catch (error) {
    if (error instanceof ExecutionLogsError) throw error
    if (isErrno(error, 'ENOENT')) fail('Database is not initialized')
    sanitizeUnknown(error, 'Database is not accessible')
  }
  let entry
  try {
    entry = fs.lstatSync(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) fail('Database is not initialized')
    sanitizeUnknown(error, 'Database is not accessible')
  }
  if (entry.isSymbolicLink()) fail('Database path must not be a symbolic link')
  if (!entry.isFile()) fail('Database is not initialized')
  assertOwnerAndPrivateMode(entry, 'Database file', 'file')
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

function parseManualSource(source: string): { workspaceId: string; projectId: string } | undefined {
  const parts = source.split(':')
  if (parts.length !== 3 || parts[0] !== 'manual') return undefined
  const workspaceId = parts[1]
  const projectId = parts[2]
  if (!workspaceId || !projectId || !SAFE_ID.test(workspaceId) || !SAFE_ID.test(projectId)) return undefined
  return { workspaceId, projectId }
}

function readTicket(db: DatabaseSync, ticketId: string): Ticket {
  const row = db.prepare('SELECT value FROM ticket WHERE id = ?').get(ticketId)
  if (!row) fail('Unknown ticket')
  let value: unknown
  try {
    value = JSON.parse(String(row.value))
  } catch {
    fail('Ticket record is malformed')
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('Ticket record is malformed')
  const ticket = value as Ticket
  if (ticket.id !== ticketId || !ticket.lifecycle || !ticket.mandate) fail('Unknown ticket')
  return ticket
}

function assertTicketInScope(ticket: Ticket, settings: LocalSettings, projects: { get(id: string): { workspaceId: string } | undefined }): void {
  const source = ticket.lifecycle?.issue.source
  if (typeof source !== 'string') fail('Unknown ticket')
  const parsed = parseManualSource(source)
  if (!parsed || parsed.workspaceId !== settings.workspaceId) fail('Cross-workspace task is not allowed')
  if (ticket.mandate.actor.id !== settings.ownerId || ticket.mandate.actor.source !== source) {
    fail('Task belongs to a different owner')
  }
  const project = projects.get(parsed.projectId)
  if (!project || project.workspaceId !== settings.workspaceId) fail('Task project is not in this workspace')
}

function pathInside(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`
  return candidate === root || candidate.startsWith(normalizedRoot)
}

function assertPrivateExecutionDir(runnersRoot: string, executionId: string): string | undefined {
  const dir = resolve(runnersRoot, executionId)
  if (!pathInside(runnersRoot, dir)) fail('Execution path escapes runners root')
  try {
    rejectSymlinkComponents(dir, false)
  } catch (error) {
    if (error instanceof ExecutionLogsError) throw error
    if (isErrno(error, 'ENOENT')) return undefined
    sanitizeUnknown(error, 'Execution directory is not accessible')
  }
  let entry
  try {
    entry = fs.lstatSync(dir)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    sanitizeUnknown(error, 'Execution directory is not accessible')
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail('Execution directory must be a real directory')
  assertOwnerAndPrivateMode(entry, 'Execution directory', 'dir')
  if (!pathInside(runnersRoot, resolve(dir))) fail('Execution path escapes runners root')
  return dir
}

function skipIncompleteUtf8Prefix(buffer: Buffer, truncated: boolean): Buffer {
  if (!truncated || buffer.length === 0) return buffer
  let index = 0
  while (index < buffer.length && (buffer[index]! & 0xc0) === 0x80) {
    index += 1
  }
  return index === 0 ? buffer : buffer.subarray(index)
}

/**
 * Truncated tails may start mid-line with a credential suffix whose prefix (`api_key=` / `Bearer`)
 * lies just before the window. Fail closed: discard the leading partial line (or the whole buffer
 * when no newline exists). Complete subsequent lines remain usable.
 */
function dropUntrustedLeadingPartialLine(buffer: Buffer, truncated: boolean): Buffer {
  if (!truncated || buffer.length === 0) return buffer
  const newline = buffer.indexOf(NEWLINE)
  if (newline === -1) return Buffer.alloc(0)
  return buffer.subarray(newline + 1)
}

function assertPrivateRegularLogFile(path: string): { size: number; dev: number; ino: number } | 'missing' {
  try {
    rejectSymlinkComponents(path, false)
  } catch (error) {
    if (error instanceof ExecutionLogsError) throw error
    if (isErrno(error, 'ENOENT')) return 'missing'
    sanitizeUnknown(error, 'Log file is not accessible')
  }
  let before
  try {
    before = fs.lstatSync(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 'missing'
    sanitizeUnknown(error, 'Log file is not accessible')
  }
  if (before.isSymbolicLink()) fail('Log path must not be a symbolic link')
  if (!before.isFile()) fail('Log path must be a regular file')
  assertOwnerAndPrivateMode(before, 'Log file', 'file')
  return { size: before.size, dev: before.dev, ino: before.ino }
}

function readFdRange(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const counted = fs.readSync(fd, buffer, offset, length - offset, position + offset)
    if (counted === 0) break
    offset += counted
  }
  if (offset !== length) fail('Log file read was incomplete')
  return buffer
}

function assertStableLogIdentity(
  opened: { dev: number; ino: number; size: number; mode: number; uid: number; isFile(): boolean },
  after: { dev: number; ino: number; size: number; mode: number; uid: number; isFile(): boolean },
): void {
  if (!after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino) {
    fail('Log file changed while reading')
  }
  assertOwnerAndPrivateMode(after, 'Log file', 'file')
  if (after.size < opened.size) fail('Log file changed while reading')
}

/** Bounded FD tail read: never loads the full file when larger than maxBytes. */
function readTailLog(path: string, maxBytes: number): { text: string; truncated: boolean } {
  const meta = assertPrivateRegularLogFile(path)
  if (meta === 'missing') return { text: '', truncated: false }

  let fd: number | undefined
  try {
    try {
      fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    } catch (error) {
      sanitizeUnknown(error, 'Log file could not be opened')
    }

    const opened = fs.fstatSync(fd)
    if (!opened.isFile() || opened.dev !== meta.dev || opened.ino !== meta.ino) {
      fail('Log file changed while opening')
    }
    assertOwnerAndPrivateMode(opened, 'Log file', 'file')

    const size = opened.size
    const truncated = size > maxBytes
    const readLength = truncated ? maxBytes : size
    const position = truncated ? size - maxBytes : 0

    const first = readFdRange(fd, position, readLength)
    // Append-only growth is allowed when the original byte range is unchanged.
    // Detect rewrite/truncation via a bounded second read of that same range.
    const afterFirst = fs.fstatSync(fd)
    assertStableLogIdentity(opened, afterFirst)

    const second = readFdRange(fd, position, readLength)
    const afterSecond = fs.fstatSync(fd)
    assertStableLogIdentity(opened, afterSecond)
    if (!first.equals(second)) fail('Log file changed while reading')

    const decodedBytes = dropUntrustedLeadingPartialLine(
      skipIncompleteUtf8Prefix(first, truncated),
      truncated,
    )
    const redactor = new StreamingRedactor({ maxPendingBytes: Math.min(Math.max(maxBytes, 1), MAX_MAX_BYTES) })
    const text = `${redactor.write(decodedBytes)}${redactor.end()}`
    return { text, truncated }
  } catch (error) {
    return sanitizeUnknown(error, 'Log file could not be read')
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
}

function runnersRootOrUndefined(dataDir: string): string | undefined {
  const runnersRoot = resolve(dataDir, RUNNERS_DIR)
  try {
    rejectSymlinkComponents(runnersRoot, false)
  } catch (error) {
    if (error instanceof ExecutionLogsError) throw error
    if (isErrno(error, 'ENOENT')) return undefined
    sanitizeUnknown(error, 'Runners directory is not accessible')
  }
  let entry
  try {
    entry = fs.lstatSync(runnersRoot)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    sanitizeUnknown(error, 'Runners directory is not accessible')
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) fail('Runners directory must be a real directory')
  assertOwnerAndPrivateMode(entry, 'Runners directory', 'dir')
  return runnersRoot
}

function readExecutionStreams(
  runnersRoot: string | undefined,
  executionId: string,
  maxBytes: number,
): Pick<ExecutionLogEntry, 'stdout' | 'stderr' | 'stdoutTruncated' | 'stderrTruncated'> {
  if (runnersRoot === undefined) {
    return { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false }
  }
  const executionDir = assertPrivateExecutionDir(runnersRoot, executionId)
  if (executionDir === undefined) {
    return { stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false }
  }
  const stdout = readTailLog(join(executionDir, STDOUT_FILE), maxBytes)
  const stderr = readTailLog(join(executionDir, STDERR_FILE), maxBytes)
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  }
}

/**
 * Read persisted execution logs for an owned ticket. Query only: no init/migration/Runner control,
 * no request.json or control-token access, and no claims about live process health.
 */
export async function readExecutionLogs(input: ReadExecutionLogsInput): Promise<ExecutionLogsResult> {
  const snapshot = snapshotInput(input)
  // Yield so caller mutations of the input object after invocation cannot redirect resolved scope.
  await Promise.resolve()

  try {
    assertPrivateRealDirectory(snapshot.dataDir, 'Data directory')
    const databasePath = resolve(snapshot.dataDir, DATABASE_FILE)
    assertRealDatabaseFile(databasePath)
    const settingsFile = resolve(snapshot.dataDir, SETTINGS_FILE)
    try {
      rejectSymlinkComponents(settingsFile, false)
    } catch (error) {
      if (error instanceof ExecutionLogsError) throw error
      if (isErrno(error, 'ENOENT')) fail('Settings file does not exist')
      sanitizeUnknown(error, 'Settings file is not accessible')
    }

    let settings: LocalSettings
    try {
      settings = loadSettings(settingsFile)
    } catch (error) {
      if (error instanceof Error && !/[\\/]/.test(error.message) && !error.message.includes('\0')) {
        fail(error.message)
      }
      sanitizeUnknown(error, 'Settings could not be loaded')
    }

    let db: DatabaseSync | undefined
    try {
      try {
        db = new DatabaseSync(databasePath, { readOnly: true })
      } catch (error) {
        sanitizeUnknown(error, 'Database could not be opened')
      }
      readMainSchema(db)
      const repos = applicationRepositories(db)
      const ticket = readTicket(db, snapshot.ticketId)
      assertTicketInScope(ticket, settings, repos.projects)

      const allForTicket = repos.executions.list().filter(record => record.ticketId === snapshot.ticketId)
      let selected = allForTicket
      if (snapshot.executionId !== undefined) {
        const match = allForTicket.find(record => record.executionId === snapshot.executionId)
        if (!match) {
          const foreign = repos.executions.get(snapshot.executionId)
          if (foreign) fail('Execution belongs to a different ticket')
          fail('Unknown execution')
        }
        selected = [match]
      }

      const runnersRoot = runnersRootOrUndefined(snapshot.dataDir)
      const executions: ExecutionLogEntry[] = selected.map(record => {
        const streams = readExecutionStreams(runnersRoot, record.executionId, snapshot.maxBytes)
        return {
          executionId: record.executionId,
          state: record.state,
          stdout: streams.stdout,
          stderr: streams.stderr,
          stdoutTruncated: streams.stdoutTruncated,
          stderrTruncated: streams.stderrTruncated,
        }
      })

      return { ticketId: snapshot.ticketId, executions }
    } finally {
      db?.close()
    }
  } catch (error) {
    sanitizeUnknown(error, 'Execution log query failed')
  }
}
