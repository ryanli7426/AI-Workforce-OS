import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createSettings,
  defaultSettings,
  loadSettings,
  validateSettings,
  type LocalSettings,
} from '../src/config/settings.ts'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'settings-')))
  chmodSync(root, 0o700)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function sample(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base = defaultSettings({ ownerId: 'owner-1' }) as unknown as Record<string, unknown>
  return {
    ...base,
    runtime: { ...(base.runtime as object) },
    scheduler: { ...(base.scheduler as object) },
    rules: (base.rules as LocalSettings['rules']).map(rule => ({ ...rule, taskTypes: [...rule.taskTypes] })),
    ...overrides,
  }
}

describe('defaultSettings', () => {
  it('returns schema v1 local defaults with approval and review required', () => {
    const settings = defaultSettings({ ownerId: 'owner-1' })
    expect(settings).toEqual({
      schemaVersion: 1,
      workspaceId: 'local',
      ownerId: 'owner-1',
      runtime: {
        id: 'claude-local',
        driver: 'claude-code',
        command: null,
        timeoutMs: 3_600_000,
        maxOutputBytes: 8 * 1024 * 1024,
        graceMs: 5_000,
      },
      scheduler: {
        pollIntervalMs: 1_000,
        maxConcurrency: 1,
      },
      rules: [{
        id: 'documentation',
        enabled: true,
        taskTypes: ['documentation'],
        priority: 10,
        approvalRequired: true,
        reviewRequired: true,
        retryLimit: 2,
      }],
    })
  })

  it('accepts an absolute claudeCommand and keeps approval on', () => {
    const settings = defaultSettings({ ownerId: 'owner-1', claudeCommand: '/usr/local/bin/claude' })
    expect(settings.runtime.command).toBe('/usr/local/bin/claude')
    expect(settings.rules[0]?.approvalRequired).toBe(true)
    expect(settings.rules[0]?.reviewRequired).toBe(true)
  })

  it('rejects unsafe owner ids, relative commands, and unknown input fields', () => {
    expect(() => defaultSettings({ ownerId: '../evil' })).toThrow(/ownerId/)
    expect(() => defaultSettings({ ownerId: 'owner-1', claudeCommand: 'claude' })).toThrow(/claudeCommand/)
    expect(() => defaultSettings({ ownerId: 'owner-1', claudeCommand: null } as never)).toThrow(/claudeCommand|field/)
    expect(() => defaultSettings({ ownerId: 'owner-1', extra: true } as never)).toThrow(/Unknown defaultSettings input field: extra/)
  })

  it('does not let caller mutations alter a previously returned snapshot', () => {
    const input = { ownerId: 'owner-1' }
    const first = defaultSettings(input)
    input.ownerId = 'mutated'
    first.ownerId = 'mutated'
    first.rules[0]!.approvalRequired = false
    first.rules[0]!.taskTypes.push('ops')
    first.runtime.command = '/bin/evil'
    const second = defaultSettings({ ownerId: 'owner-1' })
    expect(second.ownerId).toBe('owner-1')
    expect(second.rules[0]).toEqual({
      id: 'documentation',
      enabled: true,
      taskTypes: ['documentation'],
      priority: 10,
      approvalRequired: true,
      reviewRequired: true,
      retryLimit: 2,
    })
    expect(second.runtime.command).toBeNull()
  })
})

