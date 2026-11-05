import { execFileSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ArtifactStore } from '../src/artifacts/snapshots.ts'
import { LocalVerifier } from '../src/verification/local-checks.ts'

let root: string
let repository: string
let artifacts: string
let verifications: string
let baseRevision: string

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim()
}

async function captureArtifact(artifactId = 'artifact-1', executionId = 'execution-1') {
  const store = new ArtifactStore({ root: artifacts })
  return store.capture({ artifactId, executionId, cwd: repository, baseRevision })
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  expect(predicate()).toBe(true)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workforce-verify-sup-'))
  repository = join(root, 'repository')
  artifacts = join(root, 'artifacts')
  verifications = join(root, 'verifications')
  mkdirSync(repository)
  git('init', '--quiet')
  git('config', 'user.name', 'Verify Supervision')
  git('config', 'user.email', 'verify-sup@example.test')
  writeFileSync(join(repository, 'hello.txt'), 'hello artifact\n')
  git('add', '--', 'hello.txt')
  git('commit', '--quiet', '-m', 'fixture')
  baseRevision = git('rev-parse', 'HEAD')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('LocalVerifier.verifySupervised', () => {
  it('returns cancelled before spawn when already aborted and leaves no marker', async () => {
    const manifest = await captureArtifact()
    const marker = join(root, 'pre-abort-ran.txt')
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })
    const controller = new AbortController()
    controller.abort()

    const result = await verifier.verifySupervised({
      verificationId: 'verify-pre-abort',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [{
        id: 'should-not-run',
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        timeoutMs: 5_000,
      }],
    }, { signal: controller.signal })

    expect(result).toEqual({
      status: 'cancelled',
      terminalConfirmed: true,
      failureCode: 'CANCELLED',
    })
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(verifications, 'verify-pre-abort'))).toBe(false)
  })

  it('completes with a passed report for a successful owned check', async () => {
    writeFileSync(join(repository, 'hello.txt'), 'hello supervised\n')
    const manifest = await captureArtifact()
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })
    const seen: Array<{ checkId: string; processId: number }> = []

    const result = await verifier.verifySupervised({
      verificationId: 'verify-pass',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [{
        id: 'read-hello',
        command: process.execPath,
        args: ['-e', `
          const fs = require('node:fs');
          if (fs.readFileSync('hello.txt', 'utf8') !== 'hello supervised\\n') process.exit(2);
          process.stdout.write('ok');
        `],
        timeoutMs: 5_000,
      }],
    }, {
      signal: new AbortController().signal,
      onProcess: info => { seen.push(info) },
    })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.terminalConfirmed).toBe(true)
    expect(result.report.state).toBe('passed')
    expect(result.report.checks).toHaveLength(1)
    expect(result.report.checks[0]).toMatchObject({
      id: 'read-hello',
      exitCode: 0,
      signal: null,
      stdout: 'ok',
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.checkId).toBe('read-hello')
    expect(Number.isInteger(seen[0]?.processId)).toBe(true)
    const persisted = JSON.parse(readFileSync(join(verifications, 'verify-pass', 'report.json'), 'utf8'))
    expect(persisted).toEqual(result.report)
    expect(lstatSync(join(verifications, 'verify-pass', 'report.json')).mode & 0o777).toBe(0o600)
  })

  it('treats nonzero exit with termination proof as completed failed, not supervisor failed', async () => {
    const manifest = await captureArtifact()
    const marker = join(root, 'second-supervised.txt')
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })

    const result = await verifier.verifySupervised({
      verificationId: 'verify-nonzero',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [
        {
          id: 'failing',
          command: process.execPath,
          args: ['-e', 'process.stdout.write("first"); process.exit(9)'],
          timeoutMs: 5_000,
        },
        {
          id: 'second',
          command: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
          timeoutMs: 5_000,
        },
      ],
    }, { signal: new AbortController().signal })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.report.state).toBe('failed')
    expect(result.report.checks).toHaveLength(1)
    expect(result.report.checks[0]).toMatchObject({
      id: 'failing',
      exitCode: 9,
      reason: 'process exited with code 9',
    })
    expect(existsSync(marker)).toBe(false)
  })

  it('aborts an in-flight owned check, confirms child termination, and skips later checks', async () => {
    const manifest = await captureArtifact()
    const marker = join(root, 'after-cancel.txt')
    const pidFile = join(root, 'inflight-pid.txt')
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })
    const controller = new AbortController()
    let childPid: number | undefined

    const pending = verifier.verifySupervised({
      verificationId: 'verify-inflight-abort',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [
        {
          id: 'hang',
          command: process.execPath,
          args: ['-e', `
            const fs = require('node:fs');
            fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
            setInterval(() => {}, 1000);
          `],
          timeoutMs: 30_000,
        },
        {
          id: 'second',
          command: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
          timeoutMs: 5_000,
        },
      ],
    }, {
      signal: controller.signal,
      onProcess: info => {
        childPid = info.processId
      },
    })

    await waitUntil(() => existsSync(pidFile))
    const recorded = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
    expect(recorded).toBe(childPid)
    expect(alive(recorded)).toBe(true)
    controller.abort()

    const result = await pending
    expect(result).toEqual({
      status: 'cancelled',
      terminalConfirmed: true,
      failureCode: 'CANCELLED',
    })
    await waitUntil(() => !alive(recorded))
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(verifications, 'verify-inflight-abort', 'workspace', 'hello.txt'))).toBe(true)
    expect(existsSync(join(verifications, 'verify-inflight-abort', 'report.json'))).toBe(false)
  })

  it('times out an owned check with confirmed termination as completed failed', async () => {
    const manifest = await captureArtifact()
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })

    const result = await verifier.verifySupervised({
      verificationId: 'verify-timeout-sup',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [{
        id: 'hang',
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        timeoutMs: 300,
      }],
    }, { signal: new AbortController().signal })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.report.state).toBe('failed')
    expect(result.report.checks[0]?.reason).toMatch(/timed out/i)
  })

  it('caps combined output and stops the owned process with a failed completed report', async () => {
    const manifest = await captureArtifact()
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })

    const result = await verifier.verifySupervised({
      verificationId: 'verify-output-sup',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [{
        id: 'flood',
        command: process.execPath,
        args: ['-e', `
          const chunk = Buffer.alloc(64 * 1024, 'x');
          for (let i = 0; i < 40; i++) {
            process.stdout.write(chunk);
            process.stderr.write(chunk);
          }
          setInterval(() => {}, 1000);
        `],
        timeoutMs: 5_000,
      }],
    }, { signal: new AbortController().signal })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.report.state).toBe('failed')
    expect(result.report.checks[0]?.reason).toMatch(/output limit exceeded/i)
    const total = Buffer.byteLength(result.report.checks[0]?.stdout ?? '')
      + Buffer.byteLength(result.report.checks[0]?.stderr ?? '')
    expect(total).toBeLessThanOrEqual(1024 * 1024 + 8_192)
  })

  it('stops and confirms the child when onProcess throws, without running later checks', async () => {
    const manifest = await captureArtifact()
    const marker = join(root, 'callback-next.txt')
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })
    let childPid: number | undefined

    const result = await verifier.verifySupervised({
      verificationId: 'verify-callback-fail',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [
        {
          id: 'hang',
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          timeoutMs: 30_000,
        },
        {
          id: 'second',
          command: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
          timeoutMs: 5_000,
        },
      ],
    }, {
      signal: new AbortController().signal,
      onProcess: info => {
        childPid = info.processId
        throw new Error('progress persistence failed')
      },
    })

    expect(result).toEqual({
      status: 'failed',
      terminalConfirmed: true,
      failureCode: 'PROCESS_CALLBACK_FAILED',
    })
    expect(childPid).toEqual(expect.any(Number))
    await waitUntil(() => childPid !== undefined && !alive(childPid))
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(verifications, 'verify-callback-fail', 'workspace'))).toBe(true)
    expect(existsSync(join(verifications, 'verify-callback-fail', 'report.json'))).toBe(false)
  })

  it('fails closed for missing artifact and invalid path before any process spawn', async () => {
    const manifest = await captureArtifact()
    const marker = join(root, 'missing-ran.txt')
    const store = new ArtifactStore({ root: artifacts })
    const verifier = new LocalVerifier({ root: verifications, artifactStore: store })

    const missing = await verifier.verifySupervised({
      verificationId: 'verify-missing-artifact',
      executionId: 'execution-1',
      artifactId: 'missing-artifact',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [{
        id: 'should-not-run',
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        timeoutMs: 5_000,
      }],
    }, { signal: new AbortController().signal })

    expect(missing.status).toBe('failed')
    expect(missing.terminalConfirmed).toBe(true)
    if (missing.status === 'failed') {
      expect(missing.failureCode).toMatch(/^(ARTIFACT_MISSING|SETUP_FAILED|INVALID_INPUT)$/)
    }
    expect(existsSync(marker)).toBe(false)

    const mismatched = await verifier.verifySupervised({
      verificationId: 'verify-bad-revision',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: '0'.repeat(64),
      authorized: true,
      checks: [{
        id: 'should-not-run',
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        timeoutMs: 5_000,
      }],
    }, { signal: new AbortController().signal })

    expect(mismatched).toEqual({
      status: 'failed',
      terminalConfirmed: true,
      failureCode: 'ARTIFACT_MISMATCH',
    })
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(verifications, 'verify-bad-revision'))).toBe(false)

    mkdirSync(verifications, { recursive: true, mode: 0o700 })
    mkdirSync(join(verifications, 'verify-exists'))
    const exists = await verifier.verifySupervised({
      verificationId: 'verify-exists',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [{
        id: 'should-not-run',
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        timeoutMs: 5_000,
      }],
    }, { signal: new AbortController().signal })
    expect(exists).toEqual({
      status: 'failed',
      terminalConfirmed: true,
      failureCode: 'INVALID_PATH',
    })
    expect(existsSync(marker)).toBe(false)
  })

  it('does not claim success when report persistence fails after checks', async () => {
    const manifest = await captureArtifact()
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })
    const reportPath = join(verifications, 'verify-persist-fail', 'report.json')

    const result = await verifier.verifySupervised({
      verificationId: 'verify-persist-fail',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [{
        id: 'ok',
        command: process.execPath,
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 5_000,
      }],
    }, {
      signal: new AbortController().signal,
      onProcess: () => {
        writeFileSync(reportPath, 'preexisting-partial\n', { mode: 0o600 })
      },
    })

    expect(result).toEqual({
      status: 'failed',
      terminalConfirmed: true,
      failureCode: 'REPORT_PERSIST_FAILED',
    })
    expect(readFileSync(reportPath, 'utf8')).toBe('preexisting-partial\n')
    expect(existsSync(join(verifications, 'verify-persist-fail', 'workspace'))).toBe(true)
  })

  it('retains partial evidence and returns unknown when process-group proof cannot be confirmed', async () => {
    const manifest = await captureArtifact()
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })
    const realKill = process.kill.bind(process)
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      // Pretend the owned process group remains observable; never signal historical PIDs.
      if (typeof pid === 'number' && pid < 0) {
        if (signal === 0) return true
        return true
      }
      return realKill(pid, signal as NodeJS.Signals)
    }) as typeof process.kill)

    try {
      const result = await verifier.verifySupervised({
        verificationId: 'verify-unknown-group',
        executionId: 'execution-1',
        artifactId: 'artifact-1',
        artifactRevision: manifest.revision,
        authorized: true,
        checks: [{
          id: 'quick',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          timeoutMs: 5_000,
        }],
      }, { signal: new AbortController().signal })

      expect(result.status).toBe('unknown')
      expect(result.terminalConfirmed).toBe(false)
      if (result.status === 'unknown') {
        expect(result.failureCode).toMatch(/^(PROCESS_GROUP_ALIVE|STREAM_UNCONFIRMED|PROCESS_UNCONFIRMED)$/)
      }
      expect(existsSync(join(verifications, 'verify-unknown-group', 'workspace'))).toBe(true)
      expect(existsSync(join(verifications, 'verify-unknown-group', 'report.json'))).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  it('rejects unauthorized input as supervisor failed without spawning', async () => {
    const manifest = await captureArtifact()
    const marker = join(root, 'unauth-sup.txt')
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })

    const result = await verifier.verifySupervised({
      verificationId: 'verify-unauth-sup',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: false,
      checks: [{
        id: 'should-not-run',
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        timeoutMs: 5_000,
      }],
    }, { signal: new AbortController().signal })

    expect(result).toEqual({
      status: 'failed',
      terminalConfirmed: true,
      failureCode: 'INVALID_INPUT',
    })
    expect(existsSync(marker)).toBe(false)
  })

  it('returns unknown when group is absent but exit and close events never arrive', async () => {
    const manifest = await captureArtifact()
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })
    const realKill = process.kill.bind(process)
    let childPid: number | undefined
    const spy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (typeof pid === 'number' && pid < 0) {
        if (signal === 0) {
          const error = new Error('ESRCH') as NodeJS.ErrnoException
          error.code = 'ESRCH'
          throw error
        }
        // Pretend group signals succeed without delivery so exit/close stay missing.
        return true
      }
      return realKill(pid, signal as NodeJS.Signals)
    }) as typeof process.kill)

    try {
      const result = await verifier.verifySupervised({
        verificationId: 'verify-missing-events',
        executionId: 'execution-1',
        artifactId: 'artifact-1',
        artifactRevision: manifest.revision,
        authorized: true,
        checks: [{
          id: 'hang',
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          timeoutMs: 30_000,
        }],
      }, {
        signal: new AbortController().signal,
        onProcess: info => {
          childPid = info.processId
          throw new Error('force termination path')
        },
      })

      expect(result.status).toBe('unknown')
      expect(result.terminalConfirmed).toBe(false)
      if (result.status === 'unknown') {
        expect(result.failureCode).toMatch(/^(STREAM_UNCONFIRMED|PROCESS_UNCONFIRMED|PROCESS_GROUP_ALIVE)$/)
      }
      expect(existsSync(join(verifications, 'verify-missing-events', 'workspace'))).toBe(true)
      expect(existsSync(join(verifications, 'verify-missing-events', 'report.json'))).toBe(false)
    } finally {
      spy.mockRestore()
      if (childPid !== undefined) {
        try { realKill(childPid, 'SIGKILL') } catch { /* test cleanup */ }
        try { realKill(-childPid, 'SIGKILL') } catch { /* test cleanup */ }
      }
    }
  })

  it('stops a never-resolving onProcess on caller abort without leaking the child', async () => {
    const manifest = await captureArtifact()
    const pidFile = join(root, 'callback-abort-pid.txt')
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })
    const controller = new AbortController()

    const pending = verifier.verifySupervised({
      verificationId: 'verify-callback-abort',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [{
        id: 'hang',
        command: process.execPath,
        args: ['-e', `
          const fs = require('node:fs');
          fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
          setInterval(() => {}, 1000);
        `],
        timeoutMs: 30_000,
      }],
    }, {
      signal: controller.signal,
      onProcess: () => new Promise(() => {}),
    })

    await waitUntil(() => existsSync(pidFile))
    const recorded = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
    expect(alive(recorded)).toBe(true)
    controller.abort()

    const result = await pending
    expect(result).toEqual({
      status: 'cancelled',
      terminalConfirmed: true,
      failureCode: 'CANCELLED',
    })
    await waitUntil(() => !alive(recorded))
  })

  it('stops a never-resolving onProcess on check timeout without leaking the child', async () => {
    const manifest = await captureArtifact()
    const pidFile = join(root, 'callback-timeout-pid.txt')
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })

    const pending = verifier.verifySupervised({
      verificationId: 'verify-callback-timeout',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [{
        id: 'hang',
        command: process.execPath,
        args: ['-e', `
          const fs = require('node:fs');
          fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
          setInterval(() => {}, 1000);
        `],
        timeoutMs: 400,
      }],
    }, {
      signal: new AbortController().signal,
      onProcess: () => new Promise(() => {}),
    })

    await waitUntil(() => existsSync(pidFile))
    const recorded = Number.parseInt(readFileSync(pidFile, 'utf8'), 10)
    expect(alive(recorded)).toBe(true)

    const result = await pending
    expect(result).toEqual({
      status: 'failed',
      terminalConfirmed: true,
      failureCode: 'CHECK_TIMEOUT',
    })
    await waitUntil(() => !alive(recorded))
  })

  it('bounds aggregate supervised output to 1MiB across checks, not per check', async () => {
    const manifest = await captureArtifact()
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })
    // writeSync avoids process.exit truncating buffered stdout before the parent observes it.
    const chunkScript = `
      const fs = require('node:fs');
      const chunk = Buffer.alloc(64 * 1024, 'x');
      for (let i = 0; i < 10; i++) fs.writeSync(1, chunk);
    `

    const result = await verifier.verifySupervised({
      verificationId: 'verify-aggregate-output',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [
        {
          id: 'first-flood',
          command: process.execPath,
          args: ['-e', `${chunkScript}; process.exit(0)`],
          timeoutMs: 5_000,
        },
        {
          id: 'second-flood',
          command: process.execPath,
          args: ['-e', `
            ${chunkScript}
            setInterval(() => {}, 1000);
          `],
          timeoutMs: 5_000,
        },
      ],
    }, { signal: new AbortController().signal })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.report.state).toBe('failed')
    expect(result.report.checks).toHaveLength(2)
    expect(result.report.checks[0]?.exitCode).toBe(0)
    expect(result.report.checks[0]?.reason).toBeUndefined()
    const firstBytes = Buffer.byteLength(result.report.checks[0]?.stdout ?? '')
      + Buffer.byteLength(result.report.checks[0]?.stderr ?? '')
    const secondBytes = Buffer.byteLength(result.report.checks[1]?.stdout ?? '')
      + Buffer.byteLength(result.report.checks[1]?.stderr ?? '')
    expect(firstBytes).toBeGreaterThan(512 * 1024)
    expect(firstBytes).toBeLessThan(1024 * 1024)
    expect(secondBytes).toBeLessThan(1024 * 1024)
    expect(firstBytes + secondBytes).toBeLessThanOrEqual(1024 * 1024 + 8_192)
    expect(result.report.checks[1]?.reason).toMatch(/output limit exceeded/i)
  }, 20_000)

  it('fails aggregate when two subcap token-like outputs exceed 1MiB raw, without emitting raw tokens', async () => {
    const manifest = await captureArtifact()
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })
    // Long Anthropic-shaped tokens redact to "[REDACTED]"; redacted sizes stay individually subcap
    // and would under-debit remainingOutputBytes if accounting used report strings.
    const token = `sk-ant-api03-${'A'.repeat(80)}`
    const tokenScript = `
      const fs = require('node:fs');
      const line = ${JSON.stringify(`${token}\n`)};
      const target = 600 * 1024;
      let written = 0;
      while (written < target) {
        fs.writeSync(1, line);
        written += Buffer.byteLength(line);
      }
      process.exit(0);
    `

    const result = await verifier.verifySupervised({
      verificationId: 'verify-aggregate-token-raw',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [
        {
          id: 'token-a',
          command: process.execPath,
          args: ['-e', tokenScript],
          timeoutMs: 10_000,
        },
        {
          id: 'token-b',
          command: process.execPath,
          args: ['-e', tokenScript],
          timeoutMs: 10_000,
        },
      ],
    }, { signal: new AbortController().signal })

    expect(result.status).toBe('completed')
    if (result.status !== 'completed') return
    expect(result.report.state).toBe('failed')
    expect(result.report.checks).toHaveLength(2)
    expect(result.report.checks[0]?.exitCode).toBe(0)
    expect(result.report.checks[0]?.reason).toBeUndefined()
    const firstRedacted = Buffer.byteLength(result.report.checks[0]?.stdout ?? '')
      + Buffer.byteLength(result.report.checks[0]?.stderr ?? '')
    const secondRedacted = Buffer.byteLength(result.report.checks[1]?.stdout ?? '')
      + Buffer.byteLength(result.report.checks[1]?.stderr ?? '')
    expect(firstRedacted).toBeLessThan(1024 * 1024)
    expect(secondRedacted).toBeLessThan(1024 * 1024)
    expect(firstRedacted + secondRedacted).toBeLessThan(1024 * 1024)
    expect(result.report.checks[1]?.reason).toMatch(/output limit exceeded/i)
    const reportJson = JSON.stringify(result.report)
    expect(reportJson).not.toContain(token)
    expect(reportJson).not.toContain('sk-ant-api03-')
  }, 20_000)
})
