/** Consistent, database-only SQLite backups. Artifacts and credentials require separate backup policies. */
import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LAO_SCHEMA_VERSION } from './store.ts'

export const BACKUP_SCHEMA = 'ai-workforce-os.sqlite-backup' as const
const DATABASE_FILE = 'database.sqlite' as const
const MANIFEST_FILE = 'manifest.json'
const SUPPORTED_SOURCE_SCHEMAS = new Set([11, LAO_SCHEMA_VERSION])

export interface BackupManifest {
  version: 1
  id: string
  createdAt: string
  schema: typeof BACKUP_SCHEMA
  databaseFile: typeof DATABASE_FILE
  sha256: string
  sourceSchema: number
}

export interface BackupOptions {
  root: string
  label?: string
}

function assertPlainObject(value: unknown, name: string): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
}

function validateLabel(label: unknown): string | undefined {
  if (label === undefined) return undefined
  if (typeof label !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(label)) {
    throw new Error('Backup label must be a safe nonempty identifier')
  }
  return label
}

function validateSourceSchema(value: unknown): number {
  if (!Number.isSafeInteger(value) || !SUPPORTED_SOURCE_SCHEMAS.has(value as number)) {
    throw new Error(`Unsupported source schema ${String(value)}`)
  }
  return value as number
}