describe('validateSettings', () => {
  it('accepts a deep copy and ignores later caller mutations', () => {
    const raw = sample()
    const runtime = { ...(raw.runtime as object) } as LocalSettings['runtime']
    const rules = [(raw.rules as LocalSettings['rules'])[0]!]
    raw.runtime = runtime
    raw.rules = rules
    const validated = validateSettings(raw)
    runtime.command = '/bin/mutated'
    rules[0]!.approvalRequired = false
    rules[0]!.taskTypes.push('mutated')
    expect(validated.runtime.command).toBeNull()
    expect(validated.rules[0]?.approvalRequired).toBe(true)
    expect(validated.rules[0]?.taskTypes).toEqual(['documentation'])
  })

  it('rejects unknown top-level, runtime, scheduler, and rule fields without echoing values', () => {
    const secret = 'sk-ant-super-secret-value'
    expect(() => validateSettings(sample({ token: secret }))).toThrow(/Unknown settings field: token/)
    expect(() => validateSettings(sample({ token: secret }))).not.toThrow(new RegExp(secret))

    const withRuntime = sample()
    ;(withRuntime.runtime as Record<string, unknown>).apiKey = secret
    expect(() => validateSettings(withRuntime)).toThrow(/Unknown runtime field: apiKey/)
    expect(() => validateSettings(withRuntime)).not.toThrow(new RegExp(secret))

    const withScheduler = sample()
    ;(withScheduler.scheduler as Record<string, unknown>).secretRef = secret
    expect(() => validateSettings(withScheduler)).toThrow(/Unknown scheduler field: secretRef/)

    const withRule = sample()
    const rule = { ...(withRule.rules as object[])[0] as object, credential: secret }
    withRule.rules = [rule]
    expect(() => validateSettings(withRule)).toThrow(/Unknown rule\[0\] field: credential/)
    expect(() => validateSettings(withRule)).not.toThrow(new RegExp(secret))
  })

  it('sanitizes secret-shaped schemaVersion values and unknown keys in errors', () => {
    const secretVersion = 'sk-ant-schema-version-leak'
    const secretKey = 'sk-ant-super-secret-key'

    expect(() => validateSettings(sample({ schemaVersion: secretVersion }))).toThrow(/Unsupported settings schemaVersion/)
    expect(() => validateSettings(sample({ schemaVersion: secretVersion }))).not.toThrow(new RegExp(secretVersion))

    expect(() => validateSettings(sample({ schemaVersion: { token: secretVersion } }))).toThrow(/Unsupported settings schemaVersion/)
    expect(() => validateSettings(sample({ schemaVersion: { token: secretVersion } }))).not.toThrow(new RegExp(secretVersion))

    expect(() => validateSettings(sample({ [secretKey]: true }))).toThrow(/Unknown settings field/)
    expect(() => validateSettings(sample({ [secretKey]: true }))).not.toThrow(new RegExp(secretKey))

    const withRuntime = sample()
    ;(withRuntime.runtime as Record<string, unknown>)[secretKey] = 'value'
    expect(() => validateSettings(withRuntime)).toThrow(/Unknown runtime field/)
    expect(() => validateSettings(withRuntime)).not.toThrow(new RegExp(secretKey))
  })

  it('rejects malformed and future schema versions without echoing the value', () => {
    expect(() => validateSettings(sample({ schemaVersion: 2 }))).toThrow(/^Unsupported settings schemaVersion$/)
    expect(() => validateSettings(sample({ schemaVersion: '1' }))).toThrow(/^Unsupported settings schemaVersion$/)
    expect(() => validateSettings(sample({ schemaVersion: null }))).toThrow(/^Unsupported settings schemaVersion$/)
  })

  it('rejects non-local workspace and unsafe owner ids', () => {
    expect(() => validateSettings(sample({ workspaceId: 'remote' }))).toThrow(/workspaceId/)
    expect(() => validateSettings(sample({ ownerId: '' }))).toThrow(/ownerId/)
    expect(() => validateSettings(sample({ ownerId: 'bad id' }))).toThrow(/ownerId/)
  })

  it('rejects relative or empty runtime commands while allowing explicit null', () => {
    const relative = sample()
    ;(relative.runtime as Record<string, unknown>).command = 'claude'
    expect(() => validateSettings(relative)).toThrow(/runtime\.command/)

    const empty = sample()
    ;(empty.runtime as Record<string, unknown>).command = ''
    expect(() => validateSettings(empty)).toThrow(/runtime\.command/)

    const unset = sample()
    ;(unset.runtime as Record<string, unknown>).command = null
    expect(validateSettings(unset).runtime.command).toBeNull()
  })

  it('rejects out-of-bound integer parameters', () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['timeoutMs', { timeoutMs: 999 }],
      ['timeoutMs', { timeoutMs: 86_400_001 }],
      ['maxOutputBytes', { maxOutputBytes: 4095 }],
      ['maxOutputBytes', { maxOutputBytes: 1024 * 1024 * 1024 + 1 }],
      ['graceMs', { graceMs: 999 }],
      ['graceMs', { graceMs: 60_001 }],
    ]
    for (const [field, runtimePatch] of cases) {
      const value = sample()
      Object.assign(value.runtime as object, runtimePatch)
      expect(() => validateSettings(value), field).toThrow(new RegExp(field))
    }

    const lowPoll = sample()
    ;(lowPoll.scheduler as Record<string, unknown>).pollIntervalMs = 99
    expect(() => validateSettings(lowPoll)).toThrow(/pollIntervalMs/)

    const highPoll = sample()
    ;(highPoll.scheduler as Record<string, unknown>).pollIntervalMs = 60_001
    expect(() => validateSettings(highPoll)).toThrow(/pollIntervalMs/)

    const lowConc = sample()
    ;(lowConc.scheduler as Record<string, unknown>).maxConcurrency = 0
    expect(() => validateSettings(lowConc)).toThrow(/maxConcurrency/)

    const highConc = sample()
    ;(highConc.scheduler as Record<string, unknown>).maxConcurrency = 65
    expect(() => validateSettings(highConc)).toThrow(/maxConcurrency/)
  })

  it('rejects invalid runtime identity and overlapping rules via RuleAssessor', () => {
    const badId = sample()
    ;(badId.runtime as Record<string, unknown>).id = 'other'
    expect(() => validateSettings(badId)).toThrow(/runtime\.id/)

    const badDriver = sample()
    ;(badDriver.runtime as Record<string, unknown>).driver = 'shell'
    expect(() => validateSettings(badDriver)).toThrow(/runtime\.driver/)

    const overlap = sample()
    overlap.rules = [
      {
        id: 'a',
        enabled: true,
        taskTypes: ['documentation'],
        priority: 10,
        approvalRequired: true,
        reviewRequired: true,
        retryLimit: 2,
      },
      {
        id: 'b',
        enabled: true,
        taskTypes: ['documentation'],
        priority: 5,
        approvalRequired: true,
        reviewRequired: true,
        retryLimit: 1,
      },
    ]
    expect(() => validateSettings(overlap)).toThrow(/Overlapping enabled rules/)
  })
})

