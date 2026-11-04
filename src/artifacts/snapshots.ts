import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import type { BigIntStats } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const DEFAULT_MAX_BYTES = 256 * 1024 * 1024
const DEFAULT_MAX_FILES = 10_000
const GIT_MAX_BUFFER = 64 * 1024 * 1024
const GIT_TIMEOUT_MS = 30_000
const MANIFEST_FILE = 'manifest.json'
const FILES_DIRECTORY = 'files'
const EXECUTION_MARKERS = new Set(['.workforce-execution', '.workforce-execution.json'])
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const GIT_OBJECT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

export interface ArtifactFile {
  path: string
  sha256: string
  size: number
  mode: number
}

export interface ArtifactManifest {
  version: 1
  artifactId: string
  executionId: string
  baseRevision: string
  headRevision: string
  revision: string
  createdAt: string
  files: ArtifactFile[]
  deletedPaths: string[]
}

export interface ArtifactStoreOptions {
  root: string
  maxBytes?: number
  maxFiles?: number
}

export interface CaptureArtifactInput {
  artifactId: string
  executionId: string
  cwd: string
  baseRevision: string
}

interface GitRepository {
  cwd: string
  root: string
  headRevision: string
  baseRevision: string
}

interface FileDigest {
  sha256: string
  size: number
  mode: number
}

function fail(message: string): never { throw new Error(message) }

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`)
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${label} contains unknown or missing fields`)
  }
}

function safeId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value) || value === '.' || value === '..') {
    fail(`${label} must be a safe identifier`)
  }
  return value
}

function boundedInteger(value: unknown, fallback: number, label: string): number {
  const result = value === undefined ? fallback : value
  if (!Number.isSafeInteger(result) || Number(result) <= 0) fail(`${label} must be a positive safe integer`)
  return Number(result)
}

function pathInside(parent: string, child: string): boolean {
  const suffix = relative(parent, child)
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
}

function comparePaths(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right))
}

function safeRelativePath(value: unknown, label = 'artifact path'): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0') || isAbsolute(value)) {
    fail(`${label} is unsafe`)
  }
  const parts = value.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..') || parts.includes('.git')) fail(`${label} is unsafe`)
  return value
}

function isExecutionMarker(path: string): boolean {
  return EXECUTION_MARKERS.has(basename(path))
}

function parseNulList(output: Buffer, label: string): string[] {
  if (output.length === 0) return []
  if (output[output.length - 1] !== 0) fail(`Git returned a malformed ${label}`)
  const result: string[] = []
  let start = 0
  for (let index = 0; index < output.length; index++) {
    if (output[index] !== 0) continue
    const bytes = output.subarray(start, index)
    const value = bytes.toString('utf8')
    if (!Buffer.from(value).equals(bytes)) fail(`Git returned a non-UTF-8 ${label}`)
    if (value.length) result.push(value)
    start = index + 1
  }
  return result
}

function rejectGitlinks(output: Buffer): void {
  for (const entry of parseNulList(output, 'index metadata')) {
    const separator = entry.indexOf('\t')
    if (separator < 0) fail('Git returned malformed index metadata')
    const [mode] = entry.slice(0, separator).split(' ')
    if (mode === '160000') fail('Git submodules are unsupported artifact inputs')
  }
}

function git(cwd: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    execFile('git', ['-C', cwd, ...args], {
      encoding: null,
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) { resolvePromise(stdout); return }
      const detail = stderr.toString('utf8').trim()
      reject(new Error(detail ? `Git command failed: ${detail}` : 'Git command failed'))
    })
  })
}

async function gitText(cwd: string, args: readonly string[]): Promise<string> {
  const output = await git(cwd, args)
  const text = output.toString('utf8').trim()
  if (!text || !Buffer.from(output.toString('utf8')).equals(output)) fail('Git returned invalid text output')
  return text
}

async function rejectSymlinkComponents(path: string, allowMissing: boolean): Promise<void> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    let info
    try { info = await lstat(current) }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    if (info.isSymbolicLink()) {
      const canonical = await realpath(current)
      const trustedDarwinAlias = process.platform === 'darwin'
        && ['/var', '/tmp', '/etc'].includes(current) && canonical === `/private${current}`
      if (!trustedDarwinAlias) fail(`Symbolic link path component is unsupported: ${current}`)
    }
  }
}

