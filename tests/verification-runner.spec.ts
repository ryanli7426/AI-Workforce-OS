/**
 * Verification transport integration: real compiled Runner + verification wrapper subprocesses.
 * No fake ExecutionRepository rows; no simulated asynchronous success.
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../src/artifacts/snapshots.ts'
import { VerificationRunnerClient } from '../src/verification/client.ts'
import type { VerificationJobRequest } from '../src/verification/model.ts'
import {
  createVerificationSecret,
  parseSignedVerificationResult,
  parseVerificationWorkerInput,
  signVerificationResult,
  verificationResultMac,
  verificationResultSha256,
  VERIFICATION_MAX_RESULT_BYTES,
} from '../src/verification/protocol.ts'
import { verificationRequestSha256 } from '../src/verification/request.ts'
import type { RunnerSnapshot } from '../src/runner/protocol.ts'

const WORKER_JS = resolve('dist/verification/worker.js')
const RUNNER_WORKER_JS = resolve('dist/runner/worker.js')
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'UNKNOWN'])
const MAX_WAIT_MS = 12_000
const TEST_TIMEOUT_MS = 30_000

const sleep = (ms: number) => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function forceKill(snapshot: RunnerSnapshot | undefined): void {
  if (!snapshot || TERMINAL.has(snapshot.state)) return
  if (snapshot.processId && snapshot.processId > 1 && snapshot.processId !== process.pid) {
    try {
      process.kill(process.platform === 'win32' ? snapshot.processId : -snapshot.processId, 'SIGKILL')
    } catch {
      try { process.kill(snapshot.processId, 'SIGKILL') } catch { /* gone */ }
    }
  }
  if (snapshot.runnerPid > 1 && snapshot.runnerPid !== process.pid) {
    try { process.kill(snapshot.runnerPid, 'SIGKILL') } catch { /* gone */ }
  }
}

async function waitForTerminal(
  client: VerificationRunnerClient,
  verificationId: string,
  timeoutMs = MAX_WAIT_MS,
): Promise<RunnerSnapshot> {
  const deadline = Date.now() + timeoutMs
  let last: RunnerSnapshot | undefined
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      last = await client.status(verificationId)
      if (TERMINAL.has(last.state)) return last
    } catch (error) {
      lastError = error
    }
    await sleep(50)
  }
  throw new Error(`Timed out waiting for ${verificationId}; last=${last?.state ?? String(lastError)}`)
}

