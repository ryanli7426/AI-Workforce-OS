/**
 * Compiled Task CLI E2E smoke: real child processes against dist/cli/index.js.
 * Owns only this file. Parent supplies reviewed CLI/settings/orchestrator/management deps.
 */
import { execFile, execFileSync } from 'node:child_process'
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

const CLI_TIMEOUT_MS = 20_000
const HAPPY_PATH_TIMEOUT_MS = 60_000
const POLL_TIMEOUT_MS = 20_000
const STOP_AWAIT_MS = 8_000
const DETACH_WAIT_MS = 1_600
const MARKER_BODY = 'original-untouched\n'
const MARKER_FILE = 'SMOKE_MARKER.txt'

/**
 * Minimal mock Claude CLI written into the private temp root only.
 * Same JSON result contract as ClaudeCodeAdapter / orchestrator fixture.
 */
const MOCK_CLAUDE_SOURCE = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
const args = process.argv.slice(2)
const prompt = typeof args[args.length - 1] === 'string' ? args[args.length - 1] : ''
const cwd = process.cwd()
appendFileSync(join(cwd, '.fixture-launch-count'), \`\${process.pid}\\n\`, { encoding: 'utf8' })
function modeFromPrompt() {
  const match = /FIXTURE_MODE=([a-z0-9_-]+)/i.exec(prompt)
  if (match) return match[1].toLowerCase()
  return 'success'
}
function successResult(resultText) {
  return JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: resultText,
    session_id: 'fixture-session',
    usage: { input_tokens: 3, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  })
}
function applyTypoFix() {
  const readme = join(cwd, 'README.md')
  if (existsSync(readme)) {
    writeFileSync(readme, readFileSync(readme, 'utf8').replaceAll('typoo', 'typo'), { encoding: 'utf8' })
  } else {
    writeFileSync(join(cwd, 'RESULT.txt'), 'fixture-ok\\n', { encoding: 'utf8' })
  }
}
const mode = modeFromPrompt()
if (mode === 'success') {
  await delay(150)
  applyTypoFix()
  process.stdout.write(\`\${successResult('Updated local files for the authorized task.')}\\n\`)
} else if (mode === 'wait-success') {
  const duration = Number.parseInt(/FIXTURE_WAIT_MS=(\\d+)/i.exec(prompt)?.[1] ?? '1600', 10)
  await delay(Number.isFinite(duration) ? duration : 1_600)
  applyTypoFix()
  process.stdout.write(\`\${successResult('Updated local files after wait-success.')}\\n\`)
} else if (mode === 'wait') {
  const duration = Number.parseInt(/FIXTURE_WAIT_MS=(\\d+)/i.exec(prompt)?.[1] ?? '30000', 10)
  process.stdout.write('fixture waiting\\n')
  await delay(Number.isFinite(duration) ? duration : 30_000)
  process.stdout.write(\`\${successResult('Wait finished')}\\n\`)
} else {
  process.stderr.write(\`unknown fixture mode: \${mode}\\n\`)
  process.exitCode = 1
}
`

/** Independent content check: README typo fixed; marker proves unrelated content untouched. */
const CONTENT_CHECK_SCRIPT = [
  "const fs=require('fs');",
  "const readme=fs.readFileSync('README.md','utf8');",
  "if(!readme.includes('typo')||readme.includes('typoo')){",
  "process.stderr.write('README typo not fixed\\n');process.exit(1)}",
  `const marker=fs.readFileSync(${JSON.stringify(MARKER_FILE)},'utf8');`,
  `if(marker!==${JSON.stringify(MARKER_BODY)}){`,
  "process.stderr.write('marker/original content altered\\n');process.exit(1)}",
].join('')

interface CliResult {
  code: number
  stdout: string
  stderr: string
  json: unknown
}

interface ExecutionRow {
  executionId: string
  state: string
  cwd?: string
  processId?: number
  runnerPid?: number
}

let root: string
let unrelatedCwd: string
let mockClaudePath: string | undefined
/** Fresh execution IDs started by this test; never harvest historical PIDs for signals. */
const ownedExecutionIds = new Set<string>()
const ownedRunnerRoots = new Set<string>()

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'compiled-task-cli-')))
  chmodSync(root, 0o700)
  unrelatedCwd = join(root, 'unrelated-cwd')
  mkdirSync(unrelatedCwd, { mode: 0o700 })
  mockClaudePath = undefined
  ownedExecutionIds.clear()
  ownedRunnerRoots.clear()
})

