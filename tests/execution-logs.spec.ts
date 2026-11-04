/**
 * Query-only execution log reader tests. Fixture setup may write; the unit under test must not.
 */
import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalTaskService } from '../src/application/tasks.ts'
import type { Rule } from '../src/assessor/rules.ts'
import { createSettings, defaultSettings } from '../src/config/settings.ts'
import type { ExecutionSpec } from '../src/execution/model.ts'
import { ExecutionRepository } from '../src/execution/repository.ts'
import { readExecutionLogs } from '../src/observability/execution-logs.ts'
import { ProjectRepository } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LocalStore } from '../src/storage/store.ts'

const opened: LocalStore[] = []
const roots: string[] = []

// Inject concurrent writers at the filesystem boundary, keeping test hooks out
// of the production query API. Every read still uses the real file descriptor.
const readFault = vi.hoisted(() => ({ afterRead: undefined as ((fd: number) => void) | undefined }))
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    readSync: (...args: unknown[]) => {
      const count = Reflect.apply(actual.readSync, actual, args) as number
      readFault.afterRead?.(args[0] as number)
      return count
    },
  }
})

function afterReadOf(path: string, callback: (fd: number) => void): void {
  const descriptor = openSync(path, 'r')
  const expected = fstatSync(descriptor)
  closeSync(descriptor)
  readFault.afterRead = fd => {
    const current = fstatSync(fd)
    if (current.dev !== expected.dev || current.ino !== expected.ino) return
    readFault.afterRead = undefined
    callback(fd)
  }
}

