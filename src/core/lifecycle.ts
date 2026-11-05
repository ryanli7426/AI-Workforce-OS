/** Explicit LAO lifecycle commands; workers report evidence, people and policies decide completion. */
import { randomUUID } from 'node:crypto'
import { latestAssignment, type Assignment, type Ticket } from './model.ts'
import type { EngineOptions } from './part.ts'
import type { ExecutionResult, VerificationEvidence, IssueSnapshot, TaskAudit, TaskPolicy, TaskState, WorkflowRepository } from './lifecycle-model.ts'

const NEXT: Record<TaskState, readonly TaskState[]> = {
  NEW: ['QUEUED', 'WAITING_APPROVAL', 'BLOCKED', 'CANCELLED'],
  WAITING_APPROVAL: ['QUEUED', 'CANCELLED', 'BLOCKED'],
  QUEUED: ['ASSIGNED', 'WAITING_APPROVAL', 'BLOCKED', 'CANCELLED'],
  ASSIGNED: ['RUNNING', 'FAILED', 'BLOCKED', 'CANCELLED'],
  RUNNING: ['REVIEW', 'FAILED', 'BLOCKED', 'CANCELLED'],
  REVIEW: ['DONE', 'QUEUED', 'BLOCKED', 'CANCELLED'],
  DONE: [], FAILED: ['QUEUED', 'BLOCKED', 'CANCELLED'],
  BLOCKED: ['WAITING_APPROVAL', 'QUEUED', 'REVIEW', 'CANCELLED'], CANCELLED: [],
}
export function assertTransition(from: TaskState, to: TaskState): void {
  if (!NEXT[from].includes(to)) throw new Error(`Illegal task transition: ${from} -> ${to}`)
}
/** Applies LAO lifecycle mutations within Engine repository transactions, retaining the original Ticket aggregate. */
export class Lifecycle {
  constructor(private readonly options: EngineOptions) {}
  private get records(): WorkflowRepository {
    const records = this.options.repo.workflow
    if (!records) throw new Error('Repository does not support durable task lifecycle records')
    return records
  }
  private now(): string { return this.options.now?.() ?? new Date().toISOString() }
  private require(id: string): Ticket & { lifecycle: NonNullable<Ticket['lifecycle']> } {
    const ticket = this.options.repo.tickets.get(id)
    if (!ticket?.lifecycle) throw new Error(`Unknown LAO ticket: ${id}`)
    return ticket as Ticket & { lifecycle: NonNullable<Ticket['lifecycle']> }
  }
  private audit(ticket: Ticket, event: Pick<TaskAudit, 'kind' | 'actor' | 'reason'> & Partial<TaskAudit>): void {
    if (!event.actor.trim() || !event.reason.trim()) throw new Error('An actor and reason are required')
    this.records.append({ ...event, id: randomUUID(), ticketId: ticket.id, at: this.now(), policyVersion: ticket.lifecycle!.policyVersion })
  }
  private transition(ticket: Ticket, to: TaskState, actor: string, reason: string): Ticket {
    const task = ticket.lifecycle!
    const from = task.status
    assertTransition(from, to)
    task.status = to; task.version++; ticket.updatedAt = this.now()
    if (to === 'DONE' || to === 'CANCELLED') {
      ticket.ended = { at: ticket.updatedAt, by: 'human', outcome: to === 'DONE' ? 'completed' : 'stopped', reason }
      ticket.undelivered = []
    }
    this.options.repo.tickets.save(ticket)
    this.audit(ticket, { kind: 'transition', from, to, actor, reason, assignmentId: latestAssignment(ticket)?.id })
    return ticket
  }
  initialize(ticket: Ticket, issue: IssueSnapshot, taskType: string, policy: TaskPolicy): void {
    if (!issue.source.trim() || !issue.issueId.trim() || !issue.revision.trim() || !Number.isFinite(Date.parse(issue.updatedAt))
      || !Number.isFinite(issue.priority) || typeof issue.closed !== 'boolean' || !taskType.trim() || !Number.isInteger(policy.retryLimit) || policy.retryLimit < 0
      || typeof policy.approvalRequired !== 'boolean' || typeof policy.reviewRequired !== 'boolean') throw new Error('Invalid task metadata')
    this.records.bindIssue(issue, ticket.id)
    ticket.lifecycle = { status: 'NEW', version: 0, issue: structuredClone(issue), taskType, policy: { ...policy },
      policyVersion: ticket.mandate.policyVersion, attempts: 0 }
    this.options.repo.tickets.save(ticket)
    this.audit(ticket, { kind: 'transition', to: 'NEW', actor: 'intake', reason: 'Issue accepted' })
    this.transition(ticket, issue.closed ? 'CANCELLED' : policy.approvalRequired ? 'WAITING_APPROVAL' : 'QUEUED', 'policy',
      issue.closed ? 'Source issue is closed' : policy.approvalRequired ? 'Execution approval required' : 'Execution authorized')
  }
  /** Records source changes without replacing the accepted execution input. */
  observeIssue(id: string, issue: IssueSnapshot): void {
    const ticket = this.require(id), task = ticket.lifecycle, previous = task.observedIssue ?? task.issue
    if (issue.source !== task.issue.source || issue.issueId !== task.issue.issueId || !issue.revision.trim()
      || !Number.isFinite(Date.parse(issue.updatedAt)) || !Number.isFinite(issue.priority)
      || typeof issue.description !== 'string' || typeof issue.closed !== 'boolean') throw new Error('Invalid source snapshot')
    if (issue.revision === previous.revision) {
      if (issue.updatedAt !== previous.updatedAt || issue.description !== previous.description || issue.priority !== previous.priority || issue.closed !== previous.closed)
        throw new Error('Conflicting snapshot for source revision')
      return
    }
    if (Date.parse(issue.updatedAt) < Date.parse(previous.updatedAt)) return
    // With timestamp ties, a closure cannot be undone by an unordered open snapshot.
    if (Date.parse(issue.updatedAt) === Date.parse(previous.updatedAt) && previous.closed && !issue.closed) return
    task.observedIssue = structuredClone(issue); task.version++; ticket.updatedAt = this.now()
    this.options.repo.tickets.save(ticket)
    this.audit(ticket, { kind: 'source-update', actor: 'source', reason: 'Observed source revision', issueSnapshot: structuredClone(issue) })
    if (['DONE', 'CANCELLED'].includes(task.status)) return
    if (issue.closed) { this.cancel(id, 'source', 'Source issue closed'); return }
    if ((issue.description !== task.issue.description || issue.priority !== task.issue.priority)
      && ['NEW', 'QUEUED', 'WAITING_APPROVAL'].includes(task.status))
      this.transition(ticket, 'BLOCKED', 'source', 'Source input changed; reassessment required')
  }
  approve(id: string, actor: string, reason: string): Ticket {
    const ticket = this.require(id)
    if (ticket.lifecycle.status !== 'WAITING_APPROVAL') throw new Error('Ticket is not awaiting execution approval')
    if ((ticket.lifecycle.observedIssue ?? ticket.lifecycle.issue).closed || !this.options.policy().revalidate(ticket.mandate)
      || this.options.policy().version !== ticket.lifecycle.policyVersion) throw new Error('Authorization is stale')
    this.audit(ticket, { kind: 'approval', actor, reason, decision: 'approved' })
    return this.transition(ticket, 'QUEUED', actor, reason)
  }
  reject(id: string, actor: string, reason: string): Ticket {
    const ticket = this.require(id)
    if (ticket.lifecycle.status !== 'WAITING_APPROVAL') throw new Error('Ticket is not awaiting execution approval')
    this.audit(ticket, { kind: 'approval', actor, reason, decision: 'rejected' })
    return this.transition(ticket, 'CANCELLED', actor, reason)
  }
  assign(id: string, agentId: string, runtime: string, worktreePath: string): Ticket {
    const ticket = this.require(id), policy = this.options.policy()
    if (ticket.lifecycle.status !== 'QUEUED' || ticket.lifecycle.cancelRequested) throw new Error('Ticket is not queued')
    if (!agentId.trim() || !runtime.trim() || !worktreePath.trim()) throw new Error('Assignment identity and worktree required')
    if (policy.paused || !policy.revalidate(ticket.mandate) || policy.version !== ticket.lifecycle.policyVersion || (ticket.lifecycle.observedIssue ?? ticket.lifecycle.issue).closed)
      throw new Error('Execution conditions no longer hold')
    if (ticket.assignments.some(item => item.state !== 'ended')) throw new Error('An assignment is still active')
    const assignment: Assignment = { id: randomUUID(), state: 'pending', createdAt: this.now(), agentId, runtime, worktreePath }
    ticket.assignments.push(assignment); ticket.lifecycle.attempts++; delete ticket.lifecycle.result
    this.transition(ticket, 'ASSIGNED', 'scheduler', 'Assignment reserved')
    // This port must enqueue a durable launch intent, never spawn inside this transaction.
    this.options.executor.start(ticket, assignment)
    return ticket
  }
  started(id: string, assignmentId: string): void {
    const ticket = this.require(id), assignment = latestAssignment(ticket)
    if (assignment?.id === assignmentId && assignment.state === 'running' && ticket.lifecycle.status === 'RUNNING' && !ticket.lifecycle.cancelRequested) return
    if (!assignment || assignment.id !== assignmentId || ticket.lifecycle.status !== 'ASSIGNED' || ticket.lifecycle.cancelRequested)
      throw new Error('Stale or cancelled assignment start')
    assignment.state = 'running'; assignment.startedAt = this.now()
    this.transition(ticket, 'RUNNING', 'executor', 'Process start confirmed')
  }
  result(id: string, evidence: ExecutionResult): Ticket {
    const ticket = this.require(id), task = ticket.lifecycle, assignment = latestAssignment(ticket)
    if (assignment?.id === evidence.assignmentId && task.result?.executionId === evidence.executionId) {
      const { verification: _verification, ...recorded } = task.result
      if (Object.keys(recorded).every(key => recorded[key as keyof ExecutionResult] === evidence[key as keyof ExecutionResult])) return ticket
      throw new Error('Conflicting evidence for an existing execution')
    }
    if (task.status !== 'RUNNING' || !assignment || assignment.id !== evidence.assignmentId || assignment.state !== 'running')
      throw new Error('Stale execution result')
    if (!evidence.executionId.trim() || !evidence.artifactRevision.trim() || !Number.isInteger(evidence.exitCode)
      || !['success', 'error'].includes(evidence.terminal))
      throw new Error('Invalid execution evidence')
    task.result = { ...structuredClone(evidence), verification: 'unknown' }
    assignment.state = 'ended'; assignment.endedAt = this.now()
    assignment.report = { state: evidence.exitCode === 0 && evidence.terminal === 'success' ? 'ready' : 'failed', summary: evidence.summary, at: this.now() }
    this.audit(ticket, { kind: 'evidence', actor: 'executor', reason: 'Terminal execution evidence collected',
      assignmentId: assignment.id, executionId: evidence.executionId, artifactRevision: evidence.artifactRevision, evidence: task.result })
    return this.transition(ticket, task.cancelRequested ? 'CANCELLED' : evidence.exitCode === 0 && evidence.terminal === 'success' ? 'REVIEW' : 'FAILED',
      'executor', task.cancelRequested ? 'Cancellation confirmed by process exit' : 'Execution ended; completion remains subject to review')
  }
  verify(id: string, input: VerificationEvidence): Ticket {
    const ticket = this.require(id), result = ticket.lifecycle.result
    if (ticket.lifecycle.status !== 'REVIEW' || !result || input.executionId !== result.executionId || input.artifactRevision !== result.artifactRevision)
      throw new Error('Verification does not match current execution artifacts')
    if (this.options.policy().version !== ticket.lifecycle.policyVersion || !this.options.policy().revalidate(ticket.mandate))
      throw new Error('Authorization is stale')
    if (!['unknown', 'passed', 'failed', 'not_required'].includes(input.state)) throw new Error('Invalid verification status')
    if (input.provenance !== undefined) {
      const proof = input.provenance
      if (!proof || typeof proof !== 'object' || Array.isArray(proof) || Object.keys(proof).length !== 4
        || !['verificationId','reportSha256','planId','planRevision'].every(field => Object.hasOwn(proof,field))
        || !['verificationId','planId','planRevision'].every(field => typeof proof[field as keyof typeof proof] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(proof[field as keyof typeof proof]))
        || typeof proof.reportSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.reportSha256)
        || (input.state !== 'passed' && input.state !== 'failed')) throw new Error('Invalid verification provenance')
    }
    result.verification = input.state; ticket.lifecycle.version++; ticket.updatedAt = this.now()
    this.audit(ticket, { kind: 'evidence', actor: input.actor, reason: input.reason, executionId: result.executionId,
      artifactRevision: result.artifactRevision, assignmentId: result.assignmentId, verification: input.state,
      ...(input.provenance ? {verificationProvenance: structuredClone(input.provenance)} : {}) })
    this.options.repo.tickets.save(ticket)
    return ticket
  }
  review(id: string, input: { actor: string; reason: string; approved: boolean; executionId: string; artifactRevision: string }): Ticket {
    const ticket = this.require(id), task = ticket.lifecycle, result = task.result
    if (task.status !== 'REVIEW' || !result || result.executionId !== input.executionId || result.artifactRevision !== input.artifactRevision)
      throw new Error('Review does not match current execution artifacts')
    if (this.options.policy().version !== task.policyVersion || !this.options.policy().revalidate(ticket.mandate)) throw new Error('Authorization is stale')
    if (input.approved && !['passed', 'not_required'].includes(result.verification)) throw new Error('Verification has not passed or been explicitly waived')
    this.audit(ticket, { kind: 'approval', actor: input.actor, reason: input.reason, decision: input.approved ? 'approved' : 'rejected',
      executionId: result.executionId, assignmentId: result.assignmentId, artifactRevision: result.artifactRevision })
    return this.transition(ticket, input.approved ? 'DONE' : 'BLOCKED', input.actor, input.reason)
  }
  retry(id: string, actor: string, reason: string): Ticket {
    const ticket = this.require(id), task = ticket.lifecycle
    if (!['FAILED', 'BLOCKED'].includes(task.status)) throw new Error('Ticket is not retryable')
    if (ticket.assignments.some(item => item.state !== 'ended')) throw new Error('Previous process has not been confirmed stopped')
    if (task.attempts >= task.policy.retryLimit + 1) throw new Error('Retry limit reached')
    if ((task.observedIssue ?? task.issue).closed || this.options.policy().version !== task.policyVersion || !this.options.policy().revalidate(ticket.mandate))
      throw new Error('Authorization is stale')
    this.audit(ticket, { kind: 'retry', actor, reason, assignmentId: latestAssignment(ticket)?.id })
    delete task.result
    return this.transition(ticket, 'QUEUED', actor, reason)
  }
  cancel(id: string, actor: string, reason: string): Ticket {
    const ticket = this.require(id), task = ticket.lifecycle
    if (['DONE', 'CANCELLED'].includes(task.status)) throw new Error('Ticket has already ended')
    if (task.cancelRequested) return ticket
    const assignment = latestAssignment(ticket)
    if (assignment && assignment.state !== 'ended') {
      task.cancelRequested = { actor, reason, at: this.now() }; task.version++; ticket.updatedAt = this.now()
      this.options.repo.tickets.save(ticket)
      this.audit(ticket, { kind: 'cancel-request', actor, reason, assignmentId: assignment.id })
      this.options.executor.stop(ticket, assignment, reason)
      return ticket
    }
    return this.transition(ticket, 'CANCELLED', actor, reason)
  }
  interrupted(id: string, assignmentId: string): void {
    const ticket = this.require(id), assignment = latestAssignment(ticket)
    if (!assignment || assignment.id !== assignmentId || assignment.state === 'ended') throw new Error('Stale interrupted assignment')
    if (ticket.lifecycle.status === 'BLOCKED') return
    // Keep the assignment active: an unknown process must retain its slot and cannot be retried.
    this.transition(ticket, 'BLOCKED', 'recovery', 'Process identity and session must be reconciled before further execution')
  }
  confirmStopped(id: string, assignmentId: string, reason: string): Ticket {
    const ticket = this.require(id), assignment = latestAssignment(ticket), task = ticket.lifecycle
    if (assignment?.id === assignmentId && assignment.state === 'ended' && ['FAILED', 'BLOCKED', 'CANCELLED'].includes(task.status)) return ticket
    if (!assignment || assignment.id !== assignmentId || assignment.state === 'ended' || !['ASSIGNED', 'RUNNING', 'BLOCKED'].includes(task.status))
      throw new Error('Stale process termination confirmation')
    assignment.state = 'ended'; assignment.endedAt = this.now(); assignment.endedReason = reason
    if (task.cancelRequested) return this.transition(ticket, 'CANCELLED', 'executor', reason)
    if (task.status === 'BLOCKED') {
      this.options.repo.tickets.save(ticket)
      this.audit(ticket, { kind: 'evidence', actor: 'recovery', reason, assignmentId })
      return ticket
    }
    return this.transition(ticket, 'FAILED', 'executor', reason)
  }
}
