import * as fs from 'node:fs'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsIO = vi.hoisted(() => ({
  actual: null as typeof import('node:fs') | null,
  writeSync: vi.fn(),
  closeSync: vi.fn(),
  openSync: vi.fn(),
  lstatSync: vi.fn(),
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  fsIO.actual = actual
  fsIO.writeSync.mockImplementation((...args: Parameters<typeof actual.writeSync>) =>
    actual.writeSync(...args))
  fsIO.closeSync.mockImplementation((...args: Parameters<typeof actual.closeSync>) =>
    actual.closeSync(...args))
  fsIO.openSync.mockImplementation((...args: Parameters<typeof actual.openSync>) =>
    actual.openSync(...args))
  fsIO.lstatSync.mockImplementation((...args: Parameters<typeof actual.lstatSync>) =>
    actual.lstatSync(...args))
  return {
    ...actual,
    writeSync: fsIO.writeSync,
    closeSync: fsIO.closeSync,
    openSync: fsIO.openSync,
    lstatSync: fsIO.lstatSync,
  }
})

import {
  ApiAuthError,
  assertLocalRequest,
  createLocalApiCredentials,
  createOwnerAuthenticator,
  loadLocalApiAuthenticator,
} from '../src/api/auth.ts'

let root: string

function restoreFsIO(): void {
  const actual = fsIO.actual!
  fsIO.writeSync.mockReset()
  fsIO.closeSync.mockReset()
  fsIO.openSync.mockReset()
  fsIO.lstatSync.mockReset()
  fsIO.writeSync.mockImplementation((...args: Parameters<typeof actual.writeSync>) =>
    actual.writeSync(...args))
  fsIO.closeSync.mockImplementation((...args: Parameters<typeof actual.closeSync>) =>
    actual.closeSync(...args))
  fsIO.openSync.mockImplementation((...args: Parameters<typeof actual.openSync>) =>
    actual.openSync(...args))
  fsIO.lstatSync.mockImplementation((...args: Parameters<typeof actual.lstatSync>) =>
    actual.lstatSync(...args))
}

beforeEach(() => {
  restoreFsIO()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'api-auth-')))
  chmodSync(root, 0o700)
})

afterEach(() => {
  restoreFsIO()
  rmSync(root, { recursive: true, force: true })
})

function readToken(dataDir: string): string {
  const raw = JSON.parse(readFileSync(join(dataDir, 'api-auth.json'), 'utf8')) as { token: string }
  return raw.token
}

