import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RunnerClient } from '../src/runner/client.ts'
import type { LaunchSpec, RunnerSnapshot } from '../src/runner/protocol.ts'

const WORKER_PATH = resolve('dist/runner/worker.js')
const FIXTURE_PATH = resolve('tests/fixtures/runner-child.mjs')
const TERMINAL_STATES = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'])
const MAX_WAIT_MS = 10_000
const TEST_TIMEOUT_MS = 15_000

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitForTerminal(
  client: RunnerClient,
  executionId: string,
  timeoutMs = MAX_WAIT_MS,
): Promise<RunnerSnapshot> {
  const deadline = Date.now() + timeoutMs
  let lastSnapshot: RunnerSnapshot | undefined
  let lastError: unknown

  while (Date.now() < deadline) {
    try {
      lastSnapshot = await client.status(executionId)
      if (TERMINAL_STATES.has(lastSnapshot.state)) return lastSnapshot
    } catch (error) {
      lastError = error
    }
    await sleep(25)
  }

  const detail = lastSnapshot
    ? `last state was ${lastSnapshot.state}`
    : `status failed: ${String(lastError)}`
  throw new Error(`Timed out waiting for ${executionId} to finish; ${detail}`)
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function forceKill(snapshot: RunnerSnapshot | undefined): void {
  if (!snapshot || TERMINAL_STATES.has(snapshot.state)) return

  if (snapshot.processId && snapshot.processId > 1 && snapshot.processId !== process.pid) {
    try {
      process.kill(process.platform === 'win32' ? snapshot.processId : -snapshot.processId, 'SIGKILL')
    } catch {
      try {
        process.kill(snapshot.processId, 'SIGKILL')
      } catch {
        // The child already exited.
      }
    }
  }

  if (snapshot.runnerPid > 1 && snapshot.runnerPid !== process.pid) {
    try {
      process.kill(snapshot.runnerPid, 'SIGKILL')
    } catch {
      // The worker already exited.
    }
  }
}

describe('RunnerClient with a detached worker', () => {
  let root: string
  let client: RunnerClient
  let sequence = 0
  const handles = new Map<string, RunnerClient>()

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'workforce-runner-integration-'))
    await chmod(root, 0o700)
    client = new RunnerClient({ root, workerPath: WORKER_PATH })
  })

  afterEach(async () => {
    for (const [executionId, owner] of handles) {
      let lastSnapshot: RunnerSnapshot | undefined
      try {
        lastSnapshot = await owner.status(executionId)
        if (!TERMINAL_STATES.has(lastSnapshot.state)) {
          await withTimeout(owner.stop(executionId, 'integration test cleanup'), 1_000, 'cleanup stop')
          lastSnapshot = await waitForTerminal(owner, executionId, 5_000)
        }
      } catch {
        try {
          lastSnapshot = await owner.status(executionId)
        } catch {
          // A failed handshake may not have produced a readable snapshot.
        }
        forceKill(lastSnapshot)
      }
    }

    handles.clear()
    await rm(root, { recursive: true, force: true })
  }, MAX_WAIT_MS)

  function makeSpec(overrides: Partial<LaunchSpec> = {}): LaunchSpec {
    sequence += 1
    return {
      executionId: `integration-${process.pid}-${sequence}`,
      assignmentId: `assignment-${sequence}`,
      ticketId: `ticket-${sequence}`,
      generation: 1,
      command: process.execPath,
      args: [FIXTURE_PATH, 'success'],
      cwd: root,
      timeoutMs: 3_000,
      maxOutputBytes: 64 * 1024,
      graceMs: 200,
      ...overrides,
    }
  }

  async function start(owner: RunnerClient, spec: LaunchSpec): Promise<RunnerSnapshot> {
    handles.set(spec.executionId, owner)
    return owner.start(spec)
  }

  it('captures stdout and stderr and records a successful exit code', async () => {
    const spec = makeSpec()
    await start(client, spec)
    const snapshot = await waitForTerminal(client, spec.executionId)

    expect(snapshot.state).toBe('SUCCEEDED')
    expect(snapshot.exitCode).toBe(0)
    expect(snapshot.signal ?? null).toBeNull()
    await expect(readFile(join(root, spec.executionId, 'stdout.log'), 'utf8')).resolves.toBe('fixture stdout\n')
    await expect(readFile(join(root, spec.executionId, 'stderr.log'), 'utf8')).resolves.toBe('fixture stderr\n')
  }, TEST_TIMEOUT_MS)

  it('preserves a nonzero child exit code', async () => {
    const spec = makeSpec({ args: [FIXTURE_PATH, 'exit', '7'] })
    await start(client, spec)
    const snapshot = await waitForTerminal(client, spec.executionId)

    expect(snapshot.state).toBe('FAILED')
    expect(snapshot.exitCode).toBe(7)
    expect(snapshot.signal ?? null).toBeNull()
  }, TEST_TIMEOUT_MS)

  it('returns from start before a long-running child finishes', async () => {
    const spec = makeSpec({
      args: [FIXTURE_PATH, 'delay', '1500'],
      timeoutMs: 4_000,
    })
    const initial = await start(client, spec)

    expect(TERMINAL_STATES.has(initial.state)).toBe(false)
    await expect(waitForTerminal(client, spec.executionId)).resolves.toMatchObject({
      state: 'SUCCEEDED',
      exitCode: 0,
    })
  }, TEST_TIMEOUT_MS)

  it('allows a second client to monitor the same execution handle', async () => {
    const spec = makeSpec({ args: [FIXTURE_PATH, 'delay', '500'] })
    const initial = await start(client, spec)
    const observer = new RunnerClient({ root, workerPath: WORKER_PATH })

    const observed = await observer.status(spec.executionId)
    expect(observed.executionId).toBe(spec.executionId)
    expect(observed.runnerId).toBe(initial.runnerId)
    await expect(waitForTerminal(observer, spec.executionId)).resolves.toMatchObject({ state: 'SUCCEEDED' })
  }, TEST_TIMEOUT_MS)

  it('starts an identical duplicate only once', async () => {
    const markerPath = join(root, 'launch-count.txt')
    const spec = makeSpec({ args: [FIXTURE_PATH, 'count', markerPath, '500'] })
    const first = await start(client, spec)
    const duplicateClient = new RunnerClient({ root, workerPath: WORKER_PATH })
    const duplicate = await start(duplicateClient, spec)

    expect(duplicate.runnerId).toBe(first.runnerId)
    expect(duplicate.processId).toBe(first.processId)
    await waitForTerminal(duplicateClient, spec.executionId)
    const launches = (await readFile(markerPath, 'utf8')).trim().split('\n')
    expect(launches).toHaveLength(1)
  }, TEST_TIMEOUT_MS)

  it('rejects a changed spec for an existing execution ID', async () => {
    const spec = makeSpec({ args: [FIXTURE_PATH, 'wait', '30000'] })
    await start(client, spec)

    await expect(client.start({
      ...spec,
      args: [FIXTURE_PATH, 'success'],
    })).rejects.toThrow()
  }, TEST_TIMEOUT_MS)

  it('cancels on stop and repeated stop requests remain bounded', async () => {
    const spec = makeSpec({ args: [FIXTURE_PATH, 'wait', '30000'] })
    await start(client, spec)

    await expect(withTimeout(client.stop(spec.executionId, 'requested by test'), 1_000, 'first stop')).resolves.toMatchObject({
      accepted: true,
    })
    await withTimeout(client.stop(spec.executionId, 'requested again'), 1_000, 'repeated stop')

    const snapshot = await waitForTerminal(client, spec.executionId)
    expect(snapshot.state).toBe('CANCELLED')
    await expect(client.stop(spec.executionId, 'already complete')).resolves.toMatchObject({ accepted: false })
  }, TEST_TIMEOUT_MS)

  it('classifies an execution deadline as TIMED_OUT', async () => {
    const spec = makeSpec({
      args: [FIXTURE_PATH, 'wait', '30000'],
      timeoutMs: 150,
    })
    await start(client, spec)

    await expect(waitForTerminal(client, spec.executionId)).resolves.toMatchObject({ state: 'TIMED_OUT' })
  }, TEST_TIMEOUT_MS)

  it('fails when combined stdout and stderr exceed the output limit', async () => {
    const spec = makeSpec({
      args: [FIXTURE_PATH, 'output', '65536'],
      maxOutputBytes: 2_048,
    })
    await start(client, spec)
    const snapshot = await waitForTerminal(client, spec.executionId)

    expect(snapshot.state).toBe('FAILED')
    expect(snapshot.reason).toMatch(/output/i)
  }, TEST_TIMEOUT_MS)

  it('records a missing executable as a startup failure', async () => {
    const spec = makeSpec({ command: join(root, 'missing-executable') })
    const initial = await start(client, spec)
    const snapshot = TERMINAL_STATES.has(initial.state)
      ? initial
      : await waitForTerminal(client, spec.executionId)

    expect(snapshot.state).toBe('FAILED')
    expect(snapshot.processId).toBeUndefined()
    expect(snapshot.reason).toBeTruthy()
  }, TEST_TIMEOUT_MS)

  it('rejects an unsafe execution path', async () => {
    const spec = makeSpec({ executionId: '../outside-root' })

    await expect(client.start(spec)).rejects.toThrow(/execution ID/i)
  }, TEST_TIMEOUT_MS)
})
