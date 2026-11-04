/** Single-owner local Task application boundary over Core Engine + LocalStore. */
import { createHash } from 'node:crypto'
import { RuleAssessor, type Rule } from '../assessor/rules.ts'
import { createLocalEngine } from '../core/local.ts'
import { key } from '../core/ids.ts'
import type { Engine } from '../core/engine.ts'
import type { Assignment, Mandate, Ticket, Trigger } from '../core/model.ts'
import type { Assessor, Executor, Outbox, Policy, SourceScope } from '../core/ports.ts'
import { IntentRepository } from '../orchestration/intents.ts'
import { ProjectRepository } from '../projects/projects.ts'
import { applicationRepositories } from '../storage/application-store.ts'
import type { LocalStore } from '../storage/store.ts'

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/
const MAX_TITLE = 512
const MAX_DESCRIPTION = 8192
const CREATE_REQUIRED = ['issueId', 'projectId', 'title', 'description', 'taskType'] as const
const CREATE_OPTIONAL = ['priority'] as const

export interface LocalTaskServiceOptions {
  store: LocalStore
  ownerId: string
  rules: readonly Rule[]
  workspaceId?: string
  now?: () => string
}

export interface CreateTaskInput {
  issueId: string
  projectId: string
  title: string
  description: string
  taskType: string
  priority?: number
}

export interface VerifyTaskInput {
  executionId: string
  artifactRevision: string
  state: 'passed' | 'failed' | 'not_required'
  reason: string
}

export interface ReviewTaskInput {
  executionId: string
  artifactRevision: string
  approved: boolean
  reason: string
}

function requireSafeId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`Invalid ${field}`)
}

function requireReason(reason: unknown): asserts reason is string {
  if (typeof reason !== 'string' || !reason.trim() || reason.includes('\0')) throw new Error('Invalid reason')
}