async function canonicalDirectory(path: string, label: string, create: boolean): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path)) fail(`${label} must be absolute`)
  const absolute = resolve(path)
  await rejectSymlinkComponents(absolute, create)
  if (create) await mkdir(absolute, { recursive: true, mode: 0o700 })
  await rejectSymlinkComponents(absolute, false)
  const info = await lstat(absolute)
  if (info.isSymbolicLink()) fail(`${label} cannot be a symbolic link`)
  if (!info.isDirectory()) fail(`${label} must be a directory`)
  return realpath(absolute)
}

async function prospectiveDirectory(path: string, label: string): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path)) fail(`${label} must be absolute`)
  const absolute = resolve(path)
  const missing: string[] = []
  let ancestor = absolute
  while (true) {
    try {
      const info = await lstat(ancestor)
      if (info.isSymbolicLink()) fail(`${label} cannot be a symbolic link`)
      if (!info.isDirectory()) fail(`${label} must be a directory`)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      missing.unshift(basename(ancestor))
      ancestor = parent
    }
  }
  await rejectSymlinkComponents(ancestor, false)
  return join(await realpath(ancestor), ...missing)
}

async function repository(cwdInput: string, baseInput: string): Promise<GitRepository> {
  const cwd = await canonicalDirectory(cwdInput, 'cwd', false)
  if (typeof baseInput !== 'string' || !baseInput || baseInput.includes('\0') || baseInput.includes('\n') || baseInput.includes('\r')) {
    fail('baseRevision must be a nonempty Git revision')
  }
  const topLevel = await gitText(cwd, ['rev-parse', '--show-toplevel'])
  const root = await canonicalDirectory(topLevel, 'Git root', false)
  if (!pathInside(root, cwd)) fail('cwd is outside its Git root')

  const metadataPath = join(root, '.git')
  const metadata = await lstat(metadataPath)
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    fail('Git metadata links and submodule worktrees are unsupported')
  }
  const actualGitDirectory = await gitText(cwd, ['rev-parse', '--absolute-git-dir'])
  if (await realpath(actualGitDirectory) !== metadataPath) fail('Linked or external Git metadata is unsupported')

  const baseRevision = await gitText(cwd, ['rev-parse', '--verify', '--end-of-options', `${baseInput}^{commit}`])
  const headRevision = await gitText(cwd, ['rev-parse', '--verify', 'HEAD^{commit}'])
  if (!GIT_OBJECT_ID.test(baseRevision) || !GIT_OBJECT_ID.test(headRevision)) fail('Git did not resolve revisions to commit hashes')
  return { cwd, root, baseRevision, headRevision }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
}

async function digestFile(sourcePath: string, destinationPath?: string): Promise<FileDigest> {
  await rejectSymlinkComponents(sourcePath, false)
  const before = await lstat(sourcePath, { bigint: true })
  if (!before.isFile()) fail(`Unsupported non-regular artifact file: ${sourcePath}`)
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) fail(`Artifact file is too large: ${sourcePath}`)

  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW)
  let destination: Awaited<ReturnType<typeof open>> | undefined
  try {
    const opened = await source.stat({ bigint: true })
    if (!opened.isFile() || !sameFile(before, opened)) fail(`Artifact file changed before it could be read: ${sourcePath}`)
    const size = Number(opened.size)
    const mode = Number(opened.mode & 0o777n)
    if (destinationPath) {
      await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 })
      destination = await open(destinationPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    }

    const hash = createHash('sha256')
    const buffer = Buffer.allocUnsafe(64 * 1024)
    let position = 0
    while (position < size) {
      const length = Math.min(buffer.length, size - position)
      const { bytesRead } = await source.read(buffer, 0, length, position)
      if (bytesRead === 0) fail(`Artifact file changed while it was read: ${sourcePath}`)
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      if (destination) {
        let written = 0
        while (written < bytesRead) {
          const result = await destination.write(chunk, written, bytesRead - written)
          written += result.bytesWritten
        }
      }
      position += bytesRead
    }
    const after = await source.stat({ bigint: true })
    if (!sameFile(opened, after)) fail(`Artifact file changed while it was read: ${sourcePath}`)
    if (destination) await destination.sync()
    return { sha256: hash.digest('hex'), size, mode }
  } finally {
    if (destination) await destination.close()
    await source.close()
  }
}

