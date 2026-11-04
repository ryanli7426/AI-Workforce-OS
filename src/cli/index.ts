#!/usr/bin/env node
import { existsSync, chmodSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { TASK_STATES, type TaskState } from '../core/lifecycle-model.ts'
import { LAO_SCHEMA_VERSION, LocalStore } from '../storage/store.ts'

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

Options:
  --data-dir DIR         Data directory (default: .workforce in the current directory)
`

interface ParsedCommand {
  command: 'doctor' | 'init' | 'status' | 'tickets'
  dataDir: string
}

interface TicketProjection {
  id: string
  title: string
  status: TaskState
  updatedAt: string
}

function fail(message: string): never {
  throw new Error(message)
}

function parseArgs(argv: readonly string[]): ParsedCommand | { command: 'help' } {
  const [command, ...options] = argv
  if (command === '--help') {
    if (options.length) fail('--help does not accept options or arguments')
    return { command: 'help' }
  }
  if (command === undefined) fail('Missing command; use --help for usage')
  if (!['doctor', 'init', 'status', 'tickets'].includes(command)) fail(`Unknown command: ${command}`)

  let dataDir = resolve(process.cwd(), '.workforce')
  let dataDirSeen = false
  for (let index = 0; index < options.length; index++) {
    const option = options[index]!
    if (option !== '--data-dir') fail(option.startsWith('-') ? `Unknown option: ${option}` : `Unexpected argument: ${option}`)
    if (dataDirSeen) fail('Option --data-dir may only be provided once')
    const value = options[++index]
    if (!value || value.startsWith('-')) fail('Missing value for --data-dir')
    dataDir = resolve(process.cwd(), value)
    dataDirSeen = true
  }
  return { command: command as ParsedCommand['command'], dataDir }
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
        const tickets = projectTickets(db)
        const byStatus = Object.fromEntries(TASK_STATES.map(status => [status, 0])) as Record<TaskState, number>
        for (const ticket of tickets) byStatus[ticket.status]++
        return { initialized: true, schema, tasks: { total: tickets.length, byStatus } }
      })
      writeJson(io, result)
      return 0
    }

    writeJson(io, readDatabase(parsed.dataDir, db => projectTickets(db)))
    return 0
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    io.stderr.write(`Error: ${message}\n`)
    return 1
  }
}

function isMainModule(): boolean {
  if (!process.argv[1]) return false
  const modulePath = fileURLToPath(import.meta.url)
  try { return realpathSync(modulePath) === realpathSync(process.argv[1]) }
  catch { return modulePath === resolve(process.argv[1]) }
}

if (isMainModule()) process.exitCode = runCli(process.argv.slice(2))
