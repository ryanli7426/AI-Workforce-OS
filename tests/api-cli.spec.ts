/**
 * API CLI: explicit credential init and foreground loopback serve.
 * Owns only this file and src/cli/api-commands.ts. Parent copies auth/server/receipts/schema + index routing.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runApiCommand } from '../src/cli/api-commands.ts'
import { createSettings, defaultSettings } from '../src/config/settings.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LocalStore } from '../src/storage/store.ts'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CLI_PATH = resolve(REPO_ROOT, 'dist/cli/index.js')
const NODE = process.execPath

const TEST_TIMEOUT_MS = 45_000
const SERVE_READY_MS = 12_000
const BOUNDED_EXIT_MS = 8_000
const OPAQUE_TOKEN = '0123456789abcdef'.repeat(4)

let root: string
let unrelatedCwd: string
const opened: LocalStore[] = []
const ownedChildren: ChildProcessWithoutNullStreams[] = []
const ownedSockets: net.Socket[] = []

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'api-cli-')))
  chmodSync(root, 0o700)
  unrelatedCwd = join(root, 'unrelated-cwd')
  mkdirSync(unrelatedCwd, { mode: 0o700 })
})

afterEach(async () => {
  for (const socket of ownedSockets.splice(0)) {
    try { socket.destroy() } catch { /* ignore */ }
  }
  for (const child of ownedChildren.splice(0)) {
    if (child.pid && Number.isSafeInteger(child.pid) && child.pid > 1) {
      try { process.kill(child.pid, 'SIGTERM') } catch { /* already gone */ }
    }
    try { child.unref() } catch { /* ignore */ }
  }
  for (const store of opened.splice(0)) {
    try { store.close() } catch { /* ignore */ }
  }
  rmSync(root, { recursive: true, force: true })
})

async function run(...argv: string[]) {
  let stdout = ''
  let stderr = ''
  const code = await runApiCommand(argv, {
    stdout: { write: value => { stdout += value; return true } },
    stderr: { write: value => { stderr += value; return true } },
  })
  const lines = stdout.split(/\r?\n/).filter(line => line.length > 0)
  const jsonLines = lines
    .filter(line => line.startsWith('{') || line.startsWith('['))
    .map(line => JSON.parse(line) as unknown)
  const json = jsonLines.length > 0 ? jsonLines[jsonLines.length - 1] : undefined
  return { code, stdout, stderr, json, jsonLines }
}

function ownerId(): string {
  if (typeof process.getuid === 'function') return `local-${process.getuid()}`
  const username = process.env.USERNAME ?? process.env.USER ?? ''
  if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(username)) return `local-${username}`
  return 'local-owner'
}

function childEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    HOME: root,
    TMPDIR: root,
  }
}

function initDataDir(name = 'data', options: { configure?: boolean } = {}): string {
  const dataDir = join(root, name)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  chmodSync(dataDir, 0o700)
  const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
  opened.push(store)
  // Parent schema hook installs module + command receipts atomically.
  initializeApplicationSchema(store)
  store.close()
  opened.pop()
  if (options.configure !== false) {
    const defaults = defaultSettings({
      ownerId: ownerId(),
      claudeCommand: resolve('/usr/bin/true'),
    })
    createSettings(join(dataDir, 'settings.json'), {
      schemaVersion: defaults.schemaVersion,
      workspaceId: defaults.workspaceId,
      ownerId: defaults.ownerId,
      runtime: { ...defaults.runtime },
      scheduler: { ...defaults.scheduler },
      rules: defaults.rules.map(rule => ({ ...rule, taskTypes: [...rule.taskTypes] })),
    })
  }
  return realpathSync(dataDir)
}

