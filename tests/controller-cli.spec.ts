/**
 * Controller CLI: foreground control loop, authenticated stop, status, and scoped logs.
 * Owns only this file and src/cli/controller-commands.ts. Parent copies ops deps and index routing.
 */
import { execFile, execFileSync, type ChildProcess } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runControllerCommand } from '../src/cli/controller-commands.ts'
import { acquireControllerLease, inspectController } from '../src/application/controller-lease.ts'
import { createSettings, defaultSettings, loadSettings } from '../src/config/settings.ts'
import { ProjectRepository } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LocalStore } from '../src/storage/store.ts'
import { LocalTaskService } from '../src/application/tasks.ts'
import { ExecutionRepository } from '../src/execution/repository.ts'
import type { ExecutionSpec } from '../src/execution/model.ts'
import type { Rule } from '../src/assessor/rules.ts'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CLI_PATH = resolve(REPO_ROOT, 'dist/cli/index.js')
const NODE = process.execPath
const INDEX_SOURCE = resolve(REPO_ROOT, 'src/cli/index.ts')

let root: string
const opened: LocalStore[] = []
const ownedChildren: ChildProcess[] = []

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'controller-cli-')))
  chmodSync(root, 0o700)
})

afterEach(async () => {
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
  const code = await runControllerCommand(argv, {
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

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    HOME: root,
  }
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: gitEnv(), stdio: 'ignore', timeout: 15_000 })
}

function initGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'controller-cli@example.com'])
  git(dir, ['config', 'user.name', 'Controller CLI'])
  writeFileSync(join(dir, 'README'), 'fixture\n', { mode: 0o600 })
  git(dir, ['add', 'README'])
  git(dir, ['commit', '-m', 'init'])
  return realpathSync(dir)
}

function ownerId(): string {
  if (typeof process.getuid === 'function') return `local-${process.getuid()}`
  const username = process.env.USERNAME ?? process.env.USER ?? ''
  if (/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(username)) return `local-${username}`
  return 'local-owner'
}

function docsRules(): Rule[] {
  return [{
    id: 'documentation',
    enabled: true,
    taskTypes: ['documentation'],
    priority: 10,
    approvalRequired: true,
    reviewRequired: true,
    retryLimit: 2,
  }]
}

function initDataDir(name = 'data', options: { configure?: boolean; pollIntervalMs?: number } = {}): string {
  const dataDir = join(root, name)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  chmodSync(dataDir, 0o700)
  const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
  opened.push(store)
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
      scheduler: {
        pollIntervalMs: options.pollIntervalMs ?? defaults.scheduler.pollIntervalMs,
        maxConcurrency: defaults.scheduler.maxConcurrency,
      },
      rules: defaults.rules.map(rule => ({ ...rule, taskTypes: [...rule.taskTypes] })),
    })
  }
  return realpathSync(dataDir)
}

function seedProject(dataDir: string): void {
  const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
  opened.push(store)
  new ProjectRepository(store.db).create({
    id: 'proj-1',
    workspaceId: 'local',
    name: 'Docs',
    ownerId: ownerId(),
    repositoryPath: initGitRepo(join(root, `repo-${Math.random().toString(16).slice(2)}`)),
    worktreeRoot: join(root, `worktrees-${Math.random().toString(16).slice(2)}`),
    allowedTaskTypes: ['documentation'],
  })
  store.close()
  opened.pop()
}

