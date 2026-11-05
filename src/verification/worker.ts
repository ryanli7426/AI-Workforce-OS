/**
 * Detached verification wrapper: supervised LocalVerifier under generic Runner process control.
 * Tools/network/database are absent; durable signed result.json is the only success proof.
 */
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ArtifactStore } from '../artifacts/snapshots.ts'
import {
  LocalVerifier,
  type SupervisedVerificationResult,
  type VerifyInput,
} from './local-checks.ts'
import {
  assertVerificationPrivateDir,
  fsyncVerificationDirectory,
  parseVerificationWorkerInput,
  readVerificationPrivateFile,
  rejectVerificationSymlinkComponents,
  signVerificationResult,
  VERIFICATION_MAX_INPUT_BYTES,
  VERIFICATION_MAX_PROGRESS_BYTES,
  VERIFICATION_MAX_RESULT_BYTES,
  writeVerificationAtomicJson,
  writeVerificationExclusiveJson,
  type VerificationWorkerInput,
} from './protocol.ts'

const PROGRESS_FILE = 'progress.json'
const RESULT_FILE = 'result.json'
const FAILURE_CODES = {
  PREFLIGHT_FAILED: 'PREFLIGHT_FAILED',
  UNKNOWN: 'UNKNOWN',
  CANCELLED: 'CANCELLED',
} as const

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return 'UNKNOWN'
}

function fail(message: string): never {
  throw new Error(message)
}

function assertPathInside(parent: string, child: string): void {
  const suffix = relative(parent, child)
  if (suffix.startsWith(`..${sep}`) || suffix === '..' || isAbsolute(suffix)) {
    fail('Path escapes trusted verification dataDir')
  }
}

function readWorkerInputFromPath(absolute: string, inputDir: string): { input: VerificationWorkerInput; inputDir: string } {
  const raw = readVerificationPrivateFile(absolute, VERIFICATION_MAX_INPUT_BYTES, 'verification worker input')
  const parsed: unknown = JSON.parse(raw.toString('utf8'))
  const input = parseVerificationWorkerInput(parsed)
  const dataDir = assertVerificationPrivateDir(input.dataDir, 'verification dataDir')
  assertPathInside(dataDir, inputDir)
  const expectedDir = join(dataDir, 'verification-inputs', input.request.verificationId)
  const trustedInputDir = assertVerificationPrivateDir(inputDir, 'verification input directory')
  const trustedExpected = assertVerificationPrivateDir(expectedDir, 'verification expected input directory')
  if (trustedExpected !== trustedInputDir) fail('Verification input directory identity mismatch')
  return { input: { ...input, dataDir }, inputDir: trustedInputDir }
}

function writeProgress(inputDir: string, record: { checkId: string; processId: number; at: string }): void {
  const path = join(inputDir, PROGRESS_FILE)
  writeVerificationAtomicJson(path, {
    checkId: record.checkId,
    processId: record.processId,
    at: record.at,
  }, VERIFICATION_MAX_PROGRESS_BYTES)
  fsyncVerificationDirectory(inputDir)
}

function writeSignedResult(inputDir: string, input: VerificationWorkerInput, result: Parameters<typeof signVerificationResult>[0]): void {
  const path = join(inputDir, RESULT_FILE)
  if (existsSync(path)) fail(`Refusing to overwrite existing verification result: ${path}`)
  writeVerificationExclusiveJson(
    path,
    signVerificationResult(result, input.secret, input.request),
    VERIFICATION_MAX_RESULT_BYTES,
  )
  fsyncVerificationDirectory(inputDir)
}

function publishTerminal(inputDir: string, input: VerificationWorkerInput, supervised: SupervisedVerificationResult): void {
  if (supervised.terminalConfirmed !== true) {
    fail(supervised.failureCode || FAILURE_CODES.UNKNOWN)
  }

  if (supervised.status === 'completed') {
    writeSignedResult(inputDir, input, {
      version: 1,
      verificationId: input.request.verificationId,
      requestSha256: input.requestSha256,
      status: 'completed',
      terminalConfirmed: true,
      report: supervised.report,
    })
    return
  }

  if (supervised.status === 'cancelled') {
    writeSignedResult(inputDir, input, {
      version: 1,
      verificationId: input.request.verificationId,
      requestSha256: input.requestSha256,
      status: 'cancelled',
      terminalConfirmed: true,
      failureCode: FAILURE_CODES.CANCELLED,
    })
    return
  }

  if (supervised.status === 'failed') {
    writeSignedResult(inputDir, input, {
      version: 1,
      verificationId: input.request.verificationId,
      requestSha256: input.requestSha256,
      status: 'failed',
      terminalConfirmed: true,
      failureCode: supervised.failureCode,
    })
    return
  }

  fail(FAILURE_CODES.UNKNOWN)
}

