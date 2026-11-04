#!/usr/bin/env node
import { closeSync, constants, existsSync, chmodSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { redact } from '../security/redaction.ts'
import { TASK_STATES, type TaskState } from '../core/lifecycle-model.ts'
import type { ProjectCreateInput } from '../projects/projects.ts'
import { TaskQueries } from '../storage/task-queries.ts'
import { createBackup } from '../storage/backup.ts'
import { applicationRepositories, initializeApplicationSchema } from '../storage/application-store.ts'
import { LAO_SCHEMA_VERSION, LocalStore } from '../storage/store.ts'
import type { EmployeeCreateInput } from '../workforce/employees.ts'
import { runTaskCommand } from './task-commands.ts'
import { runControllerCommand } from './controller-commands.ts'
import { runApiCommand } from './api-commands.ts'

export interface CliIO {
  stdout: { write(value: string): unknown }
  stderr: { write(value: string): unknown }
}

const HELP = `Usage: workforce <command> [options]

Commands:
  --help                 Show this help
  doctor                 Report local runtime and environment facts as JSON
  init                   Initialize local storage
  status                 Show schema and task counts
  tickets                List tasks
  employees              List employees in the local workspace
  employee-create        Create an employee from a JSON file
  employee-enable ID     Enable an employee at the expected version
  projects               List projects in the local workspace
  project-create         Create a project from a JSON file
  backup                 Create a database-only backup
  configure              Create local settings (--claude-command ABS_PATH)
  task-create            Create a task from a JSON file
  task-approve ID        Approve execution (--reason TEXT)
  task-reject ID         Reject execution (--reason TEXT)
  task-cancel ID         Request cancellation (--reason TEXT)
  task-retry ID          Explicitly retry a stopped task (--reason TEXT)
  run-once               Schedule and reconcile one authorized tick
  executions             List durable execution records
  task-verify ID         Run --checks-file JSONFILE or --waive (--reason TEXT)
  task-review ID         Review exact --execution-id and --artifact-revision
                         (--decision approved|rejected --reason TEXT)
  start --foreground     Run the local controller in this terminal
  stop                   Request graceful controller stop (Runners remain independent)
  controller-status      Query controller ownership and process liveness
  logs ID                Read scoped execution logs (--tail-bytes N, --execution-id ID)
  api-init               Create private local API credentials (prints path only)
  api-serve              Run authenticated loopback HTTP API (--port N, --allow-origin URL, --web-root DIR)

Options:
  --data-dir DIR         Data directory (default: .workforce in the current directory)
  --file JSONFILE        JSON input file for create commands
  --version N            Expected employee version for employee-enable
  --backup-dir DIR       Destination root for database-only backup
`

const LOCAL_WORKSPACE = 'local'
const MAX_JSON_BYTES = 128 * 1024
const COMMANDS = [
  'doctor', 'init', 'status', 'tickets',
  'employees', 'employee-create', 'employee-enable',
  'projects', 'project-create', 'backup',
] as const

type CommandName = (typeof COMMANDS)[number]

interface DataDirCommand {
  command: 'doctor' | 'init' | 'status' | 'tickets' | 'employees' | 'projects'
  dataDir: string
}

interface FileCommand {
  command: 'employee-create' | 'project-create'
  dataDir: string
  file: string
}

interface EnableCommand {
  command: 'employee-enable'
  dataDir: string
  id: string
  version: number
}

interface BackupCommand {
  command: 'backup'
  dataDir: string
  backupDir: string
}

type ParsedCommand =
  | DataDirCommand
  | FileCommand
  | EnableCommand
  | BackupCommand
  | { command: 'help' }

interface TicketProjection {
  id: string
  title: string
  status: TaskState
  updatedAt: string
}

function fail(message: string): never {
  throw new Error(message)
}

function isCommandName(value: string): value is CommandName {
  return (COMMANDS as readonly string[]).includes(value)
}

function parseArgs(argv: readonly string[]): ParsedCommand {
  const [command, ...options] = argv
  if (command === '--help') {
    if (options.length) fail('--help does not accept options or arguments')
    return { command: 'help' }
  }
  if (command === undefined) fail('Missing command; use --help for usage')
  if (!isCommandName(command)) fail(`Unknown command: ${command}`)

  let dataDir = resolve(process.cwd(), '.workforce')
  let dataDirSeen = false
  let file: string | undefined
  let fileSeen = false
  let backupDir: string | undefined
  let backupDirSeen = false
  let version: number | undefined
  let versionSeen = false
  let id: string | undefined

  for (let index = 0; index < options.length; index++) {
    const option = options[index]!
    if (option === '--data-dir') {
      if (dataDirSeen) fail('Option --data-dir may only be provided once')
      const value = options[++index]
      if (!value || value.startsWith('-')) fail('Missing value for --data-dir')
      dataDir = resolve(process.cwd(), value)
      dataDirSeen = true
      continue
    }
    if (option === '--file') {
      if (command !== 'employee-create' && command !== 'project-create') fail(`Unknown option: ${option}`)
      if (fileSeen) fail('Option --file may only be provided once')
      const value = options[++index]
      if (!value || value.startsWith('-')) fail('Missing value for --file')
      file = resolve(process.cwd(), value)
      fileSeen = true
      continue
    }
    if (option === '--backup-dir') {
      if (command !== 'backup') fail(`Unknown option: ${option}`)
      if (backupDirSeen) fail('Option --backup-dir may only be provided once')
      const value = options[++index]
      if (!value || value.startsWith('-')) fail('Missing value for --backup-dir')
      backupDir = resolve(process.cwd(), value)
      backupDirSeen = true
      continue
    }
    if (option === '--version') {
      if (command !== 'employee-enable') fail(`Unknown option: ${option}`)
      if (versionSeen) fail('Option --version may only be provided once')
      const value = options[++index]
      if (!value || value.startsWith('-')) fail('Missing value for --version')
      if (!/^[1-9][0-9]*$/.test(value)) fail('Invalid value for --version')
      const parsed = Number(value)
      if (!Number.isSafeInteger(parsed)) fail('Invalid value for --version')
      version = parsed
      versionSeen = true
      continue
    }
    if (option.startsWith('-')) fail(`Unknown option: ${option}`)
    if (command !== 'employee-enable') fail(`Unexpected argument: ${option}`)
    if (id !== undefined) fail(`Unexpected argument: ${option}`)
    id = option
  }

  if (command === 'employee-create' || command === 'project-create') {
    if (!file) fail('Missing required option --file')
    return { command, dataDir, file }
  }
  if (command === 'employee-enable') {
    if (!id) fail('Missing employee id')
    if (version === undefined) fail('Missing required option --version')
    return { command, dataDir, id, version }
  }
  if (command === 'backup') {
    if (!backupDir) fail('Missing required option --backup-dir')
    return { command, dataDir, backupDir }
  }
  return { command, dataDir }
}

function databasePath(dataDir: string): string {
  return resolve(dataDir, 'workforce.sqlite')
}

function readSchema(db: DatabaseSync): number {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('kv', 'ticket')").all()
    .map(row => String(row.name)))
  if (!tables.has('kv')) fail('Database is not initialized: schema metadata is missing')

  const row = db.prepare("SELECT value FROM kv WHERE key = 'schema'").get()
  if (!row) fail('Database is not initialized: schema version is missing')
  let schema: unknown
  try { schema = JSON.parse(String(row.value)) }
  catch { fail('Database is not initialized: schema version is invalid') }
  if (!Number.isInteger(schema)) fail('Database is not initialized: schema version is invalid')
  if (schema === 11) fail(`Legacy LAO schema 11 cannot be queried; explicitly migrate it to schema ${LAO_SCHEMA_VERSION}`)
  if (schema !== LAO_SCHEMA_VERSION) fail(`Unsupported LAO schema ${String(schema)}; expected schema ${LAO_SCHEMA_VERSION}`)
  if (!tables.has('ticket')) fail(`Database schema ${LAO_SCHEMA_VERSION} is incomplete: ticket table is missing`)
  return schema as number
}

