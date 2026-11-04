/** Deterministic, model-independent rule assessor. Advice only — does not create tasks or mutate state. */

export interface Rule {
  id: string
  enabled: boolean
  taskTypes: string[]
  priority: number
  approvalRequired: boolean
  reviewRequired: boolean
  retryLimit: number
}

export interface AssessInput {
  issueId: string
  source: string
  title: string
  description: string
  status: 'open' | 'closed'
  taskType?: string
  requestedPriority?: number
  executionAllowed: boolean
  hasWorkspace: boolean
}

export type AssessDecision =
  | {
    kind: 'accept'
    taskType: string
    priority: number
    policy: { approvalRequired: boolean; reviewRequired: boolean; retryLimit: number }
    matchedRuleId: string
  }
  | { kind: 'ignore'; reason: string }
  | { kind: 'blocked'; reason: string }

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Invalid ${label}`)
}

function assertBoolean(value: unknown, label: string): asserts value is boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid ${label}`)
}

function assertPriority(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error(`Invalid ${label}`)
}

function assertRetryLimit(value: unknown, label: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new Error(`Invalid ${label}`)
}

function validateRule(rule: Rule, index: number): void {
  const label = `rule[${index}]`
  if (rule == null || typeof rule !== 'object') throw new Error(`Invalid ${label}`)
  assertNonEmptyString(rule.id, `${label}.id`)
  assertBoolean(rule.enabled, `${label}.enabled`)
  if (!Array.isArray(rule.taskTypes)) throw new Error(`Invalid ${label}.taskTypes`)
  const seenTypes = new Set<string>()
  for (let i = 0; i < rule.taskTypes.length; i++) {
    const taskType = rule.taskTypes[i]
    assertNonEmptyString(taskType, `${label}.taskTypes[${i}]`)
    if (seenTypes.has(taskType)) throw new Error(`Duplicate task type in ${label}: ${taskType}`)
    seenTypes.add(taskType)
  }
  assertPriority(rule.priority, `${label}.priority`)
  assertBoolean(rule.approvalRequired, `${label}.approvalRequired`)
  assertBoolean(rule.reviewRequired, `${label}.reviewRequired`)
  assertRetryLimit(rule.retryLimit, `${label}.retryLimit`)
}

function validateInput(input: AssessInput): void {
  if (input == null || typeof input !== 'object') throw new Error('Invalid assess input')
  assertNonEmptyString(input.issueId, 'issueId')
  assertNonEmptyString(input.source, 'source')
  if (typeof input.title !== 'string') throw new Error('Invalid title')
  if (typeof input.description !== 'string') throw new Error('Invalid description')
  if (input.status !== 'open' && input.status !== 'closed') throw new Error('Invalid status')
  if (input.taskType !== undefined) assertNonEmptyString(input.taskType, 'taskType')
  if (input.requestedPriority !== undefined) assertPriority(input.requestedPriority, 'requestedPriority')
  assertBoolean(input.executionAllowed, 'executionAllowed')
  assertBoolean(input.hasWorkspace, 'hasWorkspace')
}

export class RuleAssessor {
  private readonly rules: readonly Rule[]
  /** Exact taskType → enabled rule that uniquely owns it. */
  private readonly byTaskType = new Map<string, Rule>()

  constructor(rules: readonly Rule[]) {
    if (!Array.isArray(rules)) throw new Error('Invalid rules')
    const ids = new Set<string>()
    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i]!
      validateRule(rule, i)
      if (ids.has(rule.id)) throw new Error(`Duplicate rule id: ${rule.id}`)
      ids.add(rule.id)
    }
    this.rules = rules.map(rule => ({ ...rule, taskTypes: [...rule.taskTypes] }))
    for (const rule of this.rules) {
      if (!rule.enabled) continue
      for (const taskType of rule.taskTypes) {
        if (this.byTaskType.has(taskType)) throw new Error(`Overlapping enabled rules for task type: ${taskType}`)
        this.byTaskType.set(taskType, rule)
      }
    }
  }

  assess(input: AssessInput): AssessDecision {
    validateInput(input)
    // Title and description are untrusted display text only — never used for authorization.
    void input.title
    void input.description

    if (input.status === 'closed') return { kind: 'ignore', reason: 'Issue is closed' }
    if (!input.executionAllowed) return { kind: 'blocked', reason: 'Execution is not allowed' }
    if (!input.hasWorkspace) return { kind: 'blocked', reason: 'Workspace is required' }
    if (input.taskType === undefined) return { kind: 'blocked', reason: 'Task type is required' }

    const rule = this.byTaskType.get(input.taskType)
    if (!rule) return { kind: 'blocked', reason: 'No enabled admission rule matched' }

    const priority = input.requestedPriority === undefined
      ? rule.priority
      : Math.min(input.requestedPriority, rule.priority)

    return {
      kind: 'accept',
      taskType: input.taskType,
      priority,
      policy: {
        approvalRequired: rule.approvalRequired,
        reviewRequired: rule.reviewRequired,
        retryLimit: rule.retryLimit,
      },
      matchedRuleId: rule.id,
    }
  }
}
