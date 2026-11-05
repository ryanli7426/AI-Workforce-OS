/**
 * Authorized local product-acceptance checks against an immutable artifact snapshot.
 * Produces verification evidence only; never grants approval or marks a Task DONE.
 */
import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  rm,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { Readable } from 'node:stream'
import { ArtifactStore, type ArtifactManifest } from '../artifacts/snapshots.ts'
import { StreamingRedactor } from '../security/redaction.ts'

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHA256 = /^[a-f0-9]{64}$/
const MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_ARGS = 256
const MAX_ARG_BYTES = 64 * 1024
const MAX_CHECKS = 64
const MAX_WAIVE_REASON = 4_096
const LOOP_MS = 10
const SPAWN_CONFIRM_MS = 5_000
const GRACE_MS = 200
const POST_KILL_MS = 2_000
const CLOSE_WAIT_MS = 2_000
/** Absolute bound for stop confirmation even when exit/close events never arrive. */
const TERMINATION_BOUND_MS = GRACE_MS + POST_KILL_MS + CLOSE_WAIT_MS
const POSIX = process.platform !== 'win32'
const REPORT_FILE = 'report.json'
const WORKSPACE_DIRECTORY = 'workspace'
const MINIMAL_ENV_KEYS = ['PATH', 'HOME', 'USER', 'LANG', 'TMPDIR'] as const

export type VerificationState = 'passed' | 'failed' | 'not_required'

export interface VerificationCheckRequest {
  id: string
  command: string
  args: string[]
  timeoutMs: number
}

export interface VerificationCheckResult {
  id: string
  exitCode: number | null
  signal: NodeJS.Signals | null
  durationMs: number
  stdout: string
  stderr: string
  reason?: string
}

export interface VerificationReport {
  verificationId: string
  executionId: string
  artifactId: string
  artifactRevision: string
  state: VerificationState
  checks: VerificationCheckResult[]
  createdAt: string
  waiveReason?: string
}

export interface LocalVerifierOptions {
  root: string
  artifactStore: ArtifactStore
}

export interface VerifyInput {
  verificationId: string
  executionId: string
  artifactId: string
  artifactRevision: string
  checks: VerificationCheckRequest[]
  authorized: boolean
  waiveReason?: string
}

export interface VerificationSupervisionOptions {
  signal: AbortSignal
  onProcess?: (info: { checkId: string; processId: number }) => void | Promise<void>
}

export type SupervisedVerificationResult =
  | { status: 'completed'; terminalConfirmed: true; report: VerificationReport }
  | { status: 'cancelled'; terminalConfirmed: true; failureCode: 'CANCELLED' }
  | { status: 'failed'; terminalConfirmed: true; failureCode: string }
  | { status: 'unknown'; terminalConfirmed: false; failureCode: string }

type RuntimeChild = ChildProcessByStdio<null, Readable, Readable>

type OwnedCheckOutcome =
  /** `acceptedOutputBytes` is internal aggregate accounting only; never part of the public report DTO. */
  | { status: 'finished'; terminalConfirmed: true; result: VerificationCheckResult; acceptedOutputBytes: number }
  | { status: 'cancelled'; terminalConfirmed: true; result?: VerificationCheckResult }
  | { status: 'callback_failed'; terminalConfirmed: true; result?: VerificationCheckResult }
  | { status: 'infrastructure_failed'; terminalConfirmed: true; failureCode: string; result?: VerificationCheckResult }
  | { status: 'unknown'; terminalConfirmed: false; failureCode: string; result?: VerificationCheckResult }

interface RunOwnedCheckOptions {
  signal?: AbortSignal
  onProcess?: (info: { checkId: string; processId: number }) => void | Promise<void>
  /** Supervised mode awaits startup proof when a PID exists; legacy may best-effort return. */
  awaitStartupConfirmation: boolean
  /** Combined stdout+stderr budget for this check; defaults to MAX_OUTPUT_BYTES. */
  maxOutputBytes?: number
}

interface PreparedVerification {
  request: VerifyInput
  verificationRoot: string
  artifactRoot: string
  destination: string
  artifactFilesRoot: string
  manifest: ArtifactManifest
}

function fail(message: string): never {
  throw new Error(message)
}

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