function requireExactObject(value: unknown, required: readonly string[], optional: readonly string[], label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`)
  const record = value as Record<string, unknown>
  const allowed = new Set([...required, ...optional])
  for (const field of Object.keys(record)) {
    if (!allowed.has(field)) throw new Error(`Unknown ${label} field: ${field}`)
  }
  for (const field of required) {
    if (!(field in record)) throw new Error(`Missing ${label} field: ${field}`)
  }
  return record
}

function requireText(value: unknown, field: string, max: number): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0') || value.length > max) throw new Error(`Invalid ${field}`)
}

function canonicalJson(value: unknown): string {
  const seen = new Set<object>()
  const visit = (item: unknown): unknown => {
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return item
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) throw new Error('Invalid canonical number')
      return Object.is(item, -0) ? 0 : item
    }
    if (typeof item !== 'object') throw new Error('Invalid canonical value')
    if (seen.has(item as object)) throw new Error('Invalid canonical cycle')
    seen.add(item as object)
    if (Array.isArray(item)) return item.map(visit)
    const out: Record<string, unknown> = {}
    for (const keyName of Object.keys(item as Record<string, unknown>).sort()) {
      out[keyName] = visit((item as Record<string, unknown>)[keyName])
    }
    return out
  }
  return JSON.stringify(visit(value))
}

function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function manualSource(workspaceId: string, projectId: string): string {
  return `manual:${workspaceId}:${projectId}`
}

function parseManualSource(source: string): { workspaceId: string; projectId: string } | undefined {
  const parts = source.split(':')
  if (parts.length !== 3 || parts[0] !== 'manual') return undefined
  const workspaceId = parts[1]
  const projectId = parts[2]
  if (!workspaceId || !projectId || !SAFE_ID.test(workspaceId) || !SAFE_ID.test(projectId)) return undefined
  return { workspaceId, projectId }
}

function noopAssessor(): Assessor {
  return { request() { /* manual intake decides synchronously */ } }
}

function noopOutbox(): Outbox {
  return {
    send() { /* no channel delivery in local manual intake */ },
    withdraw() { /* no-op */ },
    status() { return undefined },
  }
}

function intentExecutor(intents: IntentRepository, clock: () => string): Executor {
  return {
    start(ticket: Ticket, assignment: Assignment): void {
      const lifecycle = ticket.lifecycle
      if (!lifecycle) throw new Error('Launch requires LAO lifecycle metadata')
      const agentId = assignment.agentId
      const runtime = assignment.runtime
      const cwd = assignment.worktreePath
      if (!agentId?.trim() || !runtime?.trim() || !cwd?.trim()) {
        throw new Error('Missing required launch metadata')
      }
      const generation = lifecycle.attempts
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid launch generation')
      const now = clock()
      const dueAt = Date.parse(now)
      if (!Number.isFinite(dueAt)) throw new Error('Invalid launch dueAt')
      intents.enqueue({
        id: `launch:${assignment.id}`,
        kind: 'launch',
        key: assignment.id,
        generation,
        payload: {
          ticketId: ticket.id,
          assignmentId: assignment.id,
          agentId,
          runtime,
          cwd,
          generation,
        },
        dueAt,
        maxAttempts: 3,
      })
    },
    deliver(): void {
      throw new Error('Input delivery is unsupported by the local task intent executor')
    },
    stop(ticket: Ticket, assignment: Assignment, reason: string): void {
      const lifecycle = ticket.lifecycle
      if (!lifecycle) throw new Error('Stop requires LAO lifecycle metadata')
      const generation = lifecycle.attempts
      if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid stop generation')
      const now = clock()
      const dueAt = Date.parse(now)
      if (!Number.isFinite(dueAt)) throw new Error('Invalid stop dueAt')
      intents.enqueue({
        id: `stop:${assignment.id}`,
        kind: 'stop',
        key: assignment.id,
        generation,
        payload: {
          ticketId: ticket.id,
          assignmentId: assignment.id,
          reason,
        },
        dueAt,
        maxAttempts: 3,
      })
    },
  }
}

function ownerPolicy(ownerId: string, workspaceId: string, version: string): Policy {
  const sourcePrefix = `manual:${workspaceId}:`
  return {
    version,
    paused: false,
    evalTimeoutMs: 60_000,
    gate(trigger) {
      if (!trigger.source.startsWith(sourcePrefix)) return { admissible: false, reason: 'foreignSource' }
      if (!parseManualSource(trigger.source)) return { admissible: false, reason: 'invalidSource' }
      if (!trigger.human || trigger.addressed !== 'direct') return { admissible: false, reason: 'notOwnerDirect' }
      if (trigger.actor.source !== trigger.source || trigger.actor.id !== ownerId) {
        return { admissible: false, reason: 'actorNotOwner' }
      }
      return {
        admissible: true,
        strength: 'explicit',
        basis: { via: 'addressed', addressed: 'direct', source: trigger.source, sender: ownerId },
      }
    },
    revalidate(mandate: Mandate): boolean {
      if (mandate.policyVersion !== version) return false
      if (mandate.actor.id !== ownerId) return false
      if (!mandate.actor.source.startsWith(sourcePrefix)) return false
      if (mandate.strength !== 'explicit') return false
      if (mandate.basis.via !== 'addressed' || mandate.basis.addressed !== 'direct') return false
      return true
    },
    admitsInferred() {
      return false
    },
  }
}

function ownerScope(workspaceId: string): SourceScope {
  const sourcePrefix = `manual:${workspaceId}:`
  return {
    scope(input) {
      if (!input.source.startsWith(sourcePrefix) || !parseManualSource(input.source)) {
        return { listened: false, reason: 'foreignSource' }
      }
      return { listened: true, observed: false, row: 'manual-owner' }
    },
  }
}

/** Trusted local owner application service. constructor ownerId is authenticated OS/app config, never Issue text. */
export class LocalTaskService {
  readonly engine: Engine
  private readonly store: LocalStore
  private readonly ownerId: string
  private readonly workspaceId: string
  private readonly assessor: RuleAssessor
  private readonly rulesSnapshot: readonly Rule[]
  private readonly policyVersion: string
  private readonly projects: ProjectRepository
  private readonly intents: IntentRepository
  private readonly now: () => string

  constructor(options: LocalTaskServiceOptions) {
    if (!options || typeof options !== 'object') throw new Error('Invalid LocalTaskService options')
    if (!options.store) throw new Error('LocalStore is required')
    requireSafeId(options.ownerId, 'ownerId')
    const workspaceId = options.workspaceId ?? 'local'
    requireSafeId(workspaceId, 'workspaceId')
    // Schemas must already be initialized; construction never migrates or installs them.
    applicationRepositories(options.store.db)
    this.store = options.store
    this.ownerId = options.ownerId
    this.workspaceId = workspaceId
    this.now = options.now ?? (() => new Date().toISOString())
    this.assessor = new RuleAssessor(options.rules)
    this.rulesSnapshot = options.rules.map(rule => ({
      id: rule.id,
      enabled: rule.enabled,
      taskTypes: [...rule.taskTypes],
      priority: rule.priority,
      approvalRequired: rule.approvalRequired,
      reviewRequired: rule.reviewRequired,
      retryLimit: rule.retryLimit,
    }))
    this.policyVersion = hashCanonical(this.rulesSnapshot)
    this.projects = new ProjectRepository(options.store.db)
    this.intents = new IntentRepository(options.store.db)
    const clock = () => this.now()
    this.engine = createLocalEngine({
      repo: options.store,
      policy: () => ownerPolicy(this.ownerId, this.workspaceId, this.policyVersion),
      scope: ownerScope(this.workspaceId),
      assessor: noopAssessor(),
      outbox: noopOutbox(),
      executor: intentExecutor(this.intents, clock),
      now: clock,
    })
  }

  create(input: CreateTaskInput): Ticket {
    const body = requireExactObject(input, CREATE_REQUIRED, CREATE_OPTIONAL, 'create')
    requireSafeId(body.issueId, 'issueId')
    requireSafeId(body.projectId, 'projectId')
    requireText(body.title, 'title', MAX_TITLE)
    requireText(body.description, 'description', MAX_DESCRIPTION)
    requireSafeId(body.taskType, 'taskType')
    if (body.priority !== undefined) {
      if (typeof body.priority !== 'number' || !Number.isFinite(body.priority) || body.priority < 0) {
        throw new Error('Invalid priority')
      }
    }

    const project = this.projects.get(body.projectId as string)
    const allowed = !!project && !project.archived && project.workspaceId === this.workspaceId
      && project.allowedTaskTypes.includes(body.taskType as string)
    const source = manualSource(this.workspaceId, body.projectId as string)
    const decision = this.assessor.assess({
      issueId: body.issueId as string,
      source,
      title: body.title as string,
      description: body.description as string,
      status: 'open',
      taskType: body.taskType as string,
      ...(body.priority === undefined ? {} : { requestedPriority: body.priority as number }),
      executionAllowed: allowed,
      hasWorkspace: true,
    })
    if (decision.kind !== 'accept') throw new Error(decision.reason)

    const accepted = {
      issueId: body.issueId as string,
      projectId: body.projectId as string,
      title: body.title as string,
      description: body.description as string,
      taskType: decision.taskType,
      priority: decision.priority,
    }
    const revision = hashCanonical(accepted)
    const existingId = this.store.workflow.findIssue({ source, issueId: accepted.issueId })
    if (existingId) {
      const existing = this.store.tickets.get(existingId)
      if (!existing?.lifecycle) throw new Error('Source binding has no ticket')
      this.assertOwned(existing)
      const same = existing.title === accepted.title
        && existing.lifecycle.issue.description === accepted.description
        && existing.lifecycle.taskType === accepted.taskType
        && existing.lifecycle.issue.priority === accepted.priority
        && existing.lifecycle.issue.source === source
        && existing.lifecycle.issue.revision === revision
      if (!same) throw new Error('Conflicting create payload for issue')
      return existing
    }

    const at = this.now()
    const triggerId = key('manual-task', source, accepted.issueId)
    const trigger: Trigger = {
      id: triggerId,
      source,
      threads: [{ source, id: accepted.issueId }],
      actor: { source, id: this.ownerId },
      human: true,
      addressed: 'direct',
      at,
      text: accepted.title,
      meta: {},
    }

    return this.store.atomic(() => {
      this.engine.receive(trigger)
      const recorded = this.engine.decide(triggerId, {
        kind: 'accept',
        title: accepted.title,
        scope: accepted.description,
        reason: `Matched rule ${decision.matchedRuleId}`,
        rules: [decision.matchedRuleId],
        task: {
          issue: {
            source,
            issueId: accepted.issueId,
            revision,
            updatedAt: at,
            description: accepted.description,
            priority: accepted.priority,
            closed: false,
          },
          taskType: accepted.taskType,
          policy: { ...decision.policy },
        },
      })
      const ticket = this.store.tickets.get(recorded.ticketId!)
      if (!ticket) throw new Error('Acceptance did not persist a ticket')
      return ticket
    })
  }

  get(id: string): Ticket | undefined {
    requireSafeId(id, 'id')
    const ticket = this.store.tickets.get(id)
    if (!ticket?.lifecycle) return undefined
    const parsed = parseManualSource(ticket.lifecycle.issue.source)
    if (!parsed || parsed.workspaceId !== this.workspaceId) return undefined
    try { this.assertOwned(ticket) } catch { return undefined }
    return ticket
  }

  list(): Ticket[] {
    return this.store.tickets.list().filter(ticket => {
      const source = ticket.lifecycle?.issue.source
      if (!source) return false
      const parsed = parseManualSource(source)
      if (!parsed || parsed.workspaceId !== this.workspaceId) return false
      try { this.assertOwned(ticket); return true } catch { return false }
    })
  }

  approve(id: string, reason: string): Ticket {
    requireReason(reason)
    return this.engine.approveTask(this.requireOwned(id).id, this.ownerId, reason)
  }

  reject(id: string, reason: string): Ticket {
    requireReason(reason)
    return this.engine.rejectTask(this.requireOwned(id).id, this.ownerId, reason)
  }

  cancel(id: string, reason: string): Ticket {
    requireReason(reason)
    return this.engine.cancelTask(this.requireOwned(id).id, this.ownerId, reason)
  }

  retry(id: string, reason: string): Ticket {
    requireReason(reason)
    return this.engine.retryTask(this.requireOwned(id).id, this.ownerId, reason)
  }

  verify(id: string, input: VerifyTaskInput): Ticket {
    const body = requireExactObject(input, ['executionId', 'artifactRevision', 'state', 'reason'], [], 'verify')
    requireText(body.executionId, 'executionId', 512)
    requireText(body.artifactRevision, 'artifactRevision', 512)
    if (body.state !== 'passed' && body.state !== 'failed' && body.state !== 'not_required') {
      throw new Error('Invalid verification state')
    }
    requireReason(body.reason)
    const ticket = this.requireOwned(id)
    return this.engine.recordVerification(ticket.id, {
      executionId: body.executionId as string,
      artifactRevision: body.artifactRevision as string,
      state: body.state,
      actor: this.ownerId,
      reason: body.reason as string,
    })
  }

  review(id: string, input: ReviewTaskInput): Ticket {
    const body = requireExactObject(input, ['executionId', 'artifactRevision', 'approved', 'reason'], [], 'review')
    requireText(body.executionId, 'executionId', 512)
    requireText(body.artifactRevision, 'artifactRevision', 512)
    if (typeof body.approved !== 'boolean') throw new Error('Invalid approved flag')
    requireReason(body.reason)
    const ticket = this.requireOwned(id)
    return this.engine.reviewTask(ticket.id, {
      actor: this.ownerId,
      reason: body.reason as string,
      approved: body.approved as boolean,
      executionId: body.executionId as string,
      artifactRevision: body.artifactRevision as string,
    })
  }

  private requireOwned(id: string): Ticket {
    requireSafeId(id, 'id')
    const ticket = this.store.tickets.get(id)
    if (!ticket?.lifecycle) throw new Error('Unknown ticket')
    this.assertOwned(ticket)
    return ticket
  }

  private assertOwned(ticket: Ticket): void {
    const parsed = parseManualSource(ticket.lifecycle!.issue.source)
    if (!parsed || parsed.workspaceId !== this.workspaceId) throw new Error('Cross-workspace task is not allowed')
    if (ticket.mandate.actor.id !== this.ownerId || ticket.mandate.actor.source !== ticket.lifecycle!.issue.source)
      throw new Error('Task belongs to a different owner')
    const project = this.projects.get(parsed.projectId)
    if (!project || project.workspaceId !== this.workspaceId) throw new Error('Task project is not in this workspace')
  }
}
