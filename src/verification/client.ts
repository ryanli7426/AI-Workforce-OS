/**
 * Verification transport client: exclusive immutable input + generic Runner supervision.
 * Does not initialize database/settings; parent reserves/beginLaunch before start.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RunnerClient } from '../runner/client.ts'
import { validateLaunchSpec, type LaunchSpec, type RunnerEvent, type RunnerSnapshot } from '../runner/protocol.ts'
import { TERMINAL_EXECUTION_STATES, type ExecutionState } from '../execution/model.ts'
import type { VerificationJobRequest } from './model.ts'
import type { VerificationReport } from './local-checks.ts'
import {
  assertVerificationPrivateDir,
  collectFromSignedResult,
  createVerificationSecret,
  fsyncVerificationDirectory,
  parseSignedVerificationResult,
  parseVerificationWorkerInput,
  readVerificationPrivateFile,
  rejectVerificationSymlinkComponents,
  VERIFICATION_MAX_INPUT_BYTES,
  VERIFICATION_MAX_RESULT_BYTES,
  writeVerificationExclusiveJson,
  type CollectedVerificationResult,
  type VerificationWorkerInput,
} from './protocol.ts'
import { parseVerificationRequest, verificationCanonicalJson, verificationRequestSha256 } from './request.ts'

const PRIVATE_DIR_MODE = 0o700
const INPUT_FILE = 'input.json'
const RESULT_FILE = 'result.json'
const RUNNER_ROOT_NAME = 'verification-runners'
const INPUT_ROOT_NAME = 'verification-inputs'
const DEFAULT_GRACE_MS = 8_000
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const SETUP_OVERHEAD_MS = 60_000
const RUNNER_EXECUTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const RUNNER_TOKEN = /^[0-9a-f]{64}$/
const MODE_BITS = 0o7777

export interface VerificationRunnerClientOptions {
  dataDir: string
}

export class VerificationRunnerClient {
  readonly #dataDir: string
  readonly #runner: RunnerClient
  readonly #runnerRoot: string
  readonly #workerPath: string

  constructor(options: VerificationRunnerClientOptions) {
    if (!options || typeof options.dataDir !== 'string' || !options.dataDir.trim()) {
      throw new Error('Invalid verification dataDir')
    }
    if (!isAbsolute(options.dataDir)) throw new Error('Verification dataDir must be absolute')
    this.#dataDir = assertExistingPrivateDataDir(resolve(options.dataDir))
    this.#workerPath = resolveCompiledModule('verification/worker.js', 'verification worker')
    this.#runnerRoot = join(this.#dataDir, RUNNER_ROOT_NAME)
    this.#runner = new RunnerClient({
      root: this.#runnerRoot,
      workerPath: resolveCompiledModule('runner/worker.js', 'runner worker'),
      runtimeEnvironment: {},
    })
  }

  async start(request: VerificationJobRequest): Promise<RunnerSnapshot> {
    const parsed = parseVerificationRequest(request)
    assertRunnerCompatibleId(parsed.verificationId)
    const inputRoot = join(this.#dataDir, INPUT_ROOT_NAME)
    if (!existsSync(inputRoot)) {
      mkdirSync(inputRoot, { mode: PRIVATE_DIR_MODE })
      chmodSync(inputRoot, PRIVATE_DIR_MODE)
    }
    assertVerificationPrivateDir(inputRoot, 'verification input root')
    assertPathInside(this.#dataDir, inputRoot)
    const inputDir = this.#inputDir(parsed.verificationId)
    let created = false
    try {
      mkdirSync(inputDir, { mode: PRIVATE_DIR_MODE })
      created = true
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
    }

    if (!created) {
      return this.#observeExisting(parsed)
    }

    chmodSync(inputDir, PRIVATE_DIR_MODE)
    assertVerificationPrivateDir(inputDir, 'verification input directory')
    assertPathInside(this.#dataDir, inputDir)

    const secret = createVerificationSecret()
    const input: VerificationWorkerInput = {
      version: 1,
      request: parsed,
      requestSha256: verificationRequestSha256(parsed),
      secret,
      dataDir: this.#dataDir,
    }
    const inputPath = join(inputDir, INPUT_FILE)
    writeVerificationExclusiveJson(inputPath, input, VERIFICATION_MAX_INPUT_BYTES)
    fsyncVerificationDirectory(inputDir)

    try {
      return await this.#runner.start(this.#launchSpec(parsed, inputPath))
    } catch (error) {
      // Request directory already proves a launch attempt; never repair by spawning later.
      throw unknownError(`Verification runner start failed: ${errorMessage(error)}`)
    }
  }

  async status(verificationId: string): Promise<RunnerSnapshot> {
    assertRunnerCompatibleId(verificationId)
    const input = this.#readInput(verificationId)
    this.#assertRunnerLaunchBound(input)
    return this.#runner.status(verificationId)
  }

  async events(verificationId: string, afterSequence = 0): Promise<RunnerEvent[]> {
    assertRunnerCompatibleId(verificationId)
    const input = this.#readInput(verificationId)
    this.#assertRunnerLaunchBound(input)
    return this.#runner.events(verificationId, afterSequence)
  }

  async stop(verificationId: string, reason: string): Promise<{ accepted: boolean; detail?: string }> {
    assertRunnerCompatibleId(verificationId)
    const input = this.#readInput(verificationId)
    this.#assertRunnerLaunchBound(input)
    return this.#runner.stop(verificationId, reason)
  }

  async collect(request: VerificationJobRequest): Promise<CollectedVerificationResult> {
    const parsed = parseVerificationRequest(request)
    assertRunnerCompatibleId(parsed.verificationId)
    const input = this.#readInput(parsed.verificationId)
    if (verificationCanonicalJson(input.request) !== verificationCanonicalJson(parsed)) {
      throw unknownError('Verification collect request does not match immutable input')
    }
    if (input.requestSha256 !== verificationRequestSha256(parsed)) {
      throw unknownError('Verification collect requestSha256 mismatch')
    }
    this.#assertRunnerLaunchBound(input)

    let snapshot: RunnerSnapshot
    try {
      snapshot = await this.#runner.status(parsed.verificationId)
    } catch (error) {
      throw unknownError(`Verification runner status unavailable: ${errorMessage(error)}`)
    }

    if (snapshot.executionId !== parsed.verificationId || snapshot.assignmentId !== parsed.verificationId) {
      throw unknownError('Verification runner identity mismatch')
    }
    if (snapshot.ticketId !== parsed.ticketId) throw unknownError('Verification runner ticket mismatch')
    if (!isTerminal(snapshot.state)) throw unknownError('Verification runner is not terminal')
    if (snapshot.state === 'UNKNOWN' || snapshot.state === 'TIMED_OUT') {
      throw unknownError(`Verification runner ended without releasable proof (${snapshot.state})`)
    }

    const resultPath = join(this.#inputDir(parsed.verificationId), RESULT_FILE)
    if (!existsSync(resultPath)) {
      throw unknownError('Verification signed result missing')
    }

    let parsedResult: unknown
    try {
      parsedResult = JSON.parse(
        readVerificationPrivateFile(resultPath, VERIFICATION_MAX_RESULT_BYTES, 'verification result').toString('utf8'),
      )
    } catch (error) {
      throw unknownError(`Verification signed result is corrupt: ${errorMessage(error)}`)
    }

    let signed
    try {
      signed = parseSignedVerificationResult(parsedResult, { secret: input.secret, request: parsed })
    } catch (error) {
      throw unknownError(`Verification signed result rejected: ${errorMessage(error)}`)
    }

    assertRunnerResultConsistency(snapshot, signed.status)
    return collectFromSignedResult(signed)
  }

  #observeExisting(request: VerificationJobRequest): Promise<RunnerSnapshot> {
    const input = this.#readInput(request.verificationId)
    if (verificationCanonicalJson(input.request) !== verificationCanonicalJson(request)) {
      throw new Error('Verification input conflicts with existing immutable request')
    }
    if (input.requestSha256 !== verificationRequestSha256(request)) {
      throw new Error('Verification input requestSha256 conflicts with existing request')
    }
    this.#assertRunnerLaunchBound(input)
    try {
      return this.#runner.status(request.verificationId)
    } catch (error) {
      throw unknownError(`Existing verification input has no matching runner proof: ${errorMessage(error)}`)
    }
  }

  #readInput(verificationId: string): VerificationWorkerInput {
    const inputDir = this.#inputDir(verificationId)
    if (!existsSync(inputDir)) throw unknownError('Verification input directory missing')
    assertVerificationPrivateDir(inputDir, 'verification input directory')
    assertPathInside(this.#dataDir, inputDir)
    const inputPath = join(inputDir, INPUT_FILE)
    if (!existsSync(inputPath)) throw unknownError('Verification input.json missing')
    let parsed: unknown
    try {
      parsed = JSON.parse(
        readVerificationPrivateFile(inputPath, VERIFICATION_MAX_INPUT_BYTES, 'verification input').toString('utf8'),
      )
    } catch (error) {
      throw unknownError(`Verification input.json is corrupt: ${errorMessage(error)}`)
    }
    const input = parseVerificationWorkerInput(parsed)
    if (input.dataDir !== this.#dataDir) throw unknownError('Verification input dataDir mismatch')
    if (input.request.verificationId !== verificationId) throw unknownError('Verification input identity mismatch')
    return input
  }

  #inputDir(verificationId: string): string {
    return join(this.#dataDir, INPUT_ROOT_NAME, verificationId)
  }

  #launchSpec(request: VerificationJobRequest, inputPath: string): LaunchSpec {
    const timeoutMs = request.plan.checks.reduce((total, check) => total + check.timeoutMs, 0) + SETUP_OVERHEAD_MS
    return {
      executionId: request.verificationId,
      assignmentId: request.verificationId,
      ticketId: request.ticketId,
      generation: 1,
      command: process.execPath,
      args: [this.#workerPath, '--input', inputPath],
      cwd: this.#dataDir,
      timeoutMs: Math.max(timeoutMs, SETUP_OVERHEAD_MS),
      maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES,
      graceMs: DEFAULT_GRACE_MS,
    }
  }

  /**
   * Compare private runner request.json LaunchSpec to the immutable wrapper expectation.
   * Validates the authentication token format but never returns it.
   */
  #assertRunnerLaunchBound(input: VerificationWorkerInput): void {
    const expected = this.#launchSpec(input.request, join(this.#inputDir(input.request.verificationId), INPUT_FILE))
    const runnerDir = join(this.#runnerRoot, input.request.verificationId)
    if (!existsSync(runnerDir)) throw unknownError('Verification runner directory missing')
    assertVerificationPrivateDir(runnerDir, 'verification runner directory')
    assertPathInside(this.#dataDir, runnerDir)

    const requestPath = join(runnerDir, 'request.json')
    if (!existsSync(requestPath)) throw unknownError('Verification runner request.json missing')

    let parsed: unknown
    try {
      parsed = JSON.parse(
        readVerificationPrivateFile(requestPath, VERIFICATION_MAX_INPUT_BYTES, 'verification runner request').toString('utf8'),
      )
    } catch (error) {
      throw unknownError(`Verification runner request.json is corrupt: ${errorMessage(error)}`)
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw unknownError('Verification runner request.json is malformed')
    }
    const value = parsed as Record<string, unknown>
    if (value.version !== 1) throw unknownError('Verification runner request version mismatch')
    if (typeof value.token !== 'string' || !RUNNER_TOKEN.test(value.token)) {
      throw unknownError('Verification runner request token is invalid')
    }
    // Token validated privately; never expose it on public return paths.
    try {
      validateLaunchSpec(value.spec)
    } catch (error) {
      throw unknownError(`Verification runner request spec invalid: ${errorMessage(error)}`)
    }
    const actual = value.spec as LaunchSpec
    if (stableLaunchSpec(actual) !== stableLaunchSpec(expected)) {
      throw unknownError('Verification runner LaunchSpec does not match immutable wrapper expectation')
    }
  }
}

