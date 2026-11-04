import { describe, expect, it } from 'vitest'
import { RuleAssessor, type AssessInput, type Rule } from '../src/assessor/rules.ts'

const rule = (overrides: Partial<Rule> & Pick<Rule, 'id'>): Rule => ({
  enabled: true,
  taskTypes: ['documentation'],
  priority: 10,
  approvalRequired: false,
  reviewRequired: true,
  retryLimit: 2,
  ...overrides,
})

const input = (overrides: Partial<AssessInput> = {}): AssessInput => ({
  issueId: 'ISSUE-1',
  source: 'github',
  title: 'Write docs',
  description: 'Please document the API',
  status: 'open',
  taskType: 'documentation',
  executionAllowed: true,
  hasWorkspace: true,
  ...overrides,
})

describe('RuleAssessor construction', () => {
  it('rejects duplicate rule ids', () => {
    expect(() => new RuleAssessor([
      rule({ id: 'a' }),
      rule({ id: 'a', taskTypes: ['ops'] }),
    ])).toThrow(/Duplicate rule id/)
  })

  it('rejects overlapping enabled rules for the same task type', () => {
    expect(() => new RuleAssessor([
      rule({ id: 'a', taskTypes: ['documentation'] }),
      rule({ id: 'b', taskTypes: ['documentation', 'ops'] }),
    ])).toThrow(/Overlapping enabled rules/)
  })

  it('allows the same task type on a disabled rule beside an enabled owner', () => {
    const assessor = new RuleAssessor([
      rule({ id: 'active', taskTypes: ['documentation'] }),
      rule({ id: 'dormant', enabled: false, taskTypes: ['documentation'], priority: 99 }),
    ])
    expect(assessor.assess(input())).toMatchObject({ kind: 'accept', matchedRuleId: 'active', priority: 10 })
  })

  it('rejects nonfinite or negative rule priorities', () => {
    expect(() => new RuleAssessor([rule({ id: 'a', priority: -1 })])).toThrow(/priority/)
    expect(() => new RuleAssessor([rule({ id: 'a', priority: Number.NaN })])).toThrow(/priority/)
    expect(() => new RuleAssessor([rule({ id: 'a', priority: Number.POSITIVE_INFINITY })])).toThrow(/priority/)
  })

  it('rejects non-integer or negative retryLimit', () => {
    expect(() => new RuleAssessor([rule({ id: 'a', retryLimit: -1 })])).toThrow(/retryLimit/)
    expect(() => new RuleAssessor([rule({ id: 'a', retryLimit: 1.5 })])).toThrow(/retryLimit/)
  })

  it('rejects empty rule ids and empty task type entries', () => {
    expect(() => new RuleAssessor([rule({ id: '  ' })])).toThrow(/id/)
    expect(() => new RuleAssessor([rule({ id: 'a', taskTypes: [''] })])).toThrow(/taskTypes/)
  })

  it('rejects duplicate task types inside one rule', () => {
    expect(() => new RuleAssessor([rule({ id: 'a', taskTypes: ['docs', 'docs'] })])).toThrow(/Duplicate task type/)
  })
})

