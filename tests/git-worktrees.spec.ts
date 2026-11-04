import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitWorktreeManager } from '../src/workspaces/git-worktrees.ts'

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
    },
    timeout: 15_000,
  }).trim()
}

function initializeRepository(path: string): void {
  mkdirSync(path)
  runGit(path, ['init', '-q'])
  runGit(path, ['config', '--local', 'user.name', 'Worktree Test'])
  runGit(path, ['config', '--local', 'user.email', 'worktree@example.invalid'])
  writeFileSync(join(path, 'README.md'), 'initial\n')
  runGit(path, ['add', 'README.md'])
  runGit(path, ['commit', '-q', '-m', 'initial'])
}

function configureFailingSmudge(repository: string, writeUserData: boolean): void {
  const script = join(repository, '.git', writeUserData ? 'dirty-smudge.sh' : 'failing-smudge.sh')
  const body = writeUserData
    ? 'worktree=$(git rev-parse --show-toplevel) || exit 25\ngitdir=$(git rev-parse --absolute-git-dir) || exit 25\nprintf "preserve me\\n" > "$worktree/user-data.txt"\nln -s "$worktree" "$gitdir/info" || exit 25\ncat\n'
    : 'exit 25\n'
  writeFileSync(script, `#!/bin/sh\n${body}`, { mode: 0o755 })
  runGit(repository, ['config', '--local', 'filter.worktree-test.clean', 'cat'])
  runGit(repository, ['config', '--local', 'filter.worktree-test.smudge', script])
  runGit(repository, ['config', '--local', 'filter.worktree-test.required', 'true'])
  writeFileSync(join(repository, '.gitattributes'), 'filtered.txt filter=worktree-test\n')
  writeFileSync(join(repository, 'filtered.txt'), 'checkout through required filter\n')
  runGit(repository, ['add', '.gitattributes', 'filtered.txt'])
  runGit(repository, ['commit', '-q', '-m', 'add required checkout filter'])
}

function configureExcludeCreatingSmudge(repository: string): void {
  const script = join(repository, '.git', 'exclude-creating-smudge.sh')
  writeFileSync(script, '#!/bin/sh\ngitdir=$(git rev-parse --absolute-git-dir) || exit 25\nmkdir "$gitdir/info" || exit 25\nprintf "/keep-this-entry\\n" > "$gitdir/info/exclude"\ncat\n', { mode: 0o755 })
  runGit(repository, ['config', '--local', 'filter.worktree-test.clean', 'cat'])
  runGit(repository, ['config', '--local', 'filter.worktree-test.smudge', script])
  runGit(repository, ['config', '--local', 'filter.worktree-test.required', 'true'])
  writeFileSync(join(repository, '.gitattributes'), 'filtered.txt filter=worktree-test\n')
  writeFileSync(join(repository, 'filtered.txt'), 'create an exclude during checkout\n')
  runGit(repository, ['add', '.gitattributes', 'filtered.txt'])
  runGit(repository, ['commit', '-q', '-m', 'add exclude-creating filter'])
}

