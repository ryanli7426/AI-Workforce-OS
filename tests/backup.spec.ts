import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BACKUP_SCHEMA, createBackup, verifyBackup } from '../src/storage/backup.ts'
import { LAO_SCHEMA_VERSION } from '../src/storage/store.ts'

let directory: string
const databases: DatabaseSync[] = []

beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'sqlite-backup-')) })
afterEach(() => {
  for (const db of databases.splice(0)) { if (db.isOpen) db.close() }
  rmSync(directory, { recursive: true, force: true })
})

function openSource(path = join(directory, 'source.sqlite'), schema: string = JSON.stringify(LAO_SCHEMA_VERSION)): DatabaseSync {
  const db = new DatabaseSync(path)
  databases.push(db)
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
  `)
  db.prepare('INSERT INTO kv VALUES (?, ?)').run('schema', schema)
  return db
}

function backupDirectory(root: string, id: string): string { return join(root, id) }

describe('SQLite backups', () => {
  it('captures committed data still present in WAL using VACUUM INTO', () => {
    const sourcePath = join(directory, 'source.sqlite')
    const db = openSource(sourcePath)
    db.prepare('INSERT INTO records (value) VALUES (?)').run('before')
    db.prepare('INSERT INTO records (value) VALUES (?)').run('uncheckpointed WAL value')
    expect(existsSync(`${sourcePath}-wal`)).toBe(true)

    const root = join(directory, 'backups')
    const manifest = createBackup(db, { root, label: 'nightly' })
    expect(manifest).toMatchObject({
      version: 1,
      schema: BACKUP_SCHEMA,
      databaseFile: 'database.sqlite',
      sourceSchema: LAO_SCHEMA_VERSION,
    })
    expect(manifest.id.startsWith('nightly-')).toBe(true)
    expect(verifyBackup(backupDirectory(root, manifest.id))).toEqual(manifest)

    const backup = new DatabaseSync(join(root, manifest.id, 'database.sqlite'), { readOnly: true })
    try {
      expect(backup.prepare('SELECT value FROM records ORDER BY id').all().map(row => row.value)).toEqual([
        'before',
        'uncheckpointed WAL value',
      ])
    } finally { backup.close() }
  })

  it('creates unique private backups without changing an existing backup', () => {
    const db = openSource()
    db.prepare('INSERT INTO records (value) VALUES (?)').run('first')
    const root = join(directory, 'backups')
    const first = createBackup(db, { root })
    const firstDirectory = backupDirectory(root, first.id)
    const firstManifest = readFileSync(join(firstDirectory, 'manifest.json'))
    const firstDatabase = readFileSync(join(firstDirectory, 'database.sqlite'))

    db.prepare('INSERT INTO records (value) VALUES (?)').run('second')
    const second = createBackup(db, { root })
    expect(second.id).not.toBe(first.id)
    expect(readFileSync(join(firstDirectory, 'manifest.json'))).toEqual(firstManifest)
    expect(readFileSync(join(firstDirectory, 'database.sqlite'))).toEqual(firstDatabase)
    expect(readdirSync(root).sort()).toEqual([first.id, second.id].sort())
    expect(verifyBackup(firstDirectory)).toEqual(first)
    expect(verifyBackup(backupDirectory(root, second.id))).toEqual(second)
  })

  it('rejects an active transaction before creating backup files', () => {
    const db = openSource()
    const root = join(directory, 'backups')
    db.exec('BEGIN')
    try {
      expect(() => createBackup(db, { root })).toThrow(/transaction/i)
      expect(existsSync(root)).toBe(false)
    } finally { db.exec('ROLLBACK') }
  })

  it.each([
    ['malformed', '{not-json'],
    ['future', JSON.stringify(LAO_SCHEMA_VERSION + 1)],
    ['non-number', JSON.stringify(String(LAO_SCHEMA_VERSION))],
  ])('rejects %s source schema metadata before touching the backup root', (_name, schema) => {
    const db = openSource(join(directory, 'source.sqlite'), schema)
    const root = join(directory, 'backups')
    expect(() => createBackup(db, { root })).toThrow(/schema/i)
    expect(existsSync(root)).toBe(false)
  })

  it('rejects roots that are symlinks, shared, relative, or contain the source database', () => {
    const db = openSource()
    const realRoot = join(directory, 'real-root')
    const linkedRoot = join(directory, 'linked-root')
    const privateRoot = join(directory, 'private-root')
    const sharedRoot = join(directory, 'shared-root')
    mkdirSync(realRoot, { mode: 0o700 })
    symlinkSync(realRoot, linkedRoot)
    mkdirSync(sharedRoot, { mode: 0o755 })

    expect(() => createBackup(db, { root: linkedRoot })).toThrow(/symbolic link/i)
    expect(() => createBackup(db, { root: sharedRoot })).toThrow(/group|other/i)
    expect(() => createBackup(db, { root: 'relative-backups' })).toThrow(/absolute/i)

    mkdirSync(privateRoot, { mode: 0o700 })
    const nested = openSource(join(privateRoot, 'nested-source.sqlite'))
    expect(() => createBackup(nested, { root: privateRoot })).toThrow(/contain the source/i)
  })

  it('writes only owner-accessible final files and no temporary manifest', () => {
    const db = openSource()
    const root = join(directory, 'backups')
    const manifest = createBackup(db, { root })
    const backup = backupDirectory(root, manifest.id)
    expect(lstatSync(root).mode & 0o077).toBe(0)
    expect(lstatSync(backup).mode & 0o077).toBe(0)
    expect(lstatSync(join(backup, 'database.sqlite')).mode & 0o077).toBe(0)
    expect(lstatSync(join(backup, 'manifest.json')).mode & 0o077).toBe(0)
    expect(readdirSync(backup).sort()).toEqual(['database.sqlite', 'manifest.json'])
  })

  it('rejects database and manifest tampering', () => {
    const db = openSource()
    const root = join(directory, 'backups')
    const databaseTamper = createBackup(db, { root, label: 'database-tamper' })
    appendFileSync(join(root, databaseTamper.id, 'database.sqlite'), Buffer.from([0]))
    expect(() => verifyBackup(backupDirectory(root, databaseTamper.id))).toThrow(/hash/i)

    const manifestTamper = createBackup(db, { root, label: 'manifest-tamper' })
    const manifestPath = join(root, manifestTamper.id, 'manifest.json')
    const changed = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    changed.createdAt = '2000-01-01T00:00:00.000Z'
    writeFileSync(manifestPath, JSON.stringify(changed), { mode: 0o600 })
    expect(() => verifyBackup(backupDirectory(root, manifestTamper.id))).toThrow(/metadata/i)
  })

  it('rejects symlinked backup files and unexpected files', () => {
    const db = openSource()
    const root = join(directory, 'backups')

    const linkedDatabase = createBackup(db, { root, label: 'linked-database' })
    const linkedDatabaseDirectory = backupDirectory(root, linkedDatabase.id)
    const databasePath = join(linkedDatabaseDirectory, 'database.sqlite')
    const movedDatabase = join(directory, 'moved-database.sqlite')
    renameSync(databasePath, movedDatabase)
    symlinkSync(movedDatabase, databasePath)
    expect(() => verifyBackup(linkedDatabaseDirectory)).toThrow(/symbolic link/i)

    const extraFile = createBackup(db, { root, label: 'extra-file' })
    const extraDirectory = backupDirectory(root, extraFile.id)
    writeFileSync(join(extraDirectory, 'notes.txt'), 'not part of the backup', { mode: 0o600 })
    expect(() => verifyBackup(extraDirectory)).toThrow(/unexpected files/i)
  })

  it('does not restore over or modify the source database', () => {
    const sourcePath = join(directory, 'source.sqlite')
    const db = openSource(sourcePath)
    db.prepare('INSERT INTO records (value) VALUES (?)').run('source remains live')
    const before = db.prepare('SELECT value FROM records').all()
    const root = join(directory, 'backups')
    const manifest = createBackup(db, { root })
    expect(verifyBackup(backupDirectory(root, manifest.id))).toEqual(manifest)
    expect(db.prepare('SELECT value FROM records').all()).toEqual(before)
    expect(db.isOpen).toBe(true)
  })
})
