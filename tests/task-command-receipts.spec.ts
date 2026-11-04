import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  COMMAND_SCHEMA_KEY,
  COMMAND_SCHEMA_VERSION,
  initializeCommandSchema,
  LocalTaskCommands,
  TaskCommandError,
} from '../src/application/task-commands.ts'
import { LocalTaskService } from '../src/application/tasks.ts'
import type { Rule } from '../src/assessor/rules.ts'
import { IntentRepository } from '../src/orchestration/intents.ts'
import { ProjectRepository, type ProjectCreateInput } from '../src/projects/projects.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LAO_SCHEMA_VERSION, LocalStore } from '../src/storage/store.ts'

const opened: LocalStore[] = []
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-cmd-'))
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

function initGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  git(dir, ['init'])
  git(dir, ['config', 'user.email', 'task-cmd@example.com'])
  git(dir, ['config', 'user.name', 'Task Cmd'])
  writeFileSync(join(dir, 'README'), 'fixture\n', { mode: 0o600 })
  git(dir, ['add', 'README'])
  git(dir, ['commit', '-m', 'init'])
  return resolve(dir)
}

function openStore(path = join(root, 'workforce.sqlite')): LocalStore {
  const store = new LocalStore(path)
  opened.push(store)
  initializeApplicationSchema(store)
  initializeCommandSchema(store.db)
  return store
}

function rules(overrides: Partial<Rule> = {}): Rule[] {
  return [{
    id: 'docs',
    enabled: true,
    taskTypes: ['docs'],
    priority: 10,
    approvalRequired: true,
    reviewRequired: true,
    retryLimit: 1,
    ...overrides,
  }]
}

function projectInput(overrides: Partial<ProjectCreateInput> = {}): ProjectCreateInput {
  const repositoryPath = initGitRepo(join(root, `repo-${Math.random().toString(16).slice(2)}`))
  const worktreeRoot = join(root, `worktrees-${Math.random().toString(16).slice(2)}`)
  return {
    id: 'proj-1',
    workspaceId: 'local',
    name: 'Docs',
    ownerId: 'owner-1',
    repositoryPath,
    worktreeRoot,
    allowedTaskTypes: ['docs'],
    ...overrides,
  }
}

function seedProject(store: LocalStore, overrides: Partial<ProjectCreateInput> = {}) {
  return new ProjectRepository(store.db).create(projectInput(overrides))
}

function commands(
  store: LocalStore,
  ownerId = 'owner-1',
  ruleList: Rule[] = rules(),
  workspaceId = 'local',
): LocalTaskCommands {
  return new LocalTaskCommands({ store, ownerId, rules: ruleList, workspaceId })
}

function receiptCount(store: LocalStore): number {
  return (store.db.prepare('SELECT count(*) AS n FROM task_command_receipt').get() as { n: number }).n
}

function auditCount(store: LocalStore, ticketId: string): number {
  return store.workflow.history(ticketId).length
}