describe('GitWorktreeManager', () => {
  let sandbox: string
  let repository: string
  let root: string

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'workforce-git-worktrees-'))
    repository = join(sandbox, 'repository')
    root = join(sandbox, 'worktrees')
    initializeRepository(repository)
  })

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('creates and inspects an execution-owned worktree without dirtying it with the marker', async () => {
    const manager = new GitWorktreeManager({ repository, root })
    const created = await manager.create('ticket-1', 'assignment-1', 'execution-1')

    expect(created.path).toBe(join(realpathSync(root), 'execution-1'))
    expect(created.branch).toBe('lao/execution-1')
    expect(created.baseRevision).toBe(runGit(repository, ['rev-parse', 'HEAD']))
    expect(await manager.inspect(join(root, 'execution-1'), 'ticket-1', 'assignment-1', 'execution-1')).toEqual(created)
    const worktreeGitDirectory = runGit(created.path, ['rev-parse', '--absolute-git-dir'])
    expect(readFileSync(join(worktreeGitDirectory, 'info', 'exclude'), 'utf8')).toContain('/.workforce-execution.json')

    const marker = JSON.parse(readFileSync(join(created.path, '.workforce-execution.json'), 'utf8')) as Record<string, unknown>
    expect(marker).toMatchObject({ ticketId: 'ticket-1', assignmentId: 'assignment-1', executionId: 'execution-1', branch: created.branch, baseRevision: created.baseRevision })
    expect(lstatSync(join(created.path, '.workforce-execution.json')).mode & 0o077).toBe(0)
  })

  it('creates independent worktrees for repeated tickets and assignments', async () => {
    const manager = new GitWorktreeManager({ repository, root })
    const first = await manager.create('same-ticket', 'same-assignment', 'execution-a')
    const second = await manager.create('same-ticket', 'same-assignment', 'execution-b')

    expect(first.path).not.toBe(second.path)
    expect(first.branch).toBe('lao/execution-a')
    expect(second.branch).toBe('lao/execution-b')
    await expect(manager.inspect(first.path, 'same-ticket', 'same-assignment', 'execution-a')).resolves.toEqual(first)
    await expect(manager.inspect(second.path, 'same-ticket', 'same-assignment', 'execution-b')).resolves.toEqual(second)
  })

  it('preserves unrelated entries in an existing private worktree exclude file', async () => {
    configureExcludeCreatingSmudge(repository)
    const manager = new GitWorktreeManager({ repository, root })

    const created = await manager.create('ticket', 'assignment', 'exclude-execution')
    const gitDirectory = runGit(created.path, ['rev-parse', '--absolute-git-dir'])
    expect(readFileSync(join(gitDirectory, 'info', 'exclude'), 'utf8')).toBe('/keep-this-entry\n/.workforce-execution.json\n')
  })

  it('protects dirty worktrees and removes them only with explicit approval', async () => {
    const manager = new GitWorktreeManager({ repository, root })
    const created = await manager.create('ticket', 'assignment', 'dirty-execution')
    writeFileSync(join(created.path, 'user-work.txt'), 'do not discard implicitly\n')

    await expect(manager.remove(created.path, 'ticket', 'assignment', 'dirty-execution')).rejects.toThrow(/dirty worktree/i)
    expect(readFileSync(join(created.path, 'user-work.txt'), 'utf8')).toContain('do not discard')

    await manager.remove(created.path, 'ticket', 'assignment', 'dirty-execution', { approvedDirtyRemoval: true })
    expect(existsSync(created.path)).toBe(false)
    expect(() => runGit(repository, ['show-ref', '--verify', 'refs/heads/lao/dirty-execution'])).toThrow()
  })

  it('removes a clean owned worktree and its branch despite the private untracked marker', async () => {
    const manager = new GitWorktreeManager({ repository, root })
    const created = await manager.create('ticket', 'assignment', 'clean-execution')

    await manager.remove(created.path, 'ticket', 'assignment', 'clean-execution')

    expect(existsSync(created.path)).toBe(false)
    expect(() => runGit(repository, ['show-ref', '--verify', 'refs/heads/lao/clean-execution'])).toThrow()
  })

  it('rejects traversal identities, overlapping roots, and execution path collisions', async () => {
    expect(() => new GitWorktreeManager({ repository, root: join(repository, 'worktrees') })).toThrow(/overlap/i)
    const manager = new GitWorktreeManager({ repository, root })
    await expect(manager.create('ticket', 'assignment', '../escape')).rejects.toThrow(/execution ID/i)
    await expect(manager.create('ticket/escape', 'assignment', 'execution')).rejects.toThrow(/ticket ID/i)

    mkdirSync(root)
    mkdirSync(join(root, 'collision'))
    await expect(manager.create('ticket', 'assignment', 'collision')).rejects.toThrow(/already exists/i)
    expect(existsSync(join(root, 'collision'))).toBe(true)
  })

  it('rejects symbolic-link roots, paths, and ownership markers', async () => {
    const actualRoot = join(sandbox, 'actual-root')
    const linkedRoot = join(sandbox, 'linked-root')
    mkdirSync(actualRoot)
    symlinkSync(actualRoot, linkedRoot, 'dir')
    expect(() => new GitWorktreeManager({ repository, root: linkedRoot })).toThrow(/symbolic link/i)

    const manager = new GitWorktreeManager({ repository, root })
    mkdirSync(root)
    symlinkSync(actualRoot, join(root, 'linked-execution'), 'dir')
    await expect(manager.create('ticket', 'assignment', 'linked-execution')).rejects.toThrow(/symbolic-link/i)

    const created = await manager.create('ticket', 'assignment', 'marker-execution')
    const markerPath = join(created.path, '.workforce-execution.json')
    const markerCopy = join(sandbox, 'marker-copy.json')
    writeFileSync(markerCopy, readFileSync(markerPath))
    chmodSync(markerCopy, 0o600)
    unlinkSync(markerPath)
    symlinkSync(markerCopy, markerPath)
    await expect(manager.inspect(created.path, 'ticket', 'assignment', 'marker-execution')).rejects.toThrow(/marker/i)
  })

  it('does not accept a worktree or marker owned by another repository or execution', async () => {
    const manager = new GitWorktreeManager({ repository, root })
    const first = await manager.create('ticket', 'assignment', 'first-execution')
    const second = await manager.create('ticket', 'assignment', 'second-execution')
    writeFileSync(join(second.path, '.workforce-execution.json'), readFileSync(join(first.path, '.workforce-execution.json')))
    chmodSync(join(second.path, '.workforce-execution.json'), 0o600)
    await expect(manager.inspect(second.path, 'ticket', 'assignment', 'second-execution')).rejects.toThrow(/does not match/i)

    const foreignRepository = join(sandbox, 'foreign-repository')
    initializeRepository(foreignRepository)
    const foreignManager = new GitWorktreeManager({ repository: foreignRepository, root })
    await expect(foreignManager.inspect(first.path, 'ticket', 'assignment', 'first-execution')).rejects.toThrow(/marker|registered|repository/i)
  })

  it('preserves preexisting branches on collision', async () => {
    runGit(repository, ['branch', 'lao/preexisting', 'HEAD'])
    const original = runGit(repository, ['rev-parse', 'refs/heads/lao/preexisting'])
    const manager = new GitWorktreeManager({ repository, root })

    await expect(manager.create('ticket', 'assignment', 'preexisting')).rejects.toThrow(/already exists/i)
    expect(runGit(repository, ['rev-parse', 'refs/heads/lao/preexisting'])).toBe(original)
    expect(existsSync(join(root, 'preexisting'))).toBe(false)
  })

  it('cleans its branch and registered checkout after a clean checkout failure', async () => {
    configureFailingSmudge(repository, false)
    const manager = new GitWorktreeManager({ repository, root })

    await expect(manager.create('ticket', 'assignment', 'failed-checkout')).rejects.toThrow(/Git command failed/i)
    expect(existsSync(join(root, 'failed-checkout'))).toBe(false)
    expect(() => runGit(repository, ['show-ref', '--verify', 'refs/heads/lao/failed-checkout'])).toThrow()
    expect(runGit(repository, ['worktree', 'list', '--porcelain'])).not.toContain(join(root, 'failed-checkout'))
  })

  it('preserves dirty checkout residue and its branch when failed creation produced user data', async () => {
    configureFailingSmudge(repository, true)
    const manager = new GitWorktreeManager({ repository, root })

    await expect(manager.create('ticket', 'assignment', 'dirty-failure')).rejects.toThrow(/cleanup failed.*dirty checkout residue/i)
    expect(readFileSync(join(root, 'dirty-failure', 'user-data.txt'), 'utf8')).toContain('preserve me')
    expect(runGit(repository, ['show-ref', '--verify', 'refs/heads/lao/dirty-failure'])).not.toBe('')
  })
})
