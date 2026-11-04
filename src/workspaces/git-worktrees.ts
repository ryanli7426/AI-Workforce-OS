import { execFile } from 'node:child_process'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { lstat, mkdir, open, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

const MARKER = '.workforce-execution.json'
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const REVISION_PATTERN = /^[0-9a-f]{40,64}$/
const GIT_EXECUTABLE = '/usr/bin/git'
const GIT_TIMEOUT_MS = 15_000
const GIT_MAX_OUTPUT_BYTES = 1024 * 1024

export interface GitWorktreeOptions {
  repository: string
  root: string
  baseRef?: string
}

export interface GitWorktree {
  path: string
  baseRevision: string
  branch: string
}

export interface GitWorktreeRemovalOptions {
  approvedDirtyRemoval?: boolean
}

interface Marker extends GitWorktree {
  version: 1
  repository: string
  root: string
  ticketId: string
  assignmentId: string
  executionId: string
}

interface GitResult {
  stdout: string
  stderr: string
  exitCode: number
}

class GitCommandError extends Error {
  constructor(readonly result: GitResult) {
    const detail = result.stderr.trim().split(/\r?\n/, 1)[0]
    super(`Git command failed with exit code ${result.exitCode}${detail ? `: ${detail.slice(0, 300)}` : ''}`)
  }
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === code
}

function assertAbsolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value) || !isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`)
  }
  return resolve(value)
}

function assertId(value: string, label: string): void {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) throw new Error(`Invalid ${label}`)
}

function isSameOrInside(candidate: string, parent: string): boolean {
  const pathFromParent = relative(parent, candidate)
  return pathFromParent === '' || (!pathFromParent.startsWith(`..${sep}`) && pathFromParent !== '..' && !isAbsolute(pathFromParent))
}

function assertSeparatePaths(repository: string, root: string): void {
  if (isSameOrInside(repository, root) || isSameOrInside(root, repository)) {
    throw new Error('Repository and worktree root must not overlap')
  }
}

function existingRealPath(path: string, label: string): string | undefined {
  try {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`)
    if (!stat.isDirectory()) throw new Error(`${label} must be a directory`)
    return realpathSync(path)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  }
}

