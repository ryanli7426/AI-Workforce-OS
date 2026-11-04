/** Controller lease: exclusive local ownership, authenticated stop, fail-closed recovery. */
import { spawn, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  acquireControllerLease,
  inspectController,
  requestControllerStop,
  type ControllerLease,
} from '../src/application/controller-lease.ts'

const TEST_TIMEOUT_MS = 15_000
const CLEANUP_WAIT_MS = 3_000
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

let root: string
const ownedChildren: ChildProcess[] = []
const ownedPids = new Set<number>()

function isAlive(pid: number | undefined | null): boolean {
  if (!Number.isSafeInteger(pid) || pid == null || pid <= 1 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function trackChild(child: ChildProcess): number {
  const pid = child.pid
  if (!Number.isSafeInteger(pid) || pid == null || pid <= 1) throw new Error('Child spawned without pid')
  ownedChildren.push(child)
  ownedPids.add(pid)
  return pid
}

function signalOwned(pid: number, signal: NodeJS.Signals): void {
  if (!ownedPids.has(pid) || !isAlive(pid)) return
  try {
    process.kill(pid, signal)
  } catch {
    /* already gone */
  }
}

async function confirmDead(pids: number[], timeoutMs = CLEANUP_WAIT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pids.every(pid => !isAlive(pid))) return
    await sleep(25)
  }
  const live = pids.filter(isAlive)
  if (live.length > 0) throw new Error(`Owned PIDs still alive after cleanup: ${live.join(',')}`)
}

async function spawnFixture(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
    detached: false,
  })
  const pid = trackChild(child)
  await sleep(50)
  expect(isAlive(pid)).toBe(true)
  return pid
}

function privateDataDir(name: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { mode: 0o700 })
  chmodSync(dir, 0o700)
  return realpathSync(dir)
}

function lockDir(dataDir: string): string {
  return join(dataDir, 'controller.lock')
}

function ownerPath(dataDir: string): string {
  return join(lockDir(dataDir), 'owner.json')
}

function stopPath(dataDir: string): string {
  return join(lockDir(dataDir), 'stop.json')
}

function writeOwner(dataDir: string, owner: { version: number; pid: number; token: string; startedAt: string }): void {
  const dir = lockDir(dataDir)
  if (!existsSync(dir)) {
    mkdirSync(dir, { mode: 0o700 })
    chmodSync(dir, 0o700)
  }
  writeFileSync(ownerPath(dataDir), `${JSON.stringify(owner)}\n`, { mode: 0o600, flag: 'wx' })
  chmodSync(ownerPath(dataDir), 0o600)
}

function readOwnerToken(dataDir: string): string {
  const raw = JSON.parse(readFileSync(ownerPath(dataDir), 'utf8')) as { token: string }
  return raw.token
}

function expectNoTokenLeak(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  expect(message).not.toMatch(/[0-9a-f]{64}/i)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'controller-lease-')))
  chmodSync(root, 0o700)
})

afterEach(async () => {
  for (const pid of [...ownedPids]) signalOwned(pid, 'SIGKILL')
  await confirmDead([...ownedPids])
  for (const child of ownedChildren) {
    try { child.unref() } catch { /* ignore */ }
  }
  ownedChildren.length = 0
  ownedPids.clear()
  rmSync(root, { recursive: true, force: true })
})