function expectAuthError(run: () => unknown, code: ApiAuthError['code']): void {
  try {
    run()
    expect.fail(`expected ApiAuthError ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(ApiAuthError)
    expect((error as ApiAuthError).code).toBe(code)
    expect(String(error)).not.toMatch(/Bearer |[0-9a-f]{64}|sk-|token=/i)
    expect((error as Error).message).toBe(
      code === 'UNAUTHORIZED' ? 'Unauthorized'
        : code === 'INVALID_AUTH_CONFIG' ? 'Invalid API auth configuration'
          : code === 'FORBIDDEN_ORIGIN' ? 'Forbidden origin'
            : 'Invalid host',
    )
  }
}

describe('createLocalApiCredentials', () => {
  it('creates a private credential file without returning the token and rejects collisions', () => {
    const created = createLocalApiCredentials(root)
    expect(created.path).toBe(join(root, 'api-auth.json'))
    expect(created.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(created).not.toHaveProperty('token')
    expect(JSON.stringify(created)).not.toMatch(/[0-9a-f]{64}/)

    const info = statSync(created.path)
    expect(info.mode & 0o7777).toBe(0o600)
    expect(lstatSync(created.path).isSymbolicLink()).toBe(false)

    const raw = readFileSync(created.path)
    const parsed = JSON.parse(raw.toString('utf8')) as Record<string, unknown>
    expect(Object.keys(parsed).sort()).toEqual(['createdAt', 'schemaVersion', 'token'])
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.createdAt).toBe(created.createdAt)
    expect(parsed.token).toMatch(/^[0-9a-f]{64}$/)
    // Byte preservation: reload exact on-disk bytes.
    expect(readFileSync(created.path)).toEqual(raw)

    expectAuthError(() => createLocalApiCredentials(root), 'INVALID_AUTH_CONFIG')
    expect(readFileSync(created.path)).toEqual(raw)
  })

  it('fails closed for missing roots and shared data directories without creating files', () => {
    const missing = join(root, 'missing')
    expectAuthError(() => createLocalApiCredentials(missing), 'INVALID_AUTH_CONFIG')
    expect(existsSync(missing)).toBe(false)

    const shared = join(root, 'shared')
    mkdirSync(shared, { mode: 0o755 })
    chmodSync(shared, 0o755)
    expectAuthError(() => createLocalApiCredentials(shared), 'INVALID_AUTH_CONFIG')
    expect(statSync(shared).mode & 0o777).toBe(0o755)
    expect(existsSync(join(shared, 'api-auth.json'))).toBe(false)
  })

  it('rejects relative paths and symlink dataDir components', () => {
    expectAuthError(() => createLocalApiCredentials('relative-data'), 'INVALID_AUTH_CONFIG')

    const realDir = join(root, 'real')
    mkdirSync(realDir, { mode: 0o700 })
    chmodSync(realDir, 0o700)
    const linked = join(root, 'linked')
    symlinkSync(realDir, linked)
    expectAuthError(() => createLocalApiCredentials(linked), 'INVALID_AUTH_CONFIG')
    expect(existsSync(join(realDir, 'api-auth.json'))).toBe(false)
  })

  it('does not alter HOME or PATH while creating credentials', () => {
    const home = process.env.HOME
    const path = process.env.PATH
    createLocalApiCredentials(root)
    expect(process.env.HOME).toBe(home)
    expect(process.env.PATH).toBe(path)
  })

  it('fails closed on zero or invalid short-writes and cleans up only the created inode', () => {
    fsIO.writeSync.mockReturnValue(0)
    expectAuthError(() => createLocalApiCredentials(root), 'INVALID_AUTH_CONFIG')
    expect(existsSync(join(root, 'api-auth.json'))).toBe(false)

    fsIO.writeSync.mockReturnValue(-1)
    expectAuthError(() => createLocalApiCredentials(root), 'INVALID_AUTH_CONFIG')
    expect(existsSync(join(root, 'api-auth.json'))).toBe(false)

    fsIO.writeSync.mockReturnValue(Number.NaN)
    expectAuthError(() => createLocalApiCredentials(root), 'INVALID_AUTH_CONFIG')
    expect(existsSync(join(root, 'api-auth.json'))).toBe(false)
  })

  it('rejects a replaced regular 0600 credential path after close without deleting the replacement', () => {
    const credentialPath = join(root, 'api-auth.json')
    const replacementBody = `${JSON.stringify({
      schemaVersion: 1,
      token: 'cd'.repeat(32),
      createdAt: '2020-01-01T00:00:00.000Z',
    })}\n`

    fsIO.closeSync.mockImplementation((fd: number) => {
      fsIO.actual!.closeSync(fd)
      if (!existsSync(credentialPath)) return
      unlinkSync(credentialPath)
      writeFileSync(credentialPath, replacementBody, { mode: 0o600 })
      chmodSync(credentialPath, 0o600)
    })

    expectAuthError(() => createLocalApiCredentials(root), 'INVALID_AUTH_CONFIG')
    expect(existsSync(credentialPath)).toBe(true)
    expect(readFileSync(credentialPath, 'utf8')).toBe(replacementBody)
    expect(statSync(credentialPath).mode & 0o7777).toBe(0o600)
  })

  it('maps uncertain filesystem failures to INVALID_AUTH_CONFIG without echoing paths', () => {
    const leakPath = join(root, 'secret-auth-path.json')
    fsIO.openSync.mockImplementation(() => {
      const error = new Error(`EIO: i/o error, open '${leakPath}'`) as NodeJS.ErrnoException
      error.code = 'EIO'
      error.path = leakPath
      throw error
    })

    try {
      createLocalApiCredentials(root)
      expect.fail('expected ApiAuthError INVALID_AUTH_CONFIG')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiAuthError)
      expect((error as ApiAuthError).code).toBe('INVALID_AUTH_CONFIG')
      expect(String(error)).not.toContain(leakPath)
      expect(String(error)).not.toContain(root)
      expect(String(error)).not.toMatch(/EIO|open |api-auth/i)
    }
    expect(existsSync(join(root, 'api-auth.json'))).toBe(false)
  })
})

describe('loadLocalApiAuthenticator and createOwnerAuthenticator', () => {
  it('loads credentials and authenticates a strict Bearer header without disclosing the token', () => {
    createLocalApiCredentials(root)
    const token = readToken(root)
    const auth = loadLocalApiAuthenticator({ dataDir: root, ownerId: 'owner-1' })

    expect(auth).not.toHaveProperty('token')
    expect(JSON.stringify(auth)).toBe(JSON.stringify({ ownerId: 'owner-1', workspaceId: 'local' }))
    expect(JSON.stringify(auth)).not.toContain(token)

    expect(auth.authenticate(`Bearer ${token}`)).toEqual({
      ownerId: 'owner-1',
      workspaceId: 'local',
    })
  })

  it('snapshots config and ignores later caller mutations', () => {
    createLocalApiCredentials(root)
    const token = readToken(root)
    const input = { dataDir: root, ownerId: 'owner-1', workspaceId: 'ws-1' }
    const auth = loadLocalApiAuthenticator(input)
    input.ownerId = 'mutated'
    input.workspaceId = 'mutated-ws'

    expect(auth.authenticate(`Bearer ${token}`)).toEqual({
      ownerId: 'owner-1',
      workspaceId: 'ws-1',
    })

    const live = { token, ownerId: 'owner-2', workspaceId: 'ws-2' }
    const fromMemory = createOwnerAuthenticator(live)
    live.token = '0'.repeat(64)
    live.ownerId = 'mutated'
    live.workspaceId = 'mutated'
    expect(fromMemory.authenticate(`Bearer ${token}`)).toEqual({
      ownerId: 'owner-2',
      workspaceId: 'ws-2',
    })
    expectAuthError(() => fromMemory.authenticate(`Bearer ${'0'.repeat(64)}`), 'UNAUTHORIZED')
  })

  it('rejects wrong, malformed, duplicate, and oversized auth headers without echoing secrets', () => {
    createLocalApiCredentials(root)
    const token = readToken(root)
    const auth = loadLocalApiAuthenticator({ dataDir: root, ownerId: 'owner-1', workspaceId: 'local' })
    const secretHeader = `Bearer ${token.slice(0, 32)}${'ab'.repeat(16)}`

    expectAuthError(() => auth.authenticate(`Bearer ${'a'.repeat(64)}`), 'UNAUTHORIZED')
    expectAuthError(() => auth.authenticate(secretHeader), 'UNAUTHORIZED')
    expectAuthError(() => auth.authenticate(`bearer ${token}`), 'UNAUTHORIZED')
    expectAuthError(() => auth.authenticate(`Bearer ${token} `), 'UNAUTHORIZED')
    expectAuthError(() => auth.authenticate(`Bearer ${token}\n`), 'UNAUTHORIZED')
    expectAuthError(() => auth.authenticate(`Basic ${token}`), 'UNAUTHORIZED')
    expectAuthError(() => auth.authenticate('Bearer'), 'UNAUTHORIZED')
    expectAuthError(() => auth.authenticate(`Bearer ${token.slice(0, 63)}`), 'UNAUTHORIZED')
    expectAuthError(() => auth.authenticate(['Bearer ' + token]), 'UNAUTHORIZED')
    expectAuthError(() => auth.authenticate(`Bearer ${token}${'0'.repeat(300)}`), 'UNAUTHORIZED')
    expectAuthError(() => auth.authenticate({ actor: 'owner-1', token }), 'UNAUTHORIZED')
  })

  it('rejects invalid authenticator config without echoing the token', () => {
    const secret = 'ab'.repeat(32)
    expectAuthError(
      () => createOwnerAuthenticator({ token: secret.slice(0, 63), ownerId: 'owner-1' }),
      'INVALID_AUTH_CONFIG',
    )
    expectAuthError(
      () => createOwnerAuthenticator({ token: secret.toUpperCase(), ownerId: 'owner-1' }),
      'INVALID_AUTH_CONFIG',
    )
    expectAuthError(
      () => createOwnerAuthenticator({ token: secret, ownerId: '../evil' }),
      'INVALID_AUTH_CONFIG',
    )
    expectAuthError(
      () => createOwnerAuthenticator({ token: secret, ownerId: 'owner-1', workspaceId: 'bad id' }),
      'INVALID_AUTH_CONFIG',
    )
  })

  it('fails closed on missing, permission-broadened, symlink, and malformed credential files', () => {
    expectAuthError(
      () => loadLocalApiAuthenticator({ dataDir: root, ownerId: 'owner-1' }),
      'INVALID_AUTH_CONFIG',
    )

    createLocalApiCredentials(root)
    const path = join(root, 'api-auth.json')
    chmodSync(path, 0o640)
    expectAuthError(
      () => loadLocalApiAuthenticator({ dataDir: root, ownerId: 'owner-1' }),
      'INVALID_AUTH_CONFIG',
    )
    chmodSync(path, 0o600)

    chmodSync(path, 0o2600)
    expectAuthError(
      () => loadLocalApiAuthenticator({ dataDir: root, ownerId: 'owner-1' }),
      'INVALID_AUTH_CONFIG',
    )
    chmodSync(path, 0o600)

    const link = join(root, 'api-auth.link.json')
    symlinkSync(path, link)
    // Symlink as the credential path component via replaced name is covered by linked dataDir below.
    const linkedDir = join(root, 'cred-link-dir')
    mkdirSync(linkedDir, { mode: 0o700 })
    chmodSync(linkedDir, 0o700)
    const linkedFile = join(linkedDir, 'api-auth.json')
    symlinkSync(path, linkedFile)
    expectAuthError(
      () => loadLocalApiAuthenticator({ dataDir: linkedDir, ownerId: 'owner-1' }),
      'INVALID_AUTH_CONFIG',
    )

    writeFileSync(path, '{not-json', { mode: 0o600 })
    chmodSync(path, 0o600)
    expectAuthError(
      () => loadLocalApiAuthenticator({ dataDir: root, ownerId: 'owner-1' }),
      'INVALID_AUTH_CONFIG',
    )

    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 99,
      token: 'ab'.repeat(32),
      createdAt: '2020-01-01T00:00:00.000Z',
    })}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
    expectAuthError(
      () => loadLocalApiAuthenticator({ dataDir: root, ownerId: 'owner-1' }),
      'INVALID_AUTH_CONFIG',
    )
    expect(readFileSync(path, 'utf8')).toContain('"schemaVersion":99')

    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      token: 'ab'.repeat(32),
      createdAt: '2020-01-01T00:00:00.000Z',
      extra: true,
    })}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
    expectAuthError(
      () => loadLocalApiAuthenticator({ dataDir: root, ownerId: 'owner-1' }),
      'INVALID_AUTH_CONFIG',
    )

    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      token: 'ab'.repeat(32),
      createdAt: 'not-a-timestamp',
    })}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
    expectAuthError(
      () => loadLocalApiAuthenticator({ dataDir: root, ownerId: 'owner-1' }),
      'INVALID_AUTH_CONFIG',
    )

    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      token: 'ab'.repeat(32),
      createdAt: '2020-02-30T00:00:00.000Z',
    })}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
    expectAuthError(
      () => loadLocalApiAuthenticator({ dataDir: root, ownerId: 'owner-1' }),
      'INVALID_AUTH_CONFIG',
    )

    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 1,
      token: 'ab'.repeat(32),
      createdAt: '2020-01-01T00:00:00.000Z',
    })}\n`, { mode: 0o600 })
    chmodSync(path, 0o600)
    const auth = loadLocalApiAuthenticator({ dataDir: root, ownerId: 'owner-1' })
    expect(auth.authenticate(`Bearer ${'ab'.repeat(32)}`)).toEqual({
      ownerId: 'owner-1',
      workspaceId: 'local',
    })

    const huge = 'x'.repeat(4 * 1024 + 1)
    writeFileSync(path, huge, { mode: 0o600 })
    chmodSync(path, 0o600)
    expectAuthError(
      () => loadLocalApiAuthenticator({ dataDir: root, ownerId: 'owner-1' }),
      'INVALID_AUTH_CONFIG',
    )
  })

  it('never creates credentials on load and does not authenticate payload actor fields', () => {
    const empty = join(root, 'empty')
    mkdirSync(empty, { mode: 0o700 })
    chmodSync(empty, 0o700)
    expectAuthError(
      () => loadLocalApiAuthenticator({ dataDir: empty, ownerId: 'owner-1' }),
      'INVALID_AUTH_CONFIG',
    )
    expect(existsSync(join(empty, 'api-auth.json'))).toBe(false)

    createLocalApiCredentials(root)
    const token = readToken(root)
    const auth = createOwnerAuthenticator({ token, ownerId: 'owner-1' })
    expectAuthError(
      () => auth.authenticate(JSON.stringify({ actor: 'owner-1', authorization: `Bearer ${token}` })),
      'UNAUTHORIZED',
    )
  })

  it('maps uncertain load filesystem failures without echoing path or body', () => {
    createLocalApiCredentials(root)
    const credentialPath = join(root, 'api-auth.json')
    fsIO.lstatSync.mockImplementation((path: fs.PathLike, options?: fs.StatOptions) => {
      if (String(path) === credentialPath) {
        const error = new Error(`EIO: i/o error, lstat '${credentialPath}'`) as NodeJS.ErrnoException
        error.code = 'EIO'
        error.path = credentialPath
        throw error
      }
      return fsIO.actual!.lstatSync(path, options as never)
    })

    try {
      loadLocalApiAuthenticator({ dataDir: root, ownerId: 'owner-1' })
      expect.fail('expected ApiAuthError INVALID_AUTH_CONFIG')
    } catch (error) {
      expect(error).toBeInstanceOf(ApiAuthError)
      expect((error as ApiAuthError).code).toBe('INVALID_AUTH_CONFIG')
      expect(String(error)).not.toContain(credentialPath)
      expect(String(error)).not.toContain(root)
      expect(String(error)).not.toMatch(/EIO|lstat|api-auth/i)
    }
  })
})

