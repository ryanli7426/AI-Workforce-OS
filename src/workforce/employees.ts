/** AI Employee configuration records with immutable version snapshots. Config only; no runtime health or authorization. */
import { DatabaseSync } from 'node:sqlite'

const SCHEMA_KEY = 'employee-schema'
const SCHEMA_VERSION = 1
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const MAX_CONCURRENCY = 1024
const MAX_TIMEOUT_MS = 86_400_000
const MAX_NAME_LENGTH = 256
const MAX_ROLE_LENGTH = 256
const MAX_LIST_ITEMS = 256
const MAX_ITEM_LENGTH = 512

const CREATE_FIELDS = [
  'id', 'workspaceId', 'name', 'role', 'responsibilities', 'capabilities', 'runtimeId', 'projectIds',
  'maxConcurrency', 'timeoutMs',
] as const

const UPDATE_FIELDS = [
  'expectedVersion', 'name', 'role', 'responsibilities', 'capabilities', 'runtimeId', 'projectIds',
  'maxConcurrency', 'timeoutMs',
] as const

const ENABLE_FIELDS = ['expectedVersion', 'enabled'] as const

export interface EmployeeCreateInput {
  id: string
  workspaceId: string
  name: string
  role: string
  responsibilities: string[]
  capabilities: string[]
  runtimeId: string
  projectIds: string[]
  maxConcurrency: number
  timeoutMs: number
}

export interface EmployeeUpdateInput {
  expectedVersion: number
  name?: string
  role?: string
  responsibilities?: string[]
  capabilities?: string[]
  runtimeId?: string
  projectIds?: string[]
  maxConcurrency?: number
  timeoutMs?: number
}

export interface EmployeeEnableInput {
  expectedVersion: number
  enabled: boolean
}

/** Persisted employee configuration; runtimeId is identity only and is not process health. */
export interface Employee {
  id: string
  workspaceId: string
  name: string
  role: string
  responsibilities: string[]
  capabilities: string[]
  runtimeId: string
  projectIds: string[]
  maxConcurrency: number
  timeoutMs: number
  enabled: boolean
  version: number
}

let savepointSequence = 0

function savepoint<T>(db: DatabaseSync, prefix: string, operation: () => T): T {
  const name = `${prefix}_${savepointSequence++}`
  db.exec(`SAVEPOINT ${name}`)
  try {
    const result = operation()
    db.exec(`RELEASE ${name}`)
    return result
  } catch (error) {
    try { db.exec(`ROLLBACK TO ${name}`) } finally { db.exec(`RELEASE ${name}`) }
    throw error
  }
}

function requireObject(value: unknown, description: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${description}`)
  return value as Record<string, unknown>
}

function requireOnlyFields(value: Record<string, unknown>, fields: readonly string[], description: string): void {
  const allowed = new Set(fields)
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) throw new Error(`Unknown ${description} field: ${field}`)
  }
}

function requireSafeId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`Invalid ${field}`)
}

function requireName(value: unknown, field: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || !value || value.includes('\0') || value.length > maxLength) throw new Error(`Invalid ${field}`)
}

function requirePositiveBound(value: unknown, field: string, max: number): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${field}`)
}

