import {
  chmodSync,
  existsSync,
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
import { RunnerClient } from '../src/runner/client.ts'
import type { LaunchSpec, RunnerEvent, RunnerRequest, RunnerSnapshot } from '../src/runner/protocol.ts'

let root: string
const workers: number[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'runner-client-'))
  chmodSync(root, 0o700)
})

afterEach(() => {
  for (const pid of workers.splice(0)) {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
  rmSync(root, { recursive: true, force: true })
})

function spec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
  return {
    executionId: 'exec1',
    assignmentId: 'assign1',
    ticketId: 'ticket1',
    generation: 1,
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    cwd: root,
    timeoutMs: 5_000,
    maxOutputBytes: 64_000,
    graceMs: 200,
    ...overrides,
  }
}

function requestFor(launch: LaunchSpec, token = 'a'.repeat(64)): RunnerRequest {
  return { version: 1, token, spec: launch }
}

function snapshotFor(launch: LaunchSpec, overrides: Partial<RunnerSnapshot> = {}): RunnerSnapshot {
  const now = new Date().toISOString()
  return {
    version: 1,
    executionId: launch.executionId,
    assignmentId: launch.assignmentId,
    ticketId: launch.ticketId,
    generation: launch.generation,
    runnerId: 'runner-test',
    runnerPid: process.pid,
    state: 'RUNNING',
    sequence: 1,
    startedAt: now,
    updatedAt: now,
    heartbeatAt: now,
    stdoutBytes: 0,
    stderrBytes: 0,
    ...overrides,
  }
}

function seedExecution(launch: LaunchSpec, options: {
  state?: Partial<RunnerSnapshot>
  events?: RunnerEvent[]
  omitRequest?: boolean
  omitState?: boolean
  token?: string
} = {}): { dir: string; token: string } {
  const dir = join(root, launch.executionId)
  mkdirSync(dir, { mode: 0o700 })
  chmodSync(dir, 0o700)
  const token = options.token ?? 'b'.repeat(64)
  if (!options.omitRequest) {
    writeFileSync(join(dir, 'request.json'), `${JSON.stringify(requestFor(launch, token))}\n`, { mode: 0o600 })
  }
  if (!options.omitState) {
    writeFileSync(join(dir, 'state.json'), `${JSON.stringify(snapshotFor(launch, options.state))}\n`, { mode: 0o600 })
  }
  if (options.events) {
    writeFileSync(join(dir, 'events.jsonl'), `${options.events.map(e => JSON.stringify(e)).join('\n')}\n`, { mode: 0o600 })
  }
  return { dir, token }
}

function writeFakeWorker(path: string, behavior: 'running' | 'failed' | 'hang' = 'running'): void {
  const body = behavior === 'hang'
    ? `writeFileSync(join(dir, 'worker.pid'), String(process.pid));
setInterval(() => {}, 1000);
`
    : behavior === 'failed'
      ? `
const snap = base();
snap.state = 'FAILED';
snap.reason = 'fixture failure';
snap.exitCode = null;
snap.finishedAt = snap.updatedAt;
writeFileSync(statePath, JSON.stringify(snap) + '\\n', { mode: 0o600 });
`
      : `
const snap = base();
snap.state = 'RUNNING';
writeFileSync(statePath, JSON.stringify(snap) + '\\n', { mode: 0o600 });
setInterval(() => {
  snap.heartbeatAt = new Date().toISOString();
  snap.updatedAt = snap.heartbeatAt;
  writeFileSync(statePath, JSON.stringify(snap) + '\\n', { mode: 0o600 });
  try {
    const stop = JSON.parse(readFileSync(stopPath, 'utf8'));
    if (stop && stop.token === req.token) {
      snap.state = 'CANCELLED';
      snap.signal = 'SIGTERM';
      snap.finishedAt = snap.heartbeatAt;
      writeFileSync(statePath, JSON.stringify(snap) + '\\n', { mode: 0o600 });
      process.exit(0);
    }
  } catch {}
}, 50);
`
  writeFileSync(path, `import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const idx = process.argv.indexOf('--request');
if (idx < 0) throw new Error('missing --request');
const requestPath = process.argv[idx + 1];
const req = JSON.parse(readFileSync(requestPath, 'utf8'));
const dir = dirname(requestPath);
const statePath = join(dir, 'state.json');
const stopPath = join(dir, 'stop.json');
const base = () => ({
  version: 1,
  executionId: req.spec.executionId,
  assignmentId: req.spec.assignmentId,
  ticketId: req.spec.ticketId,
  generation: req.spec.generation,
  runnerId: 'fake-worker',
  runnerPid: process.pid,
  state: 'STARTING',
  sequence: 1,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  heartbeatAt: new Date().toISOString(),
  stdoutBytes: 0,
  stderrBytes: 0,
});
${body}
`, { mode: 0o600 })
}

