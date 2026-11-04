/** Adversarial Runner integration: real detached worker via RunnerClient; bounded cleanup only. */
import { spawn, type ChildProcess } from 'node:child_process'
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
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunnerClient } from '../src/runner/client.ts'
import type { LaunchSpec, RunnerRequest, RunnerSnapshot } from '../src/runner/protocol.ts'
import { TERMINAL_EXECUTION_STATES } from '../src/execution/model.ts'

const WORKER_PATH = resolve('dist/runner/worker.js')
const FIXTURE_PATH = resolve('tests/fixtures/runner-adversary.mjs')
const TERMINAL = new Set<string>(TERMINAL_EXECUTION_STATES)
const MAX_POLL_MS = 12_000
const TEST_TIMEOUT_MS = 20_000
const API_KEY_SENTINEL = 'TEST_ADVERSARIAL_API_KEY'
const API_KEY_VALUE = 'sk-adversary-sentinel-do-not-leak-9f3a'

const sleep = (ms: number) => new Promise(resolvePromise => setTimeout(resolvePromise, ms))

function isAlive(pid: number | undefined | null): boolean {
  if (!Number.isSafeInteger(pid) || pid == null || pid <= 1 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function signalOwned(pid: number, signal: NodeJS.Signals, group: boolean): void {
  if (!isAlive(pid)) return
  try {
    process.kill(group && process.platform !== 'win32' ? -pid : pid, signal)
  } catch {
    if (group) {
      try { process.kill(pid, signal) } catch { /* already gone */ }
    }
  }
}

async function confirmDead(pids: Array<number | undefined | null>, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const tracked = pids.filter((pid): pid is number => Number.isSafeInteger(pid) && pid != null && pid > 1)
  while (Date.now() < deadline) {
    if (tracked.every(pid => !isAlive(pid))) return
    await sleep(25)
  }
  const live = tracked.filter(isAlive)
  if (live.length > 0) throw new Error(`Owned PIDs still alive after cleanup: ${live.join(',')}`)
}

function readPidFile(path: string): number | undefined {
  if (!existsSync(path)) return undefined
  const value = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
  return Number.isSafeInteger(value) ? value : undefined
}

async function waitFor(
  label: string,
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = MAX_POLL_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return
    } catch (error) {
      lastError = error
    }
    await sleep(40)
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${String(lastError)}` : ''}`)
}

async function waitForSnapshot(
  client: RunnerClient,
  executionId: string,
  predicate: (snapshot: RunnerSnapshot) => boolean,
  timeoutMs = MAX_POLL_MS,
): Promise<RunnerSnapshot> {
  let last: RunnerSnapshot | undefined
  await waitFor(executionId, async () => {
    last = await client.status(executionId)
    return predicate(last)
  }, timeoutMs)
  return last!
}

async function waitForTerminal(client: RunnerClient, executionId: string, timeoutMs = MAX_POLL_MS): Promise<RunnerSnapshot> {
  return waitForSnapshot(client, executionId, snap => TERMINAL.has(snap.state) || snap.state === 'UNKNOWN', timeoutMs)
}

