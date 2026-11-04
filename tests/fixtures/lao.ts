/** Runtime-free Engine fixture shared by memory and real SQLite integration tests. */
import { createLocalEngine } from '../../src/core/local.ts'
import { MemoryRepositories, type AssessmentOutcome, type EngineOptions, type Repositories, type Trigger } from '../../src/core/index.ts'

export function lao(repo: Repositories = new MemoryRepositories(), overrides: Partial<EngineOptions> = {}) {
  let version = 'policy-1'
  const starts: string[] = [], stops: string[] = []
  const engine = createLocalEngine({ repo,
    policy: () => ({ version, paused: false, evalTimeoutMs: 1000,
      gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }),
    scope: { scope: () => ({ listened: true, observed: false }) },
    assessor: { request: () => {} }, executor: { start: (_t, a) => { starts.push(a.id) }, deliver: () => {}, stop: (_t, a) => { stops.push(a.id) } },
    outbox: { send: () => {}, withdraw: () => {}, status: () => undefined }, ...overrides,
  })
  const trigger = (id = 'event-1'): Trigger => ({ id, source: 'ding:team-a', threads: [{ source: 'ding:team-a', id: 'issue-1' }],
    actor: { source: 'ding:team-a', id: 'alice' }, human: true, text: 'Fix typo', meta: {}, at: '2026-11-03T00:00:00.000Z' })
  const outcome = (): Extract<AssessmentOutcome, { kind: 'accept' }> => ({ kind: 'accept', title: 'Fix typo', scope: 'README typo', reason: 'Explicit request',
    task: { issue: { source: 'ding:team-a', issueId: 'issue-1', revision: 'v1', updatedAt: '2026-11-03T00:00:00.000Z', description: 'Fix typo', priority: 10, closed: false },
      taskType: 'documentation', policy: { approvalRequired: false, reviewRequired: true, retryLimit: 2 } } })
  function accept(change?: (value: ReturnType<typeof outcome>) => void, event = trigger()) {
    const value = outcome(); change?.(value)
    engine.receive(event)
    const decision = engine.decide(event.id, value)
    return repo.tickets.get(decision.ticketId!)!
  }
  const running = (id: string) => {
    const ticket = engine.assignTask(id, 'claude-local', 'claude-code', `/worktrees/${id}`)
    const assignmentId = ticket.assignments.at(-1)!.id
    ticket.execution = { name: 'fixture', directory: `/worktrees/${id}`, assignment: '' }
    repo.tickets.save(ticket)
    engine.assignmentStarted(id, assignmentId)
    return assignmentId
  }
  const result = (assignmentId: string) => ({ assignmentId, executionId: `execution-${assignmentId}`, artifactRevision: 'sha:123', exitCode: 0, terminal: 'success' as const, summary: 'Modified README' })
  const review = (assignmentId: string) => ({ actor: 'alice', reason: 'Reviewed diff', approved: true,
    executionId: result(assignmentId).executionId, artifactRevision: 'sha:123' })
  const verify = (id: string, assignmentId: string) => engine.recordVerification(id, { ...review(assignmentId), state: 'not_required', reason: 'Documentation-only change; CI explicitly not required' })
  return { engine, repo, starts, stops, trigger, outcome, accept, running, result, review, verify, setPolicy: (value: string) => { version = value } }
}
