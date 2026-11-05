/** Runtime-independent task lifecycle, source identity and audit contracts. */
import type { DomainEvent } from './ports.ts'
export const TASK_STATES = ['NEW', 'QUEUED', 'ASSIGNED', 'RUNNING', 'REVIEW', 'DONE', 'FAILED', 'BLOCKED', 'CANCELLED', 'WAITING_APPROVAL'] as const
export type TaskState = typeof TASK_STATES[number]
export interface IssueIdentity { source: string; issueId: string }
export interface IssueSnapshot extends IssueIdentity {
  revision: string
  updatedAt: string
  description: string
  priority: number
  closed: boolean
}
export interface TaskPolicy {
  approvalRequired: boolean
  reviewRequired: boolean
  retryLimit: number
}
export interface ExecutionEvidence {
  executionId: string
  assignmentId: string
  artifactRevision: string
  exitCode: number
  terminal: 'success' | 'error'
  summary: string
  verification: 'unknown' | 'passed' | 'failed' | 'not_required'
}
export type ExecutionResult = Omit<ExecutionEvidence, 'verification'>
export interface VerificationProvenance {
  verificationId: string
  reportSha256: string
  planId: string
  planRevision: string
}
export interface VerificationEvidence {
  executionId: string
  artifactRevision: string
  state: ExecutionEvidence['verification']
  actor: string
  reason: string
  provenance?: VerificationProvenance
}
export interface TaskLifecycle {
  status: TaskState
  version: number
  issue: IssueSnapshot
  /** Latest observed source state; accepted execution input remains in issue. */
  observedIssue?: IssueSnapshot
  taskType: string
  policy: TaskPolicy
  policyVersion: string
  attempts: number
  cancelRequested?: { actor: string; reason: string; at: string }
  result?: ExecutionEvidence
}
export interface TaskAudit {
  id: string
  ticketId: string
  at: string
  actor: string
  reason: string
  kind: 'transition' | 'approval' | 'retry' | 'cancel-request' | 'evidence' | 'migration' | 'source-update'
  from?: TaskState
  to?: TaskState
  policyVersion: string
  assignmentId?: string
  executionId?: string
  artifactRevision?: string
  decision?: 'approved' | 'rejected'
  verification?: ExecutionEvidence['verification']
  verificationProvenance?: VerificationProvenance
  evidence?: ExecutionEvidence
  issueSnapshot?: IssueSnapshot
}
export interface WorkflowRepository {
  recordDomain(event: DomainEvent): void
  domainEvents(): DomainEvent[]
  findIssue(identity: IssueIdentity): string | undefined
  /** A source identity can never be reassigned to another Ticket. */
  bindIssue(identity: IssueIdentity, ticketId: string): void
  append(event: TaskAudit): void
  history(ticketId: string): TaskAudit[]
}