function revisionContent(manifest: Omit<ArtifactManifest, 'revision' | 'createdAt'>): string {
  return JSON.stringify({
    version: manifest.version,
    artifactId: manifest.artifactId,
    executionId: manifest.executionId,
    baseRevision: manifest.baseRevision,
    headRevision: manifest.headRevision,
    files: manifest.files.map(file => ({ path: file.path, sha256: file.sha256, size: file.size, mode: file.mode })),
    deletedPaths: manifest.deletedPaths,
  })
}

function contentRevision(manifest: Omit<ArtifactManifest, 'revision' | 'createdAt'>): string {
  return createHash('sha256').update(revisionContent(manifest)).digest('hex')
}

function validateManifest(value: unknown, expectedArtifactId: string): ArtifactManifest {
  assertObject(value, 'artifact manifest')
  assertExactKeys(value, ['version', 'artifactId', 'executionId', 'baseRevision', 'headRevision', 'revision', 'createdAt', 'files', 'deletedPaths'], 'artifact manifest')
  if (value.version !== 1) fail('Unsupported artifact manifest version')
  const artifactId = safeId(value.artifactId, 'manifest artifactId')
  if (artifactId !== expectedArtifactId) fail('Artifact manifest identity does not match its directory')
  const executionId = safeId(value.executionId, 'manifest executionId')
  if (typeof value.baseRevision !== 'string' || !GIT_OBJECT_ID.test(value.baseRevision)) fail('Invalid manifest baseRevision')
  if (typeof value.headRevision !== 'string' || !GIT_OBJECT_ID.test(value.headRevision)) fail('Invalid manifest headRevision')
  if (typeof value.revision !== 'string' || !SHA256.test(value.revision)) fail('Invalid manifest revision')
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || new Date(value.createdAt).toISOString() !== value.createdAt) {
    fail('Invalid manifest createdAt')
  }
  if (!Array.isArray(value.files) || !Array.isArray(value.deletedPaths)) fail('Invalid manifest file lists')

  const files: ArtifactFile[] = value.files.map((entry, index) => {
    assertObject(entry, `manifest file ${index}`)
    assertExactKeys(entry, ['path', 'sha256', 'size', 'mode'], `manifest file ${index}`)
    const path = safeRelativePath(entry.path, `manifest file ${index} path`)
    if (isExecutionMarker(path)) fail('Execution marker cannot be an artifact file')
    if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) fail(`Invalid hash for artifact file ${path}`)
    if (!Number.isSafeInteger(entry.size) || Number(entry.size) < 0) fail(`Invalid size for artifact file ${path}`)
    if (!Number.isInteger(entry.mode) || Number(entry.mode) < 0 || Number(entry.mode) > 0o777) fail(`Invalid mode for artifact file ${path}`)
    return { path, sha256: entry.sha256, size: Number(entry.size), mode: Number(entry.mode) }
  })
  const deletedPaths = value.deletedPaths.map((entry, index) => safeRelativePath(entry, `deleted path ${index}`))
  if (files.some((entry, index) => index > 0 && comparePaths(files[index - 1]!.path, entry.path) >= 0)) fail('Manifest files are not uniquely sorted')
  if (deletedPaths.some((entry, index) => index > 0 && comparePaths(deletedPaths[index - 1]!, entry) >= 0)) fail('Manifest deleted paths are not uniquely sorted')
  const filePaths = new Set(files.map(file => file.path))
  for (const file of files) {
    const parts = file.path.split('/')
    for (let index = 1; index < parts.length; index++) {
      if (filePaths.has(parts.slice(0, index).join('/'))) fail('Manifest file paths conflict')
    }
  }
  if (deletedPaths.some(path => filePaths.has(path) || isExecutionMarker(path))) fail('Manifest path is both present and deleted')

  const manifest: ArtifactManifest = {
    version: 1,
    artifactId,
    executionId,
    baseRevision: value.baseRevision,
    headRevision: value.headRevision,
    revision: value.revision,
    createdAt: value.createdAt,
    files,
    deletedPaths,
  }
  const expectedRevision = contentRevision(manifest)
  if (manifest.revision !== expectedRevision) fail('Artifact manifest revision does not match its content')
  return manifest
}

