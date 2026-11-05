/**
 * Durable asynchronous verification job aggregate types.
 * Storage owns persistence; coordinator/worker/HTTP are parent-owned integrations.
 */
import type { VerificationCheckRequest } from './local-checks.ts'

export const VERIFICATION_JOB_STATES = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'UNKNOWN',
] as const

export type VerificationJobState = typeof VERIFICATION_JOB_STATES[number]

export const ACTIVE_VERIFICATION_JOB_STATES = [
  'QUEUED',
  'STARTING',
  'RUNNING',
  'STOPPING',
  'UNKNOWN',
] as const satisfies readonly VerificationJobState[]

export const TERMINAL_VERIFICATION_JOB_STATES = [
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const satisfies readonly VerificationJobState[]

export const LAUNCHED_ACTIVE_VERIFICATION_JOB_STATES = [
  'STARTING',
  'RUNNING',
  'STOPPING',
] as const satisfies readonly VerificationJobState[]

export interface VerificationJobPlan {
  id: string
  revision: string
  checks: VerificationCheckRequest[]
}

/** Immutable enqueue payload. No env, credentials, or authorized fields. */
export interface VerificationJobRequest {
  verificationId: string
  workspaceId: string
  ownerId: string
  ticketId: string
  expectedTaskVersion: number
  policyVersion: string
  executionId: string
  artifactId: string
  artifactRevision: string
  plan: VerificationJobPlan
  reason: string
  createdAt: string
}

export interface VerificationJobCancelRequest {
  actorId: string
  reason: string
  at: string
}

export interface VerificationJob {
  request: VerificationJobRequest
  status: VerificationJobState
  version: number
  lastSequence: number
  runnerId?: string
  runnerPid?: number
  processId?: number
  outcome?: 'passed' | 'failed'
  reportSha256?: string
  application?: 'pending' | 'applied' | 'superseded'
  cancelRequested?: VerificationJobCancelRequest
  createdAt: string
  updatedAt: string
  finishedAt?: string
  failureCode?: string
}

/**
 * Authenticated worker evidence. `terminalConfirmed` is private validated worker proof,
 * never a public writable HTTP DTO field.
 */
export interface VerificationJobEvent {
  verificationId: string
  sequence: number
  runnerId: string
  runnerPid: number
  status: Exclude<VerificationJobState, 'QUEUED' | 'UNKNOWN'>
  at: string
  processId?: number
  outcome?: 'passed' | 'failed'
  reportSha256?: string
  terminalConfirmed?: boolean
  failureCode?: string
}

export interface VerificationJobAuditEntry {
  id: number
  verificationId: string
  action: string
  from?: VerificationJobState
  to?: VerificationJobState
  at: string
  actorId?: string
  reasonCode?: string
  sequence?: number
}

export interface VerificationJobReceipt {
  workspaceId: string
  ownerId: string
  key: string
  commandHash: string
  verificationId: string
  resultJson: string
  at: string
}
