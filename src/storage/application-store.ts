/** Explicit composition of independent module schemas; queries must not invoke this initializer. */
import type { DatabaseSync } from 'node:sqlite'
import { LocalStore } from './store.ts'
import { ExecutionRepository, initializeExecutionSchema } from '../execution/repository.ts'
import { IntentRepository, initializeIntentSchema } from '../orchestration/intents.ts'
import { EmployeeRepository, initializeEmployeeSchema } from '../workforce/employees.ts'
import { ProjectRepository, initializeProjectSchema } from '../projects/projects.ts'
import { ApprovalRepository, initializeApprovalSchema } from '../governance/approvals.ts'
import { MANAGEMENT_SCHEMA_KEY, initializeManagementSchema } from './management-commands.ts'
import { VERIFICATION_SCHEMA_KEY, initializeVerificationSchema } from './verification-jobs.ts'
import { COMMAND_SCHEMA_KEY, initializeCommandSchema } from './command-receipts.ts'
import { CHANGE_FEED_SCHEMA_KEY, initializeChangeFeedSchema } from './change-feed.ts'

const MODULE_KEYS = ['execution-schema', 'intent-schema', 'employee-schema', 'project-schema', 'approval-schema'] as const
export function initializeApplicationSchema(store: LocalStore): void {
  store.atomic(() => {
    for (const key of [...MODULE_KEYS, COMMAND_SCHEMA_KEY, MANAGEMENT_SCHEMA_KEY, VERIFICATION_SCHEMA_KEY, CHANGE_FEED_SCHEMA_KEY]) {
      const version = store.get<unknown>(key)
      if (version !== undefined && version !== 1) throw new Error(`Unsupported module schema: ${key}`)
    }
    initializeExecutionSchema(store.db)
    initializeIntentSchema(store.db)
    initializeEmployeeSchema(store.db)
    initializeProjectSchema(store.db)
    initializeApprovalSchema(store.db)
    initializeCommandSchema(store.db)
    initializeManagementSchema(store.db)
    initializeVerificationSchema(store.db)
    initializeChangeFeedSchema(store.db)
  })
}
/** No schema mutations. Caller must explicitly initialize before constructing. */
export function applicationRepositories(db: DatabaseSync) {
  for (const key of MODULE_KEYS) {
    const value = db.prepare('SELECT value FROM kv WHERE key = ?').get(key)?.value
    if (value !== '1') throw new Error(`Application module not initialized or unsupported: ${key}`)
  }
  return {
    executions: new ExecutionRepository(db), intents: new IntentRepository(db),
    employees: new EmployeeRepository(db), projects: new ProjectRepository(db), approvals: ApprovalRepository(db),
  }
}