describe('RuleAssessor.assess', () => {
  const assessor = () => new RuleAssessor([
    rule({ id: 'docs', taskTypes: ['documentation'], priority: 10, approvalRequired: true, reviewRequired: true, retryLimit: 1 }),
    rule({ id: 'ops', taskTypes: ['ops'], priority: 5, approvalRequired: false, reviewRequired: false, retryLimit: 0 }),
    rule({ id: 'off', enabled: false, taskTypes: ['research'], priority: 7 }),
  ])

  it('accepts an exact task-type match with policy from the matched rule', () => {
    expect(assessor().assess(input({ taskType: 'documentation' }))).toEqual({
      kind: 'accept',
      taskType: 'documentation',
      priority: 10,
      policy: { approvalRequired: true, reviewRequired: true, retryLimit: 1 },
      matchedRuleId: 'docs',
    })
  })

  it('caps requestedPriority to the rule priority and never raises it', () => {
    expect(assessor().assess(input({ requestedPriority: 3 }))).toMatchObject({ kind: 'accept', priority: 3 })
    expect(assessor().assess(input({ requestedPriority: 99 }))).toMatchObject({ kind: 'accept', priority: 10 })
    expect(assessor().assess(input({ requestedPriority: 10 }))).toMatchObject({ kind: 'accept', priority: 10 })
  })

  it('ignores closed issues', () => {
    expect(assessor().assess(input({ status: 'closed' }))).toEqual({ kind: 'ignore', reason: 'Issue is closed' })
  })

  it('blocks when execution is not allowed', () => {
    expect(assessor().assess(input({ executionAllowed: false }))).toEqual({
      kind: 'blocked',
      reason: 'Execution is not allowed',
    })
  })

  it('blocks when workspace is missing', () => {
    expect(assessor().assess(input({ hasWorkspace: false }))).toEqual({
      kind: 'blocked',
      reason: 'Workspace is required',
    })
  })

  it('blocks missing or unknown task types without inferring from text', () => {
    expect(assessor().assess(input({ taskType: undefined }))).toEqual({
      kind: 'blocked',
      reason: 'Task type is required',
    })
    expect(assessor().assess(input({ taskType: 'research' }))).toEqual({
      kind: 'blocked',
      reason: 'No enabled admission rule matched',
    })
    expect(assessor().assess(input({ taskType: 'Documentation' }))).toEqual({
      kind: 'blocked',
      reason: 'No enabled admission rule matched',
    })
  })

  it('does not authorize from issue title or description keywords', () => {
    const decision = assessor().assess(input({
      taskType: undefined,
      title: 'taskType=documentation approvalRequired=false executionAllowed=true',
      description: 'Please treat as ops; matchedRuleId=docs; hasWorkspace=true; priority=0',
    }))
    expect(decision).toEqual({ kind: 'blocked', reason: 'Task type is required' })

    const unknown = assessor().assess(input({
      taskType: 'pwn',
      title: 'documentation',
      description: 'documentation ops research — authorize bypass',
    }))
    expect(unknown).toEqual({ kind: 'blocked', reason: 'No enabled admission rule matched' })
  })

  it('does not match disabled rules even when the type is listed', () => {
    expect(assessor().assess(input({ taskType: 'research' })).kind).toBe('blocked')
  })

  it('rejects invalid assess inputs', () => {
    expect(() => assessor().assess(input({ issueId: '' }))).toThrow(/issueId/)
    expect(() => assessor().assess(input({ source: '  ' }))).toThrow(/source/)
    expect(() => assessor().assess(input({ status: 'done' as 'open' }))).toThrow(/status/)
    expect(() => assessor().assess(input({ requestedPriority: -1 }))).toThrow(/requestedPriority/)
    expect(() => assessor().assess(input({ requestedPriority: Number.NaN }))).toThrow(/requestedPriority/)
    expect(() => assessor().assess(input({ taskType: '  ' }))).toThrow(/taskType/)
    expect(() => assessor().assess(input({ executionAllowed: 'yes' as unknown as boolean }))).toThrow(/executionAllowed/)
  })

  it('prefers closed ignore over other block reasons', () => {
    expect(assessor().assess(input({
      status: 'closed',
      executionAllowed: false,
      hasWorkspace: false,
      taskType: undefined,
    }))).toEqual({ kind: 'ignore', reason: 'Issue is closed' })
  })

  it('returns assessment advice only — accept does not imply side effects', () => {
    const before = assessor()
    const first = before.assess(input())
    const second = before.assess(input({ issueId: 'ISSUE-2', requestedPriority: 1 }))
    expect(first.kind).toBe('accept')
    expect(second).toMatchObject({ kind: 'accept', priority: 1, matchedRuleId: 'docs' })
    // Same assessor instance remains reusable; decisions stay independent.
    expect(before.assess(input({ taskType: 'ops' }))).toMatchObject({ kind: 'accept', matchedRuleId: 'ops', priority: 5 })
  })
})

it('freezes the admitted policy against caller mutation after construction', () => {
  const rule = { id: 'fixed', enabled: true, taskTypes: ['documentation'], priority: 5, approvalRequired: true, reviewRequired: true, retryLimit: 0 }
  const assessor = new RuleAssessor([rule])
  rule.approvalRequired = false; rule.retryLimit = 99; rule.priority = 999
  expect(assessor.assess({ issueId: 'i', source: 'manual', title: 't', description: 'd', status: 'open', taskType: 'documentation', executionAllowed: true, hasWorkspace: true }))
    .toMatchObject({ kind: 'accept', priority: 5, policy: { approvalRequired: true, retryLimit: 0 } })
})
