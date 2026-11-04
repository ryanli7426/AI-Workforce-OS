/** Detached Runner client: private-file handshake, idempotent start, validated observe/stop. */
import { RUNTIME_ENV_CHANNEL, validateRuntimeEnvironment } from './environment.ts'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXECUTION_STATES, TERMINAL_EXECUTION_STATES, type ExecutionState } from '../execution/model.ts'
import {
  assertExecutionId,
  validateLaunchSpec,
  type LaunchSpec,
  type RunnerEvent,
  type RunnerRequest,
  type RunnerSnapshot,
  type StopRequest,
} from './protocol.ts'

const HANDSHAKE_MS = 5_000
const DEFAULT_STALE_AFTER_MS = 2_000
const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

export interface RunnerClientOptions {
  root: string
  workerPath?: string
  staleAfterMs?: number
  /** Trusted application secret provider output, passed through process environment only. */
  runtimeEnvironment?: Record<string, string>
}

export class RunnerClient {
  readonly #root: string
  readonly #workerPath: string
  readonly #runtimeEnvironment: Record<string, string>
  readonly #staleAfterMs: number

  constructor(options: RunnerClientOptions) {
    if (!options || typeof options.root !== 'string' || !options.root.trim()) throw new Error('Invalid runner root')
    if (!isAbsolute(options.root)) throw new Error('Runner root must be absolute')
    this.#root = resolve(options.root)
    this.#workerPath = options.workerPath != null
      ? resolve(options.workerPath)
      : join(dirname(fileURLToPath(import.meta.url)), 'worker.js')
    const stale = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
    if (!Number.isSafeInteger(stale) || stale < 1) throw new Error('Invalid staleAfterMs')
    this.#staleAfterMs = stale
    this.#runtimeEnvironment = validateRuntimeEnvironment(options.runtimeEnvironment ?? {})
  }

  async start(spec: LaunchSpec): Promise<RunnerSnapshot> {
    validateLaunchSpec(spec)
    const cwd = lstatSync(spec.cwd)
    if (!cwd.isDirectory() || cwd.isSymbolicLink()) throw new Error('Launch cwd must be a real directory')
    this.#ensurePrivateRoot()
    const dir = this.#executionDir(spec.executionId)
    try {
      mkdirSync(dir, { mode: PRIVATE_DIR_MODE })
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      return this.#resumeExisting(dir, spec)
    }
    chmodSync(dir, PRIVATE_DIR_MODE)
    this.#assertRealDir(dir)
    this.#assertInsideRoot(dir)

    const token = randomBytes(32).toString('hex')
    const request: RunnerRequest = { version: 1, token, spec: cloneSpec(spec) }
    writeOwnedFile(join(dir, 'request.json'), `${JSON.stringify(request)}\n`)

    try {
      await this.#spawnWorker(join(dir, 'request.json'))
    } catch (error) {
      throw unknownError(`Worker spawn failed: ${errorMessage(error)}`)
    }

    const snapshot = await this.#waitForFirstState(dir, request)
    if (!snapshot) throw unknownError('Handshake timed out waiting for runner state')
    return snapshot
  }

  async status(executionId: string): Promise<RunnerSnapshot> {
    assertExecutionId(executionId)
    this.#ensurePrivateRoot()
    const dir = this.#executionDir(executionId)
    this.#assertExistingExecutionDir(dir)
    const request = this.#readRequest(dir)
    if (request.spec.executionId !== executionId) throw unknownError('Request execution identity mismatch')
    const snapshot = this.#readSnapshot(dir, request)
    return this.#observe(snapshot)
  }

