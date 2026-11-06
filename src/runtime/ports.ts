/** Runtime protocol is declarative. The independent Runner owns processes and recovery. */
import type { LaunchSpec } from '../runner/protocol.ts'

export interface RuntimeCapabilities {
  readonly activeInput: boolean
  readonly continueSession: boolean
  readonly reattachMonitor: boolean
  readonly pause: boolean
  readonly structuredResult: boolean
  /** Worktrees/cwd/tool allowlists alone do not provide filesystem containment. */
  readonly filesystemIsolation: boolean
}

export interface RuntimeTaskInput {
  executionId: string
  assignmentId: string
  ticketId: string
  generation: number
  cwd: string
  title: string
  description: string
  inputRevision: string
  policyVersion: string
}

export interface RuntimeResultInput {
  exitCode: number | null
  signal?: string | null
  stdout: string
  stderr?: string
  reason?: string
}

export interface RuntimeUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
}

export interface RuntimeResult {
  terminal: 'success' | 'error'
  summary: string
  sessionId?: string
  usage?: RuntimeUsage
}

export interface RuntimeAdapter {
  readonly runtime: string
  readonly capabilities: RuntimeCapabilities
  createLaunch(input: RuntimeTaskInput): LaunchSpec
  parseResult(input: RuntimeResultInput): RuntimeResult
}

export interface RuntimeAdapterOptions {
  command: string
  timeoutMs: number
  maxOutputBytes: number
  graceMs: number
}

export interface RuntimeDriverDescriptor {
  readonly id: string
  readonly displayName: string
  /** Bump when launch/result interpretation changes incompatibly. */
  readonly protocolVersion: number
  readonly capabilities: RuntimeCapabilities
}

/** Trusted application composition only; configuration cannot load arbitrary driver code. */
export interface RuntimeDriver extends RuntimeDriverDescriptor {
  create(options: RuntimeAdapterOptions): RuntimeAdapter
}
