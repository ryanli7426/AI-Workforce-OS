/** Local orchestration vertical slice: schedule → durable intents → Runner → reconcile evidence. */
import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ArtifactStore, type ArtifactManifest } from '../artifacts/snapshots.ts'
import { ExecutionService } from './execution-service.ts'
import { latestAssignment, type Ticket } from '../core/model.ts'
import type { ExecutionRecord, ExecutionSpec } from '../execution/model.ts'
import { TERMINAL_EXECUTION_STATES } from '../execution/model.ts'
import { ExecutionRepository } from '../execution/repository.ts'
import { IntentDispatcher, NotAppliedError } from '../orchestration/dispatcher.ts'
import { IntentRepository, type Intent, type JsonValue } from '../orchestration/intents.ts'
import { ProjectRepository, type Project } from '../projects/projects.ts'
import type { RuntimeAdapter } from '../runtime/ports.ts'
import { RuntimeRegistry } from '../runtime/registry.ts'
import { builtinRuntimeRegistry, LEGACY_CLAUDE_RUNTIME_FINGERPRINT } from '../runtime/builtins.ts'
import { RunnerClient } from '../runner/client.ts'
import { redact } from '../security/redaction.ts'
import { applicationRepositories } from '../storage/application-store.ts'
import type { LocalStore } from '../storage/store.ts'
import { EmployeeRepository, type Employee } from '../workforce/employees.ts'
import { GitWorktreeManager } from '../workspaces/git-worktrees.ts'
import type { LocalTaskService } from './tasks.ts'

const DEFAULT_MAX_CONCURRENCY = 1
const DEFAULT_TIMEOUT_MS = 60 * 60_000
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const DEFAULT_GRACE_MS = 5_000
const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const MANUAL_SOURCE = /^manual:([a-zA-Z0-9][a-zA-Z0-9_-]{0,127}):([a-zA-Z0-9][a-zA-Z0-9_-]{0,127})$/
const ERROR_MESSAGE_LIMIT = 8_192

export interface LocalRuntimeConfig {
  id: string
  driver?: string
  command: string
  timeoutMs?: number
  maxOutputBytes?: number
  graceMs?: number
}

export interface LocalOrchestratorOptions {
  store: LocalStore
  tasks: LocalTaskService
  runtime: LocalRuntimeConfig
  registry?: RuntimeRegistry
  runnerRoot: string
  artifactRoot: string
  maxConcurrency?: number
  runtimeEnvironment?: Record<string, string>
}

export interface OrchestratorCounters {
  assigned: number
  dispatched: number
  review: number
  failed: number
  unknown: number
}

interface LaunchPayload {
  ticketId: string
  assignmentId: string
  agentId: string
  runtime: string
  cwd: string
  generation: number
}

interface StopPayload {
  ticketId: string
  assignmentId: string
  reason: string
}

function emptyCounters(): OrchestratorCounters {
  return { assigned: 0, dispatched: 0, review: 0, failed: 0, unknown: 0 }
}

function requireSafeId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`Invalid ${field}`)
}

function requireText(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`Invalid ${field}`)
}

function parseManualSource(source: string): { workspaceId: string; projectId: string } | undefined {
  const match = MANUAL_SOURCE.exec(source)
  if (!match) return undefined
  return { workspaceId: match[1]!, projectId: match[2]! }
}