  async stop(executionId: string, reason: string): Promise<{ accepted: boolean; detail?: string }> {
    assertExecutionId(executionId)
    if (typeof reason !== 'string' || !reason.trim() || reason.includes('\0')) throw new Error('Invalid stop reason')
    this.#ensurePrivateRoot()
    const dir = this.#executionDir(executionId)
    this.#assertExistingExecutionDir(dir)
    const request = this.#readRequest(dir)
    if (request.spec.executionId !== executionId) throw unknownError('Request execution identity mismatch')

    let snapshot: RunnerSnapshot
    try {
      snapshot = this.#readSnapshot(dir, request)
    } catch (error) {
      return { accepted: false, detail: `UNKNOWN: ${errorMessage(error)}; must reconcile` }
    }

    if (isTerminal(snapshot.state)) return { accepted: false, detail: 'already finished' }

    const observed = this.#observe(snapshot)
    if (observed.state === 'UNKNOWN' || !isFresh(snapshot, this.#staleAfterMs) || !runnerProcessAlive(snapshot.runnerPid)) {
      return { accepted: false, detail: 'UNKNOWN: runner not live/fresh; must reconcile' }
    }

    const stop: StopRequest = { version: 1, token: request.token, reason }
    atomicWriteOwned(join(dir, 'stop.json'), `${JSON.stringify(stop)}\n`)
    return { accepted: true }
  }

  async events(executionId: string, afterSequence = 0): Promise<RunnerEvent[]> {
    assertExecutionId(executionId)
    if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) throw new Error('Invalid afterSequence')
    this.#ensurePrivateRoot()
    const dir = this.#executionDir(executionId)
    this.#assertExistingExecutionDir(dir)
    const request = this.#readRequest(dir)
    if (request.spec.executionId !== executionId) throw unknownError('Request execution identity mismatch')

    const path = join(dir, 'events.jsonl')
    if (!existsSync(path)) return []
    assertOwnedFile(path)
    const raw = readFileSync(path, 'utf8')
    if (raw.length === 0) return []

    const endsWithNewline = raw.endsWith('\n')
    const parts = raw.split('\n')
    if (endsWithNewline) parts.pop()
    else if (parts.length > 0) parts.pop() // ignore one trailing incomplete line

    const events: RunnerEvent[] = []
    let expected = 1
    for (const line of parts) {
      if (line.length === 0) throw new Error('Malformed events.jsonl: empty completed line')
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        throw new Error('Malformed events.jsonl: invalid JSON in completed line')
      }
      const event = validateEvent(parsed, request)
      if (event.sequence !== expected) throw new Error(`Malformed events.jsonl: expected sequence ${expected}`)
      expected += 1
      events.push(event)
    }
    if (new Set(events.map(event => event.runnerId)).size > 1) throw unknownError('Event runner identity changed')
    return events.filter(event => event.sequence > afterSequence)
  }

  #executionDir(executionId: string): string {
    assertExecutionId(executionId)
    return join(this.#root, executionId)
  }

  #ensurePrivateRoot(): void {
    if (!existsSync(this.#root)) {
      mkdirSync(this.#root, { recursive: true, mode: PRIVATE_DIR_MODE })
      chmodSync(this.#root, PRIVATE_DIR_MODE)
      this.#assertRealDir(this.#root)
      return
    }
    const entry = lstatSync(this.#root)
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Runner root must be a real directory')
    if (process.platform !== 'win32' && (entry.mode & 0o077) !== 0) {
      throw new Error('Existing runner root must be private (0700); choose a dedicated directory')
    }
    this.#assertRealDir(this.#root)
  }

  #assertExistingExecutionDir(dir: string): void {
    if (!existsSync(dir)) throw unknownError('Execution directory missing')
    this.#assertRealDir(dir)
    this.#assertInsideRoot(dir)
  }

  #assertRealDir(path: string): void {
    const entry = lstatSync(path)
    if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error(`Refusing non-directory or symlink path: ${path}`)
    if (process.platform !== 'win32' && (entry.mode & 0o077) !== 0) {
      throw new Error(`Execution path must be private (0700): ${path}`)
    }
  }

  #assertInsideRoot(target: string): void {
    const realRoot = realpathSync(this.#root)
    const realTarget = realpathSync(target)
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      throw new Error('Execution path escapes runner root')
    }
  }

  #resumeExisting(dir: string, spec: LaunchSpec): Promise<RunnerSnapshot> {
    this.#assertRealDir(dir)
    this.#assertInsideRoot(dir)
    const requestPath = join(dir, 'request.json')
    const statePath = join(dir, 'state.json')
    if (!existsSync(requestPath) || !existsSync(statePath)) {
      throw unknownError('Existing execution directory missing request/state; never retry spawn')
    }
    const request = this.#readRequest(dir)
    if (stableSpec(request.spec) !== stableSpec(spec)) {
      throw new Error('Launch spec conflicts with existing execution request')
    }
    return this.status(spec.executionId)
  }

  #readRequest(dir: string): RunnerRequest {
    const path = join(dir, 'request.json')
    if (!existsSync(path)) throw unknownError('Missing request.json')
    assertOwnedFile(path)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      throw unknownError('Malformed request.json')
    }
    if (!parsed || typeof parsed !== 'object') throw unknownError('Malformed request.json')
    const value = parsed as Partial<RunnerRequest>
    if (value.version !== 1 || typeof value.token !== 'string' || !/^[0-9a-f]{64}$/.test(value.token)) {
      throw unknownError('Unrecognized request.json')
    }
    try {
      validateLaunchSpec(value.spec)
    } catch (error) {
      throw unknownError(`Invalid request spec: ${errorMessage(error)}`)
    }
    return { version: 1, token: value.token, spec: cloneSpec(value.spec) }
  }

  #readSnapshot(dir: string, request: RunnerRequest): RunnerSnapshot {
    const path = join(dir, 'state.json')
    if (!existsSync(path)) throw unknownError('Missing state.json')
    assertOwnedFile(path)
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      throw unknownError('Malformed state.json')
    }
    return validateSnapshot(parsed, request)
  }

  #observe(snapshot: RunnerSnapshot): RunnerSnapshot {
    if (isTerminal(snapshot.state)) return snapshot
    if (!isFresh(snapshot, this.#staleAfterMs) || !runnerProcessAlive(snapshot.runnerPid)) {
      return { ...snapshot, state: 'UNKNOWN', reason: snapshot.reason ?? 'stale heartbeat or missing runner pid' }
    }
    return snapshot
  }

  async #spawnWorker(requestPath: string): Promise<void> {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      USER: process.env.USER ?? '',
      LANG: process.env.LANG ?? 'C',
      TMPDIR: process.env.TMPDIR ?? '',
      [RUNTIME_ENV_CHANNEL]: JSON.stringify(this.#runtimeEnvironment),
    }
    const child = spawn(process.execPath, [this.#workerPath, '--request', requestPath], {
      detached: true,
      stdio: 'ignore',
      env,
    })
    await new Promise<void>((resolvePromise, reject) => {
      child.once('error', reject)
      child.once('spawn', () => resolvePromise())
    })
    child.unref()
  }

  async #waitForFirstState(dir: string, request: RunnerRequest): Promise<RunnerSnapshot | undefined> {
    const deadline = Date.now() + HANDSHAKE_MS
    const statePath = join(dir, 'state.json')
    while (Date.now() < deadline) {
      if (existsSync(statePath)) {
        assertOwnedFile(statePath)
        return this.#readSnapshot(dir, request)
      }
      await sleep(50)
    }
    return undefined
  }
}