afterEach(() => {
  readFault.afterRead = undefined
  while (opened.length) {
    try { opened.pop()!.close() } catch { /* ignore */ }
  }
  while (roots.length) {
    try { rmSync(roots.pop()!, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

function privateRoot(prefix = 'execution-logs-'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  chmodSync(root, 0o700)
  roots.push(root)
  return root
}

function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    HOME: home,
  }
}

function git(cwd: string, home: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: gitEnv(home), stdio: 'ignore', timeout: 15_000 })
}

function initGitRepo(dir: string, home: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  git(dir, home, ['init'])
  git(dir, home, ['config', 'user.email', 'execution-logs@example.com'])
  git(dir, home, ['config', 'user.name', 'Execution Logs'])
  writeFileSync(join(dir, 'README'), 'fixture\n', { mode: 0o600 })
  git(dir, home, ['add', 'README'])
  git(dir, home, ['commit', '-m', 'init'])
  return realpathSync(dir)
}

function rules(): Rule[] {
  return [{
    id: 'docs',
    enabled: true,
    taskTypes: ['docs'],
    priority: 10,
    approvalRequired: true,
    reviewRequired: true,
    retryLimit: 1,
  }]
}

function initFixture(ownerId = 'owner-1'): {
  root: string
  dataDir: string
  store: LocalStore
  tasks: LocalTaskService
  ticketId: string
  reserve: (executionId: string, ticketId?: string) => void
  writeLog: (executionId: string, name: 'stdout.log' | 'stderr.log', body: Buffer | string, mode?: number) => string
} {
  const root = privateRoot()
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  chmodSync(dataDir, 0o700)
  createSettings(join(dataDir, 'settings.json'), defaultSettings({ ownerId }))
  const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
  opened.push(store)
  initializeApplicationSchema(store)
  const repositoryPath = initGitRepo(join(root, 'repo'), root)
  const worktreeRoot = join(root, 'worktrees')
  mkdirSync(worktreeRoot, { recursive: true, mode: 0o700 })
  new ProjectRepository(store.db).create({
    id: 'proj-1',
    workspaceId: 'local',
    name: 'Docs',
    ownerId,
    repositoryPath,
    worktreeRoot,
    allowedTaskTypes: ['docs'],
  })
  const tasks = new LocalTaskService({ store, ownerId, rules: rules(), workspaceId: 'local' })
  const ticket = tasks.create({
    issueId: 'issue-1',
    projectId: 'proj-1',
    title: 'Fix docs',
    description: 'Tighten wording',
    taskType: 'docs',
  })
  const runners = join(dataDir, 'runners')
  mkdirSync(runners, { recursive: true, mode: 0o700 })
  chmodSync(runners, 0o700)

  const reserve = (executionId: string, ticketId = ticket.id) => {
    const cwd = join(root, `cwd-${executionId}`)
    mkdirSync(cwd, { recursive: true, mode: 0o700 })
    const spec: ExecutionSpec = {
      executionId,
      assignmentId: `assign-${executionId}`,
      ticketId,
      agentId: 'emp-1',
      runtime: 'fixture',
      generation: 1,
      cwd,
      inputRevision: 'rev-1',
      policyVersion: 'policy-1',
    }
    new ExecutionRepository(store.db).reserve(spec)
  }

  const writeLog = (
    executionId: string,
    name: 'stdout.log' | 'stderr.log',
    body: Buffer | string,
    mode = 0o600,
  ): string => {
    const dir = join(runners, executionId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    const path = join(dir, name)
    const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
    const fd = openSync(path, 'w', mode)
    try {
      writeSync(fd, bytes)
    } finally {
      closeSync(fd)
    }
    chmodSync(path, mode)
    return path
  }

  return { root, dataDir, store, tasks, ticketId: ticket.id, reserve, writeLog }
}

describe('readExecutionLogs', () => {
  it('reads persisted state and bounded redacted tails from a real initialized fixture', async () => {
    const f = initFixture()
    f.reserve('exec-1')
    f.writeLog('exec-1', 'stdout.log', 'hello api_key=sk-ant-api03-abcdefghijklmnopqrstuvwxyz\n')
    f.writeLog('exec-1', 'stderr.log', 'warn\n')
    f.store.close()
    opened.pop()

    const result = await readExecutionLogs({ dataDir: f.dataDir, ticketId: f.ticketId })
    expect(result.ticketId).toBe(f.ticketId)
    expect(result.executions).toHaveLength(1)
    expect(result.executions[0]).toMatchObject({
      executionId: 'exec-1',
      state: 'STARTING',
      stderr: 'warn\n',
      stdoutTruncated: false,
      stderrTruncated: false,
    })
    expect(result.executions[0]!.stdout).toContain('hello')
    expect(result.executions[0]!.stdout).toContain('[REDACTED]')
    expect(result.executions[0]!.stdout).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz')
  })

  it('returns empty streams for reserved executions with missing log files and does not create them', async () => {
    const f = initFixture()
    f.reserve('exec-missing')
    const dir = join(f.dataDir, 'runners', 'exec-missing')
    expect(existsSync(dir)).toBe(false)
    f.store.close()
    opened.pop()

    const result = await readExecutionLogs({
      dataDir: f.dataDir,
      ticketId: f.ticketId,
      executionId: 'exec-missing',
    })
    expect(result.executions).toEqual([{
      executionId: 'exec-missing',
      state: 'STARTING',
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
    }])
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(join(f.dataDir, 'runners', 'exec-missing', 'stdout.log'))).toBe(false)
  })

  it('tails multibyte UTF-8 mid-line fail-closed: truncated no-newline window is discarded', async () => {
    const f = initFixture()
    f.reserve('exec-utf8')
    const prefix = Buffer.alloc(20, 0x61)
    const multibyte = Buffer.from('你好世界', 'utf8')
    const body = Buffer.concat([prefix, multibyte])
    f.writeLog('exec-utf8', 'stdout.log', body)
    f.writeLog('exec-utf8', 'stderr.log', '')
    f.store.close()
    opened.pop()

    // Last 10 bytes start mid-character (continuation byte of 你) with no newline in the window.
    // Fail-closed: discard the untrusted partial line rather than emit a bare suffix.
    const maxBytes = 10
    const result = await readExecutionLogs({
      dataDir: f.dataDir,
      ticketId: f.ticketId,
      executionId: 'exec-utf8',
      maxBytes,
    })
    expect(result.executions[0]!.stdoutTruncated).toBe(true)
    expect(result.executions[0]!.stdout).toBe('')
    expect(result.executions[0]!.stdout).not.toContain('好')
    expect(Buffer.byteLength(body)).toBeGreaterThan(maxBytes)
  })

  it('redacts credential suffix when api_key=/Bearer prefix lies just before the tail window', async () => {
    const f = initFixture()
    f.reserve('exec-boundary')
    const secret = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz'
    const bearer = 'control-token-boundary-0123456789abcdef'
    // Tail window begins immediately after the credential prefixes.
    const stdoutBody = `${'a'.repeat(80)}api_key=${secret}\nsafe-stdout\n`
    const stderrBody = `${'b'.repeat(80)}Bearer ${bearer}\nsafe-stderr\n`
    const stdoutMax = Buffer.byteLength(`${secret}\nsafe-stdout\n`)
    const stderrMax = Buffer.byteLength(`${bearer}\nsafe-stderr\n`)
    f.writeLog('exec-boundary', 'stdout.log', stdoutBody)
    f.writeLog('exec-boundary', 'stderr.log', stderrBody)
    f.store.close()
    opened.pop()

    const stdoutResult = await readExecutionLogs({
      dataDir: f.dataDir,
      ticketId: f.ticketId,
      executionId: 'exec-boundary',
      maxBytes: stdoutMax,
    })
    expect(stdoutResult.executions[0]!.stdoutTruncated).toBe(true)
    expect(stdoutResult.executions[0]!.stdout).toBe('safe-stdout\n')
    expect(stdoutResult.executions[0]!.stdout).not.toContain(secret)
    expect(JSON.stringify(stdoutResult)).not.toContain(secret)

    // Rebuild stderr-focused bound via a fresh fixture size check on the same files.
    const stderrResult = await readExecutionLogs({
      dataDir: f.dataDir,
      ticketId: f.ticketId,
      executionId: 'exec-boundary',
      maxBytes: stderrMax,
    })
    expect(stderrResult.executions[0]!.stderrTruncated).toBe(true)
    expect(stderrResult.executions[0]!.stderr).toBe('safe-stderr\n')
    expect(stderrResult.executions[0]!.stderr).not.toContain(bearer)
    expect(JSON.stringify(stderrResult)).not.toContain(bearer)
  })

  it('keeps complete subsequent lines when the tail boundary is exactly a newline', async () => {
    const f = initFixture()
    f.reserve('exec-newline')
    const head = `${'x'.repeat(40)}dropped-prefix\n`
    const kept = 'kept-line-one\nkept-line-two\n'
    const body = `${head}${kept}`
    f.writeLog('exec-newline', 'stdout.log', body)
    f.writeLog('exec-newline', 'stderr.log', '')
    f.store.close()
    opened.pop()

    const maxBytes = Buffer.byteLength(`\n${kept}`)
    const result = await readExecutionLogs({
      dataDir: f.dataDir,
      ticketId: f.ticketId,
      executionId: 'exec-newline',
      maxBytes,
    })
    expect(result.executions[0]!.stdoutTruncated).toBe(true)
    expect(result.executions[0]!.stdout).toBe(kept)
    expect(result.executions[0]!.stdout).not.toContain('dropped-prefix')
  })

  it('discards a huge truncated no-newline line instead of emitting a bare suffix', async () => {
    const f = initFixture()
    f.reserve('exec-huge')
    const secret = 'sk-ant-api03-hugeline-abcdefghijklmnopqrstuvwxyz'
    const body = `${'z'.repeat(200)}api_key=${secret}`
    f.writeLog('exec-huge', 'stdout.log', body)
    f.writeLog('exec-huge', 'stderr.log', '')
    f.store.close()
    opened.pop()

    const maxBytes = Buffer.byteLength(secret)
    const result = await readExecutionLogs({
      dataDir: f.dataDir,
      ticketId: f.ticketId,
      executionId: 'exec-huge',
      maxBytes,
    })
    expect(result.executions[0]!.stdoutTruncated).toBe(true)
    expect(result.executions[0]!.stdout).toBe('')
    expect(JSON.stringify(result)).not.toContain(secret)
  })

  it('preserves complete multibyte lines after discarding an untrusted leading partial', async () => {
    const f = initFixture()
    f.reserve('exec-multi')
    const head = `${'m'.repeat(30)}partial-secret-suffix`
    const kept = '你好世界\n下一行\n'
    const body = Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(`\n${kept}`, 'utf8')])
    f.writeLog('exec-multi', 'stdout.log', body)
    f.writeLog('exec-multi', 'stderr.log', '')
    f.store.close()
    opened.pop()

    const maxBytes = Buffer.byteLength(`cret-suffix\n${kept}`, 'utf8')
    const result = await readExecutionLogs({
      dataDir: f.dataDir,
      ticketId: f.ticketId,
      executionId: 'exec-multi',
      maxBytes,
    })
    expect(result.executions[0]!.stdoutTruncated).toBe(true)
    expect(result.executions[0]!.stdout).toBe(kept)
    expect(result.executions[0]!.stdout).not.toContain('partial-secret-suffix')
    expect(result.executions[0]!.stdout).not.toContain('cret-suffix')
  })

  it('accepts concurrent append-only growth when the original byte range stays identical', async () => {
    const f = initFixture()
    f.reserve('exec-append')
    const path = f.writeLog('exec-append', 'stdout.log', 'stable-line\n')
    f.writeLog('exec-append', 'stderr.log', '')
    f.store.close()
    opened.pop()

    const before = readFileSync(path)
    let probed = false
    afterReadOf(path, fd => {
      probed = true
      const mid = fstatSync(fd)
      expect(mid.size).toBe(before.length)
      // Concurrent writer grows the file after the primary FD range read.
      appendFileSync(path, 'concurrent-append\n')
      chmodSync(path, 0o600)
      expect(fstatSync(fd).size).toBeGreaterThan(before.length)
      // Prove the original range is still intact on the live FD before double-read.
      const verify = Buffer.alloc(before.length)
      expect(readSync(fd, verify, 0, before.length, 0)).toBe(before.length)
      expect(verify.equals(before)).toBe(true)
    })

    const result = await readExecutionLogs({
      dataDir: f.dataDir,
      ticketId: f.ticketId,
      executionId: 'exec-append',
    })
    expect(probed).toBe(true)
    expect(result.executions[0]!.stdout).toBe('stable-line\n')
    expect(result.executions[0]!.stdout).not.toContain('concurrent-append')
    expect(readFileSync(path).includes(Buffer.from('concurrent-append\n'))).toBe(true)
  })

  it('rejects truncation or in-place rewrite observed across the double-read', async () => {
    const f = initFixture()
    f.reserve('exec-rewrite')
    const path = f.writeLog('exec-rewrite', 'stdout.log', 'original-body\n')
    f.writeLog('exec-rewrite', 'stderr.log', '')
    f.store.close()
    opened.pop()

    let probed = false
    afterReadOf(path, fd => {
      probed = true
      const rewrite = openSync(path, 'r+')
      try {
        writeSync(rewrite, Buffer.from('tampered-body\n'))
      } finally {
        closeSync(rewrite)
      }
      chmodSync(path, 0o600)
      const verify = Buffer.alloc(14)
      expect(readSync(fd, verify, 0, 14, 0)).toBe(14)
      expect(verify.toString('utf8')).toBe('tampered-body\n')
    })

    await expect(readExecutionLogs({
      dataDir: f.dataDir,
      ticketId: f.ticketId,
      executionId: 'exec-rewrite',
    })).rejects.toThrow(/changed while reading/)
    expect(probed).toBe(true)
  })

  it('rejects non-private database files and sanitizes uncertain path-bearing errors', async () => {
    const f = initFixture()
    f.reserve('exec-dbmode')
    f.writeLog('exec-dbmode', 'stdout.log', 'ok\n')
    f.writeLog('exec-dbmode', 'stderr.log', '')
    f.store.close()
    opened.pop()

    const dbPath = join(f.dataDir, 'workforce.sqlite')
    chmodSync(dbPath, 0o644)
    await expect(readExecutionLogs({ dataDir: f.dataDir, ticketId: f.ticketId }))
      .rejects.toThrow(/0600/)
    chmodSync(dbPath, 0o600)

    const secretPath = join(f.dataDir, 'api_key=sk-ant-api03-leakpath-abcdefghijklmnopqrst')
    mkdirSync(secretPath, { mode: 0o700 })
    await expect(readExecutionLogs({ dataDir: secretPath, ticketId: f.ticketId }))
      .rejects.toSatisfy((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        return !message.includes('api_key=') && !message.includes('sk-ant-api03-leakpath')
      })
  })

  it('rejects unknown and foreign-owner tickets', async () => {
    const f = initFixture('owner-1')
    f.reserve('exec-1')
    f.store.close()
    opened.pop()

    await expect(readExecutionLogs({ dataDir: f.dataDir, ticketId: 'missing-ticket' }))
      .rejects.toThrow(/Unknown ticket/)
    await expect(readExecutionLogs({ dataDir: f.dataDir, ticketId: '../escape' }))
      .rejects.toThrow(/Invalid ticketId/)

    const rewrite = new LocalStore(join(f.dataDir, 'workforce.sqlite'))
    opened.push(rewrite)
    const ticket = rewrite.tickets.get(f.ticketId)!
    ticket.mandate = {
      ...ticket.mandate,
      actor: { ...ticket.mandate.actor, id: 'other-owner' },
    }
    rewrite.tickets.save(ticket)
    rewrite.close()
    opened.pop()

    await expect(readExecutionLogs({ dataDir: f.dataDir, ticketId: f.ticketId }))
      .rejects.toThrow(/different owner/)
  })

  it('rejects foreign execution selection and traversal-shaped ids', async () => {
    const f = initFixture()
    f.reserve('exec-a')
    const otherTicket = f.tasks.create({
      issueId: 'issue-2',
      projectId: 'proj-1',
      title: 'Other',
      description: 'Other work',
      taskType: 'docs',
    })
    f.reserve('exec-b', otherTicket.id)
    f.store.close()
    opened.pop()

    await expect(readExecutionLogs({
      dataDir: f.dataDir,
      ticketId: f.ticketId,
      executionId: 'exec-b',
    })).rejects.toThrow(/different ticket/)

    await expect(readExecutionLogs({
      dataDir: f.dataDir,
      ticketId: f.ticketId,
      executionId: '../escape',
    })).rejects.toThrow(/Invalid executionId/)

    await expect(readExecutionLogs({
      dataDir: f.dataDir,
      ticketId: f.ticketId,
      executionId: 'missing-exec',
    })).rejects.toThrow(/Unknown execution/)
  })

  it('fails closed on symlink components in dataDir and runners', async () => {
    const f = initFixture()
    f.reserve('exec-1')
    f.writeLog('exec-1', 'stdout.log', 'ok\n')
    f.writeLog('exec-1', 'stderr.log', '')
    f.store.close()
    opened.pop()

    const base = privateRoot('execution-logs-link-')
    const linkedData = join(base, 'linked-data')
    symlinkSync(f.dataDir, linkedData)
    await expect(readExecutionLogs({ dataDir: linkedData, ticketId: f.ticketId }))
      .rejects.toThrow(/symbolic link|Symbolic link/i)

    rmSync(join(f.dataDir, 'runners'), { recursive: true, force: true })
    const realRunners = join(base, 'real-runners')
    mkdirSync(realRunners, { recursive: true, mode: 0o700 })
    chmodSync(realRunners, 0o700)
    const execDir = join(realRunners, 'exec-1')
    mkdirSync(execDir, { mode: 0o700 })
    writeFileSync(join(execDir, 'stdout.log'), 'via-link\n', { mode: 0o600 })
    writeFileSync(join(execDir, 'stderr.log'), '', { mode: 0o600 })
    symlinkSync(realRunners, join(f.dataDir, 'runners'))
    await expect(readExecutionLogs({ dataDir: f.dataDir, ticketId: f.ticketId }))
      .rejects.toThrow(/symbolic link|Symbolic link|real directory/i)
  })

  it('does not surface request.json control tokens and redacts credential-shaped log text', async () => {
    const f = initFixture()
    f.reserve('exec-secret')
    const token = 'control-token-do-not-leak-0123456789abcdef'
    const execDir = join(f.dataDir, 'runners', 'exec-secret')
    mkdirSync(execDir, { recursive: true, mode: 0o700 })
    writeFileSync(join(execDir, 'request.json'), `${JSON.stringify({ version: 1, token, spec: {} })}\n`, { mode: 0o600 })
    f.writeLog('exec-secret', 'stdout.log', `Bearer ${token}\n`)
    f.writeLog('exec-secret', 'stderr.log', `password=${token}\n`)
    f.store.close()
    opened.pop()

    const result = await readExecutionLogs({ dataDir: f.dataDir, ticketId: f.ticketId, executionId: 'exec-secret' })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain(token)
    expect(result.executions[0]!.stdout).toContain('[REDACTED]')
    expect(result.executions[0]!.stderr).toContain('[REDACTED]')
  })

  it('leaves SQLite and settings bytes unchanged and creates no storage on missing roots', async () => {
    const f = initFixture()
    f.reserve('exec-ro')
    f.writeLog('exec-ro', 'stdout.log', 'stable\n')
    f.writeLog('exec-ro', 'stderr.log', '')
    f.store.close()
    opened.pop()

    const dbPath = join(f.dataDir, 'workforce.sqlite')
    const settingsPath = join(f.dataDir, 'settings.json')
    const stdoutPath = join(f.dataDir, 'runners', 'exec-ro', 'stdout.log')
    const beforeDb = readFileSync(dbPath)
    const beforeSettings = readFileSync(settingsPath)
    const beforeStdout = readFileSync(stdoutPath)

    await readExecutionLogs({ dataDir: f.dataDir, ticketId: f.ticketId })

    expect(readFileSync(dbPath).equals(beforeDb)).toBe(true)
    expect(readFileSync(settingsPath).equals(beforeSettings)).toBe(true)
    expect(readFileSync(stdoutPath).equals(beforeStdout)).toBe(true)

    const empty = privateRoot('execution-logs-empty-')
    const missing = join(empty, 'no-store')
    mkdirSync(missing, { mode: 0o700 })
    await expect(readExecutionLogs({ dataDir: missing, ticketId: 'ticket-1' }))
      .rejects.toThrow(/not initialized|does not exist|Settings/)
    expect(existsSync(join(missing, 'workforce.sqlite'))).toBe(false)
    expect(existsSync(join(missing, 'settings.json'))).toBe(false)
    expect(existsSync(join(missing, 'runners'))).toBe(false)
  })

  it('ignores caller mutation of input fields after the call begins', async () => {
    const f = initFixture()
    f.reserve('exec-mut')
    f.writeLog('exec-mut', 'stdout.log', 'original-scope\n')
    f.writeLog('exec-mut', 'stderr.log', '')
    f.store.close()
    opened.pop()

    const evil = privateRoot('execution-logs-evil-')
    const input = {
      dataDir: f.dataDir,
      ticketId: f.ticketId,
      executionId: 'exec-mut' as string | undefined,
      maxBytes: 64 * 1024 as number | undefined,
    }
    const pending = readExecutionLogs(input)
    input.dataDir = evil
    input.ticketId = 'other-ticket'
    input.executionId = '../etc/passwd'
    input.maxBytes = 1

    const result = await pending
    expect(result.ticketId).toBe(f.ticketId)
    expect(result.executions[0]?.stdout).toBe('original-scope\n')
  })

  it('validates maxBytes bounds and returns persisted state without implying process liveness', async () => {
    const f = initFixture()
    f.reserve('exec-state')
    new ExecutionRepository(f.store.db).markUnknown('exec-state', 'lost observation')
    f.writeLog('exec-state', 'stdout.log', 'still here\n')
    f.writeLog('exec-state', 'stderr.log', '')
    f.store.close()
    opened.pop()

    await expect(readExecutionLogs({ dataDir: f.dataDir, ticketId: f.ticketId, maxBytes: 0 }))
      .rejects.toThrow(/Invalid maxBytes/)
    await expect(readExecutionLogs({ dataDir: f.dataDir, ticketId: f.ticketId, maxBytes: 1024 * 1024 + 1 }))
      .rejects.toThrow(/Invalid maxBytes/)

    const result = await readExecutionLogs({ dataDir: f.dataDir, ticketId: f.ticketId })
    expect(result.executions[0]?.state).toBe('UNKNOWN')
    expect(result.executions[0]?.stdout).toBe('still here\n')
  })

  it('rejects world-readable log files without mutating execution rows', async () => {
    const f = initFixture()
    f.reserve('exec-mode')
    f.writeLog('exec-mode', 'stdout.log', 'secret-body\n', 0o644)
    f.writeLog('exec-mode', 'stderr.log', '')
    f.store.close()
    opened.pop()

    const probe = new DatabaseSync(join(f.dataDir, 'workforce.sqlite'), { readOnly: true })
    try {
      const before = probe.prepare('SELECT count(*) AS n FROM execution').get() as { n: number }
      await expect(readExecutionLogs({ dataDir: f.dataDir, ticketId: f.ticketId }))
        .rejects.toThrow(/0600/)
      const after = probe.prepare('SELECT count(*) AS n FROM execution').get() as { n: number }
      expect(after.n).toBe(before.n)
    } finally {
      probe.close()
    }
  })
})
