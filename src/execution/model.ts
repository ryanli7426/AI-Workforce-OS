/** Durable execution facts, separate from Task completion and approval. */
export const EXECUTION_STATES = ['STARTING', 'RUNNING', 'STOPPING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED', 'UNKNOWN'] as const
export type ExecutionState = typeof EXECUTION_STATES[number]
export const TERMINAL_EXECUTION_STATES: readonly ExecutionState[] = ['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED']
export interface ExecutionSpec {
  executionId: string
  assignmentId: string
  ticketId: string
  agentId: string
  runtime: string
  generation: number
  cwd: string
  inputRevision: string
  policyVersion: string
}
export interface ExecutionRecord extends ExecutionSpec {
  state: ExecutionState
  createdAt: string
  updatedAt: string
  runnerId?: string
  runnerPid?: number
  processId?: number
  sessionId?: string
  exitCode?: number | null
  signal?: string | null
  failureReason?: string
  startedAt?: string
  finishedAt?: string
  lastSequence: number
}
export interface ExecutionEvent {
  executionId: string
  generation: number
  sequence: number
  at: string
  state: ExecutionState
  runnerId: string
  runnerPid?: number
  processId?: number
  sessionId?: string
  exitCode?: number | null
  signal?: string | null
  reason?: string
}
