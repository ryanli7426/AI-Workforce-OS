import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ArtifactStore } from '../src/artifacts/snapshots.ts'

let root: string
let repository: string
let artifacts: string
let baseRevision: string

function git(...args: string[]): string {
  return execFileSync('git', ['-C', repository, ...args], { encoding: 'utf8' }).trim()
}

function capture(store: ArtifactStore, artifactId = 'artifact-1', executionId = 'execution-1', base = baseRevision) {
  return store.capture({ artifactId, executionId, cwd: repository, baseRevision: base })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'workforce-artifacts-'))
  repository = join(root, 'repository')
  artifacts = join(root, 'artifacts')
  mkdirSync(repository)
  git('init', '--quiet')
  git('config', 'user.name', 'Artifact Test')
  git('config', 'user.email', 'artifact@example.test')
  writeFileSync(join(repository, 'tracked.txt'), 'tracked before\n')
  writeFileSync(join(repository, 'binary.dat'), Buffer.from([0, 255, 1, 128, 10]))
  writeFileSync(join(repository, 'deleted.txt'), 'delete me\n')
  git('add', '--', 'tracked.txt', 'binary.dat', 'deleted.txt')
  git('commit', '--quiet', '-m', 'fixture')
  baseRevision = git('rev-parse', 'HEAD')
})

afterEach(() => { rmSync(root, { recursive: true, force: true }) })

describe('ArtifactStore capture', () => {
  it('captures tracked, untracked, binary and deleted working-tree state without changing the source', async () => {
    const store = new ArtifactStore({ root: artifacts })
    writeFileSync(join(repository, 'tracked.txt'), 'tracked after\n')
    chmodSync(join(repository, 'tracked.txt'), 0o755)
    mkdirSync(join(repository, 'nested'))
    writeFileSync(join(repository, 'nested', 'untracked.txt'), 'new file\n')
    writeFileSync(join(repository, '.gitignore'), '*.ignored\n')
    writeFileSync(join(repository, 'secret.ignored'), 'ignored\n')
    writeFileSync(join(repository, '.workforce-execution.json'), '{"private":true}\n')
    rmSync(join(repository, 'deleted.txt'))
    const statusBefore = git('status', '--porcelain=v1', '-z')
    const trackedBefore = readFileSync(join(repository, 'tracked.txt'))
    const binaryBefore = readFileSync(join(repository, 'binary.dat'))

    const manifest = await capture(store)

    expect(manifest).toMatchObject({
      version: 1,
      artifactId: 'artifact-1',
      executionId: 'execution-1',
      baseRevision,
      headRevision: baseRevision,
      deletedPaths: ['deleted.txt'],
    })
    expect(manifest.revision).toMatch(/^[a-f0-9]{64}$/)
    expect(manifest.files.map(file => file.path)).toEqual(['.gitignore', 'binary.dat', 'nested/untracked.txt', 'tracked.txt'])
    expect(manifest.files.find(file => file.path === 'tracked.txt')?.mode).toBe(0o755)
    expect(readFileSync(join(artifacts, 'artifact-1', 'files', 'tracked.txt'), 'utf8')).toBe('tracked after\n')
    expect(readFileSync(join(artifacts, 'artifact-1', 'files', 'binary.dat'))).toEqual(binaryBefore)
    expect(existsSync(join(artifacts, 'artifact-1', 'files', '.workforce-execution.json'))).toBe(false)
    expect(existsSync(join(artifacts, 'artifact-1', 'files', 'secret.ignored'))).toBe(false)
    expect(await store.manifest('artifact-1')).toEqual(manifest)
    expect(await store.verify('artifact-1')).toEqual(manifest)

    expect(readFileSync(join(repository, 'tracked.txt'))).toEqual(trackedBefore)
    expect(readFileSync(join(repository, 'binary.dat'))).toEqual(binaryBefore)
    expect(lstatSync(join(repository, 'tracked.txt')).mode & 0o777).toBe(0o755)
    expect(git('status', '--porcelain=v1', '-z')).toBe(statusBefore)
  })

  it('resolves and records a supplied base commit separately from the current HEAD', async () => {
    writeFileSync(join(repository, 'tracked.txt'), 'second commit\n')
    git('add', '--', 'tracked.txt')
    git('commit', '--quiet', '-m', 'second')
    const headRevision = git('rev-parse', 'HEAD')

    const manifest = await capture(new ArtifactStore({ root: artifacts }))

    expect(manifest.baseRevision).toBe(baseRevision)
    expect(manifest.headRevision).toBe(headRevision)
    expect(manifest.headRevision).not.toBe(manifest.baseRevision)
  })

  it('rejects an unknown base revision without creating a final artifact', async () => {
    const store = new ArtifactStore({ root: artifacts })
    await expect(capture(store, 'bad-base', 'execution-1', '0123456789012345678901234567890123456789')).rejects.toThrow(/Git command failed/)
    expect(existsSync(join(artifacts, 'bad-base'))).toBe(false)
    expect(existsSync(artifacts)).toBe(false)
  })

  it('does not overwrite duplicate or colliding artifact directories', async () => {
    const store = new ArtifactStore({ root: artifacts })
    const first = await capture(store)
    await expect(capture(store)).rejects.toThrow(/already exists/)
    expect(await store.verify('artifact-1')).toEqual(first)

    const collision = join(artifacts, 'collision')
    mkdirSync(collision)
    writeFileSync(join(collision, 'foreign.txt'), 'keep')
    await expect(capture(store, 'collision')).rejects.toThrow(/already exists/)
    expect(readFileSync(join(collision, 'foreign.txt'), 'utf8')).toBe('keep')
  })

  it.each([
    { artifactId: '../escape', executionId: 'execution-1' },
    { artifactId: 'nested/id', executionId: 'execution-1' },
    { artifactId: '.', executionId: 'execution-1' },
    { artifactId: 'artifact-1', executionId: '../execution' },
  ])('rejects unsafe identities: $artifactId / $executionId', async input => {
    const store = new ArtifactStore({ root: artifacts })
    await expect(store.capture({ ...input, cwd: repository, baseRevision })).rejects.toThrow(/safe identifier/)
    expect(existsSync(artifacts)).toBe(false)
  })

  it('enforces file-count and byte bounds and cleans only its private temporary directory', async () => {
    const countRoot = join(root, 'count-artifacts')
    await expect(capture(new ArtifactStore({ root: countRoot, maxFiles: 2 }), 'count-limit')).rejects.toThrow(/maxFiles/)
    expect(readdirSync(countRoot)).toEqual([])

    const byteRoot = join(root, 'byte-artifacts')
    await expect(capture(new ArtifactStore({ root: byteRoot, maxBytes: 4 }), 'byte-limit')).rejects.toThrow(/maxBytes/)
    expect(readdirSync(byteRoot)).toEqual([])
  })

  it('rejects source symlinks and leaves no final or temporary artifact', async () => {
    symlinkSync('tracked.txt', join(repository, 'linked.txt'))
    git('add', '--', 'linked.txt')
    const store = new ArtifactStore({ root: artifacts })

    await expect(capture(store, 'linked-artifact')).rejects.toThrow(/Symbolic links/)
    expect(existsSync(join(artifacts, 'linked-artifact'))).toBe(false)
    expect(readdirSync(artifacts)).toEqual([])
  })

  it('rejects Git submodule entries explicitly', async () => {
    git('update-index', '--add', '--cacheinfo', '160000', baseRevision, 'vendor')
    const store = new ArtifactStore({ root: artifacts })

    await expect(capture(store, 'submodule-artifact')).rejects.toThrow(/submodules are unsupported/)
    expect(readdirSync(artifacts)).toEqual([])
  })

  it('rejects an artifact root inside the repository without creating it', async () => {
    const nestedRoot = join(repository, 'artifacts')
    await expect(capture(new ArtifactStore({ root: nestedRoot }), 'overlap')).rejects.toThrow(/must not overlap/)
    expect(existsSync(nestedRoot)).toBe(false)
  })

  it('rejects symbolic-link roots and cwd aliases', async () => {
    const rootTarget = join(root, 'artifact-target')
    const rootLink = join(root, 'artifact-link')
    mkdirSync(rootTarget)
    symlinkSync(rootTarget, rootLink)
    await expect(capture(new ArtifactStore({ root: rootLink }), 'root-link')).rejects.toThrow(/symbolic link/i)

    const cwdLink = join(root, 'repository-link')
    symlinkSync(repository, cwdLink)
    const store = new ArtifactStore({ root: artifacts })
    await expect(store.capture({ artifactId: 'cwd-link', executionId: 'execution-1', cwd: cwdLink, baseRevision })).rejects.toThrow(/symbolic link/i)
    expect(readdirSync(rootTarget)).toEqual([])
  })
})