function pathInside(parent: string, child: string): boolean {
  const suffix = relative(parent, child)
  return suffix === '' || (!suffix.startsWith(`..${sep}`) && suffix !== '..' && !isAbsolute(suffix))
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return 'UNKNOWN'
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function parseSupervisionOptions(value: unknown): VerificationSupervisionOptions {
  assertObject(value, 'verification supervision options')
  const optional = 'onProcess' in value ? ['onProcess'] : []
  assertExactKeys(value, ['signal', ...optional], 'verification supervision options')
  if (!(value.signal instanceof AbortSignal)) fail('verification supervision options signal is invalid')
  if ('onProcess' in value && value.onProcess !== undefined && typeof value.onProcess !== 'function') {
    fail('verification supervision options onProcess is invalid')
  }
  return {
    signal: value.signal,
    ...(typeof value.onProcess === 'function'
      ? { onProcess: value.onProcess as VerificationSupervisionOptions['onProcess'] }
      : {}),
  }
}

function classifyPreflightFailure(error: unknown): string {
  const code = errorCode(error)
  if (code === 'ENOENT') return 'ARTIFACT_MISSING'
  const message = error instanceof Error ? error.message : ''
  if (/authorized|verify input|safe identifier|timeoutMs|waiveReason|checks must|duplicate check|args are|artifactRevision must|command is invalid|command must be an absolute/i.test(message)) {
    return 'INVALID_INPUT'
  }
  if (/symbolic link|must be absolute|must be a directory|must be private|overlap|already exists|cwd must|Verification root/i.test(message)) {
    return 'INVALID_PATH'
  }
  if (/Artifact path is not|Artifact directory contains|Artifact manifest|Artifact files entry|ENOENT|not found/i.test(message)) {
    return 'ARTIFACT_MISSING'
  }
  if (/execution identity|revision does not match|Artifact identity|Artifact file verification|digest|copy digest|copy size|Artifact files do not match|Artifact contains unexpected|Artifact file identity/i.test(message)) {
    return 'ARTIFACT_MISMATCH'
  }
  if (/command cannot|command must be a regular|command is not executable/i.test(message)) {
    return 'COMMAND_INVALID'
  }
  return 'SETUP_FAILED'
}

async function rejectSymlinkComponents(path: string, allowMissing: boolean): Promise<void> {
  const absolute = resolve(path)
  const root = parse(absolute).root
  let current = root
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
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
  if (label === 'verification root' && process.platform !== 'win32' && (info.mode & 0o077) !== 0)
    fail('Verification root must be private (0700)')
  return realpath(absolute)
}

async function assertAbsent(path: string, label: string): Promise<void> {
  try {
    await lstat(path)
    fail(`${label} already exists`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function artifactStoreRoot(store: ArtifactStore): string {
  const value = store.rootDirectory
  if (typeof value !== 'string' || !isAbsolute(value)) fail('ArtifactStore root is unavailable')
  return resolve(value)
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = Object.create(null) as NodeJS.ProcessEnv
  for (const name of MINIMAL_ENV_KEYS) {
    const value = process.env[name]
    if (value !== undefined && !value.includes('\0')) env[name] = value
  }
  return env
}

function processGroupAlive(processId: number): boolean {
  if (!POSIX) return false
  try {
    process.kill(-processId, 0)
    return true
  } catch (error) {
    return errorCode(error) !== 'ESRCH'
  }
}

function signalProcess(child: RuntimeChild, processId: number, signal: NodeJS.Signals): void {
  try {
    if (POSIX) process.kill(-processId, signal)
    else child.kill(signal)
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error
  }
}

function parseCheck(value: unknown, index: number, seen: Set<string>): VerificationCheckRequest {
  assertObject(value, `check ${index}`)
  assertExactKeys(value, ['id', 'command', 'args', 'timeoutMs'], `check ${index}`)
  const id = safeId(value.id, `check ${index} id`)
  if (seen.has(id)) fail(`duplicate check id: ${id}`)
  seen.add(id)
  if (typeof value.command !== 'string' || value.command.length === 0 || value.command.includes('\0')) {
    fail(`check ${id} command is invalid`)
  }
  if (!isAbsolute(value.command)) fail(`check ${id} command must be an absolute executable path`)
  if (!Array.isArray(value.args) || value.args.length > MAX_ARGS) fail(`check ${id} args are invalid`)
  const args = value.args.map((arg, argIndex) => {
    if (typeof arg !== 'string' || arg.includes('\0') || Buffer.byteLength(arg) > MAX_ARG_BYTES) {
      fail(`check ${id} arg ${argIndex} is invalid`)
    }
    return arg
  })
  if (!Number.isSafeInteger(value.timeoutMs) || Number(value.timeoutMs) <= 0) {
    fail(`check ${id} timeoutMs must be a positive safe integer`)
  }
  return { id, command: resolve(value.command), args, timeoutMs: Number(value.timeoutMs) }
}

function parseVerifyInput(input: unknown): VerifyInput {
  assertObject(input, 'verify input')
  const optional = 'waiveReason' in input ? ['waiveReason'] : []
  assertExactKeys(
    input,
    ['verificationId', 'executionId', 'artifactId', 'artifactRevision', 'checks', 'authorized', ...optional],
    'verify input',
  )
  if (input.authorized !== true) fail('Verification requires authorized === true')
  const verificationId = safeId(input.verificationId, 'verificationId')
  const executionId = safeId(input.executionId, 'executionId')
  const artifactId = safeId(input.artifactId, 'artifactId')
  if (typeof input.artifactRevision !== 'string' || !SHA256.test(input.artifactRevision)) {
    fail('artifactRevision must be a sha256 hex digest')
  }
  if (!Array.isArray(input.checks) || input.checks.length > MAX_CHECKS) fail('checks must be a bounded array')
  const seen = new Set<string>()
  const checks = input.checks.map((check, index) => parseCheck(check, index, seen))
  let waiveReason: string | undefined
  if ('waiveReason' in input) {
    if (typeof input.waiveReason !== 'string' || input.waiveReason.trim().length === 0 || input.waiveReason.length > MAX_WAIVE_REASON
      || input.waiveReason.includes('\0')) {
      fail('waiveReason must be a nonempty bounded string')
    }
    waiveReason = input.waiveReason
  }
  if (checks.length === 0 && (waiveReason === undefined || waiveReason.length === 0)) {
    fail('Empty checks require a nonempty waiveReason')
  }
  return {
    verificationId,
    executionId,
    artifactId,
    artifactRevision: input.artifactRevision,
    checks,
    authorized: true,
    ...(waiveReason !== undefined ? { waiveReason } : {}),
  }
}

async function assertRegularExecutable(command: string, checkId: string): Promise<void> {
  await rejectSymlinkComponents(command, false)
  const info = await lstat(command)
  if (info.isSymbolicLink()) fail(`check ${checkId} command cannot be a symbolic link`)
  if (!info.isFile()) fail(`check ${checkId} command must be a regular file`)
  try {
    await access(command, constants.X_OK)
  } catch {
    fail(`check ${checkId} command is not executable`)
  }
}

async function copyArtifactFiles(
  artifactFilesRoot: string,
  workspaceRoot: string,
  files: readonly { path: string, mode: number, sha256: string, size: number }[],
): Promise<void> {
  for (const file of files) {
    const source = join(artifactFilesRoot, ...file.path.split('/'))
    const destination = join(workspaceRoot, ...file.path.split('/'))
    if (!pathInside(artifactFilesRoot, source) || !pathInside(workspaceRoot, destination)) {
      fail(`Artifact path escapes its root: ${file.path}`)
    }
    await rejectSymlinkComponents(source, false)
    const sourceInfo = await lstat(source)
    if (sourceInfo.isSymbolicLink() || !sourceInfo.isFile()) fail(`Artifact source is not a regular file: ${file.path}`)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await assertAbsent(destination, `verification workspace file ${file.path}`)
    await copyFile(source, destination, constants.COPYFILE_EXCL)
    await chmod(destination, file.mode)
    const copied = await lstat(destination)
    if (!copied.isFile() || copied.isSymbolicLink() || copied.size !== file.size) fail('Verification copy size mismatch')
    const digest = createHash('sha256')
    const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024)
      let remaining = file.size
      let position = 0
      while (remaining > 0) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), position)
        if (bytesRead === 0) fail(`Verification copy truncated: ${file.path}`)
        digest.update(buffer.subarray(0, bytesRead))
        position += bytesRead
        remaining -= bytesRead
      }
    } finally {
      await handle.close()
    }
    if (digest.digest('hex') !== file.sha256) fail(`Verification copy digest mismatch: ${file.path}`)
  }
}