function readCredentialToken(dataDir: string): { token: string; createdAt: string } {
  const raw = JSON.parse(readFileSync(join(dataDir, 'api-auth.json'), 'utf8')) as {
    token: string
    createdAt: string
  }
  expect(typeof raw.token).toBe('string')
  expect(raw.token).toMatch(/^[0-9a-f]{64}$/)
  return raw
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function parseJsonLines(text: string): unknown[] {
  const values: unknown[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { values.push(JSON.parse(line) as unknown) } catch { /* ignore */ }
  }
  return values
}

function boundPort(address: string): number {
  if (/^https?:\/\//i.test(address)) {
    const port = Number(new URL(address).port)
    expect(Number.isInteger(port) && port > 0).toBe(true)
    return port
  }
  const port = Number(address.split(':').at(-1))
  expect(Number.isInteger(port) && port > 0).toBe(true)
  return port
}

interface ServeChild {
  child: ChildProcessWithoutNullStreams
  stdout: string
  stderr: string
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
}

/** Acceptance against the real workforce binary at dist/cli/index.js (absolute), from unrelated cwd. */
function startCompiledServe(dataDir: string, extraArgs: readonly string[] = []): ServeChild {
  if (!existsSync(CLI_PATH)) {
    throw new Error(`Missing dependency: built workforce CLI at ${CLI_PATH}; run pnpm build`)
  }
  const child = spawn(
    NODE,
    [CLI_PATH, 'api-serve', '--data-dir', dataDir, ...extraArgs],
    {
      cwd: unrelatedCwd,
      env: childEnv(),
      stdio: 'pipe',
    },
  )
  child.stdin.end()
  const serve: ServeChild = {
    child,
    stdout: '',
    stderr: '',
    exit: new Promise(resolvePromise => {
      child.once('exit', (code, signal) => resolvePromise({ code, signal }))
    }),
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { serve.stdout += chunk })
  child.stderr.on('data', chunk => { serve.stderr += chunk })
  ownedChildren.push(child)
  return serve
}

async function waitForListening(serve: ServeChild): Promise<{
  listening: true
  address: string
  workspaceId: string
}> {
  const deadline = Date.now() + SERVE_READY_MS
  while (Date.now() < deadline) {
    const payload = parseJsonLines(serve.stdout).find(value =>
      value !== null
      && typeof value === 'object'
      && (value as { listening?: unknown }).listening === true,
    ) as { listening: true; address: string; workspaceId: string } | undefined
    if (payload) return payload
    if (serve.child.exitCode !== null) {
      throw new Error(`api-serve exited early: code=${serve.child.exitCode} stderr=${serve.stderr}`)
    }
    await sleep(25)
  }
  throw new Error(`api-serve did not become ready\nstdout=${serve.stdout}\nstderr=${serve.stderr}`)
}

async function waitForExit(
  serve: ServeChild,
  timeoutMs = BOUNDED_EXIT_MS,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return await Promise.race([
    serve.exit,
    sleep(timeoutMs).then(() => {
      throw new Error(`api-serve did not exit within ${timeoutMs}ms\nstderr=${serve.stderr}`)
    }),
  ])
}

function snapshotDb(dataDir: string): { schema: number; ticketCount: number; kvKeys: string[] } {
  const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
  opened.push(store)
  const schema = store.get<number>('schema')
  const ticketCount = Number(store.db.prepare('SELECT COUNT(*) AS n FROM ticket').get()?.n ?? 0)
  const kvKeys = store.db.prepare('SELECT key FROM kv ORDER BY key').all()
    .map(row => String(row.key))
  store.close()
  opened.pop()
  return { schema: schema as number, ticketCount, kvKeys }
}

async function openPartialBodyConnection(port: number): Promise<net.Socket> {
  const socket = net.connect({ host: '127.0.0.1', port })
  ownedSockets.push(socket)
  await new Promise<void>((resolvePromise, reject) => {
    socket.once('connect', () => resolvePromise())
    socket.once('error', reject)
  })
  // Incomplete body keeps the HTTP request open so naive app.close() would hang.
  socket.write(
    `POST /api/v1/tasks HTTP/1.1\r\n`
    + `Host: 127.0.0.1:${port}\r\n`
    + 'Content-Type: application/json\r\n'
    + 'Content-Length: 65536\r\n'
    + '\r\n'
    + '{"partial":',
  )
  return socket
}

describe('runApiCommand recognition', () => {
  it('returns undefined for unrecognized commands so parent can fall through', async () => {
    expect(await runApiCommand(['status', '--data-dir', join(root, 'x')])).toBeUndefined()
    expect(await runApiCommand(['start', '--foreground', '--data-dir', join(root, 'x')])).toBeUndefined()
    expect(await runApiCommand(['task-create', '--data-dir', join(root, 'x')])).toBeUndefined()
    expect(await runApiCommand(['--help'])).toBeUndefined()
    expect(await runApiCommand([])).toBeUndefined()
  })
})

describe('strict parsing', () => {
  it('rejects duplicate, unknown, missing, and invalid port/origin args without creating storage or echoing secrets', async () => {
    const missing = join(root, 'no-db')

    const unknown = await run('api-init', '--data-dir', missing, '--token', OPAQUE_TOKEN)
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toMatch(/Unknown option/)
    expect(unknown.stderr).not.toContain(OPAQUE_TOKEN)
    expect(existsSync(missing)).toBe(false)

    const positional = await run('api-init', '--data-dir', missing, OPAQUE_TOKEN)
    expect(positional.code).toBe(1)
    expect(positional.stderr).toMatch(/Unexpected argument/)
    expect(positional.stderr).not.toContain(OPAQUE_TOKEN)
    expect(existsSync(missing)).toBe(false)

    const dupDataDir = await run('api-init', '--data-dir', missing, '--data-dir', missing)
    expect(dupDataDir.code).toBe(1)
    expect(dupDataDir.stderr).toMatch(/only be provided once/)
    expect(existsSync(missing)).toBe(false)

    const host = await run('api-serve', '--data-dir', missing, '--host', '0.0.0.0')
    expect(host.code).toBe(1)
    expect(host.stderr).toMatch(/Unknown option/)
    expect(existsSync(missing)).toBe(false)

    const badPort = await run('api-serve', '--data-dir', missing, '--port', '65536')
    expect(badPort.code).toBe(1)
    expect(badPort.stderr).toMatch(/--port/)
    expect(existsSync(missing)).toBe(false)

    const leadingZero = await run('api-serve', '--data-dir', missing, '--port', '04310')
    expect(leadingZero.code).toBe(1)
    expect(leadingZero.stderr).toMatch(/--port/)

    const badOrigin = await run('api-serve', '--data-dir', missing, '--allow-origin', 'https://evil.example')
    expect(badOrigin.code).toBe(1)
    expect(badOrigin.stderr).toMatch(/allow-origin/i)
    expect(existsSync(missing)).toBe(false)

    const dupPort = await run('api-serve', '--data-dir', missing, '--port', '0', '--port', '1')
    expect(dupPort.code).toBe(1)
    expect(dupPort.stderr).toMatch(/only be provided once/)
  })
})

describe('api-init', () => {
  it('creates exclusive credentials without printing the token', async () => {
    const dataDir = initDataDir('init-ok')
    const result = await run('api-init', '--data-dir', dataDir)
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    const payload = result.json as { path: string; createdAt: string }
    expect(payload.path).toBe(join(dataDir, 'api-auth.json'))
    expect(payload.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(Object.keys(payload).sort()).toEqual(['createdAt', 'path'])
    expect(result.stdout).not.toMatch(/[0-9a-f]{64}/)
    expect(statSync(payload.path).mode & 0o777).toBe(0o600)

    const again = await run('api-init', '--data-dir', dataDir)
    expect(again.code).toBe(1)
    expect(again.stdout).not.toMatch(/[0-9a-f]{64}/)
  })

  it('does not create files when data dir is missing', async () => {
    const missing = join(root, 'missing-data')
    const result = await run('api-init', '--data-dir', missing)
    expect(result.code).toBe(1)
    expect(existsSync(missing)).toBe(false)
    expect(existsSync(join(root, 'api-auth.json'))).toBe(false)
  })

  it('rejects schema mismatch without creating credentials', async () => {
    const dataDir = initDataDir('bad-command-schema')
    const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
    opened.push(store)
    store.db.prepare("UPDATE kv SET value = ? WHERE key = 'command-schema'")
      .run(JSON.stringify(99))
    store.close()
    opened.pop()

    const before = existsSync(join(dataDir, 'api-auth.json'))
    const result = await run('api-init', '--data-dir', dataDir)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/[Cc]ommand schema/)
    expect(existsSync(join(dataDir, 'api-auth.json'))).toBe(before)
    expect(result.stdout).not.toMatch(/[0-9a-f]{64}/)
  })
})

describe('compiled api-serve loopback', () => {
  it('serves on port 0 via dist/cli/index.js, enforces auth/origin, and exits cleanly on SIGTERM', async () => {
    const dataDir = initDataDir('serve-ok')
    const init = await run('api-init', '--data-dir', dataDir)
    expect(init.code).toBe(0)
    const { token } = readCredentialToken(dataDir)
    const before = snapshotDb(dataDir)

    const serve = startCompiledServe(dataDir, ['--port', '0'])
    const listening = await waitForListening(serve)
    expect(listening.workspaceId).toBe('local')
    expect(listening.address).toMatch(/^https?:\/\/127\.0\.0\.1:\d+$/)
    const port = boundPort(listening.address)
    expect(serve.stdout).not.toContain(token)
    expect(serve.stderr).not.toContain(token)

    const unauth = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: { host: `127.0.0.1:${port}` },
    })
    expect(unauth.status).toBe(401)
    const unauthBody = await unauth.text()
    expect(unauthBody).not.toContain(token)

    const health = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${token}`,
      },
    })
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ready: true, workspaceId: 'local' })

    const overview = await fetch(`http://127.0.0.1:${port}/api/v1/overview`, {
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${token}`,
      },
    })
    expect(overview.status).toBe(200)
    const overviewBody = await overview.json() as { tasks: unknown }
    expect(overviewBody.tasks).toBeTruthy()

    const malicious = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'http://evil.example',
        authorization: `Bearer ${token}`,
      },
    })
    expect(malicious.status).toBe(403)
    expect(await malicious.text()).not.toContain(token)

    expect(existsSync(join(dataDir, 'runners'))).toBe(false)
    expect(existsSync(join(dataDir, 'controller.lock'))).toBe(false)

    if (!serve.child.pid) throw new Error('missing serve pid')
    process.kill(serve.child.pid, 'SIGTERM')
    const exit = await waitForExit(serve)
    expect(exit.code).toBe(0)
    expect(exit.signal).toBeNull()
    expect(serve.stderr).not.toContain(token)
    expect(serve.stdout).not.toContain(token)

    expect(snapshotDb(dataDir)).toEqual(before)
  }, TEST_TIMEOUT_MS)

  it('force-closes a partial-body TCP connection on SIGTERM within a bound window and leaves DB reusable', async () => {
    const dataDir = initDataDir('serve-partial')
    expect((await run('api-init', '--data-dir', dataDir)).code).toBe(0)
    const { token } = readCredentialToken(dataDir)
    const before = snapshotDb(dataDir)

    const serve = startCompiledServe(dataDir, ['--port', '0'])
    const listening = await waitForListening(serve)
    const port = boundPort(listening.address)

    await openPartialBodyConnection(port)
    await sleep(50)

    if (!serve.child.pid) throw new Error('missing serve pid')
    const started = Date.now()
    process.kill(serve.child.pid, 'SIGTERM')
    const exit = await waitForExit(serve, BOUNDED_EXIT_MS)
    expect(Date.now() - started).toBeLessThan(BOUNDED_EXIT_MS)
    expect(exit.code).toBe(0)
    expect(exit.signal).toBeNull()
    expect(serve.stderr).not.toContain(token)
    expect(serve.stdout).not.toMatch(/[0-9a-f]{64}/)

    expect(snapshotDb(dataDir)).toEqual(before)
  }, TEST_TIMEOUT_MS)

  it('rejects invalid --allow-origin before listen and accepts a valid explicit loopback origin', async () => {
    const dataDir = initDataDir('serve-origin')
    expect((await run('api-init', '--data-dir', dataDir)).code).toBe(0)
    const { token } = readCredentialToken(dataDir)

    const bad = await run(
      'api-serve',
      '--data-dir', dataDir,
      '--port', '0',
      '--allow-origin', 'http://example.com',
    )
    expect(bad.code).toBe(1)
    expect(bad.stderr).toMatch(/allow-origin/i)

    const serve = startCompiledServe(dataDir, [
      '--port', '0',
      '--allow-origin', 'http://127.0.0.1',
    ])
    const listening = await waitForListening(serve)
    const port = boundPort(listening.address)

    const allowed = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'http://127.0.0.1',
        authorization: `Bearer ${token}`,
      },
    })
    expect(allowed.status).toBe(200)

    const denied = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
      headers: {
        host: `127.0.0.1:${port}`,
        origin: 'http://localhost',
        authorization: `Bearer ${token}`,
      },
    })
    expect(denied.status).toBe(403)

    if (!serve.child.pid) throw new Error('missing serve pid')
    process.kill(serve.child.pid, 'SIGTERM')
    expect((await waitForExit(serve)).code).toBe(0)
  }, TEST_TIMEOUT_MS)
})