function requireStringList(value: unknown, field: string, options: { unique: boolean; safeIds: boolean }): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${field}`)
  if (value.length > MAX_LIST_ITEMS) throw new Error(`Invalid ${field}`)
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (options.safeIds) requireSafeId(item, field)
    else {
      if (typeof item !== 'string' || !item || item.includes('\0') || item.length > MAX_ITEM_LENGTH) throw new Error(`Invalid ${field}`)
    }
    if (options.unique) {
      if (seen.has(item)) throw new Error(`Duplicate ${field} entry`)
      seen.add(item)
    }
    result.push(item)
  }
  return result
}

function cloneEmployee(employee: Employee): Employee {
  return {
    id: employee.id,
    workspaceId: employee.workspaceId,
    name: employee.name,
    role: employee.role,
    responsibilities: [...employee.responsibilities],
    capabilities: [...employee.capabilities],
    runtimeId: employee.runtimeId,
    projectIds: [...employee.projectIds],
    maxConcurrency: employee.maxConcurrency,
    timeoutMs: employee.timeoutMs,
    enabled: employee.enabled,
    version: employee.version,
  }
}

function sameConfig(left: Employee, right: Employee): boolean {
  return left.name === right.name
    && left.role === right.role
    && left.runtimeId === right.runtimeId
    && left.maxConcurrency === right.maxConcurrency
    && left.timeoutMs === right.timeoutMs
    && left.enabled === right.enabled
    && JSON.stringify(left.responsibilities) === JSON.stringify(right.responsibilities)
    && JSON.stringify(left.capabilities) === JSON.stringify(right.capabilities)
    && JSON.stringify(left.projectIds) === JSON.stringify(right.projectIds)
}

function parseEmployee(row: Record<string, unknown> | undefined): Employee | undefined {
  if (!row) return undefined
  return cloneEmployee(JSON.parse(String(row.config_json)) as Employee)
}

function readSchemaVersion(db: DatabaseSync): number | undefined {
  const kv = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()
  if (!kv) throw new Error('Employee schema requires an initialized kv table')
  const versionRow = db.prepare('SELECT value FROM kv WHERE key = ?').get(SCHEMA_KEY)
  if (versionRow === undefined) return undefined
  let version: unknown
  try { version = JSON.parse(String(versionRow.value)) } catch { throw new Error('Unknown employee schema version') }
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) throw new Error('Unknown employee schema version')
  return version
}

function requireCurrentSchema(db: DatabaseSync): void {
  const version = readSchemaVersion(db)
  if (version === undefined) throw new Error('Employee schema is not initialized')
  if (version !== SCHEMA_VERSION) throw new Error(`Unknown employee schema version: ${version}`)
}

function validateCreate(value: unknown): EmployeeCreateInput {
  const input = requireObject(value, 'employee create')
  requireOnlyFields(input, CREATE_FIELDS, 'employee create')
  requireSafeId(input.id, 'id')
  requireSafeId(input.workspaceId, 'workspaceId')
  requireName(input.name, 'name', MAX_NAME_LENGTH)
  requireName(input.role, 'role', MAX_ROLE_LENGTH)
  requireSafeId(input.runtimeId, 'runtimeId')
  requirePositiveBound(input.maxConcurrency, 'maxConcurrency', MAX_CONCURRENCY)
  requirePositiveBound(input.timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS)
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    name: input.name,
    role: input.role,
    responsibilities: requireStringList(input.responsibilities, 'responsibilities', { unique: false, safeIds: false }),
    capabilities: requireStringList(input.capabilities, 'capabilities', { unique: true, safeIds: false }),
    runtimeId: input.runtimeId,
    projectIds: requireStringList(input.projectIds, 'projectIds', { unique: true, safeIds: true }),
    maxConcurrency: input.maxConcurrency,
    timeoutMs: input.timeoutMs,
  }
}

function validateUpdate(value: unknown): EmployeeUpdateInput {
  const input = requireObject(value, 'employee update')
  requireOnlyFields(input, UPDATE_FIELDS, 'employee update')
  requirePositiveBound(input.expectedVersion, 'expectedVersion', Number.MAX_SAFE_INTEGER)
  const patch: EmployeeUpdateInput = { expectedVersion: input.expectedVersion }
  if ('name' in input) {
    requireName(input.name, 'name', MAX_NAME_LENGTH)
    patch.name = input.name
  }
  if ('role' in input) {
    requireName(input.role, 'role', MAX_ROLE_LENGTH)
    patch.role = input.role
  }
  if ('responsibilities' in input) {
    patch.responsibilities = requireStringList(input.responsibilities, 'responsibilities', { unique: false, safeIds: false })
  }
  if ('capabilities' in input) {
    patch.capabilities = requireStringList(input.capabilities, 'capabilities', { unique: true, safeIds: false })
  }
  if ('runtimeId' in input) {
    requireSafeId(input.runtimeId, 'runtimeId')
    patch.runtimeId = input.runtimeId
  }
  if ('projectIds' in input) {
    patch.projectIds = requireStringList(input.projectIds, 'projectIds', { unique: true, safeIds: true })
  }
  if ('maxConcurrency' in input) {
    requirePositiveBound(input.maxConcurrency, 'maxConcurrency', MAX_CONCURRENCY)
    patch.maxConcurrency = input.maxConcurrency
  }
  if ('timeoutMs' in input) {
    requirePositiveBound(input.timeoutMs, 'timeoutMs', MAX_TIMEOUT_MS)
    patch.timeoutMs = input.timeoutMs
  }
  return patch
}

function validateEnable(value: unknown): EmployeeEnableInput {
  const input = requireObject(value, 'employee enable')
  requireOnlyFields(input, ENABLE_FIELDS, 'employee enable')
  requirePositiveBound(input.expectedVersion, 'expectedVersion', Number.MAX_SAFE_INTEGER)
  if (typeof input.enabled !== 'boolean') throw new Error('Invalid enabled')
  return { expectedVersion: input.expectedVersion, enabled: input.enabled }
}

/** Adds the employee configuration schema to a caller-owned SQLite connection with a kv table. */
export function initializeEmployeeSchema(db: DatabaseSync): void {
  const version = readSchemaVersion(db)
  if (version !== undefined && version !== SCHEMA_VERSION) {
    throw new Error(`Unknown employee schema version: ${version}`)
  }

  savepoint(db, 'employee_schema', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS employee (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        runtime_id TEXT NOT NULL,
        config_json TEXT NOT NULL CHECK (json_valid(config_json)),
        UNIQUE (workspace_id, name)
      );
      CREATE TABLE IF NOT EXISTS employee_snapshot (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        config_json TEXT NOT NULL CHECK (json_valid(config_json)),
        PRIMARY KEY (id, version),
        FOREIGN KEY (id) REFERENCES employee(id)
      );
      CREATE INDEX IF NOT EXISTS employee_workspace ON employee(workspace_id);
    `)
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SCHEMA_KEY, JSON.stringify(SCHEMA_VERSION))
  })
}