describe('Runner adversarial integration', () => {
  let root: string
  let client: RunnerClient
  let sequence = 0
  const ownedRunnerPids = new Set<number>()
  const ownedProcessIds = new Set<number>()
  const ownedExtraPids = new Set<number>()
  const markerDirs: string[] = []
  let previousApiKey: string | undefined

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'workforce-runner-adversarial-'))
    chmodSync(root, 0o700)
    client = new RunnerClient({ root, workerPath: WORKER_PATH, staleAfterMs: 1_500 })
    previousApiKey = process.env[API_KEY_SENTINEL]
    process.env[API_KEY_SENTINEL] = API_KEY_VALUE
  })

  afterEach(async () => {
    if (previousApiKey === undefined) delete process.env[API_KEY_SENTINEL]
    else process.env[API_KEY_SENTINEL] = previousApiKey

    for (const pid of ownedProcessIds) signalOwned(pid, 'SIGKILL', true)
    for (const pid of ownedRunnerPids) signalOwned(pid, 'SIGKILL', false)
    for (const pid of ownedExtraPids) signalOwned(pid, 'SIGKILL', false)

    await confirmDead([...ownedProcessIds, ...ownedRunnerPids, ...ownedExtraPids])

    ownedProcessIds.clear()
    ownedRunnerPids.clear()
    ownedExtraPids.clear()

    for (const dir of markerDirs.splice(0)) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* best-effort */ }
    }
    rmSync(root, { recursive: true, force: true })
  }, MAX_POLL_MS)

  function track(snapshot: RunnerSnapshot): RunnerSnapshot {
    if (snapshot.runnerPid > 1) ownedRunnerPids.add(snapshot.runnerPid)
    if (snapshot.processId && snapshot.processId > 1) ownedProcessIds.add(snapshot.processId)
    return snapshot
  }

  function markerDir(name: string): string {
    const dir = join(root, `markers-${name}`)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    markerDirs.push(dir)
    return dir
  }

  function makeSpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
    sequence += 1
    return {
      executionId: `adv-${process.pid}-${sequence}`,
      assignmentId: `assignment-${sequence}`,
      ticketId: `ticket-${sequence}`,
      generation: 1,
      command: process.execPath,
      args: [FIXTURE_PATH, 'success'],
      cwd: root,
      timeoutMs: 8_000,
      maxOutputBytes: 64 * 1024,
      graceMs: 200,
      ...overrides,
    }
  }

  async function startTracked(owner: RunnerClient, spec: LaunchSpec): Promise<RunnerSnapshot> {
    const snapshot = track(await owner.start(spec))
    return snapshot
  }

  it('rejects an invalid stop token and leaves the child running', async () => {
    const markers = markerDir('invalid-stop')
    const spec = makeSpec({
      args: [FIXTURE_PATH, 'hold', markers, '30000'],
      timeoutMs: 15_000,
    })
    const initial = await startTracked(client, spec)
    expect(TERMINAL.has(initial.state)).toBe(false)

    await waitFor('direct.pid marker', () => existsSync(join(markers, 'direct.pid')))
    const childPid = readPidFile(join(markers, 'direct.pid'))
    expect(childPid).toBeTruthy()
    if (childPid) ownedProcessIds.add(childPid)

    const dir = join(root, spec.executionId)
    writeFileSync(join(dir, 'stop.json'), `${JSON.stringify({
      version: 1,
      token: '0'.repeat(64),
      reason: 'forged stop token',
    })}\n`, { mode: 0o600 })

    await sleep(400)
    const mid = track(await client.status(spec.executionId))
    expect(mid.state).toBe('RUNNING')
    expect(isAlive(childPid)).toBe(true)
    expect(TERMINAL.has(mid.state)).toBe(false)

    await expect(client.stop(spec.executionId, 'authorized cleanup')).resolves.toMatchObject({ accepted: true })
    const terminal = track(await waitForTerminal(client, spec.executionId))
    expect(terminal.state).toBe('CANCELLED')
  }, TEST_TIMEOUT_MS)

  it('refuses cwd symlink and identity mismatch', async () => {
    // Runner cwd here is the private execution root; a symlink root must be refused.
    const realRoot = mkdtempSync(join(tmpdir(), 'adversary-real-root-'))
    chmodSync(realRoot, 0o700)
    markerDirs.push(realRoot)
    const linkedRoot = join(root, 'cwd-symlink-root')
    symlinkSync(realRoot, linkedRoot)
    const linkedClient = new RunnerClient({ root: linkedRoot, workerPath: WORKER_PATH })
    await expect(linkedClient.start(makeSpec({
      cwd: realRoot,
      args: [FIXTURE_PATH, 'success'],
    }))).rejects.toThrow(/real directory|symlink/i)

    const live = makeSpec({
      args: [FIXTURE_PATH, 'hold', markerDir('ident'), '30000'],
      timeoutMs: 15_000,
    })
    await startTracked(client, live)
    await expect(client.start({
      ...live,
      assignmentId: 'forged-assignment',
    })).rejects.toThrow(/conflict|mismatch|ident/i)
  }, TEST_TIMEOUT_MS)

  it('tolerates a trailing incomplete events line but rejects a malformed completed line', async () => {
    const spec = makeSpec({ args: [FIXTURE_PATH, 'success'] })
    await startTracked(client, spec)
    const terminal = track(await waitForTerminal(client, spec.executionId))
    expect(terminal.state).toBe('SUCCEEDED')

    const eventsPath = join(root, spec.executionId, 'events.jsonl')
    const original = readFileSync(eventsPath, 'utf8')
    expect(original.endsWith('\n')).toBe(true)

    writeFileSync(eventsPath, `${original}{"sequence":999,"partial":`, { mode: 0o600 })
    const partial = await client.events(spec.executionId)
    expect(partial.length).toBeGreaterThan(0)
    expect(partial.every(event => event.executionId === spec.executionId)).toBe(true)

    writeFileSync(eventsPath, `${original}{not-valid-json}\n`, { mode: 0o600 })
    await expect(client.events(spec.executionId)).rejects.toThrow(/Malformed events\.jsonl/)
  }, TEST_TIMEOUT_MS)

  it('duplicate direct worker launch cannot spawn the child twice', async () => {
    const countPath = join(root, 'launch-count.txt')
    const spec = makeSpec({
      args: [FIXTURE_PATH, 'count', countPath, '800'],
      timeoutMs: 10_000,
    })
    const first = await startTracked(client, spec)
    expect(first.runnerPid).toBeGreaterThan(1)

    await waitFor('first count marker', () => existsSync(countPath) && readFileSync(countPath, 'utf8').trim().length > 0)

    const requestPath = join(root, spec.executionId, 'request.json')
    const duplicate = spawn(process.execPath, [WORKER_PATH, '--request', requestPath], {
      detached: true,
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        USER: process.env.USER ?? '',
        LANG: process.env.LANG ?? 'C',
        TMPDIR: process.env.TMPDIR ?? '',
      },
    })
    if (duplicate.pid && duplicate.pid > 1) ownedExtraPids.add(duplicate.pid)
    duplicate.unref()

    await sleep(500)
    const terminal = track(await waitForTerminal(client, spec.executionId))
    expect(['SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED']).toContain(terminal.state)

    const launches = readFileSync(countPath, 'utf8').trim().split('\n').filter(Boolean)
    expect(launches).toHaveLength(1)
  }, TEST_TIMEOUT_MS)

  it('surviving descendants block false success, are killed, and never leak', async () => {
    const markers = markerDir('orphan')
    const spec = makeSpec({
      args: [FIXTURE_PATH, 'orphan-descendant', markers, '30000'],
      timeoutMs: 10_000,
      graceMs: 150,
    })
    const initial = await startTracked(client, spec)
    expect(initial.processId === undefined || initial.processId > 1).toBe(true)

    await waitFor('descendant marker', () => existsSync(join(markers, 'descendant.pid')) || existsSync(join(markers, 'descendant.spawn.pid')))
    const descendantPid = readPidFile(join(markers, 'descendant.pid')) ?? readPidFile(join(markers, 'descendant.spawn.pid'))
    const directPid = readPidFile(join(markers, 'direct.pid'))
    if (descendantPid) ownedExtraPids.add(descendantPid)
    if (directPid) ownedProcessIds.add(directPid)

    const terminal = track(await waitForTerminal(client, spec.executionId))
    expect(terminal.state).not.toBe('SUCCEEDED')
    expect(['UNKNOWN', 'FAILED']).toContain(terminal.state)
    expect(String(terminal.reason ?? '')).toMatch(/descendant|process-group|surviv/i)

    await waitFor('descendant reaped', () => !isAlive(descendantPid), 5_000)
    expect(isAlive(descendantPid)).toBe(false)
    expect(isAlive(directPid)).toBe(false)
  }, TEST_TIMEOUT_MS)

  it('killed runner reports UNKNOWN and duplicate start never relaunches', async () => {
    const markers = markerDir('killed-runner')
    const countPath = join(root, 'relaunch-count.txt')
    const spec = makeSpec({
      args: [FIXTURE_PATH, 'count', countPath, '30000'],
      timeoutMs: 30_000,
    })
    const initial = await startTracked(client, spec)
    expect(TERMINAL.has(initial.state)).toBe(false)
    expect(initial.runnerPid).toBeGreaterThan(1)

    await waitFor('count marker', () => existsSync(countPath) && readFileSync(countPath, 'utf8').trim().length > 0)
    const launchesBefore = readFileSync(countPath, 'utf8').trim().split('\n').filter(Boolean)
    expect(launchesBefore).toHaveLength(1)
    const childPid = Number.parseInt(launchesBefore[0]!, 10)
    if (Number.isSafeInteger(childPid)) ownedProcessIds.add(childPid)
    if (initial.processId) ownedProcessIds.add(initial.processId)
    // markers dir kept for cleanup ownership bookkeeping parity with other cases
    writeFileSync(join(markers, 'tracked.pid'), `${childPid}\n`, { mode: 0o600 })

    const lockBefore = readFileSync(join(root, spec.executionId, 'worker.lock'), 'utf8')

    signalOwned(initial.runnerPid, 'SIGKILL', false)
    await confirmDead([initial.runnerPid])

    const observer = new RunnerClient({ root, workerPath: WORKER_PATH, staleAfterMs: 500 })
    const observed = await waitForSnapshot(observer, spec.executionId, snap => snap.state === 'UNKNOWN', MAX_POLL_MS)
    expect(observed.state).toBe('UNKNOWN')

    const duplicate = await observer.start(spec)
    expect(duplicate.state).toBe('UNKNOWN')
    expect(duplicate.runnerId).toBe(initial.runnerId)
    expect(duplicate.runnerPid).toBe(initial.runnerPid)

    await sleep(300)
    const launchesAfter = readFileSync(countPath, 'utf8').trim().split('\n').filter(Boolean)
    expect(launchesAfter).toHaveLength(1)
    expect(readFileSync(join(root, spec.executionId, 'worker.lock'), 'utf8')).toBe(lockBefore)

    if (isAlive(childPid)) {
      signalOwned(initial.processId ?? childPid, 'SIGKILL', true)
      await confirmDead([childPid, initial.processId])
    }
  }, TEST_TIMEOUT_MS)

  it('foreign stop cannot signal a reused PID', async () => {
    const markers = markerDir('foreign-stop')
    const spec = makeSpec({
      args: [FIXTURE_PATH, 'hold', markers, '30000'],
      timeoutMs: 20_000,
    })
    const initial = await startTracked(client, spec)
    await waitFor('foreign hold marker', () => existsSync(join(markers, 'direct.pid')))
    const childPid = readPidFile(join(markers, 'direct.pid'))
    expect(childPid).toBeTruthy()
    if (childPid) ownedProcessIds.add(childPid)
    if (initial.processId) ownedProcessIds.add(initial.processId)

    const request = JSON.parse(readFileSync(join(root, spec.executionId, 'request.json'), 'utf8')) as RunnerRequest

    signalOwned(initial.runnerPid, 'SIGKILL', false)
    if (initial.processId) signalOwned(initial.processId, 'SIGKILL', true)
    else if (childPid) signalOwned(childPid, 'SIGKILL', true)
    await confirmDead([initial.runnerPid, initial.processId, childPid])

    const sentinel: ChildProcess = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
      detached: false,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        LANG: process.env.LANG ?? 'C',
      },
    })
    expect(sentinel.pid).toBeTruthy()
    if (sentinel.pid) ownedExtraPids.add(sentinel.pid)

    writeFileSync(join(root, spec.executionId, 'stop.json'), `${JSON.stringify({
      version: 1,
      token: 'f'.repeat(64),
      reason: 'foreign stop after reuse window',
    })}\n`, { mode: 0o600 })
    writeFileSync(join(root, spec.executionId, 'stop.foreign.json'), `${JSON.stringify({
      version: 1,
      token: request.token,
      reason: 'stale authenticated stop must not be applied by client signaling',
    })}\n`, { mode: 0o600 })

    const stopResult = await client.stop(spec.executionId, 'should not signal')
    expect(stopResult.accepted).toBe(false)

    await sleep(400)
    expect(isAlive(sentinel.pid)).toBe(true)
    expect(sentinel.exitCode).toBeNull()
  }, TEST_TIMEOUT_MS)

  it('does not inherit an API-key sentinel and never logs it', async () => {
    expect(process.env[API_KEY_SENTINEL]).toBe(API_KEY_VALUE)
    const envPath = join(root, 'child-env.json')
    const spec = makeSpec({
      args: [FIXTURE_PATH, 'env-dump', envPath],
      timeoutMs: 5_000,
    })
    await startTracked(client, spec)
    const terminal = track(await waitForTerminal(client, spec.executionId))
    expect(terminal.state).toBe('SUCCEEDED')

    await waitFor('env dump', () => existsSync(envPath))
    const childEnv = JSON.parse(readFileSync(envPath, 'utf8')) as Record<string, string>
    expect(childEnv[API_KEY_SENTINEL]).toBeUndefined()
    expect(JSON.stringify(childEnv)).not.toContain(API_KEY_VALUE)

    const dir = join(root, spec.executionId)
    for (const name of ['events.jsonl', 'state.json', 'stdout.log', 'stderr.log', 'request.json']) {
      const text = readFileSync(join(dir, name), 'utf8')
      expect(text).not.toContain(API_KEY_VALUE)
      expect(text).not.toContain(API_KEY_SENTINEL)
    }
  }, TEST_TIMEOUT_MS)
})