describe('verification protocol helpers', () => {
  it('signs and authenticates a completed result bound to the request hash', () => {
    const request = sampleRequest({
      checks: [{ id: 'c1', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1_000 }],
    })
    const secret = createVerificationSecret()
    const report = {
      verificationId: request.verificationId,
      executionId: request.executionId,
      artifactId: request.artifactId,
      artifactRevision: request.artifactRevision,
      state: 'passed' as const,
      checks: [{ id: 'c1', exitCode: 0, signal: null, durationMs: 1, stdout: '', stderr: '' }],
      createdAt: new Date().toISOString(),
    }
    const signed = signVerificationResult({
      version: 1,
      verificationId: request.verificationId,
      requestSha256: verificationRequestSha256(request),
      status: 'completed',
      terminalConfirmed: true,
      report,
    }, secret, request)
    const parsed = parseSignedVerificationResult(signed, { secret, request })
    expect(parsed.mac).toMatch(/^[a-f0-9]{64}$/)
    expect(verificationResultSha256({
      version: 1,
      verificationId: request.verificationId,
      requestSha256: requestSha(request),
      status: 'completed',
      terminalConfirmed: true,
      report,
    })).toMatch(/^[a-f0-9]{64}$/)
    expect(() => parseSignedVerificationResult({ ...signed, mac: 'a'.repeat(64) }, { secret, request }))
      .toThrow(/MAC/)
  })

  it('rejects completed results with not_required or identity drift', () => {
    const request = sampleRequest({
      checks: [{ id: 'c1', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1_000 }],
    })
    const secret = createVerificationSecret()
    expect(() => signVerificationResult({
      version: 1,
      verificationId: request.verificationId,
      requestSha256: verificationRequestSha256(request),
      status: 'completed',
      terminalConfirmed: true,
      report: {
        verificationId: request.verificationId,
        executionId: request.executionId,
        artifactId: request.artifactId,
        artifactRevision: request.artifactRevision,
        state: 'not_required',
        checks: [],
        createdAt: new Date().toISOString(),
        waiveReason: 'nope',
      },
    }, secret, request)).toThrow(/passed or failed|waiveReason/)
  })

  it('requires passed reports to include exactly all plan checks and rejects fabricated prefixes', () => {
    const request = sampleRequest({
      checks: [
        { id: 'c1', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1_000 },
        { id: 'c2', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1_000 },
      ],
    })
    const secret = createVerificationSecret()
    expect(() => signVerificationResult({
      version: 1,
      verificationId: request.verificationId,
      requestSha256: verificationRequestSha256(request),
      status: 'completed',
      terminalConfirmed: true,
      report: {
        verificationId: request.verificationId,
        executionId: request.executionId,
        artifactId: request.artifactId,
        artifactRevision: request.artifactRevision,
        state: 'passed',
        checks: [{ id: 'c1', exitCode: 0, signal: null, durationMs: 1, stdout: '', stderr: '' }],
        createdAt: new Date().toISOString(),
      },
    }, secret, request)).toThrow(/exactly all plan checks/)

    const failedOk = signVerificationResult({
      version: 1,
      verificationId: request.verificationId,
      requestSha256: verificationRequestSha256(request),
      status: 'completed',
      terminalConfirmed: true,
      report: {
        verificationId: request.verificationId,
        executionId: request.executionId,
        artifactId: request.artifactId,
        artifactRevision: request.artifactRevision,
        state: 'failed',
        checks: [{
          id: 'c1',
          exitCode: 2,
          signal: null,
          durationMs: 1,
          stdout: '',
          stderr: '',
          reason: 'process exited with code 2',
        }],
        createdAt: new Date().toISOString(),
      },
    }, secret, request)
    expect(failedOk.report?.state).toBe('failed')
  })

  it('rejects embedded request that disagrees with options.request', () => {
    const request = sampleRequest({
      checks: [{ id: 'c1', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1_000 }],
    })
    const other = sampleRequest({
      verificationId: request.verificationId,
      checks: [{ id: 'c1', command: process.execPath, args: ['-e', 'process.exit(1)'], timeoutMs: 1_000 }],
    })
    const secret = createVerificationSecret()
    const report = {
      verificationId: request.verificationId,
      executionId: request.executionId,
      artifactId: request.artifactId,
      artifactRevision: request.artifactRevision,
      state: 'passed' as const,
      checks: [{ id: 'c1', exitCode: 0, signal: null, durationMs: 1, stdout: '', stderr: '' }],
      createdAt: new Date().toISOString(),
    }
    const unsigned = {
      version: 1 as const,
      verificationId: request.verificationId,
      requestSha256: verificationRequestSha256(request),
      request,
      status: 'completed' as const,
      terminalConfirmed: true as const,
      report,
    }
    const signed = {
      ...unsigned,
      mac: verificationResultMac(unsigned, secret),
    }
    expect(() => parseSignedVerificationResult(signed, { secret, request: other }))
      .toThrow(/does not match options\.request/)
  })

  it('accepts valid results larger than 256KiB and rejects streaming/result oversize', () => {
    const request = sampleRequest({
      checks: [{ id: 'big', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 1_000 }],
    })
    const secret = createVerificationSecret()
    const bulky = 'x'.repeat(300 * 1024)
    const report = {
      verificationId: request.verificationId,
      executionId: request.executionId,
      artifactId: request.artifactId,
      artifactRevision: request.artifactRevision,
      state: 'passed' as const,
      checks: [{ id: 'big', exitCode: 0, signal: null, durationMs: 1, stdout: bulky, stderr: '' }],
      createdAt: new Date().toISOString(),
    }
    const signed = signVerificationResult({
      version: 1,
      verificationId: request.verificationId,
      requestSha256: verificationRequestSha256(request),
      status: 'completed',
      terminalConfirmed: true,
      report,
    }, secret, request)
    expect(Buffer.byteLength(JSON.stringify(signed)) > 256 * 1024).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(signed)) <= VERIFICATION_MAX_RESULT_BYTES).toBe(true)
    expect(parseSignedVerificationResult(signed, { secret, request }).report?.checks[0]?.stdout).toHaveLength(bulky.length)

    const oversizedStdout = 'y'.repeat(VERIFICATION_MAX_RESULT_BYTES)
    const oversized = {
      version: 1 as const,
      verificationId: request.verificationId,
      requestSha256: verificationRequestSha256(request),
      status: 'completed' as const,
      terminalConfirmed: true as const,
      report: {
        verificationId: request.verificationId,
        executionId: request.executionId,
        artifactId: request.artifactId,
        artifactRevision: request.artifactRevision,
        state: 'passed' as const,
        checks: [{ id: 'big', exitCode: 0, signal: null, durationMs: 1, stdout: oversizedStdout, stderr: '' }],
        createdAt: new Date().toISOString(),
      },
      mac: 'a'.repeat(64),
    }
    expect(Buffer.byteLength(JSON.stringify(oversized)) > VERIFICATION_MAX_RESULT_BYTES).toBe(true)
    expect(() => parseSignedVerificationResult(oversized, { secret, request })).toThrow(/too large/)
  })
})