function sourceSchema(db: DatabaseSync): number {
  const kv = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get()
  if (!kv) throw new Error('Source database has no kv schema metadata')
  const row = db.prepare("SELECT value FROM kv WHERE key = 'schema'").get()
  if (!row) throw new Error('Source database has no schema version')
  let value: unknown
  try { value = JSON.parse(String(row.value)) } catch { throw new Error('Source database has invalid schema metadata') }
  return validateSourceSchema(value)
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

function assertPrivateDirectory(path: string, name: string): void {
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink()) throw new Error(`${name} must not be a symbolic link`)
  if (!metadata.isDirectory()) throw new Error(`${name} must be a directory`)
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${name} must not be accessible by group or other users`)
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) throw new Error(`${name} must be owned by the current user`)
}

function prepareRoot(input: unknown): string {
  if (typeof input !== 'string' || !input || !isAbsolute(input)) throw new Error('Backup root must be an absolute path')
  const requested = resolve(input)
  if (existsSync(requested)) {
    assertPrivateDirectory(requested, 'Backup root')
  } else {
    let ancestor = dirname(requested)
    while (!existsSync(ancestor)) {
      const parent = dirname(ancestor)
      if (parent === ancestor) throw new Error('Backup root has no existing ancestor')
      ancestor = parent
    }
    const ancestorMetadata = lstatSync(ancestor)
    if (ancestorMetadata.isSymbolicLink() || !ancestorMetadata.isDirectory()) {
      throw new Error('Backup root ancestor must be a real directory')
    }
    mkdirSync(requested, { recursive: true, mode: 0o700 })
    chmodSync(requested, 0o700)
    assertPrivateDirectory(requested, 'Backup root')
  }
  return realpathSync(requested)
}

function assertPrivateRegularFile(path: string, name: string): void {
  const metadata = lstatSync(path)
  if (metadata.isSymbolicLink()) throw new Error(`${name} must not be a symbolic link`)
  if (!metadata.isFile()) throw new Error(`${name} must be a regular file`)
  if ((metadata.mode & 0o077) !== 0) throw new Error(`${name} must not be accessible by group or other users`)
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) throw new Error(`${name} must be owned by the current user`)
}

function hashFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const before = fstatSync(fd)
    if (!before.isFile()) throw new Error('Backup database must be a regular file')
    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, position)
      if (!count) break
      hash.update(buffer.subarray(0, count))
      position += count
    }
    const after = fstatSync(fd)
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error('Backup database changed while hashing')
    }
    return hash.digest('hex')
  } finally { closeSync(fd) }
}

function inspectBackupDatabase(path: string, expectedSchema: number): void {
  assertPrivateRegularFile(path, 'Backup database')
  const backup = new DatabaseSync(path, { readOnly: true })
  try {
    const integrity = backup.prepare('PRAGMA integrity_check').all()
    if (integrity.length !== 1 || String(integrity[0]?.integrity_check) !== 'ok') throw new Error('Backup database failed integrity_check')
    if (sourceSchema(backup) !== expectedSchema) throw new Error('Backup database schema does not match its manifest')
  } finally { backup.close() }
}

function manifestDigest(manifest: Omit<BackupManifest, 'id'>): string {
  const canonical = { version: manifest.version, createdAt: manifest.createdAt, schema: manifest.schema,
    databaseFile: manifest.databaseFile, sha256: manifest.sha256, sourceSchema: manifest.sourceSchema }
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
}

function validateManifest(value: unknown): BackupManifest {
  assertPlainObject(value, 'Backup manifest')
  const expectedKeys = ['createdAt', 'databaseFile', 'id', 'schema', 'sha256', 'sourceSchema', 'version']
  if (Object.keys(value).sort().join('\0') !== expectedKeys.join('\0')) throw new Error('Backup manifest has unexpected fields')
  if (value.version !== 1) throw new Error('Unsupported backup manifest version')
  if (value.schema !== BACKUP_SCHEMA) throw new Error('Unsupported backup manifest schema')
  if (typeof value.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,220}$/.test(value.id)) throw new Error('Invalid backup id')
  if (typeof value.createdAt !== 'string') throw new Error('Invalid backup creation time')
  const createdAt = new Date(value.createdAt)
  if (!Number.isFinite(createdAt.valueOf()) || createdAt.toISOString() !== value.createdAt) throw new Error('Invalid backup creation time')
  if (value.databaseFile !== DATABASE_FILE) throw new Error('Invalid backup database filename')
  if (typeof value.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(value.sha256)) throw new Error('Invalid backup database hash')
  const schema = validateSourceSchema(value.sourceSchema)
  return { version: 1, id: value.id, createdAt: value.createdAt, schema: BACKUP_SCHEMA, databaseFile: DATABASE_FILE,
    sha256: value.sha256, sourceSchema: schema }
}

function readManifest(path: string): BackupManifest {
  assertPrivateRegularFile(path, 'Backup manifest')
  const metadata = statSync(path)
  if (metadata.size > 64 * 1024) throw new Error('Backup manifest is too large')
  let value: unknown
  try { value = JSON.parse(readFileSync(path, 'utf8')) } catch { throw new Error('Backup manifest is not valid JSON') }
  return validateManifest(value)
}

function writeManifestAtomic(directory: string, manifest: BackupManifest): void {
  const temporary = join(directory, `.manifest-${randomUUID()}.tmp`)
  const destination = join(directory, MANIFEST_FILE)
  let fd: number | undefined
  let created = false
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600)
    created = true
    writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    fsyncSync(fd)
    closeSync(fd); fd = undefined
    if (existsSync(destination)) throw new Error('Backup manifest already exists')
    renameSync(temporary, destination)
    created = false
  } finally {
    if (fd !== undefined) closeSync(fd)
    if (created && existsSync(temporary)) rmSync(temporary, { force: true })
  }
}

/** Creates a consistent SQLite snapshot. This backs up only the database, not artifacts or credentials. */
export function createBackup(db: DatabaseSync, options: BackupOptions): BackupManifest {
  if (!(db instanceof DatabaseSync) || !db.isOpen) throw new Error('Backup requires an open DatabaseSync')
  if (db.isTransaction) throw new Error('Cannot create a backup inside an active transaction')
  assertPlainObject(options, 'Backup options')
  if (Object.keys(options).some(key => key !== 'root' && key !== 'label')) throw new Error('Backup options have unexpected fields')
  const label = validateLabel(options.label)
  const schema = sourceSchema(db)
  const root = prepareRoot(options.root)
  const source = db.location()
  if (source !== null) {
    const sourcePath = realpathSync(resolve(source))
    if (isWithin(root, sourcePath)) throw new Error('Backup root must not contain the source database')
  }

  const createdAt = new Date().toISOString()
  const temporaryDirectory = join(root, `.backup-${randomUUID()}.tmp`)
  mkdirSync(temporaryDirectory, { mode: 0o700 })
  let finalized = false
  try {
    assertPrivateDirectory(temporaryDirectory, 'Temporary backup directory')
    const databasePath = join(temporaryDirectory, DATABASE_FILE)
    db.prepare('VACUUM INTO ?').run(databasePath)
    chmodSync(databasePath, 0o600)
    inspectBackupDatabase(databasePath, schema)
    const sha256 = hashFile(databasePath)
    const identity: Omit<BackupManifest, 'id'> = {
      version: 1, createdAt, schema: BACKUP_SCHEMA, databaseFile: DATABASE_FILE, sha256, sourceSchema: schema,
    }
    const id = `${label ?? 'backup'}-${createdAt.replace(/[-:.]/g, '')}-${randomUUID()}-${manifestDigest(identity)}`
    const finalDirectory = join(root, id)
    const manifest: BackupManifest = { ...identity, id }
    writeManifestAtomic(temporaryDirectory, manifest)
    if (existsSync(finalDirectory)) throw new Error('Backup directory already exists')
    renameSync(temporaryDirectory, finalDirectory)
    finalized = true
    return manifest
  } finally {
    if (!finalized && existsSync(temporaryDirectory)) rmSync(temporaryDirectory, { recursive: true, force: true })
  }
}

/** Verifies a database-only backup without modifying or restoring any database. */
export function verifyBackup(directory: string): BackupManifest {
  if (typeof directory !== 'string' || !directory || !isAbsolute(directory)) throw new Error('Backup directory must be an absolute path')
  const requested = resolve(directory)
  assertPrivateDirectory(requested, 'Backup directory')
  const canonical = realpathSync(requested)
  const entries = new Set<string>()
  // Reading sqlite_master can create sidecars unless the database is opened read-only, so only these two files are valid.
  for (const name of [MANIFEST_FILE, DATABASE_FILE]) {
    const path = join(canonical, name)
    if (!existsSync(path)) throw new Error(`Backup is missing ${name}`)
    entries.add(name)
  }
  const actualEntries = new Set<string>(readdirSync(canonical))
  if (actualEntries.size !== entries.size || [...actualEntries].some(name => !entries.has(name))) throw new Error('Backup directory has unexpected files')
  const manifest = readManifest(join(canonical, MANIFEST_FILE))
  if (basename(canonical) !== manifest.id) throw new Error('Backup id does not match its directory')
  const { id: _id, ...identity } = manifest
  if (!manifest.id.endsWith(`-${manifestDigest(identity)}`)) throw new Error('Backup manifest metadata does not match its id')
  const databasePath = join(canonical, manifest.databaseFile)
  assertPrivateRegularFile(databasePath, 'Backup database')
  if (hashFile(databasePath) !== manifest.sha256) throw new Error('Backup database hash mismatch')
  inspectBackupDatabase(databasePath, manifest.sourceSchema)
  return { ...manifest }
}