function isTerminalExecution(state: ExecutionRecord['state']): boolean {
  return (TERMINAL_EXECUTION_STATES as readonly string[]).includes(state)
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function launchPayload(value: JsonValue): LaunchPayload {
  if (!isObject(value)) throw new NotAppliedError('Invalid launch payload')
  const { ticketId, assignmentId, agentId, runtime, cwd, generation } = value
  requireSafeId(ticketId, 'ticketId')
  requireSafeId(assignmentId, 'assignmentId')
  requireSafeId(agentId, 'agentId')
  requireText(runtime, 'runtime')
  requireText(cwd, 'cwd')
  if (!isAbsolute(cwd)) throw new NotAppliedError('Launch cwd must be absolute')
  if (!Number.isSafeInteger(generation) || (generation as number) < 1) {
    throw new NotAppliedError('Invalid launch generation')
  }
  return {
    ticketId,
    assignmentId,
    agentId,
    runtime,
    cwd,
    generation: generation as number,
  }
}

function stopPayload(value: JsonValue): StopPayload {
  if (!isObject(value)) throw new NotAppliedError('Invalid stop payload')
  const { ticketId, assignmentId, reason } = value
  requireSafeId(ticketId, 'ticketId')
  requireSafeId(assignmentId, 'assignmentId')
  requireText(reason, 'reason')
  return { ticketId, assignmentId, reason }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Module-relative compiled worker; source-test fallback to repository dist. Never uses process.cwd(). */
function resolveWorkerPath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const compiled = resolve(moduleDir, '../runner/worker.js')
  if (pathExists(compiled)) return compiled
  const sourceTestFallback = resolve(moduleDir, '../../dist/runner/worker.js')
  if (pathExists(sourceTestFallback)) return sourceTestFallback
  return compiled
}

function readBoundedLog(path: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid log bound')
  let before
  try {
    before = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error('Runner log must be a regular file')
  }
  if (before.size > maxBytes) {
    throw new Error('Runner log exceeds configured output bound')
  }

  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(fd)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Runner log changed while opening')
    }
    if (opened.size > maxBytes) {
      throw new Error('Runner log exceeds configured output bound')
    }
    const buffer = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < buffer.length) {
      const counted = readSync(fd, buffer, offset, buffer.length - offset, offset)
      if (counted === 0) break
      offset += counted
      if (offset > maxBytes) throw new Error('Runner log exceeds configured output bound')
    }
    const after = fstatSync(fd)
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      throw new Error('Runner log changed while reading')
    }
    if (offset !== opened.size) throw new Error('Runner log read was incomplete')
    return buffer.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function artifactIdFor(executionId: string): string {
  return `artifact-${executionId}`
}

/** Assessed admission priority lives on the accepted lifecycle issue snapshot. */
function assessedPriority(ticket: Ticket): number {
  const priority = ticket.lifecycle?.issue.priority
  return typeof priority === 'number' && Number.isFinite(priority) ? priority : 0
}

function compareTickets(left: Ticket, right: Ticket): number {
  const leftPriority = assessedPriority(left)
  const rightPriority = assessedPriority(right)
  if (rightPriority !== leftPriority) return rightPriority - leftPriority
  if (left.createdAt !== right.createdAt) return left.createdAt < right.createdAt ? -1 : 1
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

function persistableReason(reason: string, fallback: string): string {
  const text = typeof reason === 'string' && reason.trim() ? reason : fallback
  const bounded = text.length > ERROR_MESSAGE_LIMIT ? text.slice(0, ERROR_MESSAGE_LIMIT) : text
  return redact(bounded)
}

function persistableError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return persistableReason(error.message, fallback)
  const text = String(error)
  return persistableReason(text, fallback)
}

/** Application entry that schedules queued work, dispatches durable intents, and reconciles Runner evidence. */
export class LocalOrchestrator {
  private readonly store: LocalStore
  private readonly tasks: LocalTaskService
  private readonly registry: RuntimeRegistry
  private readonly runtime: Required<LocalRuntimeConfig>
  private readonly maxConcurrency: number
  private readonly runnerRoot: string
  private readonly artifactRoot: string
  private readonly employees: EmployeeRepository
  private readonly projects: ProjectRepository
  private readonly executions: ExecutionRepository
  private readonly runner: RunnerClient
  private readonly artifacts: ArtifactStore
  private readonly execution: ExecutionService
  private readonly dispatcher: ReturnType<typeof IntentDispatcher>
  private runningTick = false
  private chain: Promise<void> = Promise.resolve()