function seedTicketWithExecution(dataDir: string): { ticketId: string; executionId: string } {
  seedProject(dataDir)
  const store = new LocalStore(join(dataDir, 'workforce.sqlite'))
  opened.push(store)
  const tasks = new LocalTaskService({
    store,
    ownerId: ownerId(),
    rules: docsRules(),
    workspaceId: 'local',
  })
  const ticket = tasks.create({
    issueId: 'issue-1',
    projectId: 'proj-1',
    title: 'Fix docs',
    description: 'Tighten wording',
    taskType: 'documentation',
  })
  const executionId = 'exec-logs-1'
  const cwd = join(root, `cwd-${executionId}`)
  mkdirSync(cwd, { recursive: true, mode: 0o700 })
  const spec: ExecutionSpec = {
    executionId,
    assignmentId: `assign-${executionId}`,
    ticketId: ticket.id,
    agentId: 'emp-1',
    runtime: 'fixture',
    generation: 1,
    cwd,
    inputRevision: 'rev-1',
    policyVersion: 'policy-1',
  }
  new ExecutionRepository(store.db).reserve(spec)
  const runners = join(dataDir, 'runners')
  mkdirSync(runners, { recursive: true, mode: 0o700 })
  chmodSync(runners, 0o700)
  const execDir = join(runners, executionId)
  mkdirSync(execDir, { recursive: true, mode: 0o700 })
  chmodSync(execDir, 0o700)
  writeFileSync(join(execDir, 'stdout.log'), 'hello from stdout\n', { mode: 0o600 })
  writeFileSync(join(execDir, 'stderr.log'), 'hello from stderr\n', { mode: 0o600 })
  store.close()
  opened.pop()
  return { ticketId: ticket.id, executionId }
}