function projectTickets(db: DatabaseSync): TicketProjection[] {
  return db.prepare('SELECT value FROM ticket ORDER BY rowid DESC').all().map(row => {
    let value: unknown
    try { value = JSON.parse(String(row.value)) }
    catch { fail('Database contains an invalid ticket record') }
    if (!value || typeof value !== 'object') fail('Database contains an invalid ticket record')
    const ticket = value as Record<string, unknown>
    const lifecycle = ticket.lifecycle
    const status = lifecycle && typeof lifecycle === 'object' ? (lifecycle as Record<string, unknown>).status : undefined
    if (typeof ticket.id !== 'string' || typeof ticket.title !== 'string' || typeof ticket.updatedAt !== 'string'
      || typeof status !== 'string' || !TASK_STATES.includes(status as TaskState)) {
      fail('Database contains an invalid current-schema ticket record')
    }
    return { id: ticket.id, title: ticket.title, status: status as TaskState, updatedAt: ticket.updatedAt }
  })
}

function readDatabase<T>(dataDir: string, operation: (db: DatabaseSync, schema: number) => T): T {
  const path = databasePath(dataDir)
  if (!existsSync(path) || !statSync(path).isFile()) fail(`Database is not initialized at ${path}; run init first`)
  let db: DatabaseSync | undefined
  try {
    db = new DatabaseSync(path, { readOnly: true })
    return operation(db, readSchema(db))
  } finally {
    db?.close()
  }
}