  constructor(options: LocalOrchestratorOptions) {
    if (!options || typeof options !== 'object') throw new Error('Invalid LocalOrchestrator options')
    if (!options.store) throw new Error('LocalStore is required')
    if (!options.tasks) throw new Error('LocalTaskService is required')
    requireSafeId(options.runtime?.id, 'runtime.id')
    requireText(options.runtime?.command, 'runtime.command')
    if (!isAbsolute(options.runtime.command)) throw new Error('runtime.command must be absolute')
    requireText(options.runnerRoot, 'runnerRoot')
    requireText(options.artifactRoot, 'artifactRoot')
    if (!isAbsolute(options.runnerRoot) || !isAbsolute(options.artifactRoot)) {
      throw new Error('runnerRoot and artifactRoot must be absolute')
    }
    const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('Invalid maxConcurrency')
    const timeoutMs = options.runtime.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxOutputBytes = options.runtime.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const graceMs = options.runtime.graceMs ?? DEFAULT_GRACE_MS
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Invalid runtime.timeoutMs')
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new Error('Invalid runtime.maxOutputBytes')
    if (!Number.isSafeInteger(graceMs) || graceMs < 1) throw new Error('Invalid runtime.graceMs')

    this.registry = options.registry ?? builtinRuntimeRegistry()
    const driver = options.runtime.driver ?? 'claude-code'
    this.registry.require(driver)

    applicationRepositories(options.store.db)
    this.store = options.store
    this.tasks = options.tasks
    this.runtime = {
      id: options.runtime.id,
      driver,
      command: options.runtime.command,
      timeoutMs,
      maxOutputBytes,
      graceMs,
    }
    this.maxConcurrency = maxConcurrency
    this.runnerRoot = resolve(options.runnerRoot)
    this.artifactRoot = resolve(options.artifactRoot)
    this.employees = new EmployeeRepository(options.store.db)
    this.projects = new ProjectRepository(options.store.db)
    this.executions = new ExecutionRepository(options.store.db)
    const intents = new IntentRepository(options.store.db)
    this.runner = new RunnerClient({
      root: this.runnerRoot,
      workerPath: resolveWorkerPath(),
      runtimeEnvironment: options.runtimeEnvironment,
    })
    this.artifacts = new ArtifactStore({ root: this.artifactRoot })
    this.execution = new ExecutionService(this.executions, this.runner, {
      authorize: (spec, launch) => this.authorizeLaunch(spec, launch.cwd),
    })
    this.dispatcher = IntentDispatcher({
      repository: intents,
      handlers: {
        launch: intent => this.handleLaunch(intent),
        stop: intent => this.handleStop(intent),
      },
    })
  }

  async tick(): Promise<OrchestratorCounters> {
    if (this.runningTick) throw new Error('LocalOrchestrator.tick is not reentrant')
    this.runningTick = true
    try {
      return await this.synchronized(async () => {
        const counters = emptyCounters()
        counters.assigned = this.scheduleEligible()
        counters.dispatched = await this.dispatchDue()
        const outcomes = await this.reconcileActive()
        counters.review = outcomes.review
        counters.failed = outcomes.failed
        counters.unknown = outcomes.unknown
        return counters
      })
    } finally {
      this.runningTick = false
    }
  }

  async reconcile(): Promise<OrchestratorCounters> {
    return this.synchronized(async () => {
      const outcomes = await this.reconcileActive()
      return { assigned: 0, dispatched: 0, ...outcomes }
    })
  }

  private synchronized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  private occupiedAssignmentIds(): Set<string> {
    const occupied = new Set<string>()
    for (const ticket of this.tasks.list()) {
      const assignment = latestAssignment(ticket)
      if (assignment && assignment.state !== 'ended') occupied.add(assignment.id)
    }
    for (const execution of this.executions.list()) {
      if (!isTerminalExecution(execution.state)) occupied.add(execution.assignmentId)
    }
    return occupied
  }

  private employeeOccupancy(occupied: Set<string>, employeeId: string): number {
    const counted = new Set<string>()
    for (const ticket of this.tasks.list()) {
      const assignment = latestAssignment(ticket)
      if (!assignment || assignment.state === 'ended') continue
      if (assignment.agentId !== employeeId) continue
      if (!occupied.has(assignment.id)) continue
      counted.add(assignment.id)
    }
    for (const execution of this.executions.list()) {
      if (isTerminalExecution(execution.state)) continue
      if (execution.agentId !== employeeId) continue
      if (!occupied.has(execution.assignmentId)) continue
      counted.add(execution.assignmentId)
    }
    return counted.size
  }