export async function runVerificationWorker(inputPath: string): Promise<void> {
  if (typeof inputPath !== 'string' || !inputPath.trim() || !isAbsolute(inputPath)) {
    fail('Verification worker input path must be absolute')
  }
  const absolute = resolve(inputPath)
  rejectVerificationSymlinkComponents(absolute, false)
  const parentDir = assertVerificationPrivateDir(dirname(absolute), 'verification input directory')
  const { input, inputDir } = readWorkerInputFromPath(absolute, parentDir)

  const artifactsRoot = join(input.dataDir, 'artifacts')
  assertVerificationPrivateDir(artifactsRoot, 'artifact root')
  const verificationsRoot = join(input.dataDir, 'verifications')
  if (existsSync(verificationsRoot)) {
    assertVerificationPrivateDir(verificationsRoot, 'verification root')
  }

  // Register cancellation signals before any awaitable engine/setup work.
  const abort = new AbortController()
  const onSignal = (): void => {
    abort.abort()
  }
  process.on('SIGTERM', onSignal)
  process.on('SIGINT', onSignal)

  let enteredEngine = false
  try {
    if (abort.signal.aborted) {
      writeSignedResult(inputDir, input, {
        version: 1,
        verificationId: input.request.verificationId,
        requestSha256: input.requestSha256,
        status: 'cancelled',
        terminalConfirmed: true,
        failureCode: FAILURE_CODES.CANCELLED,
      })
      return
    }

    let artifactStore: ArtifactStore
    let verifier: LocalVerifier
    try {
      artifactStore = new ArtifactStore({ root: artifactsRoot })
      verifier = new LocalVerifier({
        root: verificationsRoot,
        artifactStore,
      })
    } catch {
      // Known preflight failure before engine / no child phase: durable failed proof.
      writeSignedResult(inputDir, input, {
        version: 1,
        verificationId: input.request.verificationId,
        requestSha256: input.requestSha256,
        status: 'failed',
        terminalConfirmed: true,
        failureCode: FAILURE_CODES.PREFLIGHT_FAILED,
      })
      return
    }

    const verifyInput: VerifyInput = {
      verificationId: input.request.verificationId,
      executionId: input.request.executionId,
      artifactId: input.request.artifactId,
      artifactRevision: input.request.artifactRevision,
      checks: input.request.plan.checks.map(check => ({
        id: check.id,
        command: check.command,
        args: [...check.args],
        timeoutMs: check.timeoutMs,
      })),
      authorized: true,
    }

    enteredEngine = true
    const supervised = await verifier.verifySupervised(verifyInput, {
      signal: abort.signal,
      onProcess: async info => {
        if (typeof info.checkId !== 'string' || !info.checkId.trim()) fail('Invalid onProcess checkId')
        if (!Number.isSafeInteger(info.processId) || info.processId <= 1) fail('Invalid onProcess processId')
        writeProgress(inputDir, {
          checkId: info.checkId,
          processId: info.processId,
          at: new Date().toISOString(),
        })
      },
    })

    publishTerminal(inputDir, input, supervised)
  } catch (error) {
    // After invoking the engine, unexpected throws leave no signed result.
    // Do not infer terminalConfirmed from message regex.
    if (enteredEngine) throw error
    if (existsSync(join(inputDir, RESULT_FILE))) throw error
    try {
      writeSignedResult(inputDir, input, {
        version: 1,
        verificationId: input.request.verificationId,
        requestSha256: input.requestSha256,
        status: 'failed',
        terminalConfirmed: true,
        failureCode: FAILURE_CODES.PREFLIGHT_FAILED,
      })
      return
    } catch {
      throw error
    }
  } finally {
    process.off('SIGTERM', onSignal)
    process.off('SIGINT', onSignal)
  }
}

function mainInputPath(argv: string[]): string {
  if (argv.length !== 2 || argv[0] !== '--input' || !argv[1]) throw new Error('Usage: worker --input PATH')
  return argv[1]
}

const invokedPath = process.argv[1]
if (invokedPath && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  try {
    const inputPath = mainInputPath(process.argv.slice(2))
    runVerificationWorker(inputPath).catch(error => {
      console.error(`Verification worker failed (${errorCode(error)})`)
      process.exitCode = 1
    })
  } catch (error) {
    console.error(`Verification worker failed (${errorCode(error)})`)
    process.exitCode = 1
  }
}