function cloneSpec(spec: LaunchSpec): LaunchSpec {
  return {
    executionId: spec.executionId,
    assignmentId: spec.assignmentId,
    ticketId: spec.ticketId,
    generation: spec.generation,
    command: spec.command,
    args: [...spec.args],
    cwd: spec.cwd,
    timeoutMs: spec.timeoutMs,
    maxOutputBytes: spec.maxOutputBytes,
    graceMs: spec.graceMs,
  }
}

function stableSpec(spec: LaunchSpec): string {
  return JSON.stringify(cloneSpec(spec))
}

function isTerminal(state: ExecutionState): boolean {
  return (TERMINAL_EXECUTION_STATES as readonly string[]).includes(state)
}

function isFresh(snapshot: RunnerSnapshot, staleAfterMs: number): boolean {
  const at = Date.parse(snapshot.heartbeatAt)
  if (!Number.isFinite(at)) return false
  return Date.now() - at <= staleAfterMs
}

function runnerProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function validateSnapshot(value: unknown, request: RunnerRequest): RunnerSnapshot {
  if (!value || typeof value !== 'object') throw unknownError('Malformed state.json')
  const s = value as Partial<RunnerSnapshot>
  if (s.version !== 1) throw unknownError('Unrecognized state version')
  if (s.executionId !== request.spec.executionId) throw unknownError('State executionId mismatch')
  if (s.assignmentId !== request.spec.assignmentId) throw unknownError('State assignmentId mismatch')
  if (s.ticketId !== request.spec.ticketId) throw unknownError('State ticketId mismatch')
  if (s.generation !== request.spec.generation) throw unknownError('State generation mismatch')
  if (typeof s.runnerId !== 'string' || !s.runnerId.trim()) throw unknownError('Invalid state runnerId')
  if (!Number.isSafeInteger(s.runnerPid) || s.runnerPid! <= 1) throw unknownError('Invalid state runnerPid')
  if (s.processId !== undefined && (!Number.isSafeInteger(s.processId) || s.processId <= 1)) throw unknownError('Invalid state processId')
  if (typeof s.state !== 'string' || !(EXECUTION_STATES as readonly string[]).includes(s.state)) {
    throw unknownError('Unrecognized execution state')
  }
  if (typeof s.sequence !== 'number' || !Number.isSafeInteger(s.sequence) || s.sequence < 1) {
    throw unknownError('Invalid state sequence')
  }
  for (const field of ['startedAt', 'updatedAt', 'heartbeatAt'] as const) {
    const stamp = s[field]
    if (typeof stamp !== 'string' || !Number.isFinite(Date.parse(stamp))) throw unknownError(`Invalid state ${field}`)
  }
  if (s.finishedAt !== undefined && (typeof s.finishedAt !== 'string' || !Number.isFinite(Date.parse(s.finishedAt)))) {
    throw unknownError('Invalid state finishedAt')
  }
  if (s.exitCode !== undefined && s.exitCode !== null && !Number.isSafeInteger(s.exitCode)) {
    throw unknownError('Invalid state exitCode')
  }
  if (s.signal !== undefined && s.signal !== null && (typeof s.signal !== 'string' || !s.signal)) {
    throw unknownError('Invalid state signal')
  }
  if (s.reason !== undefined && typeof s.reason !== 'string') throw unknownError('Invalid state reason')
  if (typeof s.stdoutBytes !== 'number' || !Number.isSafeInteger(s.stdoutBytes) || s.stdoutBytes < 0) {
    throw unknownError('Invalid state stdoutBytes')
  }
  if (typeof s.stderrBytes !== 'number' || !Number.isSafeInteger(s.stderrBytes) || s.stderrBytes < 0) {
    throw unknownError('Invalid state stderrBytes')
  }
  return s as RunnerSnapshot
}