afterEach(async () => {
  await stopOwnedExecutions()
  rmSync(root, { recursive: true, force: true })
})

function sleep(ms: number): Promise<void> {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function parseJsonStdout(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (!trimmed) return undefined
  const lines = trimmed.split(/\r?\n/).filter(line => line.length > 0)
  const candidate = lines.find(line => line.startsWith('{') || line.startsWith('[')) ?? lines[lines.length - 1]!
  try {
    return JSON.parse(candidate) as unknown
  } catch {
    return undefined
  }
}

function runCli(args: readonly string[], timeoutMs = CLI_TIMEOUT_MS): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      NODE,
      [CLI_PATH, ...args],
      {
        cwd: unrelatedCwd,
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          LANG: 'C',
          LC_ALL: 'C',
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
        },
        timeout: timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        killSignal: 'SIGKILL',
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
        resolvePromise({ code, stdout: out, stderr: err, json: parseJsonStdout(out) })
      },
    )
  })
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

function initGitRepo(dir: string, body = 'hello typoo world\n'): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'compiled-smoke@example.com'])
  git(dir, ['config', 'user.name', 'Compiled Smoke'])
  writeFileSync(join(dir, 'README.md'), body, { mode: 0o600 })
  writeFileSync(join(dir, MARKER_FILE), MARKER_BODY, { mode: 0o600 })
  git(dir, ['add', 'README.md', MARKER_FILE])
  git(dir, ['commit', '-m', 'init'])
  return realpathSync(dir)
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

function installMockClaude(): string {
  const script = join(root, 'mock-claude.mjs')
  writeFileSync(script, MOCK_CLAUDE_SOURCE, { mode: 0o755 })
  chmodSync(script, 0o755)
  const launcher = join(root, 'claude-command')
  writeFileSync(
    launcher,
    `#!/bin/sh\nexec ${JSON.stringify(NODE)} ${JSON.stringify(script)} "$@"\n`,
    { mode: 0o755 },
  )
  chmodSync(launcher, 0o755)
  mockClaudePath = realpathSync(script)
  return realpathSync(launcher)
}

function writeContentChecksFile(path: string): void {
  writeJson(path, [
    {
      id: 'readme-typo-and-marker',
      command: NODE,
      args: ['-e', CONTENT_CHECK_SCRIPT],
      timeoutMs: 10_000,
    },
  ])
}

function isAlive(pid: number | undefined | null): boolean {
  if (!Number.isSafeInteger(pid) || pid == null || pid <= 1 || pid === process.pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** POSIX process identity: Linux /proc cmdline, else ps command line. */
function processIdentity(pid: number): string | undefined {
  if (process.platform === 'linux') {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
    } catch {
      return undefined
    }
  }
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
      timeout: 2_000,
      env: gitEnv(),
    }).trim()
  } catch {
    return undefined
  }
}

function isOwnedLiveProcess(pid: number): boolean {
  if (!isAlive(pid)) return false
  const identity = processIdentity(pid)
  if (!identity) return false
  const hints = [
    WORKER_PATH,
    'dist/runner/worker.js',
    mockClaudePath,
    mockClaudePath ? resolve(mockClaudePath) : undefined,
    root,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
  return hints.some(hint => identity.includes(hint))
}

function forceKillOwnedPid(pid: number): void {
  if (!isOwnedLiveProcess(pid)) return
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL')
  } catch {
    try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  }
}

async function awaitRunnerStopped(client: RunnerClient, executionId: string): Promise<void> {
  const deadline = Date.now() + STOP_AWAIT_MS
  while (Date.now() < deadline) {
    try {
      const snapshot = await client.status(executionId)
      if (
        (TERMINAL_EXECUTION_STATES as readonly string[]).includes(snapshot.state)
        || snapshot.state === 'UNKNOWN'
      ) {
        return
      }
      if (!isAlive(snapshot.runnerPid)) return
    } catch {
      return
    }
    await sleep(40)
  }
}

