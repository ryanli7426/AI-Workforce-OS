/** Project configuration records with immutable version snapshots. Paths and Git bindings are config only; archive does not stop executions. */
import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA_KEY = 'project-schema'
const SCHEMA_VERSION = 1
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const MAX_NAME_LENGTH = 256
const MAX_LIST_ITEMS = 256
const MAX_ITEM_LENGTH = 512
const GIT_TIMEOUT_MS = 15_000
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024

const CREATE_FIELDS = [
  'id', 'workspaceId', 'name', 'ownerId', 'repositoryPath', 'worktreeRoot', 'allowedTaskTypes',
] as const

const UPDATE_FIELDS = ['expectedVersion', 'name', 'ownerId', 'allowedTaskTypes'] as const

const ARCHIVE_FIELDS = ['expectedVersion'] as const

export interface ProjectCreateInput {
  id: string
  workspaceId: string
  name: string
  ownerId: string
  repositoryPath: string
  worktreeRoot: string
  allowedTaskTypes: string[]
}

export interface ProjectUpdateInput {
  expectedVersion: number
  name?: string
  ownerId?: string
  allowedTaskTypes?: string[]
}

export interface ProjectArchiveInput {
  expectedVersion: number
}

/** Persisted project configuration. archived is a record flag only and does not claim executions stopped. */
export interface Project {
  id: string
  workspaceId: string
  name: string
  ownerId: string
  repositoryPath: string
  worktreeRoot: string
  allowedTaskTypes: string[]
  archived: boolean
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

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
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

function requireStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`Invalid ${field}`)
  if (value.length > MAX_LIST_ITEMS) throw new Error(`Invalid ${field}`)
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || !item || item.includes('\0') || item.length > MAX_ITEM_LENGTH) throw new Error(`Invalid ${field}`)
    if (seen.has(item)) throw new Error(`Duplicate ${field} entry`)
    seen.add(item)
    result.push(item)
  }
  return result
}

function assertAbsolutePath(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value || value.includes('\0') || !isAbsolute(value)) {
    throw new Error(`Invalid ${field}: must be an absolute path`)
  }
  return resolve(value)
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const pathFromParent = relative(parent, candidate)
  return pathFromParent === '' || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' && !isAbsolute(pathFromParent))
}

function assertSeparatePaths(repository: string, worktreeRoot: string): void {
  if (isSameOrInside(repository, worktreeRoot) || isSameOrInside(worktreeRoot, repository)) {
    throw new Error('Repository and worktree root must not overlap')
  }
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
}

function gitShowTopLevel(cwd: string): string {
  let stdout: string
  try {
    stdout = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      env: gitEnv(),
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_OUTPUT_BYTES,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch {
    throw new Error('repositoryPath must be a Git repository root')
  }
  const value = stdout.replace(/[\r\n]+$/, '')
  if (!value || value.includes('\n') || value.includes('\r') || value.includes('\0') || !isAbsolute(value)) {
    throw new Error('Invalid Git repository top level')
  }
  return value
}

/** Canonical absolute path for an existing real directory; rejects symlinks. */
function existingRealDirectory(path: string, field: string): string {
  let stat
  try { stat = lstatSync(path) }
  catch (error) {
    if (isErrno(error, 'ENOENT')) throw new Error(`Invalid ${field}: path does not exist`)
    throw error
  }
  if (stat.isSymbolicLink()) throw new Error(`Invalid ${field}: symbolic links are not allowed`)
  if (!stat.isDirectory()) throw new Error(`Invalid ${field}: must be a directory`)
  return realpathSync(path)
}

/**
 * Absolute path that may not exist yet. Nearest existing ancestor must not be a symlink;
 * does not create missing directories. Returns a canonical absolute path.
 */
function canonicalPathAllowMissing(path: string, field: string): string {
  const absolute = assertAbsolutePath(path, field)
  const missing: string[] = []
  let current = absolute
  for (;;) {
    try {
      const stat = lstatSync(current)
      if (stat.isSymbolicLink()) throw new Error(`Invalid ${field}: symbolic links are not allowed`)
      if (!stat.isDirectory()) throw new Error(`Invalid ${field}: ancestor must be a directory`)
      let result = realpathSync(current)
      for (let index = missing.length - 1; index >= 0; index--) result = join(result, missing[index]!)
      if (!isAbsolute(result) || result.includes('\0')) throw new Error(`Invalid ${field}`)
      return result
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
      const parent = dirname(current)
      if (parent === current) throw new Error(`Invalid ${field}: no existing ancestor`)
      missing.push(basename(current))
      current = parent
    }
  }
}

function assertGitRepositoryRoot(path: string): string {
  const absolute = assertAbsolutePath(path, 'repositoryPath')
  const real = existingRealDirectory(absolute, 'repositoryPath')
  const top = gitShowTopLevel(real)
  const topReal = existingRealDirectory(top, 'repositoryPath')
  if (topReal !== real) throw new Error('repositoryPath must be its Git top level')
  return real
}

function validateResourcePaths(repositoryPath: string, worktreeRoot: string): { repositoryPath: string; worktreeRoot: string } {
  const repository = assertGitRepositoryRoot(repositoryPath)
  const worktree = canonicalPathAllowMissing(worktreeRoot, 'worktreeRoot')
  assertSeparatePaths(repository, worktree)
  return { repositoryPath: repository, worktreeRoot: worktree }
}

function cloneProject(project: Project): Project {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    ownerId: project.ownerId,
    repositoryPath: project.repositoryPath,
    worktreeRoot: project.worktreeRoot,
    allowedTaskTypes: [...project.allowedTaskTypes],
    archived: project.archived,
    version: project.version,
  }
}

