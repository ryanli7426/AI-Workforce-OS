/** Application bridge: reserve durable execution before starting a detached Runner. */
import { realpathSync } from 'node:fs'
import type { ExecutionRecord, ExecutionSpec, ExecutionEvent } from '../execution/model.ts'
import { TERMINAL_EXECUTION_STATES } from '../execution/model.ts'
import { ExecutionRepository } from '../execution/repository.ts'
import { RunnerClient } from '../runner/client.ts'
import { validateLaunchSpec, type LaunchSpec, type RunnerEvent, type RunnerSnapshot } from '../runner/protocol.ts'

export interface ExecutionAuthorization {
  /** Must validate the current Task/Assignment, policy, project and resource permissions. */
  authorize(spec: ExecutionSpec, launch: LaunchSpec): void | Promise<void>
}
const terminal = (state: ExecutionRecord['state']) => TERMINAL_EXECUTION_STATES.includes(state)

function evidence(event: RunnerEvent): ExecutionEvent {
  return {
    executionId: event.executionId, generation: event.generation, sequence: event.sequence,
    at: event.at, state: event.state, runnerId: event.runnerId, runnerPid: event.runnerPid,
    ...(event.processId === undefined ? {} : { processId: event.processId }),
    ...(event.exitCode === undefined ? {} : { exitCode: event.exitCode }),
    ...(event.signal === undefined ? {} : { signal: event.signal }),
    ...(event.reason === undefined ? {} : { reason: event.reason }),
  }
}

export class ExecutionService {
  constructor(private readonly repository: ExecutionRepository, private readonly runner: RunnerClient,
    private readonly authorization: ExecutionAuthorization) {
    if (!authorization || typeof authorization.authorize !== 'function') throw new Error('Execution requires an authorization provider')
  }

  async start(spec: ExecutionSpec, launch: LaunchSpec): Promise<ExecutionRecord> {
    // Freeze the request before the authorization await; callers cannot mutate an approved launch.
    spec = structuredClone(spec); launch = structuredClone(launch)
    validateLaunchSpec(launch)
    for (const key of ['executionId', 'assignmentId', 'ticketId', 'generation', 'cwd'] as const)
      if (spec[key] !== launch[key]) throw new Error(`Launch identity differs from reservation: ${key}`)
    if (realpathSync(spec.cwd) !== spec.cwd) throw new Error('Execution cwd must use its canonical real path')
    await this.authorization.authorize(structuredClone(spec), structuredClone(launch))
    const reserved = this.repository.reserve(spec)
    if (terminal(reserved.state)) return reserved
    if (reserved.state === 'UNKNOWN') throw new Error('Execution is UNKNOWN; reconcile before any new launch')
    try {
      await this.runner.start(launch)
      return (await this.synchronize(spec.executionId)).execution
    } catch (error) {
      this.repository.markUnknown(spec.executionId, 'Runner launch or initial observation could not be confirmed')
      throw error
    }
  }

  async synchronize(executionId: string): Promise<{ execution: ExecutionRecord; runner?: RunnerSnapshot }> {
    let current = this.repository.get(executionId)
    if (!current) throw new Error('Unknown execution')
    if (terminal(current.state)) return { execution: current }
    try {
      const events = await this.runner.events(executionId, current.lastSequence)
      for (const event of events) current = this.repository.apply(evidence(event))
      const observed = await this.runner.status(executionId)
      if (!terminal(current.state) && observed.state === 'UNKNOWN')
        current = this.repository.markUnknown(executionId, 'Runner is unreachable or its heartbeat is stale')
      return { execution: current, runner: observed }
    } catch (error) {
      // Keep occupancy even if files are absent, corrupted or the worker disappeared.
      if (!terminal(current.state)) current = this.repository.markUnknown(executionId, 'Runner evidence could not be safely reconciled')
      throw error
    }
  }

  async stop(executionId: string, reason: string): Promise<{ accepted: boolean; detail?: string }> {
    const current = this.repository.get(executionId)
    if (!current) throw new Error('Unknown execution')
    if (terminal(current.state)) return { accepted: false, detail: 'already finished' }
    const result = await this.runner.stop(executionId, reason)
    if (!result.accepted && result.detail?.includes('UNKNOWN')) this.repository.markUnknown(executionId, 'Stop could not reach a confirmed Runner')
    return result
  }
}