describe('RunnerClient validation', () => {
  it('rejects unsafe ids, shared roots, and symlink roots', async () => {
    const client = new RunnerClient({ root, workerPath: join(root, 'missing-worker.js') })
    await expect(client.start(spec({ executionId: '../escape' }))).rejects.toThrow(/Invalid execution ID/)
    await expect(client.start(spec({ executionId: 'bad/id' }))).rejects.toThrow(/Invalid execution ID/)

    chmodSync(root, 0o755)
    await expect(client.start(spec())).rejects.toThrow(/private \(0700\)/)
    chmodSync(root, 0o700)

    const linked = join(root, 'link-root')
    const real = mkdtempSync(join(tmpdir(), 'runner-link-target-'))
    chmodSync(real, 0o700)
    try {
      symlinkSync(real, linked)
      const linkedClient = new RunnerClient({ root: linked, workerPath: join(root, 'missing-worker.js') })
      await expect(linkedClient.start(spec())).rejects.toThrow(/real directory/)
    } finally {
      rmSync(real, { recursive: true, force: true })
    }
  })

  it('performs detached worker handshake and returns first state including FAILED', async () => {
    const workerPath = join(root, 'fake-worker.mjs')
    writeFakeWorker(workerPath, 'failed')
    const client = new RunnerClient({ root, workerPath, staleAfterMs: 2_000 })
    const snap = await client.start(spec({ executionId: 'hand1' }))
    expect(snap.state).toBe('FAILED')
    expect(snap.executionId).toBe('hand1')
    expect(snap.runnerId).toBe('fake-worker')
    expect(existsSync(join(root, 'hand1', 'request.json'))).toBe(true)
    const req = JSON.parse(readFileSync(join(root, 'hand1', 'request.json'), 'utf8')) as RunnerRequest
    expect(req.token).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps directory and throws UNKNOWN when handshake never produces state', async () => {
    const workerPath = join(root, 'hang-worker.mjs')
    writeFakeWorker(workerPath, 'hang')
    const client = new RunnerClient({ root, workerPath })
    await expect(client.start(spec({ executionId: 'hang1' }))).rejects.toThrow(/UNKNOWN: Handshake timed out/)
    expect(existsSync(join(root, 'hang1', 'request.json'))).toBe(true)
    expect(existsSync(join(root, 'hang1', 'state.json'))).toBe(false)
    const pidFile = join(root, 'hang1', 'worker.pid')
    expect(existsSync(pidFile)).toBe(true)
    workers.push(Number(readFileSync(pidFile, 'utf8')))
  }, 10_000)

  it('duplicate identical start never respawns and changed spec is rejected', async () => {
    const launch = spec({ executionId: 'dup1' })
    seedExecution(launch, { state: { state: 'RUNNING', runnerPid: process.pid } })
    const marker = join(root, 'spawn-count')
    const workerPath = join(root, 'count-worker.mjs')
    writeFileSync(workerPath, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(marker)}, 'x');
setInterval(() => {}, 1000);
`)
    const client = new RunnerClient({ root, workerPath, staleAfterMs: 60_000 })
    const first = await client.start(launch)
    expect(first.state).toBe('RUNNING')
    expect(existsSync(marker)).toBe(false)
    const second = await client.start(launch)
    expect(second.executionId).toBe('dup1')
    expect(existsSync(marker)).toBe(false)
    await expect(client.start(spec({ executionId: 'dup1', generation: 2 }))).rejects.toThrow(/conflicts/)
  })

  it('existing directory with missing request/state returns UNKNOWN and does not spawn', async () => {
    mkdirSync(join(root, 'miss1'), { mode: 0o700 })
    chmodSync(join(root, 'miss1'), 0o700)
    const marker = join(root, 'spawned')
    const workerPath = join(root, 'should-not-run.mjs')
    writeFileSync(workerPath, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'no');`)
    const client = new RunnerClient({ root, workerPath })
    await expect(client.start(spec({ executionId: 'miss1' }))).rejects.toThrow(/UNKNOWN:.*missing request\/state/)
    expect(existsSync(marker)).toBe(false)
  })

  it('status rejects malformed state and maps stale or dead runner to UNKNOWN', async () => {
    const launch = spec({ executionId: 'stale1' })
    seedExecution(launch, {
      state: {
        state: 'RUNNING',
        runnerPid: process.pid,
        heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      },
    })
    const client = new RunnerClient({ root, workerPath: join(root, 'none.js'), staleAfterMs: 500 })
    const stale = await client.status('stale1')
    expect(stale.state).toBe('UNKNOWN')

    seedExecution(spec({ executionId: 'dead1' }), {
      state: { state: 'RUNNING', runnerPid: 2_147_000_000, heartbeatAt: new Date().toISOString() },
    })
    const dead = await client.status('dead1')
    expect(dead.state).toBe('UNKNOWN')

    seedExecution(spec({ executionId: 'term1' }), {
      state: {
        state: 'SUCCEEDED',
        exitCode: 0,
        finishedAt: new Date(Date.now() - 120_000).toISOString(),
        heartbeatAt: new Date(Date.now() - 120_000).toISOString(),
        runnerPid: 2_147_000_001,
      },
    })
    const terminal = await client.status('term1')
    expect(terminal.state).toBe('SUCCEEDED')

    const badDir = join(root, 'bad1')
    mkdirSync(badDir, { mode: 0o700 })
    chmodSync(badDir, 0o700)
    writeFileSync(join(badDir, 'request.json'), `${JSON.stringify(requestFor(spec({ executionId: 'bad1' })))}\n`, { mode: 0o600 })
    writeFileSync(join(badDir, 'state.json'), `${JSON.stringify({ version: 1, state: 'NOPE' })}\n`, { mode: 0o600 })
    await expect(client.status('bad1')).rejects.toThrow(/UNKNOWN/)
  })

  it('refuses symlink owned files', async () => {
    const launch = spec({ executionId: 'sym1' })
    const dir = join(root, 'sym1')
    mkdirSync(dir, { mode: 0o700 })
    chmodSync(dir, 0o700)
    const realRequest = join(root, 'real-request.json')
    writeFileSync(realRequest, `${JSON.stringify(requestFor(launch))}\n`, { mode: 0o600 })
    symlinkSync(realRequest, join(dir, 'request.json'))
    writeFileSync(join(dir, 'state.json'), `${JSON.stringify(snapshotFor(launch))}\n`, { mode: 0o600 })
    const client = new RunnerClient({ root, workerPath: join(root, 'none.js'), staleAfterMs: 60_000 })
    await expect(client.status('sym1')).rejects.toThrow(/symlink/)
  })

  it('stop accepts only live fresh nonterminal and never signals directly', async () => {
    const workerPath = join(root, 'stop-worker.mjs')
    writeFakeWorker(workerPath, 'running')
    const client = new RunnerClient({ root, workerPath, staleAfterMs: 2_000 })
    const snap = await client.start(spec({ executionId: 'stop1' }))
    workers.push(snap.runnerPid)
    expect(snap.state).toBe('RUNNING')

    const accepted = await client.stop('stop1', 'user cancel')
    expect(accepted).toEqual({ accepted: true })
    const stopFile = JSON.parse(readFileSync(join(root, 'stop1', 'stop.json'), 'utf8')) as { token: string; reason: string; version: 1 }
    expect(stopFile.version).toBe(1)
    expect(stopFile.reason).toBe('user cancel')
    expect(stopFile.token).toMatch(/^[0-9a-f]{64}$/)

    seedExecution(spec({ executionId: 'done1' }), {
      state: { state: 'FAILED', reason: 'x', finishedAt: new Date().toISOString(), exitCode: 1 },
    })
    await expect(client.stop('done1', 'again')).resolves.toEqual({ accepted: false, detail: 'already finished' })

    seedExecution(spec({ executionId: 'unk1' }), {
      state: {
        state: 'RUNNING',
        runnerPid: process.pid,
        heartbeatAt: new Date(Date.now() - 60_000).toISOString(),
      },
    })
    const staleStop = await client.stop('unk1', 'nope')
    expect(staleStop.accepted).toBe(false)
    expect(staleStop.detail).toMatch(/UNKNOWN/)
    expect(existsSync(join(root, 'unk1', 'stop.json'))).toBe(false)
  })

  it('events validates sequences, ignores one trailing incomplete line, rejects bad completed lines', async () => {
    const launch = spec({ executionId: 'ev1' })
    const base = snapshotFor(launch, { state: 'STARTING', sequence: 1 })
    const e1: RunnerEvent = { ...base, at: base.startedAt, sequence: 1, state: 'STARTING' }
    const e2: RunnerEvent = {
      ...base,
      at: new Date().toISOString(),
      sequence: 2,
      state: 'RUNNING',
      updatedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
    }
    seedExecution(launch, { state: e2, events: [e1, e2] })
    const client = new RunnerClient({ root, workerPath: join(root, 'none.js'), staleAfterMs: 60_000 })
    expect(await client.events('ev1')).toHaveLength(2)
    expect(await client.events('ev1', 1)).toEqual([expect.objectContaining({ sequence: 2, state: 'RUNNING' })])

    writeFileSync(join(root, 'ev1', 'events.jsonl'), `${JSON.stringify(e1)}\n${JSON.stringify(e2)}\n{"sequence":3`, { mode: 0o600 })
    expect(await client.events('ev1')).toHaveLength(2)

    writeFileSync(join(root, 'ev1', 'events.jsonl'), `${JSON.stringify(e1)}\n{not-json}\n`, { mode: 0o600 })
    await expect(client.events('ev1')).rejects.toThrow(/Malformed events\.jsonl/)

    writeFileSync(join(root, 'ev1', 'events.jsonl'), `${JSON.stringify(e1)}\n${JSON.stringify({ ...e2, sequence: 3 })}\n`, { mode: 0o600 })
    await expect(client.events('ev1')).rejects.toThrow(/expected sequence 2/)
  })
})