function sameMutableConfig(left: Project, right: Project): boolean {
  return left.name === right.name
    && left.ownerId === right.ownerId
    && JSON.stringify(left.allowedTaskTypes) === JSON.stringify(right.allowedTaskTypes)
}

function parseProject(row: Record<string, unknown> | undefined): Project | undefined {
  if (!row) return undefined
  return cloneProject(JSON.parse(String(row.config_json)) as Project)
}

function readSchemaVersion(db: DatabaseSync): number | undefined {
  const kv = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()
  if (!kv) throw new Error('Project schema requires an initialized kv table')
  const versionRow = db.prepare('SELECT value FROM kv WHERE key = ?').get(SCHEMA_KEY)
  if (versionRow === undefined) return undefined
  let version: unknown
  try { version = JSON.parse(String(versionRow.value)) } catch { throw new Error('Unknown project schema version') }
  if (typeof version !== 'number' || !Number.isSafeInteger(version)) throw new Error('Unknown project schema version')
  return version
}

function requireCurrentSchema(db: DatabaseSync): void {
  const version = readSchemaVersion(db)
  if (version === undefined) throw new Error('Project schema is not initialized')
  if (version !== SCHEMA_VERSION) throw new Error(`Unknown project schema version: ${version}`)
}

function validateCreate(value: unknown): ProjectCreateInput {
  const input = requireObject(value, 'project create')
  requireOnlyFields(input, CREATE_FIELDS, 'project create')
  requireSafeId(input.id, 'id')
  requireSafeId(input.workspaceId, 'workspaceId')
  requireName(input.name, 'name', MAX_NAME_LENGTH)
  requireSafeId(input.ownerId, 'ownerId')
  if (typeof input.repositoryPath !== 'string') throw new Error('Invalid repositoryPath')
  if (typeof input.worktreeRoot !== 'string') throw new Error('Invalid worktreeRoot')
  const paths = validateResourcePaths(input.repositoryPath, input.worktreeRoot)
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    name: input.name,
    ownerId: input.ownerId,
    repositoryPath: paths.repositoryPath,
    worktreeRoot: paths.worktreeRoot,
    allowedTaskTypes: requireStringList(input.allowedTaskTypes, 'allowedTaskTypes'),
  }
}

function validateUpdate(value: unknown): ProjectUpdateInput {
  const input = requireObject(value, 'project update')
  requireOnlyFields(input, UPDATE_FIELDS, 'project update')
  requirePositiveBound(input.expectedVersion, 'expectedVersion', Number.MAX_SAFE_INTEGER)
  const patch: ProjectUpdateInput = { expectedVersion: input.expectedVersion }
  if ('name' in input) {
    requireName(input.name, 'name', MAX_NAME_LENGTH)
    patch.name = input.name
  }
  if ('ownerId' in input) {
    requireSafeId(input.ownerId, 'ownerId')
    patch.ownerId = input.ownerId
  }
  if ('allowedTaskTypes' in input) {
    patch.allowedTaskTypes = requireStringList(input.allowedTaskTypes, 'allowedTaskTypes')
  }
  if (patch.name === undefined && patch.ownerId === undefined && patch.allowedTaskTypes === undefined) {
    throw new Error('No updatable fields provided')
  }
  return patch
}