function stableLaunchSpec(spec: LaunchSpec): string {
  return JSON.stringify({
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
  })
}

function assertRunnerResultConsistency(
  snapshot: RunnerSnapshot,
  status: CollectedVerificationResult['status'],
): void {
  if (status === 'completed') {
    if (snapshot.state !== 'SUCCEEDED' || snapshot.exitCode !== 0 || snapshot.signal) {
      throw unknownError('Completed verification requires outer SUCCEEDED exit 0')
    }
    return
  }
  if (status === 'cancelled') {
    if (snapshot.state !== 'CANCELLED' && snapshot.state !== 'SUCCEEDED') {
      throw unknownError('Cancelled verification requires outer CANCELLED or cooperative SUCCEEDED')
    }
    if (snapshot.state === 'SUCCEEDED' && (snapshot.exitCode !== 0 || snapshot.signal)) {
      throw unknownError('Cancelled cooperative success requires clean exit proof')
    }
    return
  }
  if (snapshot.state !== 'SUCCEEDED' || snapshot.exitCode !== 0 || snapshot.signal) {
    throw unknownError('Failed verification requires outer SUCCEEDED envelope with infrastructure failure result')
  }
}

function assertExistingPrivateDataDir(path: string): string {
  rejectVerificationSymlinkComponents(path, false)
  if (!existsSync(path)) throw new Error('Verification dataDir must already exist')
  const entry = lstatSync(path)
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Verification dataDir must be a real directory')
  if (process.platform !== 'win32' && (entry.mode & MODE_BITS) !== PRIVATE_DIR_MODE) {
    throw new Error('Verification dataDir must be private (0700)')
  }
  if (typeof process.getuid === 'function' && entry.uid !== process.getuid()) {
    throw new Error('Verification dataDir must be owned by the current user')
  }
  return realpathSync(path)
}