  private scheduleEligible(): number {
    let assigned = 0
    for (;;) {
      const scheduled = this.store.atomic(() => {
        const occupied = this.occupiedAssignmentIds()
        if (occupied.size >= this.maxConcurrency) return false

        const queued = this.tasks.list()
          .filter(ticket => ticket.lifecycle?.status === 'QUEUED' && !ticket.lifecycle.cancelRequested)
          .sort(compareTickets)

        for (const ticket of queued) {
          const lifecycle = ticket.lifecycle!
          if ((lifecycle.observedIssue ?? lifecycle.issue).closed) continue
          const source = parseManualSource(lifecycle.issue.source)
          if (!source) continue
          const project = this.projects.get(source.projectId)
          if (!project || project.archived || project.workspaceId !== source.workspaceId) continue
          if (!project.allowedTaskTypes.includes(lifecycle.taskType)) continue

          const employees = this.employees.list(source.workspaceId)
            .filter(employee => this.employeeEligible(employee, project, lifecycle.taskType))
            .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))

          for (const employee of employees) {
            if (this.employeeOccupancy(occupied, employee.id) >= employee.maxConcurrency) continue
            if (occupied.size >= this.maxConcurrency) return false

            const executionId = randomUUID()
            requireSafeId(executionId, 'executionId')
            const cwd = resolve(project.worktreeRoot, executionId)
            this.tasks.engine.assignTask(ticket.id, employee.id, this.runtime.driver, cwd)
            return true
          }
        }
        return false
      })
      if (!scheduled) break
      assigned += 1
    }
    return assigned
  }

  private employeeEligible(employee: Employee, project: Project, taskType: string): boolean {
    return employee.enabled
      && employee.runtimeId === this.runtime.id
      && employee.workspaceId === project.workspaceId
      && employee.projectIds.includes(project.id)
      && employee.capabilities.includes(taskType)
  }

  private async dispatchDue(): Promise<number> {
    let dispatched = 0
    for (;;) {
      const result = await this.dispatcher.dispatchOnce({ limit: Math.max(1, this.maxConcurrency * 4) })
      dispatched += result.done
      if (result.claimed === 0) break
    }
    return dispatched
  }

  private authorizeLaunch(spec: ExecutionSpec, launchCwd: string): void {
    const ticket = this.tasks.get(spec.ticketId)
    if (!ticket?.lifecycle) throw new Error('Authorization denied: unknown task')
    const lifecycle = ticket.lifecycle
    const assignment = latestAssignment(ticket)
    if (!assignment || assignment.id !== spec.assignmentId) throw new Error('Authorization denied: assignment mismatch')
    if (assignment.state === 'ended') throw new Error('Authorization denied: assignment ended')
    if (lifecycle.cancelRequested) throw new Error('Authorization denied: cancellation requested')
    if ((lifecycle.observedIssue ?? lifecycle.issue).closed) throw new Error('Authorization denied: source closed')
    if (lifecycle.status !== 'ASSIGNED' && lifecycle.status !== 'RUNNING') {
      throw new Error('Authorization denied: task is not assigned for execution')
    }
    if (lifecycle.policyVersion !== spec.policyVersion) throw new Error('Authorization denied: policy version mismatch')
    if (lifecycle.issue.revision !== spec.inputRevision) throw new Error('Authorization denied: input revision mismatch')
    if (lifecycle.attempts !== spec.generation) throw new Error('Authorization denied: generation mismatch')
    if (assignment.worktreePath !== spec.cwd || launchCwd !== spec.cwd) throw new Error('Authorization denied: cwd mismatch')
    if (realpathSync(spec.cwd) !== spec.cwd) throw new Error('Authorization denied: cwd is not canonical')
    if (assignment.agentId !== spec.agentId) throw new Error('Authorization denied: agent mismatch')
    if (assignment.runtime !== this.runtime.driver || spec.runtime !== this.runtime.driver
      || spec.runtimeRevision !== this.registry.fingerprint(this.runtime.driver)) {
      throw new Error('Authorization denied: runtime driver mismatch')
    }

    const employee = this.employees.get(spec.agentId)
    if (!employee?.enabled) throw new Error('Authorization denied: employee disabled or missing')
    if (employee.runtimeId !== this.runtime.id) throw new Error('Authorization denied: runtime instance mismatch')
    if (!employee.capabilities.includes(lifecycle.taskType)) throw new Error('Authorization denied: capability missing')

    const source = parseManualSource(lifecycle.issue.source)
    if (!source) throw new Error('Authorization denied: invalid source identity')
    if (employee.workspaceId !== source.workspaceId) throw new Error('Authorization denied: employee workspace mismatch')
    if (!employee.projectIds.includes(source.projectId)) throw new Error('Authorization denied: project not in employee scope')

    const project = this.projects.get(source.projectId)
    if (!project || project.archived) throw new Error('Authorization denied: project unavailable')
    if (project.workspaceId !== source.workspaceId) throw new Error('Authorization denied: project workspace mismatch')
    if (!project.allowedTaskTypes.includes(lifecycle.taskType)) {
      throw new Error('Authorization denied: task type not allowed')
    }
  }

  private createAdapter(timeoutMs: number): RuntimeAdapter {
    return this.registry.create(this.runtime.driver, {
      command: this.runtime.command,
      timeoutMs,
      maxOutputBytes: this.runtime.maxOutputBytes,
      graceMs: this.runtime.graceMs,
    })
  }

  private async handleLaunch(intent: Intent): Promise<void> {
    const payload = launchPayload(intent.payload)
    if (intent.generation !== payload.generation) throw new NotAppliedError('Launch generation mismatch')

    const ticket = this.tasks.get(payload.ticketId)
    if (!ticket?.lifecycle) throw new NotAppliedError('Unknown ticket for launch')
    const assignment = latestAssignment(ticket)
    if (!assignment || assignment.id !== payload.assignmentId) {
      throw new NotAppliedError('Launch does not match current assignment')
    }
    if (ticket.lifecycle.attempts !== payload.generation) throw new NotAppliedError('Launch generation is stale')
    if (assignment.worktreePath !== payload.cwd) throw new NotAppliedError('Launch cwd metadata mismatch')
    if (assignment.agentId !== payload.agentId || assignment.runtime !== payload.runtime) {
      throw new NotAppliedError('Launch identity metadata mismatch')
    }
    if (assignment.runtime !== this.runtime.driver) throw new NotAppliedError('Unsupported runtime driver')
    if (assignment.state === 'ended') throw new NotAppliedError('Assignment already ended')

    // A replay may refer to an execution that already spawned. Its cancellation
    // needs Runner exit evidence; source closure alone cannot prove it stopped.
    const existing = this.executions.list().find(item => item.assignmentId === assignment.id)
    if (existing) {
      if (!isTerminalExecution(existing.state)) {
        await this.promoteStarted(ticket.id, assignment.id, existing.executionId)
        return
      }
      return // Terminal evidence is consumed by reconciliation, never a new launch.
    }

    if (this.shouldSkipLaunch(ticket)) {
      this.tasks.engine.confirmProcessStopped(
        ticket.id,
        assignment.id,
        persistableReason('Source closed or cancelled before launch', 'Cancelled before launch'),
      )
      return
    }

    const executionId = basename(payload.cwd)
    requireSafeId(executionId, 'executionId')
    if (resolve(payload.cwd) !== payload.cwd) throw new NotAppliedError('Launch cwd must be resolved')

    const source = parseManualSource(ticket.lifecycle.issue.source)
    if (!source) throw new NotAppliedError('Invalid task source for launch')
    const project = this.projects.get(source.projectId)
    if (!project || project.archived) throw new NotAppliedError('Project unavailable for launch')

    const manager = new GitWorktreeManager({
      repository: project.repositoryPath,
      root: project.worktreeRoot,
    })
    if (pathExists(payload.cwd)) {
      await manager.inspect(payload.cwd, ticket.id, assignment.id, executionId)
    } else {
      await manager.create(ticket.id, assignment.id, executionId)
    }
    const canonical = realpathSync(payload.cwd)
    if (canonical !== assignment.worktreePath) {
      throw new Error('Prepared worktree canonical path does not match assigned cwd')
    }

    const current = this.tasks.get(ticket.id)
    if (!current?.lifecycle || this.shouldSkipLaunch(current)) {
      const latest = latestAssignment(current ?? ticket)
      if (latest && latest.id === assignment.id && latest.state !== 'ended') {
        this.tasks.engine.confirmProcessStopped(
          ticket.id,
          assignment.id,
          persistableReason('Source closed or cancelled before spawn', 'Cancelled before spawn'),
        )
      }
      return
    }

    const employee = this.employees.get(assignment.agentId!)
    if (!employee?.enabled || employee.runtimeId !== this.runtime.id) {
      throw new NotAppliedError('Employee is not authorized for launch')
    }
    const timeoutMs = Math.min(employee.timeoutMs, this.runtime.timeoutMs)
    const adapter = this.createAdapter(timeoutMs)

    const accepted = current.lifecycle.issue
    const launch = adapter.createLaunch({
      executionId,
      assignmentId: assignment.id,
      ticketId: ticket.id,
      generation: payload.generation,
      cwd: canonical,
      title: current.title,
      description: accepted.description,
      inputRevision: accepted.revision,
      policyVersion: current.lifecycle.policyVersion,
    })
    const spec: ExecutionSpec = {
      executionId,
      assignmentId: assignment.id,
      ticketId: ticket.id,
      agentId: assignment.agentId!,
      runtime: this.runtime.driver,
      runtimeRevision: this.registry.fingerprint(this.runtime.driver),
      generation: payload.generation,
      cwd: canonical,
      inputRevision: accepted.revision,
      policyVersion: current.lifecycle.policyVersion,
    }

    const record = await this.execution.start(spec, launch)

    if (record.state === 'RUNNING' && record.startedAt) {
      const latest = this.tasks.get(ticket.id)
      if (latest?.lifecycle?.status === 'ASSIGNED' && !latest.lifecycle.cancelRequested)
        this.tasks.engine.assignmentStarted(ticket.id, assignment.id)
      return
    }
    if (isTerminalExecution(record.state) && current.lifecycle.status === 'ASSIGNED' && !record.startedAt) {
      this.tasks.engine.confirmProcessStopped(
        ticket.id,
        assignment.id,
        persistableReason(record.failureReason ?? 'Startup failed before process start', 'Startup failed before process start'),
      )
      return
    }
    if (record.state === 'UNKNOWN') {
      throw new Error('Launch outcome is UNKNOWN; reconcile required')
    }
  }

  private shouldSkipLaunch(ticket: Ticket): boolean {
    const lifecycle = ticket.lifecycle
    if (!lifecycle) return true
    if (lifecycle.cancelRequested) return true
    if ((lifecycle.observedIssue ?? lifecycle.issue).closed) return true
    if (lifecycle.status === 'CANCELLED' || lifecycle.status === 'DONE' || lifecycle.status === 'FAILED') return true
    if (lifecycle.status !== 'ASSIGNED' && lifecycle.status !== 'RUNNING') return true
    return false
  }

  private async handleStop(intent: Intent): Promise<void> {
    const payload = stopPayload(intent.payload)
    const ticket = this.tasks.get(payload.ticketId)
    const assignment = ticket ? latestAssignment(ticket) : undefined
    const execution = this.executions.list().find(item => item.assignmentId === payload.assignmentId)

    if (!execution) {
      if (ticket && assignment && assignment.id === payload.assignmentId && assignment.state !== 'ended') {
        this.tasks.engine.confirmProcessStopped(
          ticket.id,
          assignment.id,
          persistableReason(payload.reason, 'Stop requested'),
        )
      }
      return
    }

    if (execution.state === 'UNKNOWN') {
      throw new Error('Stop cannot confirm an UNKNOWN execution; reconcile required')
    }
    if (isTerminalExecution(execution.state)) return

    const result = await this.execution.stop(execution.executionId, payload.reason)
    const after = this.executions.get(execution.executionId)
    if (after?.state === 'UNKNOWN' || (!result.accepted && result.detail?.includes('UNKNOWN'))) {
      throw new Error('Stop could not confirm Runner state')
    }
  }

  private async reconcileActive(): Promise<Pick<OrchestratorCounters, 'review' | 'failed' | 'unknown'>> {
    const counters = { review: 0, failed: 0, unknown: 0 }
    const seen = new Set<string>()

    for (const execution of this.executions.list()) {
      seen.add(execution.executionId)
      await this.reconcileExecution(execution.executionId, counters)
    }

    for (const ticket of this.tasks.list()) {
      const assignment = latestAssignment(ticket)
      if (!assignment || assignment.state === 'ended') continue
      const execution = this.executions.list().find(item => item.assignmentId === assignment.id)
      if (!execution || seen.has(execution.executionId)) continue
      await this.reconcileExecution(execution.executionId, counters)
    }

    return counters
  }

  private async reconcileExecution(
    executionId: string,
    counters: Pick<OrchestratorCounters, 'review' | 'failed' | 'unknown'>,
  ): Promise<void> {
    let execution: ExecutionRecord
    try {
      execution = (await this.execution.synchronize(executionId)).execution
    } catch {
      const current = this.executions.get(executionId)
      if (current?.state === 'UNKNOWN') counters.unknown += 1
      return
    }

    const ticket = this.tasks.get(execution.ticketId)
    if (!ticket?.lifecycle) {
      if (execution.state === 'UNKNOWN') counters.unknown += 1
      return
    }
    const assignment = latestAssignment(ticket)
    if (!assignment || assignment.id !== execution.assignmentId) {
      if (execution.state === 'UNKNOWN') counters.unknown += 1
      return
    }

    if (execution.state === 'RUNNING' && execution.startedAt && ticket.lifecycle.status === 'ASSIGNED'
      && !ticket.lifecycle.cancelRequested) {
      this.tasks.engine.assignmentStarted(ticket.id, assignment.id)
    }

    if (execution.state === 'UNKNOWN') {
      counters.unknown += 1
      return
    }

    if (!isTerminalExecution(execution.state)) return

    if (['REVIEW', 'FAILED', 'CANCELLED', 'DONE'].includes(ticket.lifecycle.status) && assignment.state === 'ended') {
      return
    }

    const historicalRevision = execution.runtimeRevision === undefined
      ? (execution.runtime === 'claude-code' ? LEGACY_CLAUDE_RUNTIME_FINGERPRINT : undefined)
      : execution.runtimeRevision
    if (execution.runtime !== this.runtime.driver || assignment.runtime !== execution.runtime
      || historicalRevision !== this.registry.fingerprint(this.runtime.driver)) {
      throw new Error('Historical Runtime driver is unavailable; restore its configuration before reconciliation')
    }

    // A fast cancellation can arrive after spawn but before Core sees RUNNING.
    // Core correctly rejects starting a cancelled assignment; finalize it only
    // after the Runner has confirmed terminal process-group evidence instead.
    if (ticket.lifecycle.status === 'ASSIGNED' && ticket.lifecycle.cancelRequested) {
      this.tasks.engine.confirmProcessStopped(ticket.id, assignment.id, 'Cancellation confirmed by Runner exit')
      return
    }

    if (ticket.lifecycle.status === 'ASSIGNED' && !execution.startedAt) {
      this.tasks.engine.confirmProcessStopped(
        ticket.id,
        assignment.id,
        persistableReason(
          execution.failureReason ?? 'Startup failure before child process start',
          'Startup failure before child process start',
        ),
      )
      counters.failed += 1
      return
    }

    if (ticket.lifecycle.status === 'ASSIGNED' && execution.startedAt) {
      this.tasks.engine.assignmentStarted(ticket.id, assignment.id)
    }

    const refreshed = this.tasks.get(ticket.id)
    if (!refreshed?.lifecycle) return
    if (refreshed.lifecycle.status !== 'RUNNING') {
      if (refreshed.lifecycle.status === 'ASSIGNED' && !execution.startedAt) {
        this.tasks.engine.confirmProcessStopped(
          ticket.id,
          assignment.id,
          persistableReason(execution.failureReason ?? 'Startup failure', 'Startup failure'),
        )
        counters.failed += 1
      }
      return
    }

    try {
      await this.finalizeTerminal(refreshed, assignment.id, execution, counters)
    } catch (error) {
      const reason = persistableError(error, 'Reconciliation failed')
      const latest = this.tasks.get(ticket.id)
      const latestAssignmentRecord = latest ? latestAssignment(latest) : undefined
      if (latest && latestAssignmentRecord?.id === assignment.id && latestAssignmentRecord.state !== 'ended') {
        this.tasks.engine.confirmProcessStopped(ticket.id, assignment.id, `Reconciliation error: ${reason}`)
        counters.failed += 1
      }
    }
  }

  private async promoteStarted(ticketId: string, assignmentId: string, executionId: string): Promise<void> {
    const synced = await this.execution.synchronize(executionId)
    if (synced.execution.state === 'RUNNING' && synced.execution.startedAt) {
      const ticket = this.tasks.get(ticketId)
      if (ticket?.lifecycle?.status === 'ASSIGNED' && !ticket.lifecycle.cancelRequested) {
        this.tasks.engine.assignmentStarted(ticketId, assignmentId)
      }
    }
    if (synced.execution.state === 'UNKNOWN') {
      throw new Error('Existing execution is UNKNOWN; reconcile required')
    }
  }

  private async finalizeTerminal(
    ticket: Ticket,
    assignmentId: string,
    execution: ExecutionRecord,
    counters: Pick<OrchestratorCounters, 'review' | 'failed' | 'unknown'>,
  ): Promise<void> {
    const lifecycle = ticket.lifecycle!
    const source = parseManualSource(lifecycle.issue.source)
    if (!source) throw new Error('Invalid source during reconciliation')
    const project = this.projects.get(source.projectId)
    if (!project) throw new Error('Missing project during reconciliation')

    const manager = new GitWorktreeManager({
      repository: project.repositoryPath,
      root: project.worktreeRoot,
    })
    const worktree = await manager.inspect(execution.cwd, ticket.id, assignmentId, execution.executionId)

    const stdoutText = readBoundedLog(
      join(this.runnerRoot, execution.executionId, 'stdout.log'),
      this.runtime.maxOutputBytes,
    )
    const stderrText = readBoundedLog(
      join(this.runnerRoot, execution.executionId, 'stderr.log'),
      this.runtime.maxOutputBytes,
    )

    const adapter = this.createAdapter(this.runtime.timeoutMs)
    const parsed = adapter.parseResult({
      exitCode: execution.exitCode ?? null,
      signal: execution.signal,
      stdout: stdoutText,
      stderr: stderrText,
      reason: execution.failureReason,
    })

    const processSucceeded = execution.state === 'SUCCEEDED' && execution.exitCode === 0 && !execution.signal
    const terminal = processSucceeded && parsed.terminal === 'success' ? 'success' as const : 'error' as const
    const exitCode = terminal === 'success' ? 0 : (execution.exitCode ?? 1)

    let manifest: ArtifactManifest
    try {
      manifest = await this.captureOrReuseArtifact(execution, worktree.baseRevision)
    } catch (error) {
      const reason = persistableError(error, 'Artifact capture failed')
      this.tasks.engine.confirmProcessStopped(ticket.id, assignmentId, `Snapshot failure: ${reason}`)
      counters.failed += 1
      return
    }

    const before = lifecycle.status
    this.tasks.engine.recordExecution(ticket.id, {
      executionId: execution.executionId,
      assignmentId,
      artifactRevision: manifest.revision,
      exitCode,
      terminal,
      summary: parsed.summary,
    })
    const after = this.tasks.get(ticket.id)?.lifecycle?.status
    if (after === 'REVIEW' && before !== 'REVIEW') counters.review += 1
    if (after === 'FAILED' && before !== 'FAILED') counters.failed += 1
  }

  private async captureOrReuseArtifact(execution: ExecutionRecord, baseRevision: string): Promise<ArtifactManifest> {
    const artifactId = artifactIdFor(execution.executionId)
    const artifactPath = join(this.artifactRoot, artifactId)
    if (pathExists(artifactPath)) {
      const existing = await this.artifacts.verify(artifactId)
      if (existing.executionId !== execution.executionId) {
        throw new Error('Existing artifact execution identity mismatch')
      }
      if (existing.baseRevision !== baseRevision) throw new Error('Existing artifact base revision mismatch')
      if (!execution.finishedAt || Date.parse(existing.createdAt) < Date.parse(execution.finishedAt)) {
        throw new Error('Existing artifact predates terminal execution evidence')
      }
      return existing
    }
    return this.artifacts.capture({
      artifactId,
      executionId: execution.executionId,
      cwd: execution.cwd,
      baseRevision,
    })
  }
}