/** Durable AI Employee configuration repository. Does not authorize callers or stop executions. */
export class EmployeeRepository {
  constructor(private readonly db: DatabaseSync) {}

  create(value: EmployeeCreateInput): Employee {
    const input = validateCreate(value)
    requireCurrentSchema(this.db)
    return savepoint(this.db, 'employee_create', () => {
      const employee: Employee = {
        id: input.id,
        workspaceId: input.workspaceId,
        name: input.name,
        role: input.role,
        responsibilities: [...input.responsibilities],
        capabilities: [...input.capabilities],
        runtimeId: input.runtimeId,
        projectIds: [...input.projectIds],
        maxConcurrency: input.maxConcurrency,
        timeoutMs: input.timeoutMs,
        enabled: false,
        version: 1,
      }
      try {
        this.db.prepare(`INSERT INTO employee
          (id, workspace_id, name, version, enabled, runtime_id, config_json)
          VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
          employee.id, employee.workspaceId, employee.name, employee.version, 0, employee.runtimeId,
          JSON.stringify(employee),
        )
        this.db.prepare('INSERT INTO employee_snapshot (id, version, config_json) VALUES (?, ?, ?)')
          .run(employee.id, employee.version, JSON.stringify(employee))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (/UNIQUE/i.test(message)) throw new Error('Employee id or workspace name already exists')
        throw error
      }
      return cloneEmployee(employee)
    })
  }

  get(id: string): Employee | undefined {
    requireSafeId(id, 'id')
    requireCurrentSchema(this.db)
    return parseEmployee(this.db.prepare('SELECT config_json FROM employee WHERE id = ?').get(id))
  }

  list(workspaceId: string): Employee[] {
    requireSafeId(workspaceId, 'workspaceId')
    requireCurrentSchema(this.db)
    return this.db.prepare('SELECT config_json FROM employee WHERE workspace_id = ? ORDER BY rowid')
      .all(workspaceId)
      .map(row => parseEmployee(row)!)
  }

  update(id: string, value: EmployeeUpdateInput): Employee {
    requireSafeId(id, 'id')
    const patch = validateUpdate(value)
    requireCurrentSchema(this.db)
    return savepoint(this.db, 'employee_update', () => {
      const current = parseEmployee(this.db.prepare('SELECT config_json FROM employee WHERE id = ?').get(id))
      if (!current) throw new Error('Employee does not exist')
      if (current.version !== patch.expectedVersion) throw new Error('Employee version conflict')

      const next: Employee = {
        ...current,
        name: patch.name ?? current.name,
        role: patch.role ?? current.role,
        responsibilities: patch.responsibilities ? [...patch.responsibilities] : [...current.responsibilities],
        capabilities: patch.capabilities ? [...patch.capabilities] : [...current.capabilities],
        runtimeId: patch.runtimeId ?? current.runtimeId,
        projectIds: patch.projectIds ? [...patch.projectIds] : [...current.projectIds],
        maxConcurrency: patch.maxConcurrency ?? current.maxConcurrency,
        timeoutMs: patch.timeoutMs ?? current.timeoutMs,
      }

      if (sameConfig(current, next)) return cloneEmployee(current)

      next.version = current.version + 1
      const updated = this.db.prepare(`UPDATE employee
        SET name = ?, version = ?, runtime_id = ?, config_json = ?
        WHERE id = ? AND version = ?`).run(
        next.name, next.version, next.runtimeId, JSON.stringify(next), id, patch.expectedVersion,
      )
      if (!Number(updated.changes)) throw new Error('Employee version conflict')
      this.db.prepare('INSERT INTO employee_snapshot (id, version, config_json) VALUES (?, ?, ?)')
        .run(next.id, next.version, JSON.stringify(next))
      return cloneEmployee(next)
    })
  }

  snapshot(id: string, version: number): Employee | undefined {
    requireSafeId(id, 'id')
    requirePositiveBound(version, 'version', Number.MAX_SAFE_INTEGER)
    requireCurrentSchema(this.db)
    return parseEmployee(
      this.db.prepare('SELECT config_json FROM employee_snapshot WHERE id = ? AND version = ?').get(id, version),
    )
  }

  setEnabled(id: string, value: EmployeeEnableInput): Employee {
    requireSafeId(id, 'id')
    const input = validateEnable(value)
    requireCurrentSchema(this.db)
    return savepoint(this.db, 'employee_enable', () => {
      const current = parseEmployee(this.db.prepare('SELECT config_json FROM employee WHERE id = ?').get(id))
      if (!current) throw new Error('Employee does not exist')
      if (current.version !== input.expectedVersion) throw new Error('Employee version conflict')
      if (current.enabled === input.enabled) return cloneEmployee(current)

      const next: Employee = { ...current, responsibilities: [...current.responsibilities], capabilities: [...current.capabilities], projectIds: [...current.projectIds], enabled: input.enabled, version: current.version + 1 }
      const updated = this.db.prepare(`UPDATE employee
        SET version = ?, enabled = ?, config_json = ?
        WHERE id = ? AND version = ?`).run(
        next.version, input.enabled ? 1 : 0, JSON.stringify(next), id, input.expectedVersion,
      )
      if (!Number(updated.changes)) throw new Error('Employee version conflict')
      this.db.prepare('INSERT INTO employee_snapshot (id, version, config_json) VALUES (?, ?, ?)')
        .run(next.id, next.version, JSON.stringify(next))
      return cloneEmployee(next)
    })
  }
}
