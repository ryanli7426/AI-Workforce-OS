/**
 * Compiled controller acceptance: real child processes against dist/cli/index.js.
 * The repository contract builds dist before Vitest runs this file.
 */
import { execFile, execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TERMINAL_EXECUTION_STATES } from '../src/execution/model.ts'
import { RunnerClient } from '../src/runner/client.ts'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CLI_PATH = resolve(REPO_ROOT, 'dist/cli/index.js')
const WORKER_PATH = resolve(REPO_ROOT, 'dist/runner/worker.js')
const NODE = process.execPath

const TEST_TIMEOUT_MS = 60_000
const CLI_TIMEOUT_MS = 12_000
const POLL_TIMEOUT_MS = 18_000
const FIXTURE_DELAY_MS = 3_000
const MARKER_FILE = 'ORIGINAL_MARKER.txt'
const ORIGINAL_README = 'controller acceptance typoo\n'
const ORIGINAL_MARKER = 'original repository remains untouched\n'

const FIXTURE_RUNTIME_SOURCE = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const cwd = process.cwd()
appendFileSync(join(cwd, '.fixture-launch-count'), String(process.pid) + '\\n', { encoding: 'utf8' })
await delay(${FIXTURE_DELAY_MS})
const readme = join(cwd, 'README.md')
writeFileSync(readme, readFileSync(readme, 'utf8').replaceAll('typoo', 'typo'), { encoding: 'utf8' })
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Updated only the assigned worktree.',
  session_id: 'compiled-controller-fixture',
  usage: {
    input_tokens: 3,
    output_tokens: 2,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0
  }
}) + '\\n')
`

interface CliResult {
  code: number
  stdout: string
  stderr: string
  json: unknown
}

interface ExecutionRow {
  executionId: string
  state: string
  cwd: string
  runnerPid?: number
  processId?: number
}

interface ControllerStatus {
  state: 'stopped' | 'running' | 'unknown'
  pid?: number
}

interface ExitResult {
  code: number | null
  signal: NodeJS.Signals | null
}

interface ForegroundController {
  child: ChildProcessWithoutNullStreams
  stdout: string
  stderr: string
  exit: Promise<ExitResult>
}

interface TaskFixture {
  dataDir: string
  repositoryPath: string
  worktreeRoot: string
  ticketId: string
  originalReadme: Buffer
  originalMarker: Buffer
}

let root: string
let unrelatedCwd: string
const controllers = new Set<ForegroundController>()
const dataDirs = new Set<string>()
const executionIds = new Map<string, Set<string>>()

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'compiled-controller-')))
  chmodSync(root, 0o700)
  unrelatedCwd = join(root, 'unrelated-cwd')
  mkdirSync(unrelatedCwd, { mode: 0o700 })
  controllers.clear()
  dataDirs.clear()
  executionIds.clear()
})

afterEach(async () => {
  for (const dataDir of dataDirs) {
    try { await runCli(['stop', '--data-dir', dataDir], 2_000) } catch { /* cleanup continues below */ }
  }
  for (const controller of controllers) await stopFreshController(controller)
  await stopOwnedRunners()
  rmSync(root, { recursive: true, force: true })
})

function childEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    HOME: root,
    TMPDIR: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function parseJsonLines(text: string): unknown[] {
  const values: unknown[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { values.push(JSON.parse(line) as unknown) } catch { /* stderr and partial output are not JSON */ }
  }
  return values
}

function lastJson(text: string): unknown {
  return parseJsonLines(text).at(-1)
}

function runCli(args: readonly string[], timeoutMs = CLI_TIMEOUT_MS): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      NODE,
      [CLI_PATH, ...args],
      {
        cwd: unrelatedCwd,
        env: childEnv(),
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : String(stdout ?? '')
        const err = typeof stderr === 'string' ? stderr : String(stderr ?? '')
        if (error && 'killed' in error && (error as { killed?: boolean }).killed) {
          reject(new Error(`CLI timed out after ${timeoutMs}ms: ${args.join(' ')}\n${err}`))
          return
        }
        const code = error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : error
            ? 1
            : 0
        resolvePromise({ code, stdout: out, stderr: err, json: lastJson(out) })
      },
    )
  })
}

function startController(dataDir: string): ForegroundController {
  dataDirs.add(dataDir)
  const child = spawn(NODE, [CLI_PATH, 'start', '--foreground', '--data-dir', dataDir], {
    cwd: unrelatedCwd,
    env: childEnv(),
    stdio: 'pipe',
  })
  child.stdin.end()
  const controller: ForegroundController = {
    child,
    stdout: '',
    stderr: '',
    exit: new Promise(resolvePromise => {
      child.once('exit', (code, signal) => resolvePromise({ code, signal }))
    }),
  }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', chunk => { controller.stdout += String(chunk) })
  child.stderr.on('data', chunk => { controller.stderr += String(chunk) })
  controllers.add(controller)
  return controller
}

async function waitForExit(controller: ForegroundController, timeoutMs = 8_000): Promise<ExitResult> {
  return await Promise.race([
    controller.exit,
    sleep(timeoutMs).then(() => { throw new Error(`Controller did not exit in ${timeoutMs}ms: ${controller.stderr}`) }),
  ])
}

function childHasExited(controller: ForegroundController): boolean {
  return controller.child.exitCode !== null || controller.child.signalCode !== null
}

async function stopFreshController(controller: ForegroundController): Promise<void> {
  if (childHasExited(controller)) return
  controller.child.kill('SIGTERM')
  try {
    await waitForExit(controller, 2_000)
  } catch {
    if (!childHasExited(controller)) controller.child.kill('SIGKILL')
    try { await waitForExit(controller, 2_000) } catch { /* only the fresh handle was signalled */ }
  }
}

async function poll<T>(label: string, operation: () => Promise<T | undefined>, timeoutMs = POLL_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      const result = await operation()
      if (result !== undefined) return result
    } catch (error) {
      lastError = error
    }
    await sleep(75)
  }
  const detail = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`Timed out waiting for ${label}${detail}`)
}

function isAlive(pid: number | undefined): boolean {
  if (!Number.isSafeInteger(pid) || pid === undefined || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function git(cwd: string, args: readonly string[]): void {
  execFileSync('git', args, {
    cwd,
    env: childEnv(),
    stdio: 'ignore',
    timeout: 10_000,
  })
}

function initGitRepository(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  git(path, ['init'])
  git(path, ['config', 'user.email', 'controller-acceptance@example.com'])
  git(path, ['config', 'user.name', 'Controller Acceptance'])
  writeFileSync(join(path, 'README.md'), ORIGINAL_README, { mode: 0o600 })
  writeFileSync(join(path, MARKER_FILE), ORIGINAL_MARKER, { mode: 0o600 })
  git(path, ['add', 'README.md', MARKER_FILE])
  git(path, ['commit', '-m', 'fixture'])
  return realpathSync(path)
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

function installFixtureRuntime(): string {
  const path = join(root, 'fixture-runtime.mjs')
  writeFileSync(path, FIXTURE_RUNTIME_SOURCE, { mode: 0o755 })
  chmodSync(path, 0o755)
  return realpathSync(path)
}

async function expectCliSuccess(args: readonly string[]): Promise<CliResult> {
  const result = await runCli(args)
  expect(result.code, result.stderr).toBe(0)
  return result
}

async function createApprovedTask(name: string): Promise<TaskFixture> {
  const dataDir = join(root, `${name}-data`)
  dataDirs.add(dataDir)
  await expectCliSuccess(['init', '--data-dir', dataDir])
  const runtime = installFixtureRuntime()
  const configured = await expectCliSuccess(['configure', '--data-dir', dataDir, '--claude-command', runtime])
  const runtimeId = (configured.json as { runtime: { id: string } }).runtime.id

  // Keep the real configure contract, then use a valid settings value to make polling deterministic.
  const settingsPath = join(dataDir, 'settings.json')
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { scheduler: { pollIntervalMs: number } }
  settings.scheduler.pollIntervalMs = 100
  writeJson(settingsPath, settings)
  chmodSync(settingsPath, 0o600)

  const repositoryPath = initGitRepository(join(root, `${name}-repository`))
  const worktreeRoot = join(root, `${name}-worktrees`)
  mkdirSync(worktreeRoot, { mode: 0o700 })

  const projectId = `project-${name}`
  const projectFile = join(root, `${name}-project.json`)
  writeJson(projectFile, {
    id: projectId,
    name: `Controller ${name}`,
    ownerId: 'owner-local',
    repositoryPath,
    worktreeRoot,
    allowedTaskTypes: ['documentation'],
  })
  await expectCliSuccess(['project-create', '--data-dir', dataDir, '--file', projectFile])

  const employeeId = `employee-${name}`
  const employeeFile = join(root, `${name}-employee.json`)
  writeJson(employeeFile, {
    id: employeeId,
    name: `Controller ${name} worker`,
    role: 'documentation',
    responsibilities: ['edit assigned documentation'],
    capabilities: ['documentation'],
    runtimeId,
    projectIds: [projectId],
    maxConcurrency: 1,
    timeoutMs: 30_000,
  })
  await expectCliSuccess(['employee-create', '--data-dir', dataDir, '--file', employeeFile])
  await expectCliSuccess(['employee-enable', employeeId, '--data-dir', dataDir, '--version', '1'])

  const taskFile = join(root, `${name}-task.json`)
  writeJson(taskFile, {
    project: projectId,
    issue: `issue-${name}`,
    title: 'Fix the documented typo',
    description: 'Replace typoo with typo in README.md and do not modify the source checkout.',
    taskType: 'documentation',
  })
  const created = await expectCliSuccess(['task-create', '--data-dir', dataDir, '--file', taskFile])
  const ticketId = (created.json as { id: string; lifecycle: { status: string } }).id
  expect((created.json as { lifecycle: { status: string } }).lifecycle.status).toBe('WAITING_APPROVAL')
  const approved = await expectCliSuccess([
    'task-approve', ticketId,
    '--data-dir', dataDir,
    '--reason', 'Approved for compiled controller acceptance',
  ])
  expect(approved.json).toMatchObject({ lifecycle: { status: 'QUEUED' } })

  return {
    dataDir,
    repositoryPath,
    worktreeRoot,
    ticketId,
    originalReadme: readFileSync(join(repositoryPath, 'README.md')),
    originalMarker: readFileSync(join(repositoryPath, MARKER_FILE)),
  }
}

async function runningStatus(dataDir: string): Promise<ControllerStatus> {
  return await poll('controller running status', async () => {
    const result = await runCli(['controller-status', '--data-dir', dataDir])
    if (result.code !== 0) return undefined
    const status = result.json as ControllerStatus
    return status.state === 'running' && isAlive(status.pid) ? status : undefined
  })
}

async function runningExecution(fixture: TaskFixture): Promise<ExecutionRow> {
  return await poll('a running execution', async () => {
    const result = await runCli(['executions', '--data-dir', fixture.dataDir])
    if (result.code !== 0 || !Array.isArray(result.json)) return undefined
    const rows = result.json as ExecutionRow[]
    const row = rows.length === 1 && rows[0]?.state === 'RUNNING' ? rows[0] : undefined
    if (!row) return undefined
    rememberExecution(fixture.dataDir, row.executionId)
    const tickets = await runCli(['tickets', '--data-dir', fixture.dataDir])
    const ticket = Array.isArray(tickets.json)
      ? (tickets.json as Array<{ id: string; status: string }>).find(item => item.id === fixture.ticketId)
      : undefined
    return ticket?.status === 'RUNNING' ? row : undefined
  })
}

function rememberExecution(dataDir: string, executionId: string): void {
  const ids = executionIds.get(dataDir) ?? new Set<string>()
  ids.add(executionId)
  executionIds.set(dataDir, ids)
}

async function awaitReview(fixture: TaskFixture, executionId: string): Promise<ExecutionRow> {
  return await poll('the same execution to reach REVIEW', async () => {
    const executions = await runCli(['executions', '--data-dir', fixture.dataDir])
    if (executions.code !== 0 || !Array.isArray(executions.json)) return undefined
    const rows = executions.json as ExecutionRow[]
    for (const row of rows) rememberExecution(fixture.dataDir, row.executionId)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.executionId).toBe(executionId)

    const tickets = await runCli(['tickets', '--data-dir', fixture.dataDir])
    if (tickets.code !== 0 || !Array.isArray(tickets.json)) return undefined
    const ticket = (tickets.json as Array<{ id: string; status: string }>).find(item => item.id === fixture.ticketId)
    expect(ticket?.status).not.toBe('DONE')
    return ticket?.status === 'REVIEW' ? rows[0] : undefined
  })
}

function assertSingleLaunchAndIsolatedChange(fixture: TaskFixture, execution: ExecutionRow): void {
  const launches = readFileSync(join(execution.cwd, '.fixture-launch-count'), 'utf8').trim().split(/\r?\n/)
  expect(launches).toHaveLength(1)
  expect(readFileSync(join(fixture.repositoryPath, 'README.md'))).toEqual(fixture.originalReadme)
  expect(readFileSync(join(fixture.repositoryPath, MARKER_FILE))).toEqual(fixture.originalMarker)
  expect(readFileSync(join(execution.cwd, 'README.md'), 'utf8')).toBe('controller acceptance typo\n')
  expect(readFileSync(join(execution.cwd, MARKER_FILE))).toEqual(fixture.originalMarker)
}

async function gracefulStop(dataDir: string, controller: ForegroundController): Promise<void> {
  const stopped = await runCli(['stop', '--data-dir', dataDir])
  expect(stopped.code, stopped.stderr).toBe(0)
  expect(stopped.json).toMatchObject({ requested: true })
  expect(await waitForExit(controller)).toEqual({ code: 0, signal: null })
  const status = await runCli(['controller-status', '--data-dir', dataDir])
  expect(status.code, status.stderr).toBe(0)
  expect(status.json).toMatchObject({ state: 'stopped' })
}

async function stopOwnedRunners(): Promise<void> {
  for (const dataDir of dataDirs) {
    if (!existsSync(join(dataDir, 'runners'))) continue
    const ids = executionIds.get(dataDir) ?? new Set<string>()
    try {
      const listed = await runCli(['executions', '--data-dir', dataDir], 2_000)
      if (listed.code === 0 && Array.isArray(listed.json)) {
        for (const row of listed.json as ExecutionRow[]) ids.add(row.executionId)
      }
    } catch { /* use already observed execution identities */ }
    const client = new RunnerClient({ root: join(dataDir, 'runners'), workerPath: WORKER_PATH })
    for (const executionId of ids) {
      try { await client.stop(executionId, 'compiled controller acceptance cleanup') } catch { /* terminal/missing */ }
      const deadline = Date.now() + 6_000
      while (Date.now() < deadline) {
        try {
          const snapshot = await client.status(executionId)
          if ((TERMINAL_EXECUTION_STATES as readonly string[]).includes(snapshot.state)) break
        } catch {
          break
        }
        await sleep(75)
      }
    }
  }
}

describe('compiled foreground controller process acceptance', () => {
  it('owns one live controller, persists a private startup event, and stops through its authenticated channel', async () => {
    const missing = join(root, 'missing-data')
    const missingStatus = await runCli(['controller-status', '--data-dir', missing])
    expect(missingStatus.code, missingStatus.stderr).toBe(0)
    expect(missingStatus.json).toMatchObject({ state: 'stopped' })
    expect(existsSync(missing)).toBe(false)
    const missingStop = await runCli(['stop', '--data-dir', missing])
    expect(missingStop.code, missingStop.stderr).toBe(0)
    expect(missingStop.json).toMatchObject({ requested: false })
    expect(existsSync(missing)).toBe(false)

    const fixture = await createApprovedTask('lease')
    // This case exercises controller lifecycle only; cancel before it can dispatch queued work.
    await expectCliSuccess([
      'task-cancel', fixture.ticketId,
      '--data-dir', fixture.dataDir,
      '--reason', 'Lease-only acceptance case',
    ])

    const first = startController(fixture.dataDir)
    const status = await runningStatus(fixture.dataDir)
    expect(status.pid).toBe(first.child.pid)
    expect(isAlive(first.child.pid)).toBe(true)

    await poll('startup_reconciled event', async () => {
      const events = parseJsonLines(first.stdout) as Array<{ kind?: string }>
      return events.some(event => event.kind === 'startup_reconciled') ? true : undefined
    })

    const owner = JSON.parse(readFileSync(join(fixture.dataDir, 'controller.lock', 'owner.json'), 'utf8')) as { token: string }
    expect(owner.token).toMatch(/^[0-9a-f]+$/)
    expect(first.stdout).not.toContain(owner.token)
    expect(first.stderr).not.toContain(owner.token)

    const second = await runCli(['start', '--foreground', '--data-dir', fixture.dataDir])
    expect(second.code).toBe(1)
    expect(second.stderr).toMatch(/controller|lease|running|owned/i)
    expect(second.stdout).not.toContain(owner.token)
    expect(second.stderr).not.toContain(owner.token)

    const stop = await runCli(['stop', '--data-dir', fixture.dataDir])
    expect(stop.code, stop.stderr).toBe(0)
    expect(stop.json).toMatchObject({ requested: true })
    expect(stop.stdout).not.toContain(owner.token)
    expect(stop.stderr).not.toContain(owner.token)
    expect(await waitForExit(first)).toEqual({ code: 0, signal: null })

    const eventsPath = join(fixture.dataDir, 'controller-events.jsonl')
    const eventBytes = readFileSync(eventsPath)
    expect(eventBytes.byteLength).toBeGreaterThan(0)
    if (process.platform !== 'win32') expect(statSync(eventsPath).mode & 0o777).toBe(0o600)
    expect(eventBytes.toString('utf8')).not.toContain(owner.token)
    expect((parseJsonLines(eventBytes.toString('utf8')) as Array<{ kind?: string }>))
      .toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'startup_reconciled' })]))

    const finalStatus = await runCli(['controller-status', '--data-dir', fixture.dataDir])
    expect(finalStatus.code, finalStatus.stderr).toBe(0)
    expect(finalStatus.json).toMatchObject({ state: 'stopped' })
  }, TEST_TIMEOUT_MS)

  it('leaves a running Runner alive across a graceful controller restart without duplicate launch', async () => {
    const fixture = await createApprovedTask('restart')
    const first = startController(fixture.dataDir)
    await runningStatus(fixture.dataDir)
    const running = await runningExecution(fixture)

    const stop = await runCli(['stop', '--data-dir', fixture.dataDir])
    expect(stop.code, stop.stderr).toBe(0)
    expect(stop.json).toMatchObject({ requested: true })
    expect(await waitForExit(first)).toEqual({ code: 0, signal: null })

    const runner = new RunnerClient({ root: join(fixture.dataDir, 'runners'), workerPath: WORKER_PATH })
    const active = await runner.status(running.executionId)
    expect(active.state).toBe('RUNNING')
    expect(isAlive(active.runnerPid)).toBe(true)
    expect(isAlive(active.processId)).toBe(true)

    const restarted = startController(fixture.dataDir)
    const restartedStatus = await runningStatus(fixture.dataDir)
    expect(restartedStatus.pid).toBe(restarted.child.pid)
    const reviewed = await awaitReview(fixture, running.executionId)
    expect(reviewed.executionId).toBe(running.executionId)
    assertSingleLaunchAndIsolatedChange(fixture, reviewed)

    const tickets = await runCli(['tickets', '--data-dir', fixture.dataDir])
    expect((tickets.json as Array<{ id: string; status: string }>).find(item => item.id === fixture.ticketId)?.status)
      .toBe('REVIEW')
    await gracefulStop(fixture.dataDir, restarted)
  }, TEST_TIMEOUT_MS)

  it('recovers a freshly killed controller lease while preserving the live Runner and execution identity', async () => {
    const fixture = await createApprovedTask('crash')
    const first = startController(fixture.dataDir)
    await runningStatus(fixture.dataDir)
    const running = await runningExecution(fixture)

    expect(first.child.kill('SIGKILL')).toBe(true)
    const killed = await waitForExit(first)
    expect(killed.code).toBeNull()
    expect(killed.signal).toBe('SIGKILL')

    const runner = new RunnerClient({ root: join(fixture.dataDir, 'runners'), workerPath: WORKER_PATH })
    const afterCrash = await runner.status(running.executionId)
    expect(afterCrash.state).toBe('RUNNING')
    expect(isAlive(afterCrash.runnerPid)).toBe(true)
    expect(isAlive(afterCrash.processId)).toBe(true)

    const recovered = startController(fixture.dataDir)
    const recoveredStatus = await runningStatus(fixture.dataDir)
    expect(recoveredStatus.pid).toBe(recovered.child.pid)
    expect(recoveredStatus.pid).not.toBe(first.child.pid)

    const reviewed = await awaitReview(fixture, running.executionId)
    expect(reviewed.executionId).toBe(running.executionId)
    assertSingleLaunchAndIsolatedChange(fixture, reviewed)
    await gracefulStop(fixture.dataDir, recovered)
  }, TEST_TIMEOUT_MS)
})