function validateArchive(value: unknown): ProjectArchiveInput {
  const input = requireObject(value, 'project archive')
  requireOnlyFields(input, ARCHIVE_FIELDS, 'project archive')
  requirePositiveBound(input.expectedVersion, 'expectedVersion', Number.MAX_SAFE_INTEGER)
  return { expectedVersion: input.expectedVersion }
}

/** Adds the project configuration schema to a caller-owned SQLite connection with a kv table. */
export function initializeProjectSchema(db: DatabaseSync): void {
  const version = readSchemaVersion(db)
  if (version !== undefined && version !== SCHEMA_VERSION) {
    throw new Error(`Unknown project schema version: ${version}`)
  }

  savepoint(db, 'project_schema', () => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
        repository_path TEXT NOT NULL,
        worktree_root TEXT NOT NULL,
        config_json TEXT NOT NULL CHECK (json_valid(config_json)),
        UNIQUE (workspace_id, name)
      );
      CREATE TABLE IF NOT EXISTS project_snapshot (
        id TEXT NOT NULL,
        version INTEGER NOT NULL,
        config_json TEXT NOT NULL CHECK (json_valid(config_json)),
        PRIMARY KEY (id, version),
        FOREIGN KEY (id) REFERENCES project(id)
      );
      CREATE INDEX IF NOT EXISTS project_workspace ON project(workspace_id);
    `)
    db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(SCHEMA_KEY, JSON.stringify(SCHEMA_VERSION))
  })
}

/** Opaque same-instance capability from prepareCreate; only commitCreate on that repository accepts it. */
export type PreparedProjectCreate = {
  readonly __brand: 'PreparedProjectCreate'
}

type PreparedProjectEntry = {
  repository: ProjectRepository
  input: ProjectCreateInput
}

const preparedProjectCreates = new WeakMap<PreparedProjectCreate, PreparedProjectEntry>()

function createPreparedProjectToken(): PreparedProjectCreate {
  return Object.freeze({ __brand: 'PreparedProjectCreate' as const })
}

/** Durable project configuration repository. Does not authorize callers or stop executions. */
export class ProjectRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * Validates paths/Git outside any DB transaction and returns an opaque capability for commitCreate.
   * Must not run while db.isTransaction is true.
   */
  prepareCreate(value: ProjectCreateInput): PreparedProjectCreate {
    if (this.db.isTransaction) {
      throw new Error('Project path validation cannot run inside a transaction')
    }
    const input = validateCreate(value)
    const token = createPreparedProjectToken()
    preparedProjectCreates.set(token, { repository: this, input })
    return token
  }

  /** Commits a prepareCreate capability without filesystem/Git IO. Single-use; rejects forged tokens. */
  commitCreate(prepared: PreparedProjectCreate): Project {
    const entry = preparedProjectCreates.get(prepared)
    if (!entry || entry.repository !== this) {
      throw new Error('Invalid prepared project create')
    }
    preparedProjectCreates.delete(prepared)
    requireCurrentSchema(this.db)
    return savepoint(this.db, 'project_create', () => this.insertCreated(entry.input))
  }

  create(value: ProjectCreateInput): Project {
    // Path/Git checks run in prepareCreate before the write transaction (no external CLI inside tx).
    return this.commitCreate(this.prepareCreate(value))
  }

  private insertCreated(input: ProjectCreateInput): Project {
    const project: Project = {
      id: input.id,
      workspaceId: input.workspaceId,
      name: input.name,
      ownerId: input.ownerId,
      repositoryPath: input.repositoryPath,
      worktreeRoot: input.worktreeRoot,
      allowedTaskTypes: [...input.allowedTaskTypes],
      archived: false,
      version: 1,
    }
    try {
      this.db.prepare(`INSERT INTO project
        (id, workspace_id, name, version, archived, repository_path, worktree_root, config_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        project.id, project.workspaceId, project.name, project.version, 0,
        project.repositoryPath, project.worktreeRoot, JSON.stringify(project),
      )
      this.db.prepare('INSERT INTO project_snapshot (id, version, config_json) VALUES (?, ?, ?)')
        .run(project.id, project.version, JSON.stringify(project))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/UNIQUE/i.test(message)) throw new Error('Project id or workspace name already exists')
      throw error
    }
    return cloneProject(project)
  }

  get(id: string): Project | undefined {
    requireSafeId(id, 'id')
    requireCurrentSchema(this.db)
    return parseProject(this.db.prepare('SELECT config_json FROM project WHERE id = ?').get(id))
  }

  list(workspaceId: string): Project[] {
    requireSafeId(workspaceId, 'workspaceId')
    requireCurrentSchema(this.db)
    return this.db.prepare('SELECT config_json FROM project WHERE workspace_id = ? ORDER BY rowid')
      .all(workspaceId)
      .map(row => parseProject(row)!)
  }

  update(id: string, value: ProjectUpdateInput): Project {
    requireSafeId(id, 'id')
    const patch = validateUpdate(value)
    requireCurrentSchema(this.db)
    return savepoint(this.db, 'project_update', () => {
      const current = parseProject(this.db.prepare('SELECT config_json FROM project WHERE id = ?').get(id))
      if (!current) throw new Error('Project does not exist')
      if (current.archived) throw new Error('Archived project cannot be updated')
      if (current.version !== patch.expectedVersion) throw new Error('Project version conflict')

      const next: Project = {
        ...current,
        name: patch.name ?? current.name,
        ownerId: patch.ownerId ?? current.ownerId,
        allowedTaskTypes: patch.allowedTaskTypes ? [...patch.allowedTaskTypes] : [...current.allowedTaskTypes],
        repositoryPath: current.repositoryPath,
        worktreeRoot: current.worktreeRoot,
        workspaceId: current.workspaceId,
        id: current.id,
        archived: current.archived,
      }

      if (sameMutableConfig(current, next)) return cloneProject(current)

      next.version = current.version + 1
      try {
        const updated = this.db.prepare(`UPDATE project
          SET name = ?, version = ?, config_json = ?
          WHERE id = ? AND version = ? AND archived = 0`).run(
          next.name, next.version, JSON.stringify(next), id, patch.expectedVersion,
        )
        if (!Number(updated.changes)) throw new Error('Project version conflict')
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message === 'Project version conflict') throw error
        if (/UNIQUE/i.test(message)) throw new Error('Project id or workspace name already exists')
        throw error
      }
      this.db.prepare('INSERT INTO project_snapshot (id, version, config_json) VALUES (?, ?, ?)')
        .run(next.id, next.version, JSON.stringify(next))
      return cloneProject(next)
    })
  }

  archive(id: string, value: ProjectArchiveInput): Project {
    requireSafeId(id, 'id')
    const input = validateArchive(value)
    requireCurrentSchema(this.db)
    return savepoint(this.db, 'project_archive', () => {
      const current = parseProject(this.db.prepare('SELECT config_json FROM project WHERE id = ?').get(id))
      if (!current) throw new Error('Project does not exist')
      if (current.version !== input.expectedVersion) throw new Error('Project version conflict')
      if (current.archived) return cloneProject(current)

      const next: Project = {
        ...current,
        allowedTaskTypes: [...current.allowedTaskTypes],
        archived: true,
        version: current.version + 1,
      }
      const updated = this.db.prepare(`UPDATE project
        SET version = ?, archived = 1, config_json = ?
        WHERE id = ? AND version = ? AND archived = 0`).run(
        next.version, JSON.stringify(next), id, input.expectedVersion,
      )
      if (!Number(updated.changes)) throw new Error('Project version conflict')
      this.db.prepare('INSERT INTO project_snapshot (id, version, config_json) VALUES (?, ?, ?)')
        .run(next.id, next.version, JSON.stringify(next))
      return cloneProject(next)
    })
  }

  snapshot(id: string, version: number): Project | undefined {
    requireSafeId(id, 'id')
    requirePositiveBound(version, 'version', Number.MAX_SAFE_INTEGER)
    requireCurrentSchema(this.db)
    return parseProject(
      this.db.prepare('SELECT config_json FROM project_snapshot WHERE id = ? AND version = ?').get(id, version),
    )
  }
}