describe('ArtifactStore verification', () => {
  it('detects content, mode, manifest and extra-file tampering', async () => {
    const contentStore = new ArtifactStore({ root: join(root, 'content-artifacts') })
    await capture(contentStore, 'content')
    writeFileSync(join(root, 'content-artifacts', 'content', 'files', 'tracked.txt'), 'tampered\n')
    await expect(contentStore.verify('content')).rejects.toThrow(/verification failed/)

    const modeStore = new ArtifactStore({ root: join(root, 'mode-artifacts') })
    await capture(modeStore, 'mode')
    chmodSync(join(root, 'mode-artifacts', 'mode', 'files', 'tracked.txt'), 0o700)
    await expect(modeStore.verify('mode')).rejects.toThrow(/verification failed/)

    const manifestStore = new ArtifactStore({ root: join(root, 'manifest-artifacts') })
    await capture(manifestStore, 'manifest')
    const manifestPath = join(root, 'manifest-artifacts', 'manifest', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.executionId = 'different-execution'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    await expect(manifestStore.verify('manifest')).rejects.toThrow(/revision/)

    const extraStore = new ArtifactStore({ root: join(root, 'extra-artifacts') })
    await capture(extraStore, 'extra')
    writeFileSync(join(root, 'extra-artifacts', 'extra', 'files', 'extra.txt'), 'extra')
    await expect(extraStore.verify('extra')).rejects.toThrow(/do not match/)
  })

  it('rejects symlinks introduced after capture', async () => {
    const store = new ArtifactStore({ root: artifacts })
    await capture(store)
    const snapshot = join(artifacts, 'artifact-1', 'files', 'tracked.txt')
    rmSync(snapshot)
    symlinkSync(join(repository, 'tracked.txt'), snapshot)

    await expect(store.verify('artifact-1')).rejects.toThrow(/symbolic link/)
  })

  it('rejects artifact identity substitution and unexpected top-level entries', async () => {
    const store = new ArtifactStore({ root: artifacts })
    await capture(store)
    const manifestPath = join(artifacts, 'artifact-1', 'manifest.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    manifest.artifactId = 'artifact-2'
    writeFileSync(manifestPath, JSON.stringify(manifest))
    await expect(store.manifest('artifact-1')).rejects.toThrow(/identity/)

    writeFileSync(join(artifacts, 'artifact-1', 'foreign'), 'foreign')
    await expect(store.verify('artifact-1')).rejects.toThrow(/unexpected entries/)
  })
})