function indexRoutesController(): boolean {
  try {
    const source = readFileSync(INDEX_SOURCE, 'utf8')
    return source.includes('runControllerCommand')
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

describe('runControllerCommand recognition', () => {
  it('returns undefined for unrecognized commands so parent can fall through', async () => {
    expect(await runControllerCommand(['status', '--data-dir', join(root, 'x')])).toBeUndefined()
    expect(await runControllerCommand(['task-create', '--data-dir', join(root, 'x')])).toBeUndefined()
    expect(await runControllerCommand(['--help'])).toBeUndefined()
    expect(await runControllerCommand([])).toBeUndefined()
  })
})

describe('strict parsing', () => {
  it('rejects duplicate, unknown, and missing options without creating storage', async () => {
    const missing = join(root, 'no-db')

    const noForeground = await run('start', '--data-dir', missing)
    expect(noForeground.code).toBe(1)
    expect(noForeground.stderr).toMatch(/--foreground/)
    expect(existsSync(missing)).toBe(false)

    const dupForeground = await run('start', '--foreground', '--foreground', '--data-dir', missing)
    expect(dupForeground.code).toBe(1)
    expect(dupForeground.stderr).toMatch(/only be provided once/)

    const unknown = await run('stop', '--data-dir', missing, '--token', 'evil')
    expect(unknown.code).toBe(1)
    expect(unknown.stderr).toMatch(/Unknown option/)
    expect(existsSync(missing)).toBe(false)

    const dupDataDir = await run('controller-status', '--data-dir', missing, '--data-dir', missing)
    expect(dupDataDir.code).toBe(1)
    expect(dupDataDir.stderr).toMatch(/only be provided once/)

    const missingTicket = await run('logs', '--data-dir', missing)
    expect(missingTicket.code).toBe(1)
    expect(missingTicket.stderr).toMatch(/Missing ticket id/)

    const badTail = await run('logs', 'ticket-1', '--data-dir', missing, '--tail-bytes', '0')
    expect(badTail.code).toBe(1)
    expect(badTail.stderr).toMatch(/tail-bytes/i)
  })
})

describe('missing-data queries do not initialize', () => {
  it('leaves no storage behind for status, stop, logs, and start against missing dirs', async () => {
    const missing = join(root, 'never-init')
    const status = await run('controller-status', '--data-dir', missing)
    expect(status.code).toBe(0)
    expect(status.json).toEqual({ state: 'stopped' })
    expect(existsSync(missing)).toBe(false)
    for (const argv of [
      ['logs', 'ticket-1', '--data-dir', missing],
      ['start', '--foreground', '--data-dir', missing],
    ] as const) {
      const result = await run(...argv)
      expect(result.code).toBe(1)
      expect(existsSync(missing)).toBe(false)
    }

    const stop = await run('stop', '--data-dir', missing)
    expect(stop.code).toBe(0)
    expect(stop.json).toEqual({ requested: false, state: 'stopped' })
    expect(existsSync(missing)).toBe(false)
  })
})

describe('stop requested vs stopped', () => {
  it('reports requested false when no controller is present without opening a database', async () => {
    const dataDir = initDataDir('stopped-empty')
    const before = existsSync(join(dataDir, 'workforce.sqlite'))
    const result = await run('stop', '--data-dir', dataDir)
    expect(result.code).toBe(0)
    expect(result.json).toMatchObject({ requested: false, state: 'stopped' })
    expect(existsSync(join(dataDir, 'controller.lock'))).toBe(false)
    expect(existsSync(join(dataDir, 'workforce.sqlite'))).toBe(before)
  })

  it('requests stop against a live lease without claiming the process already stopped', async () => {
    const dataDir = initDataDir('live-stop')
    const lease = acquireControllerLease({ dataDir })
    try {
      expect(inspectController(dataDir)).toMatchObject({ state: 'running', pid: process.pid })
      const result = await run('stop', '--data-dir', dataDir)
      expect(result.code).toBe(0)
      expect(result.json).toMatchObject({
        requested: true,
        state: 'running',
        pid: process.pid,
      })
      expect(lease.shouldStop()).toBe(true)
    } finally {
      lease.release()
    }
  })
})

describe('controller-status', () => {
  it('inspects without mkdir or migrate and does not imply Runtime health', async () => {
    const dataDir = initDataDir('status-dir')
    const stopped = await run('controller-status', '--data-dir', dataDir)
    expect(stopped.code).toBe(0)
    expect(stopped.json).toEqual({ state: 'stopped' })

    const lease = acquireControllerLease({ dataDir })
    try {
      const running = await run('controller-status', '--data-dir', dataDir)
      expect(running.code).toBe(0)
      expect(running.json).toEqual({ state: 'running', pid: process.pid })
    } finally {
      lease.release()
    }
  })
})

describe('logs scope', () => {
  it('delegates to readExecutionLogs with owner scope and bounded tail', async () => {
    const dataDir = initDataDir('logs-dir')
    const { ticketId, executionId } = seedTicketWithExecution(dataDir)

    const all = await run('logs', ticketId, '--data-dir', dataDir)
    expect(all.code).toBe(0)
    expect(all.json).toMatchObject({
      ticketId,
      executions: [{
        executionId,
        stdout: 'hello from stdout\n',
        stderr: 'hello from stderr\n',
      }],
    })

    const filtered = await run(
      'logs', ticketId,
      '--data-dir', dataDir,
      '--execution-id', executionId,
      '--tail-bytes', '8',
    )
    expect(filtered.code).toBe(0)
    const payload = filtered.json as {
      executions: Array<{ stdout: string; stdoutTruncated: boolean }>
    }
    expect(payload.executions).toHaveLength(1)
    expect(payload.executions[0]!.stdoutTruncated).toBe(true)
    // The only line starts outside this tail window. Its suffix is withheld
    // because the omitted prefix could have identified a credential.
    expect(payload.executions[0]!.stdout).toBe('')

    const foreign = await run('logs', ticketId, '--data-dir', dataDir, '--execution-id', 'exec-other')
    expect(foreign.code).toBe(1)
    expect(foreign.stderr.length).toBeGreaterThan(0)
  })
})

describe('private event path rejection', () => {
  it('rejects a symlink controller-events.jsonl path during start', async () => {
    const dataDir = initDataDir('events-symlink', { pollIntervalMs: 100 })
    const target = join(root, 'foreign-events.jsonl')
    writeFileSync(target, '', { mode: 0o600 })
    symlinkSync(target, join(dataDir, 'controller-events.jsonl'))

    const result = await run('start', '--foreground', '--data-dir', dataDir)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/symbolic link|Controller event|not a regular file/i)
    expect(inspectController(dataDir).state).toBe('stopped')
  })
})

describe('foreground start control loop', () => {
  it('runs against configured settings, writes events, and stops via authenticated request', async () => {
    const dataDir = initDataDir('start-ok', { pollIntervalMs: 100 })
    expect(loadSettings(join(dataDir, 'settings.json')).runtime.command).toBeTruthy()

    const started = run('start', '--foreground', '--data-dir', dataDir)
    await sleep(220)
    const status = await run('controller-status', '--data-dir', dataDir)
    expect(status.json).toMatchObject({ state: 'running' })

    const stop = await run('stop', '--data-dir', dataDir)
    expect(stop.json).toMatchObject({ requested: true })

    const result = await started
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.json).toMatchObject({
      ticks: expect.any(Number),
      errors: expect.any(Number),
    })
    const summary = result.json as { ticks: number; errors: number }
    expect(summary.ticks).toBeGreaterThanOrEqual(0)
    expect(Object.keys(summary).sort()).toEqual(['errors', 'ticks'])

    const eventFile = join(dataDir, 'controller-events.jsonl')
    expect(existsSync(eventFile)).toBe(true)
    expect(statSync(eventFile).mode & 0o777).toBe(0o600)
    const eventText = readFileSync(eventFile, 'utf8')
    expect(eventText).toMatch(/startup_reconciled/)
    expect(eventText).toMatch(/shutdown_reconciled|tick_completed/)
    expect(result.stdout).toContain('startup_reconciled')
    expect(inspectController(dataDir).state).toBe('stopped')
  })

  it('ignores a valid mismatched stop token and only stops on authenticated request', async () => {
    const dataDir = initDataDir('mismatch-stop', { pollIntervalMs: 100 })
    const started = run('start', '--foreground', '--data-dir', dataDir)
    await sleep(220)
    expect(inspectController(dataDir)).toMatchObject({ state: 'running' })

    const stopPath = join(dataDir, 'controller.lock', 'stop.json')
    writeFileSync(stopPath, `${JSON.stringify({
      version: 1,
      token: '0'.repeat(64),
      requestedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 })
    chmodSync(stopPath, 0o600)

    await sleep(250)
    expect(inspectController(dataDir)).toMatchObject({ state: 'running', pid: expect.any(Number) })

    const stop = await run('stop', '--data-dir', dataDir)
    expect(stop.json).toMatchObject({ requested: true })
    const result = await started
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.json).toMatchObject({ ticks: expect.any(Number), errors: expect.any(Number) })
    expect(inspectController(dataDir).state).toBe('stopped')
  })

  it('fails closed on in-place owner token replacement via actual lease helper', async () => {
    const dataDir = initDataDir('owner-token-replaced', { pollIntervalMs: 100 })
    const started = run('start', '--foreground', '--data-dir', dataDir)
    await sleep(220)
    expect(inspectController(dataDir)).toMatchObject({ state: 'running' })

    const ownerPath = join(dataDir, 'controller.lock', 'owner.json')
    const original = JSON.parse(readFileSync(ownerPath, 'utf8')) as {
      version: number
      pid: number
      token: string
      startedAt: string
    }
    expect(original.token).toHaveLength(64)
    writeFileSync(ownerPath, `${JSON.stringify({
      ...original,
      token: 'a'.repeat(64),
    })}\n`, { mode: 0o600 })
    chmodSync(ownerPath, 0o600)

    const result = await started
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/lease was lost|ownership was lost|release failed/i)
    const successSummaries = result.jsonLines.filter(value => (
      value !== null
      && typeof value === 'object'
      && 'ticks' in value
      && 'errors' in value
      && !('kind' in value)
    ))
    expect(successSummaries).toHaveLength(0)
  })

  it('maps malformed stop evidence thrown by lease.shouldStop to nonzero', async () => {
    const dataDir = initDataDir('malformed-stop', { pollIntervalMs: 100 })
    const started = run('start', '--foreground', '--data-dir', dataDir)
    await sleep(220)
    expect(inspectController(dataDir)).toMatchObject({ state: 'running' })

    const stopPath = join(dataDir, 'controller.lock', 'stop.json')
    writeFileSync(stopPath, '{not-json\n', { mode: 0o600 })
    chmodSync(stopPath, 0o600)

    const result = await started
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/malformed|lease was lost|ownership/i)
    const successSummaries = result.jsonLines.filter(value => (
      value !== null
      && typeof value === 'object'
      && 'ticks' in value
      && 'errors' in value
      && !('kind' in value)
    ))
    expect(successSummaries).toHaveLength(0)
  })

  it('reports nonzero when ownership is replaced so lease.release cannot fake success', async () => {
    const dataDir = initDataDir('release-ownership-loss', { pollIntervalMs: 100 })
    const started = run('start', '--foreground', '--data-dir', dataDir)
    await sleep(220)
    expect(inspectController(dataDir)).toMatchObject({ state: 'running' })

    const lockDir = join(dataDir, 'controller.lock')
    const moved = join(dataDir, 'controller.lock.moved')
    renameSync(lockDir, moved)
    mkdirSync(lockDir, { mode: 0o700 })
    chmodSync(lockDir, 0o700)
    writeFileSync(join(lockDir, 'owner.json'), `${JSON.stringify({
      version: 1,
      pid: process.pid,
      token: 'f'.repeat(64),
      startedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600, flag: 'wx' })
    chmodSync(join(lockDir, 'owner.json'), 0o600)

    const result = await started
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/lease was lost|ownership was lost|release failed/i)
    const successSummaries = result.jsonLines.filter(value => (
      value !== null
      && typeof value === 'object'
      && 'ticks' in value
      && 'errors' in value
      && !('kind' in value)
    ))
    expect(successSummaries).toHaveLength(0)
    expect(existsSync(join(lockDir, 'owner.json'))).toBe(true)
    expect(readFileSync(join(lockDir, 'owner.json'), 'utf8')).toContain('f'.repeat(64))
    expect(existsSync(moved)).toBe(true)
  })

  it('fails closed when runtime command is not configured', async () => {
    const dataDir = initDataDir('no-runtime', { configure: false })
    createSettings(join(dataDir, 'settings.json'), defaultSettings({ ownerId: ownerId() }))
    const result = await run('start', '--foreground', '--data-dir', dataDir)
    expect(result.code).toBe(1)
    expect(result.stderr).toMatch(/not configured/i)
    expect(existsSync(join(dataDir, 'controller.lock'))).toBe(false)
  })
})

describe('compiled controller child process', () => {
  it('requires parent index routing before exercising dist/cli/index.js', async () => {
    if (!indexRoutesController()) {
      throw new Error(
        'Missing dependency: src/cli/index.ts must route runControllerCommand before runTaskCommand/runCli '
        + '(parent-owned). Until routed, compiled child-process controller acceptance cannot run.',
      )
    }
    if (!existsSync(CLI_PATH)) {
      throw new Error(`Missing dependency: built CLI at ${CLI_PATH}; run pnpm build after parent routing`)
    }

    const dataDir = initDataDir('compiled-child', { pollIntervalMs: 100 })
    const child = execFile(
      NODE,
      [CLI_PATH, 'start', '--foreground', '--data-dir', dataDir],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          LANG: 'C',
          LC_ALL: 'C',
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      () => { /* settled via promise wrapper below */ },
    )
    if (child.pid && child.pid > 1) ownedChildren.push(child)

    const exit = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolvePromise) => {
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', chunk => { stdout += String(chunk) })
      child.stderr?.on('data', chunk => { stderr += String(chunk) })
      child.on('exit', code => resolvePromise({ code, stdout, stderr }))
    })

    await sleep(250)
    const stop = await run('stop', '--data-dir', dataDir)
    expect(stop.json).toMatchObject({ requested: true })
    const finished = await exit
    expect(finished.code).toBe(0)
    expect(finished.stdout).toMatch(/startup_reconciled/)
    expect(finished.stdout).toMatch(/"ticks":/)
  })
})