describe('assertLocalRequest', () => {
  const allowed = ['http://127.0.0.1:8787', 'https://localhost:8787', 'http://[::1]:8787'] as const

  it('accepts exact loopback hosts and same-origin allowlist matches', () => {
    expect(() => assertLocalRequest({
      host: '127.0.0.1:8787',
      origin: 'http://127.0.0.1:8787',
      allowedOrigins: allowed,
    })).not.toThrow()

    expect(() => assertLocalRequest({
      host: 'localhost',
      origin: 'https://localhost:8787',
      allowedOrigins: allowed,
    })).not.toThrow()

    expect(() => assertLocalRequest({
      host: '[::1]:8787',
      origin: 'http://[::1]:8787',
      allowedOrigins: allowed,
    })).not.toThrow()
  })

  it('allows absent Origin for authenticated CLI while still requiring a valid Host', () => {
    expect(() => assertLocalRequest({
      host: '127.0.0.1',
      origin: undefined,
      allowedOrigins: allowed,
    })).not.toThrow()

    expect(() => assertLocalRequest({
      host: 'localhost:3000',
      origin: null,
      allowedOrigins: [],
    })).not.toThrow()
  })

  it('rejects malicious hosts and DNS-rebinding names without echoing them', () => {
    const cases = [
      'evil.com',
      '127.0.0.1.attacker.com',
      'localhost.evil',
      '127.0.0.1:99999',
      '127.0.0.1:08',
      'user@127.0.0.1',
      '127.0.0.1/admin',
      '127.0.0.1?x=1',
      '127.0.0.1#x',
      '[::1',
      '::1',
      '0.0.0.0',
      '',
    ]
    for (const host of cases) {
      expectAuthError(
        () => assertLocalRequest({ host, origin: undefined, allowedOrigins: allowed }),
        'INVALID_HOST',
      )
    }
    expectAuthError(
      () => assertLocalRequest({ host: ['127.0.0.1', '127.0.0.1'], origin: undefined, allowedOrigins: allowed }),
      'INVALID_HOST',
    )
  })

  it('rejects malicious or non-allowlisted origins without echoing untrusted values', () => {
    const host = '127.0.0.1:8787'
    const cases = [
      'http://evil.com',
      'http://127.0.0.1.evil.com',
      'http://127.0.0.1:8787/admin',
      'http://user:pass@127.0.0.1:8787',
      'http://127.0.0.1:8787?q=1',
      'http://127.0.0.1:8787#x',
      'null',
      '*',
      'http://localhost:8787',
      'HTTP://127.0.0.1:8787',
      '',
    ]
    for (const origin of cases) {
      expectAuthError(
        () => assertLocalRequest({ host, origin, allowedOrigins: allowed }),
        'FORBIDDEN_ORIGIN',
      )
    }
    expectAuthError(
      () => assertLocalRequest({
        host,
        origin: ['http://127.0.0.1:8787', 'http://127.0.0.1:8787'],
        allowedOrigins: allowed,
      }),
      'FORBIDDEN_ORIGIN',
    )
    // Invalid allowlist entries never count as trusted.
    expectAuthError(
      () => assertLocalRequest({
        host,
        origin: 'http://evil.com',
        allowedOrigins: ['http://evil.com', 'null', '*'],
      }),
      'FORBIDDEN_ORIGIN',
    )
  })
})
