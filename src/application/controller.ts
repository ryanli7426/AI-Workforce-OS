/** Compose independently supervised execution and verification under one controller lease. */
import type { LocalSettings } from '../config/settings.ts'
import type { LocalStore } from '../storage/store.ts'
import { VERIFICATION_SCHEMA_KEY, requireVerificationSchema } from '../storage/verification-jobs.ts'
import { VerificationRunnerClient } from '../verification/client.ts'
import { VerificationCoordinator } from './verification-coordinator.ts'
import type { ControlLoopOrchestrator } from './control-loop.ts'
import type { LocalTaskService } from './tasks.ts'

export function composeController(options: {
  execution: ControlLoopOrchestrator
  store: LocalStore
  tasks: LocalTaskService
  settings: LocalSettings
  dataDir: string
}): ControlLoopOrchestrator {
  // Historical initialized databases continue execution; verification requires explicit init.
  const installed = options.store.db.prepare('SELECT value FROM kv WHERE key = ?').get(VERIFICATION_SCHEMA_KEY)
  if (!installed) {
    const orphan = options.store.db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table'
      AND name IN ('verification_job','verification_job_event','verification_job_audit','verification_job_receipt') LIMIT 1`).get()
    if (orphan) throw new Error('Verification schema metadata is missing; refusing ambiguous state')
    return options.execution
  }
  requireVerificationSchema(options.store.db)
  const verification = new VerificationCoordinator({ store: options.store, tasks: options.tasks,
    ownerId: options.settings.ownerId, workspaceId: options.settings.workspaceId,
    runner: new VerificationRunnerClient({ dataDir: options.dataDir }),
    maxConcurrency: options.settings.scheduler.maxConcurrency })
  return {
    async reconcile() {
      const executions = await options.execution.reconcile()
      const verifications = await verification.reconcile()
      return { executions, verifications }
    },
    async tick() {
      const executions = await options.execution.tick()
      const verifications = await verification.tick()
      return executions && typeof executions === 'object' && !Array.isArray(executions)
        ? { ...executions, verifications } : { executions, verifications }
    },
  }
}
