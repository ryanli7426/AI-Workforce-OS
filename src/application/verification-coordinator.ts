/** Detached verification supervision. IO precedes short, atomic evidence application. */
import type { RunnerEvent, RunnerSnapshot } from '../runner/protocol.ts'
import type { LocalStore } from '../storage/store.ts'
import { VerificationJobRepository } from '../storage/verification-jobs.ts'
import {
  ACTIVE_VERIFICATION_JOB_STATES,
  type VerificationJob,
  type VerificationJobEvent,
  type VerificationJobRequest,
  type VerificationJobState,
} from '../verification/model.ts'
import type { VerificationReport } from '../verification/local-checks.ts'
import type { LocalTaskService } from './tasks.ts'

export interface VerificationCollection {
  status: 'completed' | 'failed' | 'cancelled'
  terminalConfirmed: true
  reportSha256: string
  report?: VerificationReport
  failureCode?: string
}

/** Supplied by the application composition root, never by HTTP callers. */
export interface VerificationJobRunner {
  start(request: VerificationJobRequest): Promise<RunnerSnapshot>
  status(id: string): Promise<RunnerSnapshot>
  events(id: string, afterSequence?: number): Promise<RunnerEvent[]>
  stop(id: string, reason: string): Promise<{ accepted: boolean; detail?: string }>
  collect(request: VerificationJobRequest): Promise<VerificationCollection>
}

export interface VerificationCoordinatorOptions {
  store: LocalStore
  tasks: LocalTaskService
  ownerId: string
  workspaceId: string
  runner: VerificationJobRunner
  maxConcurrency?: number
}

export interface VerificationCoordinatorSummary {
  launched: number
  observed: number
  unknown: number
}

const ACTIVE = ACTIVE_VERIFICATION_JOB_STATES.filter(state => state !== 'QUEUED')
const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'])
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

/** Requires the existing controller lease: a second coordinator must not schedule concurrently. */
export class VerificationCoordinator {
  private readonly repository: VerificationJobRepository
  private readonly concurrency: number
  private busy = false

