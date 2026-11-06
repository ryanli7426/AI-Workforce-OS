/** Compose independently supervised execution and verification under one controller lease. */
import type { LocalSettings } from '../config/settings.ts'
import type { LocalStore } from '../storage/store.ts'
import { VERIFICATION_SCHEMA_KEY, requireVerificationSchema } from '../storage/verification-jobs.ts'
import { VerificationRunnerClient } from '../verification/client.ts'
import { VerificationCoordinator } from './verification-coordinator.ts'
import type { ControlLoopOrchestrator } from './control-loop.ts'
import type { LocalTaskService } from './tasks.ts'
import { CHANGE_FEED_SCHEMA_KEY,ChangeFeedRepository } from '../storage/change-feed.ts'

/** Cache invalidation history is bounded independently of permanent domain audits. */
function withChangeRetention(controller:ControlLoopOrchestrator,store:LocalStore,settings:LocalSettings):ControlLoopOrchestrator {
  const installed=store.db.prepare('SELECT value FROM kv WHERE key=?').get(CHANGE_FEED_SCHEMA_KEY)
  if(!installed){
    if(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name IN ('change_feed','change_feed_meta')").get()) {
      throw new Error('Change feed metadata is missing; refusing ambiguous state')
    }
    return controller
  }
  const feed=new ChangeFeedRepository({db:store.db,ownerId:settings.ownerId,workspaceId:settings.workspaceId})
  let lastPrune=0
  function trim(){
    if(Date.now()-lastPrune<60_000)return
    feed.prune(50_000)
    lastPrune=Date.now()
  }
  return {
    async reconcile(){const result=await controller.reconcile();trim();return result},
    async tick(){const result=await controller.tick();trim();return result},
  }
}

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
    return withChangeRetention(options.execution,options.store,options.settings)
  }
  requireVerificationSchema(options.store.db)
  const verification = new VerificationCoordinator({ store: options.store, tasks: options.tasks,
    ownerId: options.settings.ownerId, workspaceId: options.settings.workspaceId,
    runner: new VerificationRunnerClient({ dataDir: options.dataDir }),
    maxConcurrency: options.settings.scheduler.maxConcurrency })
  return withChangeRetention({
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
  },options.store,options.settings)
}