describe('acquireControllerLease', () => {
  it('acquires exclusive ownership under a private data dir', () => {
    const dataDir = privateDataDir('ok')
    const lease = acquireControllerLease({ dataDir })
    expect(inspectController(dataDir)).toEqual({ state: 'running', pid: process.pid })
    expect(lstatSync(lockDir(dataDir)).isDirectory()).toBe(true)
    expect(lstatSync(ownerPath(dataDir)).mode & 0o777).toBe(0o600)
    expect(lstatSync(lockDir(dataDir)).mode & 0o777).toBe(0o700)
    const owner = JSON.parse(readFileSync(ownerPath(dataDir), 'utf8')) as Record<string, unknown>
    expect(owner).toMatchObject({
      version: 1,
      pid: process.pid,
    })
    expect(typeof owner.token).toBe('string')
    expect(typeof owner.startedAt).toBe('string')
    lease.release()
    expect(existsSync(lockDir(dataDir))).toBe(false)
    expect(inspectController(dataDir)).toEqual({ state: 'stopped' })
  }, TEST_TIMEOUT_MS)

  it('refuses a second acquire while the owner process is live', async () => {
    const dataDir = privateDataDir('live')
    const first = acquireControllerLease({ dataDir })
    expect(() => acquireControllerLease({ dataDir })).toThrow(/live owner/i)
    first.release()

    const fixturePid = await spawnFixture()
    writeOwner(dataDir, {
      version: 1,
      pid: fixturePid,
      token: 'a'.repeat(64),
      startedAt: new Date().toISOString(),
    })
    expect(() => acquireControllerLease({ dataDir })).toThrow(/live owner/i)
    expect(inspectController(dataDir)).toEqual({ state: 'running', pid: fixturePid })
    signalOwned(fixturePid, 'SIGKILL')
    await confirmDead([fixturePid])
  }, TEST_TIMEOUT_MS)

  it('recovers a confirmed dead owner via exclusive claim inside the lock directory', async () => {
    const dataDir = privateDataDir('dead')
    const fixturePid = await spawnFixture()
    writeOwner(dataDir, {
      version: 1,
      pid: fixturePid,
      token: 'b'.repeat(64),
      startedAt: new Date().toISOString(),
    })
    signalOwned(fixturePid, 'SIGKILL')
    await confirmDead([fixturePid])
    expect(inspectController(dataDir)).toEqual({ state: 'stopped', pid: fixturePid })

    const lease = acquireControllerLease({ dataDir })
    expect(inspectController(dataDir)).toEqual({ state: 'running', pid: process.pid })
    const owner = JSON.parse(readFileSync(ownerPath(dataDir), 'utf8')) as { pid: number; token: string }
    expect(owner.pid).toBe(process.pid)
    expect(owner.token).not.toBe('b'.repeat(64))
    expect(existsSync(join(lockDir(dataDir), 'recovery.claim'))).toBe(false)
    lease.release()
  }, TEST_TIMEOUT_MS)

  it('fails closed when owner metadata is missing or malformed', () => {
    const dataDir = privateDataDir('corrupt')
    mkdirSync(lockDir(dataDir), { mode: 0o700 })
    chmodSync(lockDir(dataDir), 0o700)
    expect(() => acquireControllerLease({ dataDir })).toThrow(/unknown|malformed|missing/i)
    expect(inspectController(dataDir).state).toBe('unknown')

    writeFileSync(ownerPath(dataDir), '{not-json\n', { mode: 0o600 })
    chmodSync(ownerPath(dataDir), 0o600)
    expect(() => acquireControllerLease({ dataDir })).toThrow(/unknown|malformed/i)
    expectNoTokenLeak((() => {
      try {
        acquireControllerLease({ dataDir })
      } catch (error) {
        return error
      }
      return new Error('expected throw')
    })())

    writeFileSync(ownerPath(dataDir), `${JSON.stringify({
      version: 1,
      pid: 2,
      token: 'c'.repeat(64),
      startedAt: 'not-a-date',
      extra: true,
    })}\n`, { mode: 0o600 })
    expect(() => acquireControllerLease({ dataDir })).toThrow(/unknown|malformed/i)
    expect(inspectController(dataDir).state).toBe('unknown')
  }, TEST_TIMEOUT_MS)

  it('fails closed when a crashed recovery claim is present', async () => {
    const dataDir = privateDataDir('claim')
    const fixturePid = await spawnFixture()
    writeOwner(dataDir, {
      version: 1,
      pid: fixturePid,
      token: 'd'.repeat(64),
      startedAt: new Date().toISOString(),
    })
    signalOwned(fixturePid, 'SIGKILL')
    await confirmDead([fixturePid])
    writeFileSync(join(lockDir(dataDir), 'recovery.claim'), `${JSON.stringify({
      version: 1,
      pid: process.pid,
      nonce: 'e'.repeat(32),
      createdAt: new Date().toISOString(),
    })}\n`, { mode: 0o600, flag: 'wx' })
    chmodSync(join(lockDir(dataDir), 'recovery.claim'), 0o600)

    expect(() => acquireControllerLease({ dataDir })).toThrow(/unknown|intervention|recovery/i)
    expect(inspectController(dataDir).state).toBe('unknown')
    expect(() => requestControllerStop(dataDir)).toThrow(/unknown|blocked/i)
  }, TEST_TIMEOUT_MS)

  it('rejects non-private data dirs and symlink path components', () => {
    const openDir = join(root, 'open')
    mkdirSync(openDir, { mode: 0o755 })
    chmodSync(openDir, 0o755)
    expect(() => acquireControllerLease({ dataDir: openDir })).toThrow(/0700|private/i)

    const dataDir = privateDataDir('link-base')
    const viaLink = join(root, 'alias-link')
    symlinkSync(dataDir, viaLink)
    expect(() => acquireControllerLease({ dataDir: viaLink })).toThrow(/symbolic link/i)
    expect(() => inspectController(viaLink)).toThrow(/symbolic link/i)
    expect(() => requestControllerStop(viaLink)).toThrow(/symbolic link/i)
  }, TEST_TIMEOUT_MS)

  it('does not create a missing data directory', () => {
    const missing = join(root, 'missing-root')
    expect(() => acquireControllerLease({ dataDir: missing })).toThrow(/does not exist/i)
    expect(existsSync(missing)).toBe(false)
    expect(inspectController(missing)).toEqual({ state: 'stopped' })
    expect(existsSync(missing)).toBe(false)
    expect(requestControllerStop(missing)).toEqual({ requested: false })
    expect(existsSync(missing)).toBe(false)
  }, TEST_TIMEOUT_MS)

  it('recovers after stop+child death then release clears the lock for reacquire', async () => {
    const dataDir = privateDataDir('stop-dead-recover')
    const fixturePid = await spawnFixture()
    const token = '7'.repeat(64)
    writeOwner(dataDir, {
      version: 1,
      pid: fixturePid,
      token,
      startedAt: new Date().toISOString(),
    })
    expect(requestControllerStop(dataDir)).toEqual({ requested: true })
    expect(existsSync(stopPath(dataDir))).toBe(true)
    signalOwned(fixturePid, 'SIGKILL')
    await confirmDead([fixturePid])

    const recovered = acquireControllerLease({ dataDir })
    expect(inspectController(dataDir)).toEqual({ state: 'running', pid: process.pid })
    expect(existsSync(stopPath(dataDir))).toBe(false)
    expect(existsSync(join(lockDir(dataDir), 'recovery.claim'))).toBe(false)
    recovered.release()
    expect(existsSync(lockDir(dataDir))).toBe(false)

    const again = acquireControllerLease({ dataDir })
    expect(inspectController(dataDir)).toEqual({ state: 'running', pid: process.pid })
    again.release()
  }, TEST_TIMEOUT_MS)

  it('fails closed during recovery when stale stop is foreign or malformed', async () => {
    const dataDir = privateDataDir('bad-stale-stop')
    const fixturePid = await spawnFixture()
    writeOwner(dataDir, {
      version: 1,
      pid: fixturePid,
      token: '8'.repeat(64),
      startedAt: new Date().toISOString(),
    })
    writeFileSync(stopPath(dataDir), `${JSON.stringify({
      version: 1,
      token: '9'.repeat(64),
      requestedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 })
    chmodSync(stopPath(dataDir), 0o600)
    signalOwned(fixturePid, 'SIGKILL')
    await confirmDead([fixturePid])
    expect(() => acquireControllerLease({ dataDir })).toThrow(/stop|blocked|recovery/i)
    expect(existsSync(join(lockDir(dataDir), 'recovery.claim'))).toBe(true)
    expect(inspectController(dataDir).state).toBe('unknown')
  }, TEST_TIMEOUT_MS)
})

describe('release fencing', () => {
  it('preserves unknown evidence and reports that release could not be completed', () => {
    const dataDir = privateDataDir('release-unknown-evidence')
    const lease = acquireControllerLease({ dataDir })
    const foreign = join(lockDir(dataDir), 'foreign-evidence.txt')
    writeFileSync(foreign, 'keep for reconciliation', { mode: 0o600 })
    expect(() => lease.release()).toThrow(/unknown|safe release/i)
    expect(readFileSync(foreign, 'utf8')).toBe('keep for reconciliation')
    expect(existsSync(ownerPath(dataDir))).toBe(true)
    rmSync(foreign)
    lease.release()
    expect(existsSync(lockDir(dataDir))).toBe(false)
  })

  it('does not delete a replaced lock directory or foreign owner file', () => {
    const dataDir = privateDataDir('fence')
    const lease = acquireControllerLease({ dataDir })
    const originalLock = lockDir(dataDir)
    const moved = join(dataDir, 'controller.lock.moved')
    renameSync(originalLock, moved)

    mkdirSync(originalLock, { mode: 0o700 })
    chmodSync(originalLock, 0o700)
    writeFileSync(ownerPath(dataDir), `${JSON.stringify({
      version: 1,
      pid: process.pid,
      token: 'f'.repeat(64),
      startedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600, flag: 'wx' })
    chmodSync(ownerPath(dataDir), 0o600)

    expect(() => lease.release()).toThrow(/ownership was lost/i)
    expect(existsSync(ownerPath(dataDir))).toBe(true)
    expect(readFileSync(ownerPath(dataDir), 'utf8')).toContain('f'.repeat(64))
    expect(existsSync(moved)).toBe(true)
    expect(existsSync(join(moved, 'owner.json'))).toBe(true)
  }, TEST_TIMEOUT_MS)
})

describe('authenticated stop', () => {
  it('requestControllerStop writes a private stop file and shouldStop honors matching token only', () => {
    const dataDir = privateDataDir('stop')
    const lease = acquireControllerLease({ dataDir })
    expect(lease.shouldStop()).toBe(false)
    expect(requestControllerStop(dataDir)).toEqual({ requested: true })
    expect(lstatSync(stopPath(dataDir)).mode & 0o777).toBe(0o600)
    const stop = JSON.parse(readFileSync(stopPath(dataDir), 'utf8')) as Record<string, unknown>
    expect(stop.version).toBe(1)
    expect(typeof stop.token).toBe('string')
    expect(typeof stop.requestedAt).toBe('string')
    expect(lease.shouldStop()).toBe(true)

    writeFileSync(stopPath(dataDir), `${JSON.stringify({
      version: 1,
      token: '0'.repeat(64),
      requestedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 })
    chmodSync(stopPath(dataDir), 0o600)
    expect(lease.shouldStop()).toBe(false)

    expect(requestControllerStop(dataDir)).toEqual({ requested: true })
    expect(lease.shouldStop()).toBe(true)
    expect(readOwnerToken(dataDir)).toHaveLength(64)
    lease.release()
    expect(existsSync(stopPath(dataDir))).toBe(false)
  }, TEST_TIMEOUT_MS)

  it('shouldStop fails closed on malformed stop and ownership loss', () => {
    const dataDir = privateDataDir('stop-fail-closed')
    const lease = acquireControllerLease({ dataDir })

    writeFileSync(stopPath(dataDir), '{not-json\n', { mode: 0o600 })
    chmodSync(stopPath(dataDir), 0o600)
    expect(() => lease.shouldStop()).toThrow(/malformed|unknown|ownership/i)
    expectNoTokenLeak((() => {
      try {
        lease.shouldStop()
      } catch (error) {
        return error
      }
      return new Error('expected throw')
    })())
    rmSync(stopPath(dataDir), { force: true })

    const original = readFileSync(ownerPath(dataDir), 'utf8')
    const mutated = JSON.parse(original) as {
      version: number
      pid: number
      token: string
      startedAt: string
    }
    mutated.token = 'a'.repeat(64)
    writeFileSync(ownerPath(dataDir), `${JSON.stringify(mutated)}\n`, { mode: 0o600 })
    chmodSync(ownerPath(dataDir), 0o600)
    expect(() => lease.shouldStop()).toThrow(/ownership was lost/i)
    writeFileSync(ownerPath(dataDir), original, { mode: 0o600 })
    chmodSync(ownerPath(dataDir), 0o600)

    const moved = join(dataDir, 'controller.lock.moved')
    renameSync(lockDir(dataDir), moved)
    mkdirSync(lockDir(dataDir), { mode: 0o700 })
    chmodSync(lockDir(dataDir), 0o700)
    writeFileSync(ownerPath(dataDir), original, { mode: 0o600, flag: 'wx' })
    chmodSync(ownerPath(dataDir), 0o600)
    expect(() => lease.shouldStop()).toThrow(/ownership was lost/i)
  }, TEST_TIMEOUT_MS)

  it('requestControllerStop rejects unsafe existing stop files', () => {
    const dataDir = privateDataDir('unsafe-stop')
    const lease = acquireControllerLease({ dataDir })
    writeFileSync(stopPath(dataDir), '{broken\n', { mode: 0o600 })
    chmodSync(stopPath(dataDir), 0o600)
    expect(() => requestControllerStop(dataDir)).toThrow(/unsafe|malformed|blocked/i)
    expect(() => lease.shouldStop()).toThrow(/malformed|unknown|ownership/i)

    rmSync(stopPath(dataDir), { force: true })
    symlinkSync(join(dataDir, 'elsewhere'), stopPath(dataDir))
    expect(() => requestControllerStop(dataDir)).toThrow(/unsafe|symbolic|blocked/i)
    expect(() => lease.release()).toThrow(/symbolic|release failed/i)
    expect(lstatSync(stopPath(dataDir)).isSymbolicLink()).toBe(true)
    expect(existsSync(ownerPath(dataDir))).toBe(true)
    rmSync(stopPath(dataDir))
    lease.release()
  }, TEST_TIMEOUT_MS)

  it('stop against a live foreign-held lease uses owner token without exposing it', async () => {
    const dataDir = privateDataDir('foreign-stop')
    const fixturePid = await spawnFixture()
    const token = '1'.repeat(64)
    writeOwner(dataDir, {
      version: 1,
      pid: fixturePid,
      token,
      startedAt: new Date().toISOString(),
    })
    expect(requestControllerStop(dataDir)).toEqual({ requested: true })
    const stop = JSON.parse(readFileSync(stopPath(dataDir), 'utf8')) as { token: string }
    expect(stop.token).toBe(token)
    const status = inspectController(dataDir)
    expect(status).toEqual({ state: 'running', pid: fixturePid })
    expect(JSON.stringify(status)).not.toMatch(/1{64}/)
    signalOwned(fixturePid, 'SIGKILL')
    await confirmDead([fixturePid])
  }, TEST_TIMEOUT_MS)

  it('does not request stop for a confirmed dead owner and returns stopped inspect', async () => {
    const dataDir = privateDataDir('dead-stop')
    const fixturePid = await spawnFixture()
    writeOwner(dataDir, {
      version: 1,
      pid: fixturePid,
      token: '2'.repeat(64),
      startedAt: new Date().toISOString(),
    })
    signalOwned(fixturePid, 'SIGKILL')
    await confirmDead([fixturePid])
    expect(requestControllerStop(dataDir)).toEqual({ requested: false })
    expect(existsSync(stopPath(dataDir))).toBe(false)
    expect(inspectController(dataDir)).toEqual({ state: 'stopped', pid: fixturePid })
  }, TEST_TIMEOUT_MS)
})

describe('query safety', () => {
  it('inspect and stop never create lock roots on an empty private data dir', () => {
    const dataDir = privateDataDir('empty')
    expect(inspectController(dataDir)).toEqual({ state: 'stopped' })
    expect(requestControllerStop(dataDir)).toEqual({ requested: false })
    expect(existsSync(lockDir(dataDir))).toBe(false)
  }, TEST_TIMEOUT_MS)

  it('rejects relative dataDir paths', () => {
    expect(() => acquireControllerLease({ dataDir: 'relative-dir' })).toThrow(/absolute/i)
    expect(() => inspectController('relative-dir')).toThrow(/absolute/i)
    expect(() => requestControllerStop('relative-dir')).toThrow(/absolute/i)
  }, TEST_TIMEOUT_MS)
})

describe('lease lifecycle', () => {
  it('shouldStop returns false after release and release is idempotent', () => {
    const dataDir = privateDataDir('lifecycle')
    const lease: ControllerLease = acquireControllerLease({ dataDir })
    expect(requestControllerStop(dataDir)).toEqual({ requested: true })
    expect(lease.shouldStop()).toBe(true)
    lease.release()
    expect(lease.shouldStop()).toBe(false)
    lease.release()
    expect(inspectController(dataDir)).toEqual({ state: 'stopped' })
  }, TEST_TIMEOUT_MS)
})