async function fsyncContainingDirectory(filePath: string): Promise<void> {
  const handle = await open(dirname(filePath), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0))
  try {
    await handle.sync()
  } catch (error) {
    const code = errorCode(error)
    if (code !== 'EINVAL' && code !== 'ENOTSUP') throw error
  } finally {
    await handle.close()
  }
}

async function persistReport(destination: string, report: VerificationReport): Promise<void> {
  await assertAbsent(destination, 'verification report')
  const temporary = join(dirname(destination), `.report-${basename(destination)}-${randomBytes(8).toString('hex')}.tmp`)
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await chmod(temporary, 0o600)
  await rename(temporary, destination)
  await chmod(destination, 0o600)
  await fsyncContainingDirectory(destination)
}

async function awaitOwnedTermination(
  child: RuntimeChild,
  processId: number,
  state: {
    directExited: () => boolean
    childClosed: () => boolean
    exitCode: () => number | null | undefined
    exitSignal: () => NodeJS.Signals | null | undefined
  },
): Promise<{ confirmed: boolean; alive: boolean; closed: boolean; directExited: boolean }> {
  const terminationRequestedAt = Date.now()
  const deadlineAt = terminationRequestedAt + TERMINATION_BOUND_MS
  let killSentAt: number | undefined
  let closeWaitStartedAt: number | undefined
  const groupAlive = (): boolean => (POSIX ? processGroupAlive(processId) : !state.directExited())

  try { signalProcess(child, processId, 'SIGTERM') } catch { /* escalate */ }

  for (;;) {
    const now = Date.now()
    if (groupAlive() && killSentAt === undefined && now - terminationRequestedAt >= GRACE_MS) {
      killSentAt = now
      try { signalProcess(child, processId, 'SIGKILL') } catch { /* confirm via poll */ }
    }
    const alive = groupAlive()
    const exited = state.directExited()
    const closed = state.childClosed()
    if (!alive && exited && closeWaitStartedAt === undefined) closeWaitStartedAt = now
    // PID-owned confirmation requires direct exit + stream close + group absence.
    if (exited && closed && !alive) {
      return { confirmed: true, alive: false, closed: true, directExited: true }
    }
    const killExpired = killSentAt !== undefined && now - killSentAt >= POST_KILL_MS
    const closeExpired = closeWaitStartedAt !== undefined && now - closeWaitStartedAt >= CLOSE_WAIT_MS
    const absoluteExpired = now >= deadlineAt
    if (killExpired || closeExpired || absoluteExpired) {
      try { child.stdout.destroy() } catch { /* ignore */ }
      try { child.stderr.destroy() } catch { /* ignore */ }
      if (alive) {
        try { signalProcess(child, processId, 'SIGKILL') } catch { /* final attempt */ }
      }
      return { confirmed: false, alive, closed, directExited: exited }
    }
    await sleep(LOOP_MS)
  }
}