function assertPathInside(parent: string, child: string): void {
  const realParent = realpathSync(parent)
  const realChild = realpathSync(child)
  const suffix = relative(realParent, realChild)
  if (suffix === '' || suffix.startsWith(`..${sep}`) || suffix === '..' || isAbsolute(suffix)) {
    throw new Error('Path escapes verification dataDir')
  }
}

function assertRunnerCompatibleId(id: string): void {
  if (!RUNNER_EXECUTION_ID.test(id)) {
    throw new Error('verificationId must be compatible with runner execution identity')
  }
}

/**
 * Resolve compiled modules from import.meta.url so any unrelated caller cwd works.
 * Preferred: sibling/neighbor under the same dist (or src) tree; fallback: package dist/.
 */
function resolveCompiledModule(packageRelative: string, label: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const baseName = packageRelative.split('/').pop()
  if (!baseName) throw new Error(`Compiled ${label} path is invalid`)

  const candidates = [
    // When this module is already under dist/verification/, sibling worker.js etc.
    packageRelative.startsWith('verification/')
      ? join(here, baseName)
      : join(here, '..', ...packageRelative.split('/')),
    // When loaded from src/verification/, fall back to package-root dist/.
    resolve(here, '..', '..', 'dist', ...packageRelative.split('/')),
    // When already under dist/verification/ but looking for dist/runner/*.
    resolve(here, '..', ...packageRelative.split('/')),
  ]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    rejectVerificationSymlinkComponents(candidate, false)
    const workerStat = lstatSync(candidate)
    if (workerStat.isSymbolicLink() || !workerStat.isFile()) continue
    return realpathSync(candidate)
  }
  throw new Error(`Compiled ${label} is missing`)
}

function isTerminal(state: ExecutionState): boolean {
  return (TERMINAL_EXECUTION_STATES as readonly string[]).includes(state) || state === 'UNKNOWN'
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

export type { CollectedVerificationResult, VerificationReport, RunnerSnapshot, RunnerEvent }