async function stopOwnedExecutions(): Promise<void> {
  const ids = [...ownedExecutionIds]
  const roots = [...ownedRunnerRoots]
  ownedExecutionIds.clear()
  ownedRunnerRoots.clear()
  for (const runnersRoot of roots) {
    if (!existsSync(runnersRoot)) continue
    const client = new RunnerClient({ root: runnersRoot, workerPath: WORKER_PATH })
    for (const executionId of ids) {
      try {
        await client.stop(executionId, 'compiled-task-cli smoke cleanup')
      } catch {
        /* missing/terminal */
      }
      await awaitRunnerStopped(client, executionId)
      try {
        const snapshot = await client.status(executionId)
        if (typeof snapshot.runnerPid === 'number') forceKillOwnedPid(snapshot.runnerPid)
        if (typeof snapshot.processId === 'number') forceKillOwnedPid(snapshot.processId)
      } catch {
        /* gone */
      }
    }
  }
}

function rememberOwned(dataDir: string, row: ExecutionRow | undefined): void {
  ownedRunnerRoots.add(join(dataDir, 'runners'))
  if (row?.executionId) ownedExecutionIds.add(row.executionId)
}

describe('compiled Task CLI smoke', () => {
  it('readonly commands on missing storage leave no database behind', async () => {
    const missing = join(root, 'never-created')
    for (const command of ['status', 'tickets', 'employees', 'projects', 'executions'] as const) {
      const result = await runCli([command, '--data-dir', missing])
      expect(result.code).toBe(1)
      expect(result.stderr).toMatch(/run init first|not initialized/i)
      expect(existsSync(missing)).toBe(false)
    }
  })

  it('rejects invalid Task JSON types instead of coercing them', async () => {
    const dataDir = join(root, 'type-data')
    const init = await runCli(['init', '--data-dir', dataDir])
    expect(init.code).toBe(0)

    const mock = installMockClaude()
    const configured = await runCli(['configure', '--data-dir', dataDir, '--claude-command', mock])
    expect(configured.code).toBe(0)

    const repositoryPath = initGitRepo(join(root, 'type-repo'))
    const worktreeRoot = join(root, 'type-worktrees')
    mkdirSync(worktreeRoot, { mode: 0o700 })
    const projectFile = join(root, 'type-project.json')
    writeJson(projectFile, {
      id: 'proj-type',
      name: 'Type Gate',
      ownerId: 'owner-local',
      repositoryPath,
      worktreeRoot,
      allowedTaskTypes: ['documentation'],
    })
    expect((await runCli(['project-create', '--data-dir', dataDir, '--file', projectFile])).code).toBe(0)

    const badFile = join(root, 'bad-task.json')
    writeJson(badFile, {
      project: 'proj-type',
      issue: 'issue-type',
      title: 42,
      description: 'must reject number title',
      taskType: 'documentation',
    })
    const created = await runCli(['task-create', '--data-dir', dataDir, '--file', badFile])
    expect(created.code).toBe(1)
    expect(created.stderr).toMatch(/Invalid title|must be a string|Invalid create|type/i)
    expect(created.json).toBeUndefined()
  })

  it('configure is exclusive and does not overwrite settings', async () => {
    const dataDir = join(root, 'cfg-data')
    expect((await runCli(['init', '--data-dir', dataDir])).code).toBe(0)
    const mock = installMockClaude()
    const first = await runCli(['configure', '--data-dir', dataDir, '--claude-command', mock])
    expect(first.code).toBe(0)
    expect(first.json).toMatchObject({
      schemaVersion: 1,
      workspaceId: 'local',
      runtime: { id: 'claude-local', driver: 'claude-code', command: mock },
    })
    const settingsPath = join(dataDir, 'settings.json')
    const before = readFileSync(settingsPath)
    const second = await runCli(['configure', '--data-dir', dataDir, '--claude-command', mock])
    expect(second.code).toBe(1)
    expect(second.stderr).toMatch(/already exists/i)
    expect(readFileSync(settingsPath)).toEqual(before)
  })

  it('premature review cannot complete a task without verification', async () => {
    const dataDir = join(root, 'premature-data')
    expect((await runCli(['init', '--data-dir', dataDir])).code).toBe(0)
    const mock = installMockClaude()
    expect((await runCli(['configure', '--data-dir', dataDir, '--claude-command', mock])).code).toBe(0)

    const repositoryPath = initGitRepo(join(root, 'premature-repo'))
    const worktreeRoot = join(root, 'premature-worktrees')
    mkdirSync(worktreeRoot, { mode: 0o700 })
    const projectFile = join(root, 'premature-project.json')
    writeJson(projectFile, {
      id: 'proj-premature',
      name: 'Premature',
      ownerId: 'owner-local',
      repositoryPath,
      worktreeRoot,
      allowedTaskTypes: ['documentation'],
    })
    expect((await runCli(['project-create', '--data-dir', dataDir, '--file', projectFile])).code).toBe(0)

    const taskFile = join(root, 'premature-task.json')
    writeJson(taskFile, {
      project: 'proj-premature',
      issue: 'issue-premature',
      title: 'Cannot skip verify',
      description: 'Review without verification must fail',
      taskType: 'documentation',
    })
    const created = await runCli(['task-create', '--data-dir', dataDir, '--file', taskFile])
    expect(created.code).toBe(0)
    const ticketId = (created.json as { id: string }).id
    expect((created.json as { lifecycle: { status: string } }).lifecycle.status).toBe('WAITING_APPROVAL')

    const premature = await runCli([
      'task-review', ticketId,
      '--data-dir', dataDir,
      '--execution-id', 'exec-missing',
      '--artifact-revision', 'rev-missing',
      '--decision', 'approved',
      '--reason', 'skip verification',
    ])
    expect(premature.code).toBe(1)
    expect(premature.stderr.length).toBeGreaterThan(0)

    const tickets = await runCli(['tickets', '--data-dir', dataDir])
    expect(tickets.code).toBe(0)
    expect(tickets.json).toEqual([
      expect.objectContaining({ id: ticketId, status: 'WAITING_APPROVAL' }),
    ])
  })

  it('task-verify --waive is exclusive governance opt-in (not happy-path content check)', async () => {
    const dataDir = join(root, 'waive-gov-data')
    expect((await runCli(['init', '--data-dir', dataDir])).code).toBe(0)
    const checksFile = join(root, 'gov-checks.json')
    writeContentChecksFile(checksFile)

    const both = await runCli([
      'task-verify', 'ticket-gov',
      '--data-dir', dataDir,
      '--reason', 'must choose one path',
      '--waive',
      '--checks-file', checksFile,
    ])
    expect(both.code).toBe(1)
    expect(both.stderr).toMatch(/exactly one of --checks-file or --waive/i)

    const neither = await runCli([
      'task-verify', 'ticket-gov',
      '--data-dir', dataDir,
      '--reason', 'missing verify mode',
    ])
    expect(neither.code).toBe(1)
    expect(neither.stderr).toMatch(/exactly one of --checks-file or --waive/i)
  })

  it('runs init → configure → project/employee → task → approve → run-once detach → REVIEW → checks-file verify → review → DONE', async () => {
    const dataDir = join(root, 'happy-data')
    mkdirSync(dataDir, { mode: 0o700 })

    const initialized = await runCli(['init', '--data-dir', dataDir])
    expect(initialized.code).toBe(0)
    expect(initialized.json).toMatchObject({ initialized: true })
    expect(statSync(dataDir).mode & 0o777).toBe(0o700)

    const mock = installMockClaude()
    const configured = await runCli(['configure', '--data-dir', dataDir, '--claude-command', mock])
    expect(configured.code).toBe(0)
    const runtimeId = (configured.json as { runtime: { id: string } }).runtime.id
    expect(runtimeId).toBe('claude-local')

    const repositoryPath = initGitRepo(join(root, 'happy-repo'))
    const worktreeRoot = join(root, 'happy-worktrees')
    mkdirSync(worktreeRoot, { mode: 0o700 })
    const originalReadme = readFileSync(join(repositoryPath, 'README.md'), 'utf8')
    const originalMarker = readFileSync(join(repositoryPath, MARKER_FILE), 'utf8')
    expect(originalReadme).toContain('typoo')
    expect(originalMarker).toBe(MARKER_BODY)

    const projectFile = join(root, 'happy-project.json')
    writeJson(projectFile, {
      id: 'proj-smoke',
      name: 'Smoke Docs',
      ownerId: 'owner-local',
      repositoryPath,
      worktreeRoot,
      allowedTaskTypes: ['documentation'],
    })
    const project = await runCli(['project-create', '--data-dir', dataDir, '--file', projectFile])
    expect(project.code).toBe(0)
    expect(project.json).toMatchObject({
      id: 'proj-smoke',
      workspaceId: 'local',
      archived: false,
      version: 1,
    })

    const employeeFile = join(root, 'happy-employee.json')
    writeJson(employeeFile, {
      id: 'emp-smoke',
      name: 'Smoke Writer',
      role: 'documentation',
      responsibilities: ['fix docs'],
      capabilities: ['documentation'],
      runtimeId,
      projectIds: ['proj-smoke'],
      maxConcurrency: 1,
      timeoutMs: 30_000,
    })
    const employee = await runCli(['employee-create', '--data-dir', dataDir, '--file', employeeFile])
    expect(employee.code).toBe(0)
    expect(employee.json).toMatchObject({ id: 'emp-smoke', enabled: false, version: 1, runtimeId })
    const enabled = await runCli(['employee-enable', 'emp-smoke', '--data-dir', dataDir, '--version', '1'])
    expect(enabled.code).toBe(0)
    expect(enabled.json).toMatchObject({ id: 'emp-smoke', enabled: true, version: 2 })

    const taskFile = join(root, 'happy-task.json')
    writeJson(taskFile, {
      project: 'proj-smoke',
      issue: 'issue-smoke-1',
      title: 'Fix README typo',
      description: `Correct README typoo. FIXTURE_MODE=wait-success FIXTURE_WAIT_MS=${DETACH_WAIT_MS}`,
      taskType: 'documentation',
    })
    const created = await runCli(['task-create', '--data-dir', dataDir, '--file', taskFile])
    expect(created.code).toBe(0)
    const ticket = created.json as { id: string; lifecycle: { status: string } }
    expect(ticket.lifecycle.status).toBe('WAITING_APPROVAL')
    const ticketId = ticket.id

    const approved = await runCli(['task-approve', ticketId, '--data-dir', dataDir, '--reason', 'Owner approved smoke'])
    expect(approved.code).toBe(0)
    expect(approved.json).toMatchObject({ lifecycle: { status: 'QUEUED' } })

    try {
      const firstTick = await runCli(['run-once', '--data-dir', dataDir])
      expect(firstTick.code).toBe(0)
      expect(firstTick.json).toMatchObject({
        assigned: expect.any(Number),
        dispatched: expect.any(Number),
        review: expect.any(Number),
        failed: expect.any(Number),
        unknown: expect.any(Number),
      })
      expect((firstTick.json as { assigned: number }).assigned).toBeGreaterThanOrEqual(1)

      // CLI already returned; bounded poll until RUNNING once (detach proof while wait-success lives).
      const runningDeadline = Date.now() + Math.min(POLL_TIMEOUT_MS, DETACH_WAIT_MS + 500)
      let runningRow: ExecutionRow | undefined
      while (Date.now() < runningDeadline) {
        const listed = await runCli(['executions', '--data-dir', dataDir])
        expect(listed.code).toBe(0)
        expect(Array.isArray(listed.json)).toBe(true)
        expect((listed.json as unknown[]).length).toBe(1)
        const row = (listed.json as ExecutionRow[])[0]!
        rememberOwned(dataDir, row)
        if (row.state === 'RUNNING') {
          runningRow = row
          break
        }
        expect(['STARTING', 'RUNNING']).toContain(row.state)
        await sleep(40)
      }
      expect(runningRow?.state).toBe('RUNNING')
      const executionId = runningRow!.executionId

      const midStatus = await runCli(['tickets', '--data-dir', dataDir])
      expect(midStatus.code).toBe(0)
      const midTicket = (midStatus.json as Array<{ id: string; status: string }>).find(row => row.id === ticketId)
      expect(midTicket).toBeDefined()
      expect(midTicket!.status).not.toBe('DONE')

      const secondTick = await runCli(['run-once', '--data-dir', dataDir])
      expect(secondTick.code).toBe(0)
      const secondExecutions = await runCli(['executions', '--data-dir', dataDir])
      expect(secondExecutions.code).toBe(0)
      expect(secondExecutions.json).toEqual([
        expect.objectContaining({ executionId }),
      ])
      expect((secondExecutions.json as unknown[]).length).toBe(1)
      rememberOwned(dataDir, (secondExecutions.json as ExecutionRow[])[0])

      const deadline = Date.now() + POLL_TIMEOUT_MS
      let reviewStatus: string | undefined
      while (Date.now() < deadline) {
        await runCli(['run-once', '--data-dir', dataDir])
        const tickets = await runCli(['tickets', '--data-dir', dataDir])
        expect(tickets.code).toBe(0)
        const row = (tickets.json as Array<{ id: string; status: string }>).find(item => item.id === ticketId)
        reviewStatus = row?.status
        if (reviewStatus === 'REVIEW') break
        expect(reviewStatus).not.toBe('DONE')
        await sleep(40)
      }
      expect(reviewStatus).toBe('REVIEW')

      const finalExecutions = await runCli(['executions', '--data-dir', dataDir])
      expect(finalExecutions.code).toBe(0)
      expect(finalExecutions.json).toEqual([
        expect.objectContaining({ executionId }),
      ])
      const cwd = (finalExecutions.json as Array<{ cwd: string }>)[0]!.cwd
      expect(readFileSync(join(repositoryPath, 'README.md'), 'utf8')).toBe(originalReadme)
      expect(readFileSync(join(repositoryPath, MARKER_FILE), 'utf8')).toBe(originalMarker)
      expect(readFileSync(join(cwd, 'README.md'), 'utf8')).toContain('typo')
      expect(readFileSync(join(cwd, 'README.md'), 'utf8')).not.toContain('typoo')
      expect(readFileSync(join(cwd, MARKER_FILE), 'utf8')).toBe(MARKER_BODY)

      const beforeVerify = await runCli(['tickets', '--data-dir', dataDir])
      expect((beforeVerify.json as Array<{ id: string; status: string }>).find(row => row.id === ticketId)?.status).toBe('REVIEW')

      const checksFile = join(root, 'happy-checks.json')
      writeContentChecksFile(checksFile)
      const verified = await runCli([
        'task-verify', ticketId,
        '--data-dir', dataDir,
        '--reason', 'Independent README+marker content check passed',
        '--checks-file', checksFile,
      ])
      expect(verified.code).toBe(0)
      expect(verified.json).toMatchObject({
        executionId,
        artifactRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
        state: 'passed',
      })
      const artifactRevision = (verified.json as { artifactRevision: string }).artifactRevision

      const stillNotDone = await runCli(['tickets', '--data-dir', dataDir])
      expect((stillNotDone.json as Array<{ id: string; status: string }>).find(row => row.id === ticketId)?.status).not.toBe('DONE')

      const reviewed = await runCli([
        'task-review', ticketId,
        '--data-dir', dataDir,
        '--execution-id', executionId,
        '--artifact-revision', artifactRevision,
        '--decision', 'approved',
        '--reason', 'Version-bound review accepted',
      ])
      expect(reviewed.code).toBe(0)
      expect(reviewed.json).toMatchObject({ lifecycle: { status: 'DONE' } })

      const doneTickets = await runCli(['tickets', '--data-dir', dataDir])
      expect(doneTickets.code).toBe(0)
      expect(doneTickets.json).toEqual([
        expect.objectContaining({ id: ticketId, status: 'DONE' }),
      ])
      expect(readFileSync(join(repositoryPath, 'README.md'), 'utf8')).toBe(originalReadme)
      expect(readFileSync(join(repositoryPath, MARKER_FILE), 'utf8')).toBe(originalMarker)
    } finally {
      await stopOwnedExecutions()
    }
  }, HAPPY_PATH_TIMEOUT_MS)
})