  constructor(private readonly options: VerificationCoordinatorOptions) {
    if (!options || !SAFE_ID.test(options.ownerId) || !SAFE_ID.test(options.workspaceId)
      || !options.store || !options.tasks || !options.runner
      || ['start', 'events', 'status', 'stop', 'collect'].some(method =>
        typeof options.runner[method as keyof VerificationJobRunner] !== 'function')) {
      throw new Error('Invalid verification coordinator options')
    }
    this.concurrency = options.maxConcurrency ?? 1
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 64) {
      throw new Error('Invalid verification concurrency')
    }
    this.repository = new VerificationJobRepository(options.store.db)
  }

  /** Observe-only on startup/shutdown: even missing Runner evidence never triggers start. */
  reconcile(): Promise<VerificationCoordinatorSummary> { return this.run(false) }
  tick(): Promise<VerificationCoordinatorSummary> { return this.run(true) }

  private jobs(statuses: readonly VerificationJobState[]): VerificationJob[] {
    const items: VerificationJob[] = []
    let beforeRowid: number | undefined
    do {
      const page = this.repository.list({ ownerId: this.options.ownerId, workspaceId: this.options.workspaceId,
        statuses, limit: 200, ...(beforeRowid === undefined ? {} : { beforeRowid }) })
      items.push(...page.items)
      beforeRowid = page.nextCursor
    } while (beforeRowid !== undefined)
    return items
  }

  private assertOutsideTransaction(): void {
    if (this.options.store.db.isTransaction) throw new Error('Verification IO inside transaction is forbidden')
  }

  private async run(launch: boolean): Promise<VerificationCoordinatorSummary> {
    this.assertOutsideTransaction()
    if (this.busy) throw new Error('Verification coordinator is already running')
    this.busy = true
    const summary = { launched: 0, observed: 0, unknown: 0 }
    try {
      for (const job of this.jobs([...ACTIVE, 'COMPLETED'])) {
        if (job.status === 'COMPLETED' && job.application !== 'pending') continue
        await this.observe(job)
        summary.observed++
      }
      if (launch) {
        let slots = Math.max(0, this.concurrency - this.jobs(ACTIVE).length)
        // Repository is newest-first; scheduling is oldest-first.
        for (const queued of this.jobs(['QUEUED']).reverse()) {
          if (slots <= 0) break
          const current = this.options.store.atomic(() => this.repository.beginLaunch(queued.request.verificationId))
          slots--
          summary.launched++
          this.assertOutsideTransaction()
          try {
            const started = await this.options.runner.start(current.request)
            this.assertIdentity(current, started)
          } catch {
            this.repository.markUnknown(current.request.verificationId, 'START_UNCONFIRMED')
            continue
          }
          await this.observe(current)
        }
      }
      summary.unknown = this.jobs(['UNKNOWN']).length
      return summary
    } finally { this.busy = false }
  }

  private async observe(original: VerificationJob): Promise<void> {
    const id = original.request.verificationId
    this.assertOutsideTransaction()
    // Terminal pending records can be reconciled after older installations committed them separately.
    if (original.status === 'COMPLETED') {
      const collected = await this.options.runner.collect(original.request)
      this.applyCompletion(id, undefined, collected)
      return
    }
    try {
      let current = this.repository.get(id)!
      const events = await this.options.runner.events(id, current.lastSequence)
      for (const event of events) {
        current = this.repository.get(id)!
        this.assertIdentity(current, event)
        if (event.state === 'UNKNOWN') {
          this.repository.markUnknown(id, 'RUNNER_UNCONFIRMED')
          return // Do not consume a sequence without actual releasable evidence.
        }
        if (TERMINAL.has(event.state)) {
          const collected = await this.options.runner.collect(current.request)
          this.applyCompletion(id, event, collected)
          return
        }
        if (event.state !== 'STARTING' && event.state !== 'RUNNING' && event.state !== 'STOPPING') {
          throw new Error('Invalid verification runner state')
        }
        this.repository.apply(this.event(current, event, event.state))
      }
      current = this.repository.get(id)!
      const snapshot = await this.options.runner.status(id)
      this.assertIdentity(current, snapshot)
      if (snapshot.state === 'UNKNOWN' || (TERMINAL.has(snapshot.state) && snapshot.sequence > current.lastSequence)) {
        // Terminal snapshot without its contiguous event log is insufficient to consume a sequence.
        this.repository.markUnknown(id, 'RUNNER_UNCONFIRMED')
        return
      }
      if (current.cancelRequested) {
        this.assertOutsideTransaction()
        // Transport uses the authenticated private stop channel, never a stored PID signal.
        const stopped = await this.options.runner.stop(id, 'OWNER_VERIFICATION_CANCEL')
        if (!stopped.accepted) this.repository.markUnknown(id, 'STOP_UNCONFIRMED')
      }
    } catch {
      const current = this.repository.get(id)!
      if ((ACTIVE as readonly string[]).includes(current.status)) {
        this.repository.markUnknown(id, 'EVIDENCE_UNCONFIRMED')
      } else throw new Error('Verification reconciliation failed')
    }
  }

  private assertIdentity(job: VerificationJob, value: RunnerSnapshot): void {
    if (value.executionId !== job.request.verificationId || value.assignmentId !== job.request.verificationId
      || value.ticketId !== job.request.ticketId || value.generation !== 1
      || (job.runnerId !== undefined && job.runnerId !== value.runnerId)
      || (job.runnerPid !== undefined && job.runnerPid !== value.runnerPid)
      || (job.processId !== undefined && value.processId !== undefined && job.processId !== value.processId)) {
      throw new Error('Verification runner identity mismatch')
    }
  }

  private event(job: VerificationJob, value: RunnerEvent, status: VerificationJobEvent['status']): VerificationJobEvent {
    return { verificationId: job.request.verificationId, sequence: value.sequence,
      runnerId: value.runnerId, runnerPid: value.runnerPid, status, at: value.at,
      ...(value.processId === undefined ? {} : { processId: value.processId }) }
  }

  private applyCompletion(id: string, evidence: RunnerEvent | undefined, collection: VerificationCollection): void {
    if (collection.terminalConfirmed !== true || !/^[a-f0-9]{64}$/.test(collection.reportSha256)) {
      throw new Error('Verification terminal proof is invalid')
    }
    this.options.store.atomic(() => {
      let job = this.repository.get(id)!
      const request = job.request
      if (collection.status === 'completed') {
        const report = collection.report
        if (!report || (report.state !== 'passed' && report.state !== 'failed')
          || report.verificationId !== id || report.executionId !== request.executionId
          || report.artifactId !== request.artifactId || report.artifactRevision !== request.artifactRevision) {
          throw new Error('Verification report does not match immutable request')
        }
        if (evidence) job = this.repository.apply({ ...this.event(job, evidence, 'COMPLETED'),
          terminalConfirmed: true, outcome: report.state, reportSha256: collection.reportSha256 })
        if (job.status !== 'COMPLETED' || job.reportSha256 !== collection.reportSha256 || job.outcome !== report.state) {
          throw new Error('Verification report does not match stored completion')
        }
        if (job.application !== 'pending') return
        const ticket = this.options.tasks.get(request.ticketId)
        const task = ticket?.lifecycle
        const matches = task?.status === 'REVIEW' && task.version === request.expectedTaskVersion
          && this.options.tasks.currentPolicyVersion === request.policyVersion
          && task.policyVersion === request.policyVersion && task.result?.executionId === request.executionId
          && task.result.artifactRevision === request.artifactRevision && task.result.terminal === 'success'
          && task.result.exitCode === 0
        if (matches) {
          this.options.tasks.verify(request.ticketId, { executionId: request.executionId,
            artifactRevision: request.artifactRevision, state: report.state,
            reason: `Trusted verification ${request.plan.id}@${request.plan.revision}`,
            provenance: { verificationId: id, reportSha256: collection.reportSha256,
              planId: request.plan.id, planRevision: request.plan.revision } })
        }
        this.repository.recordApplication(id, { expectedVersion: job.version,
          application: matches ? 'applied' : 'superseded', reportSha256: collection.reportSha256,
          at: new Date().toISOString() })
      } else {
        if (!evidence || (collection.status !== 'failed' && collection.status !== 'cancelled')) {
          throw new Error('Verification terminal proof is invalid')
        }
        this.repository.apply({ ...this.event(job, evidence, collection.status === 'failed' ? 'FAILED' : 'CANCELLED'),
          terminalConfirmed: true, failureCode: collection.failureCode ?? (collection.status === 'failed' ? 'CHECK_INFRASTRUCTURE_FAILED' : 'CANCELLED') })
      }
    })
  }
}