describe('createSettings and loadSettings', () => {
  it('creates a private 0600 file, loads a cloned snapshot, and rejects collisions', () => {
    const path = join(root, 'settings.json')
    const created = createSettings(path, defaultSettings({ ownerId: 'owner-1' }))
    expect(statSync(path).mode & 0o7777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(created)

    const loaded = loadSettings(path)
    expect(loaded).toEqual(created)
    loaded.rules[0]!.approvalRequired = false
    loaded.rules[0]!.taskTypes.push('ops')
    // Returned objects are cloned, not frozen; mutations must not affect the file or later loads.
    expect(loadSettings(path).rules[0]).toEqual(created.rules[0])

    expect(() => createSettings(path, defaultSettings({ ownerId: 'owner-2' }))).toThrow(/already exists/)
    expect(loadSettings(path).ownerId).toBe('owner-1')
  })

  it('rejects shared parents without chmod and cleans up only own partial failures', () => {
    const shared = join(root, 'shared')
    mkdirSync(shared, { mode: 0o755 })
    chmodSync(shared, 0o755)
    const path = join(shared, 'settings.json')
    expect(() => createSettings(path, defaultSettings({ ownerId: 'owner-1' }))).toThrow(/private/)
    expect(statSync(shared).mode & 0o777).toBe(0o755)
    expect(existsSync(path)).toBe(false)
  })

  it('rejects symlink path components and symlink settings files', () => {
    const realDir = join(root, 'real')
    mkdirSync(realDir, { mode: 0o700 })
    chmodSync(realDir, 0o700)
    const linkedDir = join(root, 'linked')
    symlinkSync(realDir, linkedDir)
    expect(() => createSettings(join(linkedDir, 'settings.json'), defaultSettings({ ownerId: 'owner-1' })))
      .toThrow(/Symbolic link|symlink/i)

    const path = join(root, 'settings.json')
    createSettings(path, defaultSettings({ ownerId: 'owner-1' }))
    const link = join(root, 'settings.link.json')
    symlinkSync(path, link)
    expect(() => loadSettings(link)).toThrow(/Symbolic link|symlink|0600/i)
  })

  it('rejects broader permissions, special mode bits, and oversized files on load', () => {
    const path = join(root, 'settings.json')
    createSettings(path, defaultSettings({ ownerId: 'owner-1' }))
    chmodSync(path, 0o640)
    expect(() => loadSettings(path)).toThrow(/0600/)
    chmodSync(path, 0o600)

    // Exact mode includes special bits: setgid/sticky/setuid must not be accepted as "0600".
    chmodSync(path, 0o2600)
    expect(() => loadSettings(path)).toThrow(/0600/)
    chmodSync(path, 0o600)

    const huge = join(root, 'huge.json')
    writeFileSync(huge, `${'x'.repeat(128 * 1024 + 1)}`, { mode: 0o600 })
    chmodSync(huge, 0o600)
    expect(() => loadSettings(huge)).toThrow(/128KiB/)
  })

  it('rejects malformed JSON and future versions without creating or migrating', () => {
    const malformed = join(root, 'malformed.json')
    writeFileSync(malformed, '{not-json', { mode: 0o600 })
    chmodSync(malformed, 0o600)
    expect(() => loadSettings(malformed)).toThrow(/JSON/)

    const futurePath = join(root, 'future.json')
    writeFileSync(futurePath, `${JSON.stringify(sample({ schemaVersion: 99 }))}\n`, { mode: 0o600 })
    chmodSync(futurePath, 0o600)
    expect(() => loadSettings(futurePath)).toThrow(/schemaVersion/)
    expect(readFileSync(futurePath, 'utf8')).toContain('"schemaVersion":99')
  })

  it('rejects relative paths and settings placed directly in HOME', () => {
    expect(() => createSettings('settings.json', defaultSettings({ ownerId: 'owner-1' }))).toThrow(/absolute/)
    expect(() => loadSettings('settings.json')).toThrow(/absolute/)

    const homePath = join(homedir(), `.workforce-settings-test-${Date.now()}.json`)
    expect(() => createSettings(homePath, defaultSettings({ ownerId: 'owner-1' }))).toThrow(/directly in the default user HOME/)
    expect(existsSync(homePath)).toBe(false)
  })

  it('allows explicit project-local settings under a private directory inside the real home', () => {
    const homeRoot = mkdtempSync(join(homedir(), '.workforce-settings-home-'))
    try {
      chmodSync(homeRoot, 0o700)
      const projectDir = join(homeRoot, 'Desktop', 'demo', '.workforce')
      mkdirSync(projectDir, { recursive: true, mode: 0o700 })
      chmodSync(join(homeRoot, 'Desktop'), 0o700)
      chmodSync(join(homeRoot, 'Desktop', 'demo'), 0o700)
      chmodSync(projectDir, 0o700)

      const path = join(projectDir, 'settings.json')
      const created = createSettings(path, defaultSettings({ ownerId: 'owner-1' }))
      expect(loadSettings(path)).toEqual(created)
      expect(statSync(path).mode & 0o7777).toBe(0o600)
    } finally {
      rmSync(homeRoot, { recursive: true, force: true })
    }
  })

  it('accepts canonical temp roots after trusted macOS alias normalization', () => {
    const path = join(root, 'alias-ok.json')
    const created = createSettings(path, defaultSettings({
      ownerId: 'owner-1',
      claudeCommand: resolve('/bin/sh'),
    }))
    expect(loadSettings(path)).toEqual(created)
    expect(created.runtime.command).toBe(resolve('/bin/sh'))
  })
})