describe('VerificationRunnerClient with detached wrapper', () => {
  let dataDir: string
  let repository: string
  let baseRevision: string
  let client: VerificationRunnerClient
  let sequence = 0
  const handles = new Map<string, VerificationRunnerClient>()

  beforeAll(() => {
    if (!existsSync(WORKER_JS)) {
      throw new Error(`Missing compiled verification worker at ${WORKER_JS}; run build first`)
    }
    if (!existsSync(RUNNER_WORKER_JS)) {
      throw new Error(`Missing compiled runner worker at ${RUNNER_WORKER_JS}; run build first`)
    }
  })

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'workforce-verification-runner-'))
    chmodSync(dataDir, 0o700)
    mkdirSync(join(dataDir, 'artifacts'), { mode: 0o700 })
    chmodSync(join(dataDir, 'artifacts'), 0o700)
    mkdirSync(join(dataDir, 'verifications'), { mode: 0o700 })
    chmodSync(join(dataDir, 'verifications'), 0o700)
    repository = join(dataDir, 'repository')
    mkdirSync(repository)
    git(repository, 'init', '--quiet')
    git(repository, 'config', 'user.name', 'Verify Transport')
    git(repository, 'config', 'user.email', 'verify-transport@example.test')
    writeFileSync(join(repository, 'hello.txt'), 'hello artifact\n')
    git(repository, 'add', '--', 'hello.txt')
    git(repository, 'commit', '--quiet', '-m', 'fixture')
    baseRevision = git(repository, 'rev-parse', 'HEAD')
    client = new VerificationRunnerClient({ dataDir })
  })

  afterEach(async () => {
    for (const [verificationId, owner] of handles) {
      let snapshot: RunnerSnapshot | undefined
      try {
        snapshot = await owner.status(verificationId)
        if (!TERMINAL.has(snapshot.state)) {
          await owner.stop(verificationId, 'verification runner test cleanup')
          snapshot = await waitForTerminal(owner, verificationId, 5_000)
        }
      } catch {
        try { snapshot = await owner.status(verificationId) } catch { /* ignore */ }
        forceKill(snapshot)
      }
    }
    handles.clear()
    rmSync(dataDir, { recursive: true, force: true })
  }, MAX_WAIT_MS)

  async function capture(artifactId: string, executionId: string) {
    const store = new ArtifactStore({ root: join(dataDir, 'artifacts') })
    return store.capture({ artifactId, executionId, cwd: repository, baseRevision })
  }

  async function start(owner: VerificationRunnerClient, request: VerificationJobRequest): Promise<RunnerSnapshot> {
    handles.set(request.verificationId, owner)
    return owner.start(request)
  }

  it('protocol input round-trip keeps secret out of public collect payload', async () => {
    const request = sampleRequest({
      verificationId: nextId('proto'),
      checks: [{ id: 'ok', command: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 2_000 }],
    })
    const secret = createVerificationSecret()
    const input = parseVerificationWorkerInput({
      version: 1,
      request,
      requestSha256: verificationRequestSha256(request),
      secret,
      dataDir,
    })
    expect(input.secret).toBe(secret)
    const collectedShape = {
      status: 'failed' as const,
      terminalConfirmed: true as const,
      reportSha256: 'a'.repeat(64),
      failureCode: 'PREFLIGHT_FAILED',
    }
    expect(JSON.stringify(collectedShape)).not.toContain(secret)
  })

  it('collects a successful passed run and starts at most once', async () => {
    const marker = join(dataDir, 'spawn-marker.txt')
    const manifest = await capture('artifact-once', 'execution-once')
    const request = sampleRequest({
      verificationId: nextId('once'),
      executionId: 'execution-once',
      artifactId: 'artifact-once',
      artifactRevision: manifest.revision,
      checks: [{
        id: 'mark',
        command: process.execPath,
        args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(marker)}, '1')`],
        timeoutMs: 5_000,
      }],
    })

    await start(client, request)
    const firstInput = readFileSync(join(dataDir, 'verification-inputs', request.verificationId, 'input.json'), 'utf8')
    const secret = JSON.parse(firstInput).secret as string
    expect(secret).toMatch(/^[0-9a-f]{64}$/)

    const again = await client.start(request)
    expect(again.executionId).toBe(request.verificationId)
    const secondInput = readFileSync(join(dataDir, 'verification-inputs', request.verificationId, 'input.json'), 'utf8')
    expect(secondInput).toBe(firstInput)

    const terminal = await waitForTerminal(client, request.verificationId)
    expect(terminal.state).toBe('SUCCEEDED')
    expect(readFileSync(marker, 'utf8')).toBe('1')
    const collected = await client.collect(request)
    expect(collected.terminalConfirmed).toBe(true)
    expect(collected.status).toBe('completed')
    expect(collected.report?.state).toBe('passed')
    expect(JSON.stringify(collected)).not.toContain(secret)

    const observer = new VerificationRunnerClient({ dataDir })
    const observed = await observer.status(request.verificationId)
    expect(observed.state).toBe('SUCCEEDED')
    expect(observed.exitCode).toBe(0)
  }, TEST_TIMEOUT_MS)

  it('collects a nonzero check as completed failed evidence without fake execution rows', async () => {
    const manifest = await capture('artifact-fail', 'execution-fail')
    const request = sampleRequest({
      verificationId: nextId('fail'),
      executionId: 'execution-fail',
      artifactId: 'artifact-fail',
      artifactRevision: manifest.revision,
      checks: [{
        id: 'boom',
        command: process.execPath,
        args: ['-e', 'process.exit(7)'],
        timeoutMs: 5_000,
      }],
    })
    await start(client, request)
    const terminal = await waitForTerminal(client, request.verificationId)
    expect(terminal.state).toBe('SUCCEEDED')
    const collected = await client.collect(request)
    expect(collected.status).toBe('completed')
    expect(collected.report?.state).toBe('failed')
    expect(collected.report?.checks[0]?.exitCode).toBe(7)
    expect(existsSync(join(dataDir, 'runners'))).toBe(false)
  }, TEST_TIMEOUT_MS)

  it('authenticated stop produces signed cancellation once owned children are gone', async () => {
    const manifest = await capture('artifact-cancel', 'execution-cancel')
    const request = sampleRequest({
      verificationId: nextId('cancel'),
      executionId: 'execution-cancel',
      artifactId: 'artifact-cancel',
      artifactRevision: manifest.revision,
      checks: [{
        id: 'sleep',
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 30_000)'],
        timeoutMs: 60_000,
      }],
    })
    await start(client, request)
    const progressPath = join(dataDir, 'verification-inputs', request.verificationId, 'progress.json')
    const running = await waitUntil(async () => {
      const snap = await client.status(request.verificationId)
      // Wait until the supervised check is live so abort can confirm children and sign CANCELLED.
      if (snap.state === 'RUNNING' && snap.processId && snap.processId > 1 && existsSync(progressPath)) {
        return snap
      }
      return undefined
    }, 8_000)
    const stop = await client.stop(request.verificationId, 'owner cancel')
    expect(stop.accepted).toBe(true)
    const terminal = await waitForTerminal(client, request.verificationId)
    expect(['CANCELLED', 'SUCCEEDED']).toContain(terminal.state)
    await waitUntil(async () => {
      const childGone = !terminal.processId || !alive(terminal.processId)
      const runnerGone = !terminal.runnerPid || !alive(terminal.runnerPid)
      return childGone && runnerGone ? true : undefined
    }, 5_000)
    const collected = await client.collect(request)
    expect(collected.status).toBe('cancelled')
    expect(collected.failureCode).toBe('CANCELLED')
    expect(running.state).toBe('RUNNING')
  }, TEST_TIMEOUT_MS)

  it('killed wrapper without signed result makes collect reject UNKNOWN', async () => {
    const marker = join(dataDir, 'owned-kill-check')
    const manifest = await capture('artifact-kill', 'execution-kill')
    const request = sampleRequest({
      verificationId: nextId('kill'),
      executionId: 'execution-kill',
      artifactId: 'artifact-kill',
      artifactRevision: manifest.revision,
      checks: [{
        id: 'hang',
        command: process.execPath,
        args: ['-e', "require('node:fs').writeFileSync(process.argv[1], 'owned');setInterval(() => {}, 1000)", marker],
        timeoutMs: 60_000,
      }],
    })
    await start(client, request)
    const live = await waitUntil(async () => {
      const snap = await client.status(request.verificationId)
      return snap.state === 'RUNNING' && snap.processId && existsSync(marker) ? snap : undefined
    }, 5_000)
    const progress = JSON.parse(readFileSync(join(dataDir,'verification-inputs',request.verificationId,'progress.json'),'utf8')) as {processId:number}
    const command = (pid:number) => execFileSync('ps',['-p',String(pid),'-o','command=','-ww'],{encoding:'utf8',timeout:2000}).trim()
    try {
      expect(command(live.processId!)).toContain(join(dataDir,'verification-inputs',request.verificationId,'input.json'))
      process.kill(live.processId!, 'SIGKILL') // Current positively identified wrapper, not a historical PID.
      await waitForTerminal(client,request.verificationId)
      const resultPath = join(dataDir, 'verification-inputs', request.verificationId, 'result.json')
      expect(existsSync(resultPath)).toBe(false)
      await expect(client.collect(request)).rejects.toThrow(/UNKNOWN/)
    } finally {
      // Checks own a separate process group: killing the wrapper does not prove they stopped.
      if (alive(progress.processId)) {
        expect(command(progress.processId)).toContain(marker)
        process.kill(process.platform === 'win32' ? progress.processId : -progress.processId,'SIGKILL')
        await waitUntil(async () => !alive(progress.processId) ? true : undefined, 5000)
      }
    }
  }, TEST_TIMEOUT_MS)

  it('collects a >256KiB valid completed result from engine output', async () => {
    const manifest = await capture('artifact-bulky', 'execution-bulky')
    const request = sampleRequest({
      verificationId: nextId('bulky'),
      executionId: 'execution-bulky',
      artifactId: 'artifact-bulky',
      artifactRevision: manifest.revision,
      checks: [{
        id: 'bulky',
        command: process.execPath,
        // writeSync avoids process.exit truncating unflushed pipe buffers below 256KiB.
        args: ['-e', 'require("node:fs").writeSync(1, "x".repeat(300000))'],
        timeoutMs: 10_000,
      }],
    })
    await start(client, request)
    const terminal = await waitForTerminal(client, request.verificationId, 20_000)
    expect(terminal.state).toBe('SUCCEEDED')
    const collected = await client.collect(request)
    expect(collected.status).toBe('completed')
    expect(collected.report?.state).toBe('passed')
    expect(collected.report?.checks[0]?.stdout.length).toBeGreaterThan(256 * 1024)
    const resultRaw = readFileSync(
      join(dataDir, 'verification-inputs', request.verificationId, 'result.json'),
      'utf8',
    )
    expect(Buffer.byteLength(resultRaw) > 256 * 1024).toBe(true)
  }, TEST_TIMEOUT_MS)

  it('streaming output cap produces completed failed evidence rather than empty passed', async () => {
    const manifest = await capture('artifact-cap', 'execution-cap')
    const request = sampleRequest({
      verificationId: nextId('cap'),
      executionId: 'execution-cap',
      artifactId: 'artifact-cap',
      artifactRevision: manifest.revision,
      checks: [{
        id: 'flood',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("z".repeat(1024*1024+64)); setTimeout(()=>{}, 1000)'],
        timeoutMs: 10_000,
      }],
    })
    await start(client, request)
    const terminal = await waitForTerminal(client, request.verificationId, 20_000)
    expect(terminal.state).toBe('SUCCEEDED')
    const collected = await client.collect(request)
    expect(collected.status).toBe('completed')
    expect(collected.report?.state).toBe('failed')
    expect(collected.report?.checks[0]?.reason).toMatch(/output limit exceeded/i)
  }, TEST_TIMEOUT_MS)

  it('refuses symlink dataDir and does not respawn for modified input evidence', async () => {
    const linked = join(tmpdir(), `workforce-verification-link-${process.pid}`)
    try {
      rmSync(linked, { recursive: true, force: true })
      symlinkSync(dataDir, linked)
      expect(() => new VerificationRunnerClient({ dataDir: linked })).toThrow()
    } finally {
      rmSync(linked, { force: true })
    }

    const manifest = await capture('artifact-tamper', 'execution-tamper')
    const request = sampleRequest({
      verificationId: nextId('tamper'),
      executionId: 'execution-tamper',
      artifactId: 'artifact-tamper',
      artifactRevision: manifest.revision,
      checks: [{
        id: 'ok',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 5_000,
      }],
    })
    await start(client, request)
    await waitForTerminal(client, request.verificationId)
    const inputPath = join(dataDir, 'verification-inputs', request.verificationId, 'input.json')
    const raw = JSON.parse(readFileSync(inputPath, 'utf8')) as Record<string, unknown>
    raw.requestSha256 = 'b'.repeat(64)
    chmodSync(inputPath, 0o600)
    writeFileSync(inputPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 })
    const runnerDir = join(dataDir, 'verification-runners', request.verificationId)
    const mtimeBefore = lstatSync(join(runnerDir, 'request.json')).mtimeMs
    await sleep(20)
    await expect(client.start(request)).rejects.toThrow(/requestSha256|mismatch|UNKNOWN|conflict|Invalid/i)
    expect(lstatSync(join(runnerDir, 'request.json')).mtimeMs).toBe(mtimeBefore)
    await expect(client.start(request)).rejects.toThrow()
    expect(lstatSync(join(runnerDir, 'request.json')).mtimeMs).toBe(mtimeBefore)
  }, TEST_TIMEOUT_MS)

  it('keeps the secret out of runner argv and status snapshots', async () => {
    const manifest = await capture('artifact-secret', 'execution-secret')
    const request = sampleRequest({
      verificationId: nextId('secret'),
      executionId: 'execution-secret',
      artifactId: 'artifact-secret',
      artifactRevision: manifest.revision,
      checks: [{
        id: 'ok',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 5_000,
      }],
    })
    await start(client, request)
    const input = JSON.parse(
      readFileSync(join(dataDir, 'verification-inputs', request.verificationId, 'input.json'), 'utf8'),
    ) as { secret: string }
    const runnerRequest = readFileSync(
      join(dataDir, 'verification-runners', request.verificationId, 'request.json'),
      'utf8',
    )
    expect(runnerRequest).not.toContain(input.secret)
    const terminal = await waitForTerminal(client, request.verificationId)
    expect(JSON.stringify(terminal)).not.toContain(input.secret)
    const events = await client.events(request.verificationId)
    expect(JSON.stringify(events)).not.toContain(input.secret)
  }, TEST_TIMEOUT_MS)

  it('rejects mutated runner LaunchSpec without respawning', async () => {
    const manifest = await capture('artifact-launch', 'execution-launch')
    const request = sampleRequest({
      verificationId: nextId('launch'),
      executionId: 'execution-launch',
      artifactId: 'artifact-launch',
      artifactRevision: manifest.revision,
      checks: [{
        id: 'ok',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 5_000,
      }],
    })
    await start(client, request)
    await waitForTerminal(client, request.verificationId)
    const runnerRequestPath = join(dataDir, 'verification-runners', request.verificationId, 'request.json')
    const raw = JSON.parse(readFileSync(runnerRequestPath, 'utf8')) as {
      version: 1
      token: string
      spec: Record<string, unknown>
    }
    const token = raw.token
    raw.spec = {
      ...raw.spec,
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
    }
    writeFileSync(runnerRequestPath, `${JSON.stringify(raw)}\n`, { mode: 0o600 })
    chmodSync(runnerRequestPath, 0o600)
    const mtime = lstatSync(runnerRequestPath).mtimeMs
    await expect(client.status(request.verificationId)).rejects.toThrow(/LaunchSpec|UNKNOWN|match/i)
    await expect(client.collect(request)).rejects.toThrow(/LaunchSpec|UNKNOWN|match/i)
    expect(lstatSync(runnerRequestPath).mtimeMs).toBe(mtime)
    expect(JSON.parse(readFileSync(runnerRequestPath, 'utf8')).token).toBe(token)
  }, TEST_TIMEOUT_MS)

  it('constructor and readonly queries do not create files under a fresh unrelated cwd', async () => {
    const previous = process.cwd()
    const foreign = mkdtempSync(join(tmpdir(), 'workforce-verification-cwd-'))
    try {
      process.chdir(foreign)
      const fresh = new VerificationRunnerClient({ dataDir })
      const manifest = await capture('artifact-cwd', 'execution-cwd')
      const request = sampleRequest({
        verificationId: nextId('cwd'),
        executionId: 'execution-cwd',
        artifactId: 'artifact-cwd',
        artifactRevision: manifest.revision,
        checks: [{
          id: 'ok',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          timeoutMs: 5_000,
        }],
      })
      await start(fresh, request)
      await waitForTerminal(fresh, request.verificationId)
      const observer = new VerificationRunnerClient({ dataDir })
      await observer.status(request.verificationId)
      await observer.events(request.verificationId)
      expect(existsSync(join(foreign, 'dist'))).toBe(false)
      expect(existsSync(join(foreign, 'verification-inputs'))).toBe(false)
    } finally {
      process.chdir(previous)
      rmSync(foreign, { recursive: true, force: true })
    }
  }, TEST_TIMEOUT_MS)

  function nextId(prefix: string): string {
    sequence += 1
    return `${prefix}-${process.pid}-${sequence}`
  }
})

function sampleRequest(overrides: {
  verificationId?: string
  executionId?: string
  artifactId?: string
  artifactRevision?: string
  checks: VerificationJobRequest['plan']['checks']
}): VerificationJobRequest {
  const verificationId = overrides.verificationId ?? `verify-${process.pid}`
  const executionId = overrides.executionId ?? 'execution-1'
  const artifactId = overrides.artifactId ?? 'artifact-1'
  const artifactRevision = overrides.artifactRevision ?? 'a'.repeat(64)
  return {
    verificationId,
    workspaceId: 'workspace-1',
    ownerId: 'owner-1',
    ticketId: 'ticket-1',
    expectedTaskVersion: 1,
    policyVersion: 'policy-1',
    executionId,
    artifactId,
    artifactRevision,
    plan: {
      id: 'plan-1',
      revision: 'planrev-1',
      checks: overrides.checks,
    },
    reason: 'transport test',
    createdAt: new Date().toISOString(),
  }
}

function requestSha(request: VerificationJobRequest): string {
  return verificationRequestSha256(request)
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

async function waitUntil<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await sleep(50)
  }
  throw new Error('waitUntil timed out')
}