async function readRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  await rejectSymlinkComponents(path, false)
  const before = await lstat(path, { bigint: true })
  if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maxBytes)) {
    fail('Artifact manifest is not a bounded, independent regular file')
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!sameFile(before, opened)) fail('Artifact manifest changed while it was opened')
    const contents = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    if (!sameFile(opened, after)) fail('Artifact manifest changed while it was read')
    return contents
  } finally { await handle.close() }
}

async function exclusiveTemporaryDirectory(root: string, artifactId: string): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const path = join(root, `.artifact-tmp-${artifactId}-${randomBytes(12).toString('hex')}`)
    try { await mkdir(path, { mode: 0o700 }); return path }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  }
  fail('Could not allocate a private artifact temporary directory')
}

async function assertAbsent(path: string): Promise<void> {
  try { await lstat(path); fail('Artifact already exists') }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}

async function listSnapshotEntries(filesRoot: string): Promise<{ files: string[], directories: string[] }> {
  const files: string[] = []
  const directories: string[] = []
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolutePath = join(directory, entry.name)
      const info = await lstat(absolutePath)
      if (info.isSymbolicLink()) fail(`Artifact contains a symbolic link: ${relativePath}`)
      if (info.isDirectory()) { directories.push(relativePath); await visit(absolutePath, relativePath); continue }
      if (!info.isFile()) fail(`Artifact contains an unsupported entry: ${relativePath}`)
      files.push(relativePath)
    }
  }
  await visit(filesRoot, '')
  files.sort(comparePaths); directories.sort(comparePaths)
  return { files, directories }
}

/**
 * Immutable local snapshots of a terminated execution's Git working directory.
 * The caller is responsible for proving execution termination and for running any CI or verification policy.
 */
export class ArtifactStore {
  private readonly configuredRoot: string
  private readonly maxBytes: number
  private readonly maxFiles: number

  constructor(options: ArtifactStoreOptions) {
    assertObject(options, 'ArtifactStore options')
    assertExactKeys(options as unknown as Record<string, unknown>, ['root', ...('maxBytes' in options ? ['maxBytes'] : []), ...('maxFiles' in options ? ['maxFiles'] : [])], 'ArtifactStore options')
    if (typeof options.root !== 'string' || !isAbsolute(options.root)) fail('Artifact root must be absolute')
    this.configuredRoot = resolve(options.root)
    this.maxBytes = boundedInteger(options.maxBytes, DEFAULT_MAX_BYTES, 'maxBytes')
    this.maxFiles = boundedInteger(options.maxFiles, DEFAULT_MAX_FILES, 'maxFiles')
  }

