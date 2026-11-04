import type { ProductOverview, ProductTaskListOptions, ProductTaskListResult, ProductTaskDetail } from '../../src/application/product-queries.ts'
import type { LocalTaskCommand, TaskCommandResult } from '../../src/application/task-commands.ts'
import type { Employee } from '../../src/workforce/employees.ts'
import type { Project } from '../../src/projects/projects.ts'
import type { ExecutionRecord } from '../../src/execution/model.ts'
import type { ExecutionLogsResult } from '../../src/observability/execution-logs.ts'
export type { ProductOverview, ProductTaskListOptions, ProductTaskListResult, ProductTaskDetail, LocalTaskCommand, TaskCommandResult, Employee, Project, ExecutionRecord, ExecutionLogsResult }
export interface Principal { ownerId: string; workspaceId: string; role: 'owner' }
export interface ApiClient {
  me(signal?: AbortSignal): Promise<Principal>
  overview(signal?: AbortSignal): Promise<ProductOverview>
  employees(signal?: AbortSignal): Promise<Employee[]>
  projects(signal?: AbortSignal): Promise<Project[]>
  tasks(options?: ProductTaskListOptions, signal?: AbortSignal): Promise<ProductTaskListResult>
  task(id: string, signal?: AbortSignal): Promise<ProductTaskDetail>
  execution(id: string, signal?: AbortSignal): Promise<ExecutionRecord>
  logs(ticketId: string, options?: { executionId?: string; maxBytes?: number }, signal?: AbortSignal): Promise<ExecutionLogsResult>
  command(key: string, command: LocalTaskCommand, signal?: AbortSignal): Promise<TaskCommandResult>
}
