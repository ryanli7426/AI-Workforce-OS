import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalTaskService } from '../src/application/tasks.ts'
import type { Rule } from '../src/assessor/rules.ts'
import type { VerificationProvenance } from '../src/core/lifecycle-model.ts'
import type { Ticket } from '../src/core/model.ts'
import { ProjectRepository } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LocalStore } from '../src/storage/store.ts'

const opened: LocalStore[] = []
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'verification-provenance-'))
})

afterEach(() => {
  for (const store of opened.splice(0)) {
    try { store.close() } catch { /* ignore */ }
  }
  rmSync(root, { recursive: true, force: true })
})

function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    HOME: root,
  }
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, env: gitEnv(), stdio: 'ignore', timeout: 15_000 })
}

function openStore(): LocalStore {
  const store = new LocalStore(join(root, 'workforce.sqlite'))
  opened.push(store)
  initializeApplicationSchema(store)
  return store
}

function rules(): Rule[] {
  return [{
    id: 'docs',
    enabled: true,
    taskTypes: ['docs'],
    priority: 10,
    approvalRequired: false,
    reviewRequired: true,
    retryLimit: 1,
  }]
}

interface ReviewFixture {
  tasks: LocalTaskService
  ticket: Ticket
  executionId: string
  artifactRevision: string
}

function createReviewFixture(store: LocalStore): ReviewFixture {
  const repositoryPath = join(root, 'repo')
  mkdirSync(repositoryPath, { recursive: true, mode: 0o700 })
  git(repositoryPath, ['init'])
  git(repositoryPath, ['config', 'user.email', 'provenance@example.com'])
  git(repositoryPath, ['config', 'user.name', 'Provenance Fixture'])
  writeFileSync(join(repositoryPath, 'README.md'), '# provenance\n', { mode: 0o600 })
  git(repositoryPath, ['add', 'README.md'])
  git(repositoryPath, ['commit', '-m', 'fixture'])
  new ProjectRepository(store.db).create({
    id: 'project-1',
    workspaceId: 'local',
    name: 'Provenance project',
    ownerId: 'business-owner',
    repositoryPath: resolve(repositoryPath),
    worktreeRoot: join(root, 'worktrees'),
    allowedTaskTypes: ['docs'],
  })
  const tasks = new LocalTaskService({ store, ownerId: 'owner-1', workspaceId: 'local', rules: rules() })
  const created = tasks.create({
    issueId: 'issue-1',
    projectId: 'project-1',
    title: 'Persist verifier provenance',
    description: 'Bind verification evidence to its durable report',
    taskType: 'docs',
  })
  const assigned = tasks.engine.assignTask(created.id, 'codex-local', 'codex', join(root, 'worktree'))
  const assignmentId = assigned.assignments.at(-1)!.id
  tasks.engine.assignmentStarted(created.id, assignmentId)
  const executionId = `execution-${assignmentId}`
  const artifactRevision = 'c'.repeat(64)
  const ticket = tasks.engine.recordExecution(created.id, {
    assignmentId,
    executionId,
    artifactRevision,
    exitCode: 0,
    terminal: 'success',
    summary: 'Execution complete',
  })
  expect(ticket.lifecycle?.status).toBe('REVIEW')
  return { tasks, ticket, executionId, artifactRevision }
}

function provenance(overrides: Partial<VerificationProvenance> = {}): VerificationProvenance {
  return {
    verificationId: 'verification-1',
    reportSha256: 'd'.repeat(64),
    planId: 'local-checks',
    planRevision: 'revision-1',
    ...overrides,
  }
}

describe('Core verification provenance', () => {
  it('validates, audits, persists, and deep-clones exact verifier provenance', () => {
    const store = openStore()
    const fixture = createReviewFixture(store)
    const proof = provenance()
    const beforeVersion = fixture.ticket.lifecycle!.version

    const verified = fixture.tasks.verify(fixture.ticket.id, {
      executionId: fixture.executionId,
      artifactRevision: fixture.artifactRevision,
      state: 'passed',
      reason: 'Signed verifier report completed with passing checks',
      provenance: proof,
    })
    expect(verified.lifecycle).toMatchObject({
      status: 'REVIEW',
      version: beforeVersion + 1,
      result: { verification: 'passed' },
    })
    const evidence = store.workflow.history(fixture.ticket.id).at(-1)!
    expect(evidence).toMatchObject({
      kind: 'evidence',
      actor: 'owner-1',
      executionId: fixture.executionId,
      artifactRevision: fixture.artifactRevision,
      verification: 'passed',
      verificationProvenance: provenance(),
    })

    proof.planId = 'caller-mutated'
    expect(store.workflow.history(fixture.ticket.id).at(-1)?.verificationProvenance?.planId).toBe('local-checks')
    evidence.verificationProvenance!.planRevision = 'returned-value-mutated'
    expect(store.workflow.history(fixture.ticket.id).at(-1)?.verificationProvenance?.planRevision).toBe('revision-1')
  })

  it.each([
    ['unsafe verification identity', provenance({ verificationId: 'bad/id' }), 'passed'],
    ['unsafe plan identity', provenance({ planId: '.hidden' }), 'passed'],
    ['blank plan revision', provenance({ planRevision: '' }), 'passed'],
    ['non-lowercase report digest', provenance({ reportSha256: 'D'.repeat(64) }), 'passed'],
    ['short report digest', provenance({ reportSha256: 'd'.repeat(63) }), 'failed'],
    ['provenance on a waiver', provenance(), 'not_required'],
    ['unknown provenance field', { ...provenance(), secret: 'not-allowed' }, 'passed'],
  ] as const)('rejects %s and rolls back task evidence and audit', (_label, proof, state) => {
    const store = openStore()
    const fixture = createReviewFixture(store)
    const before = store.workflow.history(fixture.ticket.id)
    const beforeVersion = fixture.ticket.lifecycle!.version

    expect(() => fixture.tasks.verify(fixture.ticket.id, {
      executionId: fixture.executionId,
      artifactRevision: fixture.artifactRevision,
      state,
      reason: 'This evidence must be rejected atomically',
      provenance: proof as VerificationProvenance,
    })).toThrow(/Invalid verification provenance/)
    expect(fixture.tasks.get(fixture.ticket.id)?.lifecycle).toMatchObject({
      status: 'REVIEW',
      version: beforeVersion,
      result: { verification: 'unknown' },
    })
    expect(store.workflow.history(fixture.ticket.id)).toEqual(before)
  })

  it('accepts provenance for a failed verification while preserving the report identity in audit', () => {
    const store = openStore()
    const fixture = createReviewFixture(store)
    const proof = provenance({ verificationId: 'verification-failed', reportSha256: 'e'.repeat(64) })

    fixture.tasks.verify(fixture.ticket.id, {
      executionId: fixture.executionId,
      artifactRevision: fixture.artifactRevision,
      state: 'failed',
      reason: 'Checks completed and reported a failure',
      provenance: proof,
    })
    expect(fixture.tasks.get(fixture.ticket.id)?.lifecycle?.result?.verification).toBe('failed')
    expect(store.workflow.history(fixture.ticket.id).at(-1)?.verificationProvenance).toEqual(proof)
  })
})