  async capture(input: CaptureArtifactInput): Promise<ArtifactManifest> {
    assertObject(input, 'capture input')
    assertExactKeys(input as unknown as Record<string, unknown>, ['artifactId', 'executionId', 'cwd', 'baseRevision'], 'capture input')
    const artifactId = safeId(input.artifactId, 'artifactId')
    const executionId = safeId(input.executionId, 'executionId')
    const repo = await repository(input.cwd, input.baseRevision)
    const prospectiveRoot = await prospectiveDirectory(this.configuredRoot, 'artifact root')
    if (pathInside(prospectiveRoot, repo.root) || pathInside(repo.root, prospectiveRoot)) {
      fail('Artifact root and Git root must not overlap')
    }
    const root = await canonicalDirectory(this.configuredRoot, 'artifact root', true)
    if (root !== prospectiveRoot) fail('Artifact root identity changed during capture')

    const finalDirectory = join(root, artifactId)
    await assertAbsent(finalDirectory)

    rejectGitlinks(await git(repo.root, ['ls-files', '-z', '--stage']))
    const listed = parseNulList(await git(repo.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']), 'file list')
      .map(path => safeRelativePath(path, 'Git file path'))
      .filter(path => !isExecutionMarker(path))
    const unique = new Set(listed)
    if (unique.size !== listed.length) fail('Git returned duplicate artifact paths')

    const deletedPaths = [...new Set(parseNulList(
      await git(repo.root, ['diff', '--name-only', '--diff-filter=D', '-z', 'HEAD', '--']), 'deleted path list',
    ).map(path => safeRelativePath(path, 'Git deleted path')).filter(path => !isExecutionMarker(path)))].sort(comparePaths)
    const deleted = new Set(deletedPaths)
    const paths = listed.filter(path => !deleted.has(path)).sort(comparePaths)
    if (paths.length + deletedPaths.length > this.maxFiles) fail(`Artifact exceeds maxFiles (${this.maxFiles})`)

    const staged: { path: string, source: string, size: number }[] = []
    let totalBytes = 0
    for (const path of paths) {
      const source = join(repo.root, ...path.split('/'))
      let info
      try { info = await lstat(source, { bigint: true }) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' && deleted.has(path)) continue
        throw new Error(`Artifact path disappeared before capture: ${path}`, { cause: error })
      }
      if (info.isSymbolicLink()) fail(`Symbolic links are unsupported artifact files: ${path}`)
      if (!info.isFile()) fail(`Submodules and non-regular artifact files are unsupported: ${path}`)
      if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) fail(`Artifact file is too large: ${path}`)
      totalBytes += Number(info.size)
      if (!Number.isSafeInteger(totalBytes) || totalBytes > this.maxBytes) fail(`Artifact exceeds maxBytes (${this.maxBytes})`)
      staged.push({ path, source, size: Number(info.size) })
    }

    const temporaryDirectory = await exclusiveTemporaryDirectory(root, artifactId)
    let finalized = false
    try {
      const filesDirectory = join(temporaryDirectory, FILES_DIRECTORY)
      await mkdir(filesDirectory, { mode: 0o700 })
      const files: ArtifactFile[] = []
      let copiedBytes = 0
      for (const entry of staged) {
        const destination = join(filesDirectory, ...entry.path.split('/'))
        const digest = await digestFile(entry.source, destination)
        if (digest.size !== entry.size) fail(`Artifact file changed before it was copied: ${entry.path}`)
        copiedBytes += digest.size
        if (copiedBytes > this.maxBytes) fail(`Artifact exceeds maxBytes (${this.maxBytes})`)
        await chmod(destination, digest.mode)
        files.push({ path: entry.path, ...digest })
      }

      const currentHead = await gitText(repo.root, ['rev-parse', '--verify', 'HEAD^{commit}'])
      if (currentHead !== repo.headRevision) fail('Git HEAD changed during artifact capture')
      rejectGitlinks(await git(repo.root, ['ls-files', '-z', '--stage']))
      const relisted = parseNulList(
        await git(repo.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']), 'file list',
      ).map(path => safeRelativePath(path, 'Git file path')).filter(path => !isExecutionMarker(path))
      const redeleted = [...new Set(parseNulList(
        await git(repo.root, ['diff', '--name-only', '--diff-filter=D', '-z', 'HEAD', '--']), 'deleted path list',
      ).map(path => safeRelativePath(path, 'Git deleted path')).filter(path => !isExecutionMarker(path)))].sort(comparePaths)
      const redeletedSet = new Set(redeleted)
      const currentPaths = [...new Set(relisted)].filter(path => !redeletedSet.has(path)).sort(comparePaths)
      if (relisted.length !== new Set(relisted).size || currentPaths.length !== paths.length
        || currentPaths.some((path, index) => path !== paths[index]) || redeleted.length !== deletedPaths.length
        || redeleted.some((path, index) => path !== deletedPaths[index])) {
        fail('Git file set changed during artifact capture')
      }

      const content = {
        version: 1 as const,
        artifactId,
        executionId,
        baseRevision: repo.baseRevision,
        headRevision: repo.headRevision,
        files,
        deletedPaths,
      }
      const manifest: ArtifactManifest = {
        ...content,
        revision: contentRevision(content),
        createdAt: new Date().toISOString(),
      }
      const manifestPath = join(temporaryDirectory, MANIFEST_FILE)
      const handle = await open(manifestPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      try { await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`); await handle.sync() }
      finally { await handle.close() }

      const validated = validateManifest(manifest, artifactId)
      await assertAbsent(finalDirectory)
      await rename(temporaryDirectory, finalDirectory)
      finalized = true
      return validated
    } finally {
      if (!finalized) await rm(temporaryDirectory, { recursive: true, force: true })
    }
  }

  async manifest(artifactIdInput: string): Promise<ArtifactManifest> {
    const artifactId = safeId(artifactIdInput, 'artifactId')
    const root = await canonicalDirectory(this.configuredRoot, 'artifact root', false)
    const artifactDirectory = join(root, artifactId)
    await rejectSymlinkComponents(artifactDirectory, false)
    const directoryInfo = await lstat(artifactDirectory)
    if (!directoryInfo.isDirectory()) fail('Artifact path is not a directory')
    const raw = await readRegularFile(join(artifactDirectory, MANIFEST_FILE), GIT_MAX_BUFFER)
    const text = raw.toString('utf8')
    if (!Buffer.from(text).equals(raw)) fail('Artifact manifest is not valid UTF-8')
    let value: unknown
    try { value = JSON.parse(text) }
    catch { fail('Artifact manifest is not valid JSON') }
    return validateManifest(value, artifactId)
  }

  async verify(artifactIdInput: string): Promise<ArtifactManifest> {
    const artifactId = safeId(artifactIdInput, 'artifactId')
    const root = await canonicalDirectory(this.configuredRoot, 'artifact root', false)
    const artifactDirectory = join(root, artifactId)
    await rejectSymlinkComponents(artifactDirectory, false)
    const entries = await readdir(artifactDirectory, { withFileTypes: true })
    const names = entries.map(entry => entry.name).sort(comparePaths)
    if (names.length !== 2 || names[0] !== FILES_DIRECTORY || names[1] !== MANIFEST_FILE) fail('Artifact directory contains unexpected entries')
    if (!entries.find(entry => entry.name === FILES_DIRECTORY)?.isDirectory()) fail('Artifact files entry is not a directory')
    if (!entries.find(entry => entry.name === MANIFEST_FILE)?.isFile()) fail('Artifact manifest entry is not a regular file')

    const manifest = await this.manifest(artifactId)
    if (manifest.files.length + manifest.deletedPaths.length > this.maxFiles) fail(`Artifact exceeds maxFiles (${this.maxFiles})`)
    const filesRoot = join(artifactDirectory, FILES_DIRECTORY)
    const actual = await listSnapshotEntries(filesRoot)
    const expectedFiles = manifest.files.map(file => file.path)
    if (actual.files.length !== expectedFiles.length || actual.files.some((path, index) => path !== expectedFiles[index])) {
      fail('Artifact files do not match the manifest')
    }
    const expectedDirectories = new Set<string>()
    for (const path of expectedFiles) {
      const parts = path.split('/')
      for (let index = 1; index < parts.length; index++) expectedDirectories.add(parts.slice(0, index).join('/'))
    }
    const directories = [...expectedDirectories].sort(comparePaths)
    if (actual.directories.length !== directories.length || actual.directories.some((path, index) => path !== directories[index])) {
      fail('Artifact contains unexpected directories')
    }

    let totalBytes = 0
    for (const expected of manifest.files) {
      const path = join(filesRoot, ...expected.path.split('/'))
      const info = await stat(path, { bigint: true })
      if (!info.isFile() || info.nlink !== 1n) fail(`Artifact file identity is invalid: ${expected.path}`)
      const digest = await digestFile(path)
      totalBytes += digest.size
      if (totalBytes > this.maxBytes) fail(`Artifact exceeds maxBytes (${this.maxBytes})`)
      if (digest.sha256 !== expected.sha256 || digest.size !== expected.size || digest.mode !== expected.mode) {
        fail(`Artifact file verification failed: ${expected.path}`)
      }
    }
    return manifest
  }
}