function requireExistingDatabase(dataDir: string): string {
  const path = databasePath(dataDir)
  if (!existsSync(path) || !statSync(path).isFile()) fail(`Database is not initialized at ${path}; run init first`)
  readDatabase(dataDir, () => undefined)
  return path
}

function withLocalStore<T>(dataDir: string, operation: (store: LocalStore) => T): T {
  const path = requireExistingDatabase(dataDir)
  let store: LocalStore | undefined
  try {
    store = new LocalStore(path)
    return operation(store)
  } finally {
    store?.close()
  }
}

function readJsonObjectFile(path: string): Record<string, unknown> {
  let metadata
  try { metadata = lstatSync(path) }
  catch { fail('JSON file does not exist') }
  if (metadata.isSymbolicLink()) fail('JSON file must not be a symbolic link')
  if (!metadata.isFile()) fail('JSON file must be a regular file')
  if (metadata.size > MAX_JSON_BYTES) fail('JSON file exceeds 128KiB limit')

  let fd: number | undefined
  let raw: string
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const bytes = readFileSync(fd)
    if (bytes.byteLength > MAX_JSON_BYTES) fail('JSON file exceeds 128KiB limit')
    raw = bytes.toString('utf8')
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('JSON file')) throw error
    fail('JSON file could not be read')
  } finally {
    if (fd !== undefined) closeSync(fd)
  }

  let value: unknown
  try { value = JSON.parse(raw) }
  catch { fail('JSON file is not valid JSON') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('JSON file must contain an object')
  return value as Record<string, unknown>
}

/** Supply the single-owner local workspace; reject any other workspaceId from JSON. */
function withLocalWorkspace(record: Record<string, unknown>): Record<string, unknown> {
  if ('workspaceId' in record && record.workspaceId !== LOCAL_WORKSPACE) {
    fail(`This local CLI only supports workspaceId "${LOCAL_WORKSPACE}"`)
  }
  return { ...record, workspaceId: LOCAL_WORKSPACE }
}

function writeJson(io: CliIO, value: unknown): void {
  io.stdout.write(`${JSON.stringify(value)}\n`)
}

