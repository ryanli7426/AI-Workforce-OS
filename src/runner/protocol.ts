/** Versioned private-file Runner protocol; credentials are never accepted in launch specs. */
import { isAbsolute } from 'node:path'
import type { ExecutionState } from '../execution/model.ts'
export interface LaunchSpec {
  executionId: string
  assignmentId: string
  ticketId: string
  generation: number
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
  maxOutputBytes: number
  graceMs: number
}
export interface RunnerRequest { version: 1; token: string; spec: LaunchSpec }
export interface RunnerSnapshot {
  version: 1
  executionId: string
  assignmentId: string
  ticketId: string
  generation: number
  runnerId: string
  runnerPid: number
  processId?: number
  state: ExecutionState
  sequence: number
  startedAt: string
  updatedAt: string
  heartbeatAt: string
  finishedAt?: string
  exitCode?: number | null
  signal?: string | null
  reason?: string
  stdoutBytes: number
  stderrBytes: number
}
export interface RunnerEvent extends RunnerSnapshot { at: string }
export interface StopRequest { version: 1; token: string; reason: string }
export function assertExecutionId(id: string): void {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw new Error('Invalid execution ID')
}
export function validateLaunchSpec(value: unknown): asserts value is LaunchSpec {
  if (!value || typeof value !== 'object') throw new Error('Invalid launch spec')
  const s = value as LaunchSpec
  const fields = ['executionId','assignmentId','ticketId','generation','command','args','cwd','timeoutMs','maxOutputBytes','graceMs']
  if (Object.keys(s).some(key => !fields.includes(key))) throw new Error('Unknown launch fields')
  assertExecutionId(s.executionId)
  for (const field of ['assignmentId', 'ticketId', 'command', 'cwd'] as const)
    if (typeof s[field] !== 'string' || !s[field].trim() || s[field].includes('\0')) throw new Error(`Invalid launch ${field}`)
  if (!isAbsolute(s.command) || !isAbsolute(s.cwd)) throw new Error('Launch command and cwd must be absolute')
  if (!Number.isSafeInteger(s.generation) || s.generation < 1) throw new Error('Invalid launch generation')
  if (!Array.isArray(s.args) || s.args.some(a => typeof a !== 'string' || a.includes('\0'))) throw new Error('Invalid launch arguments')
  for (const field of ['timeoutMs', 'maxOutputBytes', 'graceMs'] as const)
    if (!Number.isSafeInteger(s[field]) || s[field] < 1) throw new Error(`Invalid launch ${field}`)
}
