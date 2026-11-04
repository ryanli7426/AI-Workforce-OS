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
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workforce-verify-'))
  repository = join(root, 'repository')
  artifacts = join(root, 'artifacts')
  verifications = join(root, 'verifications')
  mkdirSync(repository)
  git('init', '--quiet')
  git('config', 'user.name', 'Verify Test')
  git('config', 'user.email', 'verify@example.test')
  writeFileSync(join(repository, 'hello.txt'), 'hello artifact\n')
  mkdirSync(join(repository, 'nested'))
  writeFileSync(join(repository, 'nested', 'note.txt'), 'nested\n')
  git('add', '--', 'hello.txt', 'nested/note.txt')
  git('commit', '--quiet', '-m', 'fixture')
  baseRevision = git('rev-parse', 'HEAD')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('LocalVerifier', () => {
  it('runs authorized checks against an artifact copy, persists a passed report, and leaves the artifact unchanged', async () => {
    writeFileSync(join(repository, 'hello.txt'), 'hello verified\n')
    const manifest = await captureArtifact()
    const original = readFileSync(join(artifacts, 'artifact-1', 'files', 'hello.txt'))
    const store = new ArtifactStore({ root: artifacts })
    const verifier = new LocalVerifier({ root: verifications, artifactStore: store })

    const report = await verifier.verify({
      verificationId: 'verify-1',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [{
        id: 'read-hello',
        command: process.execPath,
        args: ['-e', `
          const fs = require('node:fs');
          const text = fs.readFileSync('hello.txt', 'utf8');
          if (text !== 'hello verified\\n') throw new Error('unexpected content');
          fs.writeFileSync('hello.txt', 'mutated by check\\n');
          process.stdout.write('stdout-ok');
          process.stderr.write('stderr-ok');
        `],
        timeoutMs: 5_000,
      }],
    })

    expect(report.state).toBe('passed')
    expect(report.checks).toHaveLength(1)
    expect(report.checks[0]).toMatchObject({
      id: 'read-hello',
      exitCode: 0,
      signal: null,
      stdout: 'stdout-ok',
      stderr: 'stderr-ok',
    })
    expect(report.checks[0]?.reason).toBeUndefined()
    expect(readFileSync(join(artifacts, 'artifact-1', 'files', 'hello.txt'))).toEqual(original)
    expect(readFileSync(join(verifications, 'verify-1', 'workspace', 'hello.txt'), 'utf8')).toBe('mutated by check\n')
    const persisted = JSON.parse(readFileSync(join(verifications, 'verify-1', 'report.json'), 'utf8'))
    expect(persisted).toEqual(report)
    expect(lstatSync(join(verifications, 'verify-1', 'report.json')).mode & 0o777).toBe(0o600)
    expect(await store.verify('artifact-1')).toEqual(manifest)
  })

  it('stops at the first failed check and reports failed without running the remainder', async () => {
    const manifest = await captureArtifact()
    const marker = join(root, 'second-ran.txt')
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })

    const report = await verifier.verify({
      verificationId: 'verify-fail',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [
        {
          id: 'failing',
          command: process.execPath,
          args: ['-e', 'process.stdout.write("first"); process.exit(7)'],
          timeoutMs: 5_000,
        },
        {
          id: 'second',
          command: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
          timeoutMs: 5_000,
        },
      ],
    })

    expect(report.state).toBe('failed')
    expect(report.checks).toHaveLength(1)
    expect(report.checks[0]).toMatchObject({
      id: 'failing',
      exitCode: 7,
      stdout: 'first',
      reason: 'process exited with code 7',
    })
    expect(existsSync(marker)).toBe(false)
  })

  it('times out, kills the process group including descendants, and closes streams', async () => {
    const manifest = await captureArtifact()
    const pidFile = join(root, 'child-pids.txt')
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })

    const report = await verifier.verify({
      verificationId: 'verify-timeout',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [{
        id: 'hang',
        command: process.execPath,
        args: ['-e', `
          const { spawn } = require('node:child_process');
          const fs = require('node:fs');
          // Stay in the verifier-owned process group so timeout SIGKILL cleans descendants.
          const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
            detached: false,
            stdio: 'ignore',
          });
          fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid) + '\\n' + String(child.pid));
          setInterval(() => {}, 1000);
        `],
        timeoutMs: 300,
      }],
    })

    expect(report.state).toBe('failed')
    expect(report.checks).toHaveLength(1)
    expect(report.checks[0]?.reason).toMatch(/timed out|surviving process-group|descendant/i)
    expect(report.checks[0]?.durationMs).toBeGreaterThanOrEqual(250)
    const pids = readFileSync(pidFile, 'utf8').trim().split('\n').map(value => Number.parseInt(value, 10))
    expect(pids).toHaveLength(2)
    expect(pids.every(pid => Number.isInteger(pid))).toBe(true)
    const deadline = Date.now() + 3_000
    while (pids.some(alive) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    expect(pids.some(alive)).toBe(false)
  })

  it('bounds combined stdout/stderr output per check', async () => {
    const manifest = await captureArtifact()
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })

    const report = await verifier.verify({
      verificationId: 'verify-output',
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
    })

    expect(report.state).toBe('failed')
    expect(report.checks[0]?.reason).toMatch(/output limit exceeded|surviving process-group|timed out/i)
    const total = Buffer.byteLength(report.checks[0]?.stdout ?? '') + Buffer.byteLength(report.checks[0]?.stderr ?? '')
    expect(total).toBeLessThanOrEqual(1024 * 1024 + 8_192)
  })

  it('rejects unauthorized verification before launching checks', async () => {
    const manifest = await captureArtifact()
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })
    const marker = join(root, 'unauthorized-ran.txt')

    await expect(verifier.verify({
      verificationId: 'verify-unauth',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: false,
      checks: [{
        id: 'should-not-run',
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'no')`],
        timeoutMs: 5_000,
      }],
    })).rejects.toThrow(/authorized/)
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(verifications, 'verify-unauth'))).toBe(false)
  })

  it('rejects wrong artifact revision, wrong execution identity, relative commands, and tampered content before launching', async () => {
    const manifest = await captureArtifact()
    const store = new ArtifactStore({ root: artifacts })
    const verifier = new LocalVerifier({ root: verifications, artifactStore: store })
    const marker = join(root, 'wrong-rev-ran.txt')

    await expect(verifier.verify({
      verificationId: 'verify-wrong-rev',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: '0'.repeat(64),
      authorized: true,
      checks: [{
        id: 'should-not-run',
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'no')`],
        timeoutMs: 5_000,
      }],
    })).rejects.toThrow(/revision/)
    expect(existsSync(marker)).toBe(false)

    await expect(verifier.verify({
      verificationId: 'verify-wrong-exec',
      executionId: 'other-execution',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [{
        id: 'should-not-run',
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'no')`],
        timeoutMs: 5_000,
      }],
    })).rejects.toThrow(/execution identity/)
    expect(existsSync(marker)).toBe(false)

    await expect(verifier.verify({
      verificationId: 'verify-relative',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [{
        id: 'relative',
        command: 'node',
        args: ['-e', 'process.exit(0)'],
        timeoutMs: 5_000,
      }],
    })).rejects.toThrow(/absolute executable path/)
    expect(existsSync(join(verifications, 'verify-relative'))).toBe(false)

    writeFileSync(join(artifacts, 'artifact-1', 'files', 'hello.txt'), 'tampered\n')
    chmodSync(join(artifacts, 'artifact-1', 'files', 'hello.txt'), 0o644)
    await expect(verifier.verify({
      verificationId: 'verify-tamper',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [{
        id: 'should-not-run',
        command: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'no')`],
        timeoutMs: 5_000,
      }],
    })).rejects.toThrow(/verification failed|digest|match/i)
    expect(existsSync(marker)).toBe(false)
  })

  it('rejects empty checks without a waiver and returns not_required when waived', async () => {
    const manifest = await captureArtifact()
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })

    await expect(verifier.verify({
      verificationId: 'verify-empty',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [],
    })).rejects.toThrow(/waiveReason/)

    await expect(verifier.verify({
      verificationId: 'verify-blank-waiver',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [],
      waiveReason: ' \t\n ',
    })).rejects.toThrow(/waiveReason/)
    expect(existsSync(join(verifications, 'verify-blank-waiver'))).toBe(false)

    const report = await verifier.verify({
      verificationId: 'verify-waived',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [],
      waiveReason: 'policy allows skip for this fixture',
    })
    expect(report.state).toBe('not_required')
    expect(report.checks).toEqual([])
    expect(JSON.parse(readFileSync(join(verifications, 'verify-waived', 'report.json'), 'utf8'))).toEqual(report)
    expect(lstatSync(join(verifications, 'verify-waived', 'report.json')).mode & 0o777).toBe(0o600)
  })

  it('rejects symlink destinations, overlapping roots, and preexisting destinations', async () => {
    const manifest = await captureArtifact()
    const store = new ArtifactStore({ root: artifacts })

    const overlap = new LocalVerifier({ root: join(artifacts, 'nested-verify'), artifactStore: store })
    await expect(overlap.verify({
      verificationId: 'verify-overlap',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [],
      waiveReason: 'n/a',
    })).rejects.toThrow(/overlap/)

    mkdirSync(verifications, { recursive: true, mode: 0o700 })
    symlinkSync(join(root, 'elsewhere'), join(verifications, 'verify-link'))
    mkdirSync(join(root, 'elsewhere'))
    const linked = new LocalVerifier({ root: verifications, artifactStore: store })
    await expect(linked.verify({
      verificationId: 'verify-link',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [],
      waiveReason: 'n/a',
    })).rejects.toThrow(/already exists|symbolic link/i)

    mkdirSync(join(verifications, 'verify-exists'), { recursive: true })
    await expect(linked.verify({
      verificationId: 'verify-exists',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [],
      waiveReason: 'n/a',
    })).rejects.toThrow(/already exists/)
  })

  it('redacts credential-shaped check output', async () => {
    const manifest = await captureArtifact()
    const verifier = new LocalVerifier({
      root: verifications,
      artifactStore: new ArtifactStore({ root: artifacts }),
    })

    const report = await verifier.verify({
      verificationId: 'verify-redact',
      executionId: 'execution-1',
      artifactId: 'artifact-1',
      artifactRevision: manifest.revision,
      authorized: true,
      checks: [{
        id: 'secret-out',
        command: process.execPath,
        args: ['-e', 'process.stdout.write("token=sk-ant-api03-abcdefghijklmnopqrstuvwxyz");'],
        timeoutMs: 5_000,
      }],
    })

    expect(report.state).toBe('passed')
    expect(report.checks[0]?.stdout).toContain('[REDACTED]')
    expect(report.checks[0]?.stdout).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')
  })
})