/** Runs one CLI invocation. argv contains command arguments only (normally process.argv.slice(2)). */
export function runCli(argv: readonly string[], io: CliIO = process): number {
  try {
    const parsed = parseArgs(argv)
    if (parsed.command === 'help') {
      io.stdout.write(HELP)
      return 0
    }

    if (parsed.command === 'doctor') {
      const path = databasePath(parsed.dataDir)
      writeJson(io, {
        runtime: { node: process.version, platform: process.platform, arch: process.arch },
        environment: { cwd: process.cwd(), dataDir: parsed.dataDir, databaseExists: existsSync(path) && statSync(path).isFile() },
      })
      return 0
    }

    if (parsed.command === 'init') {
      if (existsSync(parsed.dataDir)) {
        const entry = lstatSync(parsed.dataDir)
        if (!entry.isDirectory() || entry.isSymbolicLink()) fail('Data directory must be a real directory')
        if (process.platform !== 'win32' && (entry.mode & 0o077) !== 0)
          fail('Existing data directory must be private (0700); choose a dedicated directory')
      } else {
        mkdirSync(parsed.dataDir, { recursive: true, mode: 0o700 })
        chmodSync(parsed.dataDir, 0o700)
      }
      let store: LocalStore | undefined
      let schema: number | undefined
      try {
        store = new LocalStore(databasePath(parsed.dataDir))
        initializeApplicationSchema(store)
        schema = store.get<number>('schema')
      } finally {
        store?.close()
      }
      if (schema !== LAO_SCHEMA_VERSION) fail(`Initialization produced unexpected schema ${String(schema)}`)
      writeJson(io, { initialized: true, schema })
      return 0
    }

    if (parsed.command === 'status') {
      const result = readDatabase(parsed.dataDir, (db, schema) => {
        const counts = TaskQueries(db).counts()
        return { initialized: true, schema, tasks: { total: counts.total, byStatus: counts.byState } }
      })
      writeJson(io, result)
      return 0
    }

    if (parsed.command === 'tickets') {
      writeJson(io, readDatabase(parsed.dataDir, db => projectTickets(db)))
      return 0
    }

    if (parsed.command === 'employees') {
      writeJson(io, readDatabase(parsed.dataDir, db => applicationRepositories(db).employees.list(LOCAL_WORKSPACE)))
      return 0
    }

    if (parsed.command === 'projects') {
      writeJson(io, readDatabase(parsed.dataDir, db => applicationRepositories(db).projects.list(LOCAL_WORKSPACE)))
      return 0
    }

    if (parsed.command === 'employee-create') {
      const input = withLocalWorkspace(readJsonObjectFile(parsed.file)) as unknown as EmployeeCreateInput
      const created = withLocalStore(parsed.dataDir, store => applicationRepositories(store.db).employees.create(input))
      writeJson(io, created)
      return 0
    }

    if (parsed.command === 'project-create') {
      const input = withLocalWorkspace(readJsonObjectFile(parsed.file)) as unknown as ProjectCreateInput
      const created = withLocalStore(parsed.dataDir, store => applicationRepositories(store.db).projects.create(input))
      writeJson(io, created)
      return 0
    }

    if (parsed.command === 'employee-enable') {
      const updated = withLocalStore(parsed.dataDir, store => {
        const employees = applicationRepositories(store.db).employees
        if (employees.get(parsed.id)?.workspaceId !== LOCAL_WORKSPACE) fail('Employee is not in the local workspace')
        return employees.setEnabled(parsed.id, { expectedVersion: parsed.version, enabled: true })
      })
      writeJson(io, updated)
      return 0
    }

    if (parsed.command === 'backup') {
      const manifest = withLocalStore(parsed.dataDir, store => createBackup(store.db, { root: parsed.backupDir }))
      writeJson(io, manifest)
      return 0
    }

    fail(`Unhandled command: ${(parsed as { command: string }).command}`)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    io.stderr.write(`Error: ${redact(message)}\n`)
    return 1
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false
  const modulePath = fileURLToPath(import.meta.url)
  try { return realpathSync(modulePath) === realpathSync(process.argv[1]) }
  catch { return modulePath === resolve(process.argv[1]) }
}

/** Async application entry; the legacy synchronous management dispatcher remains importable. */
export async function runApplicationCli(argv: readonly string[], io: CliIO = process): Promise<number> {
  return await runApiCommand(argv, io) ?? await runControllerCommand(argv, io) ?? await runTaskCommand(argv, io) ?? runCli(argv, io)
}

if (isMainModule()) process.exitCode = await runApplicationCli(process.argv.slice(2))