function git(args: readonly string[], cwd: string): Promise<GitResult> {
  const environment: NodeJS.ProcessEnv = {
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
  return new Promise((resolvePromise, reject) => {
    execFile(GIT_EXECUTABLE, [...args], {
      cwd,
      env: environment,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: GIT_MAX_OUTPUT_BYTES,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (!error) {
        resolvePromise({ stdout, stderr, exitCode: 0 })
        return
      }
      const exitCode = typeof error.code === 'number' ? error.code : -1
      reject(new GitCommandError({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode }))
    })
  })
}

async function gitExit(args: readonly string[], cwd: string): Promise<GitResult> {
  try {
    return await git(args, cwd)
  } catch (error) {
    if (error instanceof GitCommandError) return error.result
    throw error
  }
}

function singleLine(output: string, label: string): string {
  const value = output.replace(/[\r\n]+$/, '')
  if (!value || value.includes('\n') || value.includes('\r') || value.includes('\0')) throw new Error(`Invalid Git ${label}`)
  return value
}

async function canonicalGitPath(args: readonly string[], cwd: string, label: string): Promise<string> {
  const output = singleLine((await git(args, cwd)).stdout, label)
  return realpath(isAbsolute(output) ? output : resolve(cwd, output))
}

interface ListedWorktree {
  path: string
  head?: string
  branch?: string
  detached: boolean
}

function parseWorktreeList(output: string): ListedWorktree[] {
  const records: ListedWorktree[] = []
  let current: ListedWorktree | undefined
  for (const field of output.split(/[\0\n]/)) {
    if (!field) {
      if (current) records.push(current)
      current = undefined
      continue
    }
    const separator = field.indexOf(' ')
    const key = separator < 0 ? field : field.slice(0, separator)
    const value = separator < 0 ? '' : field.slice(separator + 1)
    if (key === 'worktree') {
      if (current) records.push(current)
      current = { path: value, detached: false }
    } else if (current && key === 'HEAD') {
      current.head = value
    } else if (current && key === 'branch') {
      current.branch = value
    } else if (current && key === 'detached') {
      current.detached = true
    }
  }
  if (current) records.push(current)
  if (records.some(record => !isAbsolute(record.path) || /[\0\r\n]/.test(record.path))) throw new Error('Git returned an invalid worktree path')
  return records
}

function markerData(value: unknown): Marker {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid worktree ownership marker')
  const marker = value as Partial<Marker>
  const keys = ['version', 'repository', 'root', 'ticketId', 'assignmentId', 'executionId', 'path', 'baseRevision', 'branch']
  if (Object.keys(marker).length !== keys.length || Object.keys(marker).some(key => !keys.includes(key))) {
    throw new Error('Invalid worktree ownership marker')
  }
  if (marker.version !== 1) throw new Error('Invalid worktree ownership marker')
  for (const key of ['repository', 'root', 'ticketId', 'assignmentId', 'executionId', 'path', 'baseRevision', 'branch'] as const) {
    if (typeof marker[key] !== 'string' || marker[key].includes('\0')) throw new Error('Invalid worktree ownership marker')
  }
  if (typeof marker.baseRevision !== 'string' || !REVISION_PATTERN.test(marker.baseRevision)) throw new Error('Invalid worktree ownership marker')
  return marker as Marker
}

async function readMarker(path: string): Promise<Marker> {
  const markerPath = join(path, MARKER)
  const before = await lstat(markerPath)
  if (before.isSymbolicLink() || !before.isFile() || before.size > 16 * 1024 || (before.mode & 0o077) !== 0) {
    throw new Error('Unsafe worktree ownership marker')
  }
  const handle = await open(markerPath, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const after = await handle.stat()
    if (!after.isFile() || after.size > 16 * 1024 || after.dev !== before.dev || after.ino !== before.ino || (after.mode & 0o077) !== 0) {
      throw new Error('Unsafe worktree ownership marker')
    }
    const content = await handle.readFile({ encoding: 'utf8' })
    if (content.length > 16 * 1024) throw new Error('Invalid worktree ownership marker')
    return markerData(JSON.parse(content) as unknown)
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error('Invalid worktree ownership marker')
    throw error
  } finally {
    await handle.close()
  }
}

async function writeMarker(path: string, marker: Marker): Promise<void> {
  const handle = await open(join(path, MARKER), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(marker, null, 2)}\n`, { encoding: 'utf8' })
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function addPrivateExclude(worktreePath: string, repository: string): Promise<void> {
  const dotGit = await lstat(join(worktreePath, '.git'))
  if (dotGit.isSymbolicLink() || !dotGit.isFile()) throw new Error('Unsafe linked-worktree Git marker')
  const gitDirectory = singleLine((await git(['rev-parse', '--absolute-git-dir'], worktreePath)).stdout, 'directory')
  if (!isAbsolute(gitDirectory)) throw new Error('Git returned a non-absolute directory')
  const canonicalDirectory = await realpath(gitDirectory)
  const commonDirectory = await canonicalGitPath(['rev-parse', '--git-common-dir'], repository, 'common directory')
  const registryDirectory = join(commonDirectory, 'worktrees')
  const registryStat = await lstat(registryDirectory)
  if (registryStat.isSymbolicLink() || !registryStat.isDirectory() || canonicalDirectory === registryDirectory || !isSameOrInside(canonicalDirectory, registryDirectory)) {
    throw new Error('Linked worktree Git directory is outside the configured repository')
  }
  const infoDirectory = join(canonicalDirectory, 'info')
  try {
    await mkdir(infoDirectory, { mode: 0o700 })
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error
  }
  const infoStat = await lstat(infoDirectory)
  if (infoStat.isSymbolicLink() || !infoStat.isDirectory()) throw new Error('Unsafe per-worktree exclude directory')
  const excludePath = join(infoDirectory, 'exclude')
  let existing = ''
  try {
    const stat = await lstat(excludePath)
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Unsafe per-worktree exclude file')
    const reader = await open(excludePath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      existing = await reader.readFile({ encoding: 'utf8' })
    } finally {
      await reader.close()
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
  const entry = `/${MARKER}`
  if (existing.split(/\r?\n/).includes(entry)) return
  const writer = await open(excludePath, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
  try {
    const prefix = existing && !existing.endsWith('\n') ? '\n' : ''
    await writer.writeFile(`${prefix}${entry}\n`, { encoding: 'utf8' })
  } finally {
    await writer.close()
  }
}

export class GitWorktreeManager {
  private readonly repositoryInput: string
  private readonly rootInput: string
  private readonly baseRef: string
  private repositoryPath?: string
  private rootPath?: string

  constructor(options: GitWorktreeOptions) {
    if (!options || typeof options !== 'object') throw new Error('Git worktree options are required')
    this.repositoryInput = assertAbsolutePath(options.repository, 'Repository')
    this.rootInput = assertAbsolutePath(options.root, 'Worktree root')
    assertSeparatePaths(this.repositoryInput, this.rootInput)
    if (options.baseRef !== undefined && (typeof options.baseRef !== 'string' || !options.baseRef.trim() || /[\0\r\n]/.test(options.baseRef) || options.baseRef.startsWith('-') || options.baseRef.length > 1024)) {
      throw new Error('Invalid base reference')
    }
    this.baseRef = options.baseRef ?? 'HEAD'

    const repository = existingRealPath(this.repositoryInput, 'Repository')
    const root = existingRealPath(this.rootInput, 'Worktree root')
    if (repository && root) assertSeparatePaths(repository, root)
    this.repositoryPath = repository
    this.rootPath = root
  }

  async create(ticketId: string, assignmentId: string, executionId: string): Promise<GitWorktree> {
    this.assertIdentities(ticketId, assignmentId, executionId)
    const { repository, root } = await this.prepare()
    const path = this.executionPath(root, executionId)
    await this.assertPathAbsent(path)

    const branch = `lao/${executionId}`
    const branchRef = `refs/heads/${branch}`
    const baseRevision = singleLine((await git(['rev-parse', '--verify', '--end-of-options', `${this.baseRef}^{commit}`], repository)).stdout, 'base revision')
    if (!REVISION_PATTERN.test(baseRevision)) throw new Error('Git returned an invalid base revision')

    const existingBranch = await gitExit(['show-ref', '--verify', '--quiet', branchRef], repository)
    if (existingBranch.exitCode === 0) throw new Error(`Worktree branch already exists: ${branch}`)
    if (existingBranch.exitCode !== 1) throw new Error('Unable to check worktree branch ownership')

    let branchCreated = false
    try {
      await git(['update-ref', branchRef, baseRevision, ''], repository)
      branchCreated = true
      await git(['worktree', 'add', '--', path, branch], repository)
      const createdPathStat = await lstat(path)
      if (createdPathStat.isSymbolicLink() || !createdPathStat.isDirectory() || await realpath(path) !== path) {
        throw new Error('Created worktree path was replaced or escaped its execution root')
      }
      const marker: Marker = { version: 1, repository, root, ticketId, assignmentId, executionId, path, baseRevision, branch }
      await writeMarker(path, marker)
      await addPrivateExclude(path, repository)
      return { path, baseRevision, branch }
    } catch (error) {
      const cleanupProblems = await this.cleanupFailedCreate(repository, path, branchRef, baseRevision, branchCreated)
      const reason = error instanceof Error ? error.message : 'Unknown worktree creation error'
      if (cleanupProblems.length) throw new Error(`${reason}; creation cleanup failed: ${cleanupProblems.join('; ')}`)
      throw error
    }
  }

  async inspect(path: string, ticketId: string, assignmentId: string, executionId: string): Promise<GitWorktree> {
    this.assertIdentities(ticketId, assignmentId, executionId)
    const { repository, root } = await this.prepare()
    const expectedPath = this.executionPath(root, executionId)
    const suppliedPath = assertAbsolutePath(path, 'Worktree path')
    const configuredPath = resolve(this.rootInput, executionId)
    if (suppliedPath !== expectedPath && suppliedPath !== configuredPath) throw new Error('Worktree path does not match its execution root')
    const pathStat = await lstat(suppliedPath)
    if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) throw new Error('Unsafe worktree path')
    if (await realpath(suppliedPath) !== expectedPath) throw new Error('Worktree path escapes its execution root')

    const marker = await readMarker(suppliedPath)
    if (marker.repository !== repository || marker.root !== root || marker.path !== expectedPath || marker.ticketId !== ticketId || marker.assignmentId !== assignmentId || marker.executionId !== executionId || marker.branch !== `lao/${executionId}`) {
      throw new Error('Worktree ownership marker does not match the requested execution')
    }

    const records = parseWorktreeList((await git(['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain'], repository)).stdout)
    const matches = records.filter(record => resolve(record.path) === expectedPath)
    if (matches.length !== 1) throw new Error('Worktree is not uniquely registered with the configured repository')
    const record = matches[0]!
    if (record.detached || record.branch !== `refs/heads/${marker.branch}`) throw new Error('Worktree is not on its owned branch')

    const repositoryCommon = await canonicalGitPath(['rev-parse', '--git-common-dir'], repository, 'common directory')
    const worktreeCommon = await canonicalGitPath(['rev-parse', '--git-common-dir'], expectedPath, 'common directory')
    if (repositoryCommon !== worktreeCommon) throw new Error('Worktree belongs to a different repository')
    const topLevel = await canonicalGitPath(['rev-parse', '--show-toplevel'], expectedPath, 'top level')
    if (topLevel !== expectedPath) throw new Error('Worktree top level does not match its registered path')
    const symbolicBranch = singleLine((await git(['symbolic-ref', '--quiet', 'HEAD'], expectedPath)).stdout, 'branch')
    if (symbolicBranch !== `refs/heads/${marker.branch}`) throw new Error('Worktree current branch does not match its ownership marker')
    const currentRevision = singleLine((await git(['rev-parse', '--verify', 'HEAD'], expectedPath)).stdout, 'worktree revision')
    const branchRevision = singleLine((await git(['rev-parse', '--verify', `refs/heads/${marker.branch}`], repository)).stdout, 'branch revision')
    if (!REVISION_PATTERN.test(currentRevision) || record.head !== currentRevision || branchRevision !== currentRevision) {
      throw new Error('Worktree branch revision does not match its registration')
    }
    const baseCheck = await gitExit(['cat-file', '-e', `${marker.baseRevision}^{commit}`], repository)
    if (baseCheck.exitCode !== 0) throw new Error('Worktree base revision is no longer valid')
    return { path: expectedPath, baseRevision: marker.baseRevision, branch: marker.branch }
  }

  async remove(path: string, ticketId: string, assignmentId: string, executionId: string, options: GitWorktreeRemovalOptions = {}): Promise<void> {
    if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'approvedDirtyRemoval') || (options.approvedDirtyRemoval !== undefined && typeof options.approvedDirtyRemoval !== 'boolean')) {
      throw new Error('Invalid worktree removal options')
    }
    const owned = await this.inspect(path, ticketId, assignmentId, executionId)
    const { repository } = await this.prepare()
    const dirty = await this.isDirty(owned.path)
    if (dirty && options.approvedDirtyRemoval !== true) throw new Error('Refusing to remove a dirty worktree without explicit approval')

    const branchRef = `refs/heads/${owned.branch}`
    const head = singleLine((await git(['rev-parse', '--verify', branchRef], repository)).stdout, 'branch revision')
    const worktreeHead = singleLine((await git(['rev-parse', '--verify', 'HEAD'], owned.path)).stdout, 'worktree revision')
    if (head !== worktreeHead || !REVISION_PATTERN.test(head)) throw new Error('Owned worktree branch changed during removal')

    // The private marker is deliberately untracked. Some Git versions do not honor
    // a linked worktree's private info/exclude, so force is required even after the
    // status check above has proved that no other changes will be discarded.
    await git(['worktree', 'remove', '--force', owned.path], repository)
    try {
      await lstat(owned.path)
      throw new Error('Git removed the registration but left the worktree path behind')
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
    const branchDeletion = await gitExit(['update-ref', '-d', branchRef, head], repository)
    if (branchDeletion.exitCode !== 0) throw new Error('Worktree was removed, but its owned branch could not be cleaned safely')
  }

  private assertIdentities(ticketId: string, assignmentId: string, executionId: string): void {
    assertId(ticketId, 'ticket ID')
    assertId(assignmentId, 'assignment ID')
    assertId(executionId, 'execution ID')
  }

  private async prepare(): Promise<{ repository: string; root: string }> {
    const repositoryStat = await lstat(this.repositoryInput)
    if (repositoryStat.isSymbolicLink() || !repositoryStat.isDirectory()) throw new Error('Repository must be a real directory')
    const repository = await realpath(this.repositoryInput)
    if (this.repositoryPath && repository !== this.repositoryPath) throw new Error('Repository identity changed')
    const repositoryTop = await canonicalGitPath(['rev-parse', '--show-toplevel'], repository, 'repository top level')
    if (repositoryTop !== repository) throw new Error('Repository path must be its Git top level')

    try {
      const existingRoot = await lstat(this.rootInput)
      if (existingRoot.isSymbolicLink() || !existingRoot.isDirectory()) throw new Error('Worktree root must be a real directory')
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
      await mkdir(this.rootInput, { recursive: true, mode: 0o700 })
    }
    const rootStat = await lstat(this.rootInput)
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Worktree root must be a real directory')
    const root = await realpath(this.rootInput)
    if (this.rootPath && root !== this.rootPath) throw new Error('Worktree root identity changed')
    assertSeparatePaths(repository, root)
    this.repositoryPath = repository
    this.rootPath = root
    return { repository, root }
  }

  private executionPath(root: string, executionId: string): string {
    const path = resolve(root, executionId)
    if (relative(root, path) !== executionId || !isSameOrInside(path, root) || path === root) throw new Error('Execution path escapes the worktree root')
    return path
  }

  private async assertPathAbsent(path: string): Promise<void> {
    try {
      const stat = await lstat(path)
      if (stat.isSymbolicLink()) throw new Error('Refusing to replace a symbolic-link worktree path')
      throw new Error('Execution worktree path already exists')
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
    }
  }

  private async isDirty(path: string): Promise<boolean> {
    const status = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.', `:(exclude)${MARKER}`], path)
    return status.stdout.length > 0
  }

  private async cleanupFailedCreate(repository: string, path: string, branchRef: string, baseRevision: string, branchCreated: boolean): Promise<string[]> {
    const problems: string[] = []
    let pathExists = false
    try {
      const stat = await lstat(path)
      pathExists = true
      if (stat.isSymbolicLink() || !stat.isDirectory()) problems.push('created path is unsafe and was preserved')
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) problems.push('could not inspect created path')
    }

    if (pathExists && problems.length === 0) {
      try {
        const pathStat = await lstat(path)
        if (pathStat.isSymbolicLink() || !pathStat.isDirectory() || await realpath(path) !== path) {
          problems.push('created path identity changed and was preserved')
          return problems
        }
        const records = parseWorktreeList((await git(['-c', 'core.quotePath=false', 'worktree', 'list', '--porcelain'], repository)).stdout)
        const registrations = records.filter(record => resolve(record.path) === path)
        if (registrations.length === 0) {
          problems.push('unregistered checkout residue was preserved')
        } else if (registrations.length !== 1 || registrations[0]!.detached || registrations[0]!.branch !== branchRef || registrations[0]!.head !== baseRevision) {
          problems.push('unverified checkout registration was preserved')
        } else if (await this.isDirty(path)) {
          problems.push('dirty checkout residue was preserved')
        } else {
          await git(['worktree', 'remove', '--force', path], repository)
          try {
            await lstat(path)
            problems.push('Git left checkout residue behind')
          } catch (error) {
            if (!isErrno(error, 'ENOENT')) problems.push('could not verify checkout cleanup')
            else pathExists = false
          }
        }
      } catch {
        problems.push('Git could not safely remove the created worktree')
      }
    }

    if (branchCreated && !pathExists && problems.length === 0) {
      const deletion = await gitExit(['update-ref', '-d', branchRef, baseRevision], repository)
      if (deletion.exitCode !== 0) problems.push('created branch could not be deleted with verified ownership')
    }
    return problems
  }
}