type CallbackRaceResult = 'completed' | 'failed' | 'aborted' | 'timed_out'

async function raceProcessCallback(
  invoke: () => void | Promise<void>,
  options: { signal?: AbortSignal; deadlineAt: number },
): Promise<CallbackRaceResult> {
  let settled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined

  return await new Promise<CallbackRaceResult>(resolvePromise => {
    const finish = (result: CallbackRaceResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (onAbort && options.signal) options.signal.removeEventListener('abort', onAbort)
      resolvePromise(result)
    }

    if (options.signal?.aborted) {
      finish('aborted')
      return
    }

    const remainingMs = Math.max(0, options.deadlineAt - Date.now())
    timer = setTimeout(() => finish('timed_out'), remainingMs)

    if (options.signal) {
      onAbort = () => finish('aborted')
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    Promise.resolve()
      .then(() => invoke())
      .then(() => finish('completed'), () => finish('failed'))
  })
}

async function runOwnedCheck(
  check: VerificationCheckRequest,
  cwd: string,
  options: RunOwnedCheckOptions,
): Promise<OwnedCheckOutcome> {
  await assertRegularExecutable(check.command, check.id)
  const cwdInfo = await lstat(cwd)
  if (cwdInfo.isSymbolicLink() || !cwdInfo.isDirectory()) fail(`check ${check.id} cwd must be a real directory`)

  if (options.signal?.aborted) {
    return { status: 'cancelled', terminalConfirmed: true }
  }

  const env = minimalEnvironment()
  const secrets = Object.entries(env)
    .filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(name) && !!value)
    .map(([, value]) => value!)
  const outputLimit = Math.max(0, options.maxOutputBytes ?? MAX_OUTPUT_BYTES)
  const redactors = {
    stdout: new StreamingRedactor({ secrets, maxPendingBytes: Math.max(1, outputLimit) }),
    stderr: new StreamingRedactor({ secrets, maxPendingBytes: Math.max(1, outputLimit) }),
  }

  let child: RuntimeChild | undefined
  let spawnError: unknown
  let spawned = false
  let directExited = false
  let childClosed = false
  let exitCode: number | null | undefined
  let exitSignal: NodeJS.Signals | null | undefined
  let stdout = ''
  let stderr = ''
  let outputBytes = 0
  let outputExceeded = false
  let acceptingOutput = true
  const started = Date.now()
  const checkDeadlineAt = started + check.timeoutMs

  try {
    child = spawn(check.command, check.args, {
      cwd,
      env,
      shell: false,
      detached: POSIX,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    spawnError = error
  }

  const writeOutput = (kind: 'stdout' | 'stderr', chunk: Buffer | string): void => {
    if (!acceptingOutput || outputExceeded) return
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    const remaining = Math.max(0, outputLimit - outputBytes)
    const accepted = Math.min(remaining, data.length)
    if (accepted > 0) {
      const text = redactors[kind].write(data.subarray(0, accepted))
      if (kind === 'stdout') stdout += text
      else stderr += text
      outputBytes += accepted
    }
    if (accepted < data.length) outputExceeded = true
  }

  if (child) {
    child.once('spawn', () => { spawned = true })
    child.on('error', error => {
      if (!spawned) spawnError = error
    })
    child.once('exit', (code, signal) => {
      directExited = true
      exitCode = code
      exitSignal = signal
    })
    child.once('close', (code, signal) => {
      childClosed = true
      if (exitCode === undefined) exitCode = code
      if (exitSignal === undefined) exitSignal = signal
    })
    child.stdout.on('data', chunk => writeOutput('stdout', chunk as Buffer))
    child.stderr.on('data', chunk => writeOutput('stderr', chunk as Buffer))
  }

  const spawnDeadline = Date.now() + SPAWN_CONFIRM_MS
  while (child && !spawned && !spawnError && Date.now() < spawnDeadline) {
    if (options.signal?.aborted) break
    await sleep(LOOP_MS)
  }

  const finishRedactors = (): void => {
    stdout += redactors.stdout.end()
    stderr += redactors.stderr.end()
  }

  const snapshotResult = (reason?: string): VerificationCheckResult => ({
    id: check.id,
    exitCode: exitCode ?? null,
    signal: exitSignal ?? null,
    durationMs: Math.max(0, Date.now() - started),
    stdout,
    stderr,
    ...(reason !== undefined ? { reason } : {}),
  })

  const finishedOutcome = (result: VerificationCheckResult): OwnedCheckOutcome => ({
    status: 'finished',
    terminalConfirmed: true,
    result,
    acceptedOutputBytes: outputBytes,
  })

  const ownershipState = {
    directExited: () => directExited,
    childClosed: () => childClosed,
    exitCode: () => exitCode,
    exitSignal: () => exitSignal,
  }

  if (!child || spawnError || !spawned || child.pid === undefined) {
    acceptingOutput = false
    if (child?.pid !== undefined) {
      if (options.awaitStartupConfirmation) {
        const stop = await awaitOwnedTermination(child, child.pid, ownershipState)
        child.stdout.destroy()
        child.stderr.destroy()
        finishRedactors()
        if (!stop.confirmed) {
          return {
            status: 'unknown',
            terminalConfirmed: false,
            failureCode: stop.alive
              ? 'PROCESS_GROUP_ALIVE'
              : (!stop.directExited || !stop.closed ? 'STREAM_UNCONFIRMED' : 'PROCESS_UNCONFIRMED'),
            result: snapshotResult('child startup failed'),
          }
        }
        return finishedOutcome(snapshotResult(`child startup failed (${errorCode(spawnError)})`))
      }
      try { signalProcess(child, child.pid, 'SIGKILL') } catch { /* best-effort legacy */ }
    }
    child?.stdout.destroy()
    child?.stderr.destroy()
    finishRedactors()
    return finishedOutcome(snapshotResult(`child startup failed (${errorCode(spawnError)})`))
  }

  const processId = child.pid

  const stopOwnedWithProof = async (
    reason: string,
  ): Promise<{ confirmed: boolean; alive: boolean; failureCode: string }> => {
    acceptingOutput = false
    const stop = await awaitOwnedTermination(child!, processId, ownershipState)
    try { child!.stdout.destroy() } catch { /* ignore */ }
    try { child!.stderr.destroy() } catch { /* ignore */ }
    try { finishRedactors() } catch { /* ignore */ }
    if (!stop.confirmed) {
      const failureCode = stop.alive
        ? 'PROCESS_GROUP_ALIVE'
        : (!stop.directExited || !stop.closed ? 'STREAM_UNCONFIRMED' : 'PROCESS_UNCONFIRMED')
      return { confirmed: false, alive: stop.alive, failureCode }
    }
    return { confirmed: true, alive: false, failureCode: reason }
  }

  try {
    if (options.onProcess) {
      const callbackResult = await raceProcessCallback(
        () => options.onProcess!({ checkId: check.id, processId }),
        { signal: options.signal, deadlineAt: checkDeadlineAt },
      )

      if (callbackResult !== 'completed') {
        const stopReason = callbackResult === 'aborted'
          ? 'verification check cancelled'
          : callbackResult === 'timed_out'
            ? 'verification check timed out'
            : 'process callback failed'
        const stop = await stopOwnedWithProof(stopReason)
        const result = snapshotResult(stopReason)
        if (!stop.confirmed) {
          return {
            status: 'unknown',
            terminalConfirmed: false,
            failureCode: stop.failureCode,
            result,
          }
        }
        if (callbackResult === 'aborted') {
          return { status: 'cancelled', terminalConfirmed: true, result }
        }
        if (callbackResult === 'timed_out') {
          return {
            status: 'infrastructure_failed',
            terminalConfirmed: true,
            failureCode: 'CHECK_TIMEOUT',
            result,
          }
        }
        return {
          status: 'callback_failed',
          terminalConfirmed: true,
          result,
        }
      }
    }

    let terminationReason: string | undefined
    let terminationRequestedAt: number | undefined
    let killSentAt: number | undefined
    let closeWaitStartedAt: number | undefined
    let cancelRequested = false
    const groupAlive = (): boolean => (POSIX ? processGroupAlive(processId) : !directExited)

    const requestStop = (reason: string, cancelled = false): void => {
      if (terminationReason) return
      terminationReason = reason
      cancelRequested = cancelled
      terminationRequestedAt = Date.now()
      try { signalProcess(child!, processId, 'SIGTERM') } catch { /* escalate to SIGKILL */ }
    }

    for (;;) {
      const now = Date.now()
      if (!terminationReason && options.signal?.aborted) requestStop('verification check cancelled', true)
      if (!terminationReason && outputExceeded) requestStop('combined output limit exceeded')
      if (!terminationReason && now >= checkDeadlineAt) requestStop('verification check timed out')
      if (!terminationReason && directExited && groupAlive()) requestStop('descendant processes outlived direct child')

      if (terminationReason && groupAlive() && killSentAt === undefined
        && terminationRequestedAt !== undefined && now - terminationRequestedAt >= GRACE_MS) {
        killSentAt = now
        try { signalProcess(child, processId, 'SIGKILL') } catch { /* confirm via liveness poll */ }
      }

      const alive = groupAlive()
      if (!alive && directExited && closeWaitStartedAt === undefined) closeWaitStartedAt = now
      // Close-confirm proof requires direct exit + stream close + group absence.
      if (childClosed && directExited && !alive) break

      const killExpired = killSentAt !== undefined && now - killSentAt >= POST_KILL_MS
      const closeExpired = closeWaitStartedAt !== undefined && now - closeWaitStartedAt >= CLOSE_WAIT_MS
      const absoluteExpired = terminationRequestedAt !== undefined
        && now - terminationRequestedAt >= TERMINATION_BOUND_MS
      if (killExpired || closeExpired || absoluteExpired) {
        acceptingOutput = false
        child.stdout.destroy()
        child.stderr.destroy()
        finishRedactors()
        if (alive) {
          try { signalProcess(child, processId, 'SIGKILL') } catch { /* final attempt */ }
        }
        const failureCode = alive
          ? 'PROCESS_GROUP_ALIVE'
          : (!directExited || !childClosed ? 'STREAM_UNCONFIRMED' : 'PROCESS_UNCONFIRMED')
        const reason = alive
          ? 'surviving process-group members could not be ruled out'
          : (terminationReason ?? 'child stream closure could not be confirmed')
        if (options.awaitStartupConfirmation) {
          return {
            status: 'unknown',
            terminalConfirmed: false,
            failureCode,
            result: snapshotResult(reason),
          }
        }
        return finishedOutcome(snapshotResult(reason))
      }

      await sleep(LOOP_MS)
    }

    acceptingOutput = false
    child.stdout.destroy()
    child.stderr.destroy()
    finishRedactors()

    const result = (() => {
      const durationMs = Math.max(0, Date.now() - started)
      const code = exitCode ?? null
      const signal = exitSignal ?? null
      if (terminationReason) {
        return { id: check.id, exitCode: code, signal, durationMs, stdout, stderr, reason: terminationReason }
      }
      if (code === 0 && signal === null) {
        return { id: check.id, exitCode: 0, signal: null, durationMs, stdout, stderr }
      }
      return {
        id: check.id,
        exitCode: code,
        signal,
        durationMs,
        stdout,
        stderr,
        reason: signal ? `process exited on signal ${signal}` : `process exited with code ${String(code)}`,
      }
    })()

    if (cancelRequested) {
      return { status: 'cancelled', terminalConfirmed: true, result }
    }
    return finishedOutcome(result)
  } catch {
    // Unexpected monitor errors stay unknown even when stop appears confirmed — never synthesize failed.
    const stop = await stopOwnedWithProof('owned check monitoring failed')
    if (!stop.confirmed) {
      return {
        status: 'unknown',
        terminalConfirmed: false,
        failureCode: stop.failureCode,
        result: snapshotResult('owned check monitoring failed'),
      }
    }
    return {
      status: 'unknown',
      terminalConfirmed: false,
      failureCode: 'PROCESS_UNCONFIRMED',
      result: snapshotResult('owned check monitoring failed'),
    }
  }
}

async function runCheck(
  check: VerificationCheckRequest,
  cwd: string,
): Promise<VerificationCheckResult> {
  const outcome = await runOwnedCheck(check, cwd, { awaitStartupConfirmation: false })
  if (outcome.result) return outcome.result
  return {
    id: check.id,
    exitCode: null,
    signal: null,
    durationMs: 0,
    stdout: '',
    stderr: '',
    reason: outcome.status === 'unknown' ? outcome.failureCode : 'verification check failed',
  }
}

export class LocalVerifier {
  private readonly configuredRoot: string
  private readonly artifactStore: ArtifactStore

  constructor(options: LocalVerifierOptions) {
    assertObject(options, 'LocalVerifier options')
    assertExactKeys(options as unknown as Record<string, unknown>, ['root', 'artifactStore'], 'LocalVerifier options')
    if (typeof options.root !== 'string' || !isAbsolute(options.root)) fail('Verification root must be absolute')
    if (!(options.artifactStore instanceof ArtifactStore)) fail('artifactStore must be an ArtifactStore')
    this.configuredRoot = resolve(options.root)
    this.artifactStore = options.artifactStore
  }

  private async prepareVerification(input: VerifyInput): Promise<PreparedVerification> {
    const request = parseVerifyInput(input)
    if (!POSIX) fail('Reliable verification process-group control currently requires POSIX')

    const artifactRootConfigured = artifactStoreRoot(this.artifactStore)
    const verificationRoot = await canonicalDirectory(this.configuredRoot, 'verification root', true)
    const artifactRoot = await canonicalDirectory(artifactRootConfigured, 'artifact root', false)
    if (pathInside(verificationRoot, artifactRoot) || pathInside(artifactRoot, verificationRoot)) {
      fail('Verification root and artifact root must not overlap')
    }

    const destination = join(verificationRoot, request.verificationId)
    await rejectSymlinkComponents(destination, true)
    await assertAbsent(destination, 'verification destination')

    const manifest = await this.artifactStore.verify(request.artifactId)
    if (manifest.executionId !== request.executionId) fail('Artifact execution identity does not match verification request')
    if (manifest.revision !== request.artifactRevision) fail('Artifact revision does not match verification request')
    if (manifest.artifactId !== request.artifactId) fail('Artifact identity does not match verification request')

    const artifactFilesRoot = join(artifactRoot, request.artifactId, 'files')
    if (pathInside(artifactFilesRoot, verificationRoot) || pathInside(verificationRoot, artifactFilesRoot)) {
      fail('Verification root must not overlap artifact files')
    }

    return {
      request,
      verificationRoot,
      artifactRoot,
      destination,
      artifactFilesRoot,
      manifest,
    }
  }

  private buildReport(
    request: VerifyInput,
    state: VerificationState,
    checks: VerificationCheckResult[],
    createdAt: string,
  ): VerificationReport {
    return {
      verificationId: request.verificationId,
      executionId: request.executionId,
      artifactId: request.artifactId,
      artifactRevision: request.artifactRevision,
      state,
      checks,
      createdAt,
      ...(state === 'not_required' && request.waiveReason !== undefined ? { waiveReason: request.waiveReason } : {}),
    }
  }

  async verify(input: VerifyInput): Promise<VerificationReport> {
    const prepared = await this.prepareVerification(input)
    const { request, destination, artifactFilesRoot, manifest } = prepared

    await mkdir(destination, { mode: 0o700 })
    let finalized = false
    try {
      const createdAt = new Date().toISOString()
      const reportPath = join(destination, REPORT_FILE)

      if (request.checks.length === 0) {
        const report = this.buildReport(request, 'not_required', [], createdAt)
        await persistReport(reportPath, report)
        finalized = true
        return report
      }

      const workspace = join(destination, WORKSPACE_DIRECTORY)
      await mkdir(workspace, { mode: 0o700 })
      await copyArtifactFiles(artifactFilesRoot, workspace, manifest.files)

      const results: VerificationCheckResult[] = []
      let state: VerificationState = 'passed'
      for (const check of request.checks) {
        const result = await runCheck(check, workspace)
        results.push(result)
        if (result.reason !== undefined || result.exitCode !== 0 || result.signal !== null) {
          state = 'failed'
          break
        }
      }

      const report = this.buildReport(request, state, results, createdAt)
      await persistReport(reportPath, report)
      finalized = true
      return report
    } finally {
      if (!finalized) {
        await rm(destination, { recursive: true, force: true })
      }
    }
  }

  async verifySupervised(
    input: VerifyInput,
    options: VerificationSupervisionOptions,
  ): Promise<SupervisedVerificationResult> {
    let supervision: VerificationSupervisionOptions
    try {
      supervision = parseSupervisionOptions(options)
    } catch {
      return { status: 'failed', terminalConfirmed: true, failureCode: 'INVALID_INPUT' }
    }

    if (supervision.signal.aborted) {
      return { status: 'cancelled', terminalConfirmed: true, failureCode: 'CANCELLED' }
    }

    let prepared: PreparedVerification
    try {
      prepared = await this.prepareVerification(input)
    } catch (error) {
      return { status: 'failed', terminalConfirmed: true, failureCode: classifyPreflightFailure(error) }
    }

    if (supervision.signal.aborted) {
      return { status: 'cancelled', terminalConfirmed: true, failureCode: 'CANCELLED' }
    }

    const { request, destination, artifactFilesRoot, manifest } = prepared
    let ownedProcessSeen = false

    try {
      await mkdir(destination, { mode: 0o700 })
      const createdAt = new Date().toISOString()
      const reportPath = join(destination, REPORT_FILE)

      if (request.checks.length === 0) {
        if (supervision.signal.aborted) {
          return { status: 'cancelled', terminalConfirmed: true, failureCode: 'CANCELLED' }
        }
        const report = this.buildReport(request, 'not_required', [], createdAt)
        try {
          await persistReport(reportPath, report)
        } catch {
          return { status: 'failed', terminalConfirmed: true, failureCode: 'REPORT_PERSIST_FAILED' }
        }
        if (supervision.signal.aborted) {
          return { status: 'cancelled', terminalConfirmed: true, failureCode: 'CANCELLED' }
        }
        return { status: 'completed', terminalConfirmed: true, report }
      }

      if (supervision.signal.aborted) {
        return { status: 'cancelled', terminalConfirmed: true, failureCode: 'CANCELLED' }
      }

      const workspace = join(destination, WORKSPACE_DIRECTORY)
      await mkdir(workspace, { mode: 0o700 })
      await copyArtifactFiles(artifactFilesRoot, workspace, manifest.files)

      if (supervision.signal.aborted) {
        return { status: 'cancelled', terminalConfirmed: true, failureCode: 'CANCELLED' }
      }

      const results: VerificationCheckResult[] = []
      let state: VerificationState = 'passed'
      // Supervised aggregate output is bounded to 1MiB total across checks (legacy remains per-check).
      let remainingOutputBytes = MAX_OUTPUT_BYTES

      for (const check of request.checks) {
        if (supervision.signal.aborted) {
          return { status: 'cancelled', terminalConfirmed: true, failureCode: 'CANCELLED' }
        }

        const outcome = await runOwnedCheck(check, workspace, {
          awaitStartupConfirmation: true,
          signal: supervision.signal,
          maxOutputBytes: remainingOutputBytes,
          ...(supervision.onProcess ? { onProcess: supervision.onProcess } : {}),
        })
        if (outcome.result !== undefined) ownedProcessSeen = true

        if (outcome.status === 'unknown') {
          return {
            status: 'unknown',
            terminalConfirmed: false,
            failureCode: outcome.failureCode,
          }
        }

        if (outcome.status === 'cancelled') {
          return { status: 'cancelled', terminalConfirmed: true, failureCode: 'CANCELLED' }
        }

        if (outcome.status === 'callback_failed') {
          return { status: 'failed', terminalConfirmed: true, failureCode: 'PROCESS_CALLBACK_FAILED' }
        }

        if (outcome.status === 'infrastructure_failed') {
          return {
            status: 'failed',
            terminalConfirmed: true,
            failureCode: outcome.failureCode,
          }
        }

        results.push(outcome.result)
        // Debit raw accepted bytes only — redacted report strings compress/expand and must not drive the budget.
        remainingOutputBytes = Math.max(0, remainingOutputBytes - outcome.acceptedOutputBytes)
        if (outcome.result.reason !== undefined || outcome.result.exitCode !== 0 || outcome.result.signal !== null) {
          state = 'failed'
          break
        }
      }

      if (supervision.signal.aborted) {
        return { status: 'cancelled', terminalConfirmed: true, failureCode: 'CANCELLED' }
      }

      const report = this.buildReport(request, state, results, createdAt)
      try {
        await persistReport(reportPath, report)
      } catch {
        return { status: 'failed', terminalConfirmed: true, failureCode: 'REPORT_PERSIST_FAILED' }
      }

      if (supervision.signal.aborted) {
        return { status: 'cancelled', terminalConfirmed: true, failureCode: 'CANCELLED' }
      }

      return { status: 'completed', terminalConfirmed: true, report }
    } catch (error) {
      if (ownedProcessSeen) {
        return {
          status: 'unknown',
          terminalConfirmed: false,
          failureCode: 'PROCESS_UNCONFIRMED',
        }
      }
      return {
        status: 'failed',
        terminalConfirmed: true,
        failureCode: classifyPreflightFailure(error),
      }
    }
    // Supervised mode retains partial evidence on the destination; never delete it here.
  }
}