describe('initializeCommandSchema', () => {
  it('requires current main schema and installs command-schema 1 explicitly', () => {
    const store = new LocalStore(join(root, 'cmd.sqlite'))
    opened.push(store)
    expect(store.get('schema')).toBe(LAO_SCHEMA_VERSION)
    expect(() => new LocalTaskCommands({ store, ownerId: 'owner-1', rules: rules() }))
      .toThrow(/not initialized/)
    initializeApplicationSchema(store)
    expect(() => new LocalTaskCommands({ store, ownerId: 'owner-1', rules: rules() }))
      .not.toThrow()
    initializeCommandSchema(store.db)
    expect(store.get<number>(COMMAND_SCHEMA_KEY)).toBe(COMMAND_SCHEMA_VERSION)
    expect(() => new LocalTaskCommands({ store, ownerId: 'owner-1', rules: rules() })).not.toThrow()
  })

  it('refuses unsupported command schema without mutating tables', () => {
    const store = openStore()
    store.set(COMMAND_SCHEMA_KEY, 99)
    const before = store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'task_command_receipt'").get()
    expect(() => initializeCommandSchema(store.db)).toThrow(/Unsupported command schema/)
    expect(store.get<number>(COMMAND_SCHEMA_KEY)).toBe(99)
    expect(store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'task_command_receipt'").get()).toEqual(before)
  })

  it('refuses when main schema is not current', () => {
    const store = new LocalStore(join(root, 'bad-main.sqlite'))
    opened.push(store)
    store.set('schema', LAO_SCHEMA_VERSION - 1)
    expect(() => initializeCommandSchema(store.db)).toThrow(/main schema/)
    expect(store.get(COMMAND_SCHEMA_KEY)).toBeUndefined()
    expect(store.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='task_command_receipt'").get())
      .toBeUndefined()
  })

  it('fails construction on missing or corrupt receipt table without initializing', () => {
    const missing = openStore(join(root, 'missing-receipt.sqlite'))
    missing.db.exec('DROP TABLE task_command_receipt')
    expect(missing.get<number>(COMMAND_SCHEMA_KEY)).toBe(COMMAND_SCHEMA_VERSION)
    expect(() => new LocalTaskCommands({ store: missing, ownerId: 'owner-1', rules: rules() }))
      .toThrow(/corrupt|not initialized/i)
    expect(missing.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='task_command_receipt'").get())
      .toBeUndefined()
    expect(missing.get<number>(COMMAND_SCHEMA_KEY)).toBe(COMMAND_SCHEMA_VERSION)

    const corrupt = openStore(join(root, 'corrupt-receipt.sqlite'))
    corrupt.db.exec('DROP TABLE task_command_receipt')
    corrupt.db.exec(`
      CREATE TABLE task_command_receipt (
        workspace_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        PRIMARY KEY (workspace_id, owner_id)
      )
    `)
    expect(() => new LocalTaskCommands({ store: corrupt, ownerId: 'owner-1', rules: rules() }))
      .toThrow(/corrupt/i)
    const columns = corrupt.db.prepare("SELECT name FROM pragma_table_info('task_command_receipt')")
      .all()
      .map(row => String((row as { name: unknown }).name))
      .sort()
    expect(columns).toEqual(['owner_id', 'workspace_id'])
    expect(corrupt.get<number>(COMMAND_SCHEMA_KEY)).toBe(COMMAND_SCHEMA_VERSION)
  })
})

describe('create and approve receipt replay', () => {
  it('creates, approves, and replays identical keys without a second mutation', () => {
    const store = openStore()
    seedProject(store, { ownerId: 'project-biz-owner' })
    const api = commands(store)
    const createInput = {
      issueId: 'issue-1',
      projectId: 'proj-1',
      title: 'Fix docs',
      description: 'Tighten wording',
      taskType: 'docs',
    }

    const created = api.execute('create-1', { kind: 'create', input: createInput })
    expect(created.replayed).toBe(false)
    expect(created.ticket.lifecycle?.status).toBe('WAITING_APPROVAL')
    expect(created.ticket.lifecycle?.version).toBe(1)
    expect(receiptCount(store)).toBe(1)

    const auditsAfterCreate = auditCount(store, created.ticket.id)
    const createAgain = api.execute('create-1', { kind: 'create', input: { ...createInput } })
    expect(createAgain.replayed).toBe(true)
    expect(createAgain.ticket.id).toBe(created.ticket.id)
    expect(createAgain.ticket.lifecycle?.version).toBe(1)
    expect(store.tickets.list()).toHaveLength(1)
    expect(auditCount(store, created.ticket.id)).toBe(auditsAfterCreate)

    const approved = api.execute('approve-1', {
      kind: 'approve',
      ticketId: created.ticket.id,
      expectedVersion: 1,
      reason: 'Owner approved scoped docs edits',
    })
    expect(approved.replayed).toBe(false)
    expect(approved.ticket.lifecycle?.status).toBe('QUEUED')
    expect(approved.ticket.lifecycle?.version).toBe(2)
    const auditsAfterApprove = auditCount(store, created.ticket.id)

    const live = store.tickets.get(created.ticket.id)!
    live.title = 'mutated-after-approve'
    store.tickets.save(live)

    const approveAgain = api.execute('approve-1', {
      kind: 'approve',
      ticketId: created.ticket.id,
      expectedVersion: 1,
      reason: 'Owner approved scoped docs edits',
    })
    expect(approveAgain.replayed).toBe(true)
    expect(approveAgain.ticket.title).toBe('Fix docs')
    expect(approveAgain.ticket.lifecycle?.status).toBe('QUEUED')
    expect(approveAgain.ticket.lifecycle?.version).toBe(2)
    expect(auditCount(store, created.ticket.id)).toBe(auditsAfterApprove)
    expect(store.tickets.get(created.ticket.id)?.title).toBe('mutated-after-approve')
  })

  it('conflicts when the same key carries a different payload', () => {
    const store = openStore()
    seedProject(store)
    const api = commands(store)
    api.execute('k1', {
      kind: 'create',
      input: {
        issueId: 'issue-1', projectId: 'proj-1', title: 'A', description: 'd', taskType: 'docs',
      },
    })
    let caught: unknown
    try {
      api.execute('k1', {
        kind: 'create',
        input: {
          issueId: 'issue-2', projectId: 'proj-1', title: 'B', description: 'd', taskType: 'docs',
        },
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(TaskCommandError)
    expect((caught as TaskCommandError).code).toBe('IDEMPOTENCY_CONFLICT')
    expect(String((caught as Error).message)).not.toMatch(/token|password|secret|Bearer/i)
    expect(store.tickets.list()).toHaveLength(1)
    expect(receiptCount(store)).toBe(1)
  })
})

describe('version, ownership, validation, and rollback', () => {
  it('rejects stale versions without writing a receipt', () => {
    const store = openStore()
    seedProject(store)
    const api = commands(store)
    const created = api.execute('c1', {
      kind: 'create',
      input: {
        issueId: 'issue-1', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs',
      },
    })
    api.execute('a1', {
      kind: 'approve',
      ticketId: created.ticket.id,
      expectedVersion: 1,
      reason: 'ok',
    })
    const beforeReceipts = receiptCount(store)
    const beforeAudits = auditCount(store, created.ticket.id)
    try {
      api.execute('a-stale', {
        kind: 'approve',
        ticketId: created.ticket.id,
        expectedVersion: 1,
        reason: 'stale',
      })
      expect.fail('expected VERSION_CONFLICT')
    } catch (error) {
      expect(error).toBeInstanceOf(TaskCommandError)
      expect((error as TaskCommandError).code).toBe('VERSION_CONFLICT')
    }
    expect(receiptCount(store)).toBe(beforeReceipts)
    expect(auditCount(store, created.ticket.id)).toBe(beforeAudits)
    expect(store.tickets.get(created.ticket.id)?.lifecycle?.status).toBe('QUEUED')
  })

  it('masks foreign owner tickets as NOT_FOUND', () => {
    const store = openStore()
    seedProject(store)
    const owner = commands(store, 'owner-1')
    const foreign = commands(store, 'owner-2')
    const created = owner.execute('c1', {
      kind: 'create',
      input: {
        issueId: 'issue-1', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs',
      },
    })
    try {
      foreign.execute('x1', {
        kind: 'approve',
        ticketId: created.ticket.id,
        expectedVersion: 1,
        reason: 'nope',
      })
      expect.fail('expected NOT_FOUND')
    } catch (error) {
      expect(error).toBeInstanceOf(TaskCommandError)
      expect((error as TaskCommandError).code).toBe('NOT_FOUND')
      expect(String((error as Error).message)).not.toMatch(/owner-1|token|secret/i)
    }
    expect(receiptCount(store)).toBe(1)
    expect(store.tickets.get(created.ticket.id)?.lifecycle?.status).toBe('WAITING_APPROVAL')
  })

  it('rolls back receipt, task, audit, and intents when the outer transaction fails', () => {
    const store = openStore()
    seedProject(store)
    const api = commands(store, 'owner-1', rules({ approvalRequired: false }))
    expect(() => store.atomic(() => {
      api.execute('c-roll', {
        kind: 'create',
        input: {
          issueId: 'issue-roll', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs',
        },
      })
      throw new Error('force-rollback')
    })).toThrow('force-rollback')
    expect(store.tickets.list()).toEqual([])
    expect(receiptCount(store)).toBe(0)
    expect(new IntentRepository(store.db).list()).toEqual([])

    const created = api.execute('c-ok', {
      kind: 'create',
      input: {
        issueId: 'issue-ok', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs',
      },
    })
    const tasks = new LocalTaskService({
      store,
      ownerId: 'owner-1',
      rules: rules({ approvalRequired: false }),
      workspaceId: 'local',
    })
    const assigned = tasks.engine.assignTask(
      created.ticket.id,
      'claude-local',
      'claude-code',
      join(root, 'work', created.ticket.id),
    )
    const assignmentId = assigned.assignments.at(-1)!.id
    tasks.engine.assignmentStarted(created.ticket.id, assignmentId)
    const version = store.tickets.get(created.ticket.id)!.lifecycle!.version
    const receiptsBefore = receiptCount(store)
    const auditsBefore = auditCount(store, created.ticket.id)

    expect(() => store.atomic(() => {
      api.execute('cancel-roll', {
        kind: 'cancel',
        ticketId: created.ticket.id,
        expectedVersion: version,
        reason: 'abort later',
      })
      throw new Error('force-cancel-rollback')
    })).toThrow('force-cancel-rollback')

    expect(receiptCount(store)).toBe(receiptsBefore)
    expect(auditCount(store, created.ticket.id)).toBe(auditsBefore)
    expect(new IntentRepository(store.db).list().filter(item => item.kind === 'stop')).toEqual([])
    expect(store.tickets.get(created.ticket.id)?.lifecycle?.cancelRequested).toBeUndefined()
  })

  it('maps illegal state transitions to STATE_CONFLICT without a receipt', () => {
    const store = openStore()
    seedProject(store)
    const api = commands(store)
    const created = api.execute('c1', {
      kind: 'create',
      input: {
        issueId: 'issue-1', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs',
      },
    })
    const before = receiptCount(store)
    try {
      api.execute('retry-1', {
        kind: 'retry',
        ticketId: created.ticket.id,
        expectedVersion: 1,
        reason: 'not failed',
      })
      expect.fail('expected STATE_CONFLICT')
    } catch (error) {
      expect(error).toBeInstanceOf(TaskCommandError)
      expect((error as TaskCommandError).code).toBe('STATE_CONFLICT')
    }
    expect(receiptCount(store)).toBe(before)
  })

  it('rejects scalar and foreign stored receipts without writes', () => {
    const store = openStore()
    seedProject(store)
    const api = commands(store)
    const createInput = {
      issueId: 'issue-1', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs',
    }
    const created = api.execute('good', { kind: 'create', input: createInput })
    const hash = store.db.prepare(
      `SELECT command_hash AS h FROM task_command_receipt
       WHERE workspace_id = 'local' AND owner_id = 'owner-1' AND command_key = 'good'`,
    ).get() as { h: string }

    store.db.prepare(
      `INSERT INTO task_command_receipt
        (workspace_id, owner_id, command_key, command_hash, result_json, created_at)
       VALUES ('local', 'owner-1', 'scalar', ?, '42', ?)`,
    ).run(hash.h, new Date().toISOString())

    const ticketsBefore = store.tickets.list().length
    const auditsBefore = auditCount(store, created.ticket.id)
    const receiptsBefore = receiptCount(store)
    let scalarCaught: unknown
    try {
      api.execute('scalar', { kind: 'create', input: createInput })
      expect.fail('expected corrupt scalar receipt rejection')
    } catch (error) {
      scalarCaught = error
    }
    expect(scalarCaught).toBeInstanceOf(Error)
    expect(scalarCaught).not.toBeInstanceOf(TaskCommandError)
    expect(String((scalarCaught as Error).message)).not.toMatch(/42|token|secret|Bearer/i)
    expect(store.tickets.list()).toHaveLength(ticketsBefore)
    expect(auditCount(store, created.ticket.id)).toBe(auditsBefore)
    expect(receiptCount(store)).toBe(receiptsBefore)

    const foreign = structuredClone(created.ticket)
    foreign.mandate.actor.id = 'other-owner'
    store.db.prepare(
      `INSERT INTO task_command_receipt
        (workspace_id, owner_id, command_key, command_hash, result_json, created_at)
       VALUES ('local', 'owner-1', 'foreign', ?, ?, ?)`,
    ).run(hash.h, JSON.stringify(foreign), new Date().toISOString())
    let foreignCaught: unknown
    try {
      api.execute('foreign', { kind: 'create', input: createInput })
      expect.fail('expected foreign receipt rejection')
    } catch (error) {
      foreignCaught = error
    }
    expect(foreignCaught).toBeInstanceOf(Error)
    expect(foreignCaught).not.toBeInstanceOf(TaskCommandError)
    expect(String((foreignCaught as Error).message)).not.toMatch(/other-owner|token|secret/i)
    expect(store.tickets.list()).toHaveLength(ticketsBefore)
    expect(auditCount(store, created.ticket.id)).toBe(auditsBefore)
    expect(receiptCount(store)).toBe(receiptsBefore + 1)
  })

  it('rolls back task/audit/intents when receipt INSERT aborts and classifies as operational', () => {
    const store = openStore()
    seedProject(store)
    const api = commands(store, 'owner-1', rules({ approvalRequired: false }))
    store.db.exec(`
      CREATE TRIGGER abort_receipt_insert
      BEFORE INSERT ON task_command_receipt
      BEGIN
        SELECT RAISE(ABORT, 'forced receipt insert failure with secret-token');
      END;
    `)

    let caught: unknown
    try {
      api.execute('c-abort', {
        kind: 'create',
        input: {
          issueId: 'issue-abort', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs',
        },
      })
      expect.fail('expected receipt insert abort')
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(TaskCommandError)
    expect(String((caught as Error).message)).not.toMatch(/forced receipt|secret-token|sqlite|SQL/i)
    expect(store.tickets.list()).toEqual([])
    expect(receiptCount(store)).toBe(0)
    expect(new IntentRepository(store.db).list()).toEqual([])

    const created = (() => {
      store.db.exec('DROP TRIGGER abort_receipt_insert')
      return api.execute('c-ok-abort', {
        kind: 'create',
        input: {
          issueId: 'issue-ok-abort', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs',
        },
      })
    })()
    const tasks = new LocalTaskService({
      store,
      ownerId: 'owner-1',
      rules: rules({ approvalRequired: false }),
      workspaceId: 'local',
    })
    const assigned = tasks.engine.assignTask(
      created.ticket.id,
      'claude-local',
      'claude-code',
      join(root, 'work-abort', created.ticket.id),
    )
    const assignmentId = assigned.assignments.at(-1)!.id
    tasks.engine.assignmentStarted(created.ticket.id, assignmentId)
    const version = store.tickets.get(created.ticket.id)!.lifecycle!.version
    const receiptsBefore = receiptCount(store)
    const auditsBefore = auditCount(store, created.ticket.id)
    store.db.exec(`
      CREATE TRIGGER abort_receipt_insert
      BEFORE INSERT ON task_command_receipt
      BEGIN
        SELECT RAISE(ABORT, 'forced cancel receipt failure');
      END;
    `)

    let cancelCaught: unknown
    try {
      api.execute('cancel-abort', {
        kind: 'cancel',
        ticketId: created.ticket.id,
        expectedVersion: version,
        reason: 'abort insert',
      })
      expect.fail('expected cancel receipt insert abort')
    } catch (error) {
      cancelCaught = error
    }
    expect(cancelCaught).toBeInstanceOf(Error)
    expect(cancelCaught).not.toBeInstanceOf(TaskCommandError)
    expect(String((cancelCaught as Error).message)).not.toMatch(/forced cancel|secret|token/i)
    expect(receiptCount(store)).toBe(receiptsBefore)
    expect(auditCount(store, created.ticket.id)).toBe(auditsBefore)
    expect(new IntentRepository(store.db).list().filter(item => item.kind === 'stop')).toEqual([])
    expect(store.tickets.get(created.ticket.id)?.lifecycle?.cancelRequested).toBeUndefined()
  })

  it('rejects malformed commands and credential-shaped unknown fields without echoing secrets', () => {
    const store = openStore()
    seedProject(store)
    const api = commands(store)
    try {
      api.execute('bad', {
        kind: 'create',
        input: {
          issueId: 'issue-1',
          projectId: 'proj-1',
          title: 't',
          description: 'd',
          taskType: 'docs',
          api_token: 'sk-secret-value',
        } as never,
      })
      expect.fail('expected INVALID_COMMAND')
    } catch (error) {
      expect(error).toBeInstanceOf(TaskCommandError)
      expect((error as TaskCommandError).code).toBe('INVALID_COMMAND')
      expect(String((error as Error).message)).not.toMatch(/api_token|sk-secret/i)
    }
    expect(() => api.execute('', { kind: 'create', input: {
      issueId: 'issue-1', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs',
    } })).toThrow(TaskCommandError)
    expect(receiptCount(store)).toBe(0)
    expect(store.tickets.list()).toEqual([])
  })

  it('keeps returned tickets and constructor rules immutable', () => {
    const store = openStore()
    seedProject(store)
    const mutable = rules()
    const api = commands(store, 'owner-1', mutable)
    mutable[0]!.approvalRequired = false
    mutable[0]!.priority = 1
    const created = api.execute('c1', {
      kind: 'create',
      input: {
        issueId: 'issue-1', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs', priority: 99,
      },
    })
    expect(created.ticket.lifecycle?.status).toBe('WAITING_APPROVAL')
    expect(created.ticket.lifecycle?.issue.priority).toBe(10)
    created.ticket.title = 'caller-mutated'
    const replayed = api.execute('c1', {
      kind: 'create',
      input: {
        issueId: 'issue-1', projectId: 'proj-1', title: 't', description: 'd', taskType: 'docs', priority: 99,
      },
    })
    expect(replayed.ticket.title).toBe('t')
    expect(replayed.replayed).toBe(true)
  })
})