function validateEvent(value: unknown, request: RunnerRequest): RunnerEvent {
  const snapshot = validateSnapshot(value, request)
  if (!value || typeof value !== 'object' || typeof (value as { at?: unknown }).at !== 'string') {
    throw new Error('Malformed events.jsonl: missing at')
  }
  const at = (value as { at: string }).at
  if (!Number.isFinite(Date.parse(at))) throw new Error('Malformed events.jsonl: invalid at')
  return { ...snapshot, at }
}

function writeOwnedFile(path: string, contents: string): void {
  writeFileSync(path, contents, { mode: PRIVATE_FILE_MODE, flag: 'wx' })
  chmodSync(path, PRIVATE_FILE_MODE)
}

function atomicWriteOwned(path: string, contents: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
  writeFileSync(tmp, contents, { mode: PRIVATE_FILE_MODE, flag: 'wx' })
  chmodSync(tmp, PRIVATE_FILE_MODE)
  renameSync(tmp, path)
}

function assertOwnedFile(path: string): void {
  const entry = lstatSync(path)
  if (entry.isSymbolicLink()) throw new Error(`Refusing symlink owned file: ${path}`)
  if (!entry.isFile()) throw new Error(`Owned path is not a file: ${path}`)
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code: string }).code === 'EEXIST')
}

function unknownError(detail: string): Error {
  return new Error(`UNKNOWN: ${detail}`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
