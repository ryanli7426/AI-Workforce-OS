import { randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOwnerAuthenticator } from '../src/api/auth.ts'
import { createApiServer } from '../src/api/server.ts'
import { loadWebAssets } from '../src/api/web-assets.ts'
import { defaultSettings } from '../src/config/settings.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LocalStore } from '../src/storage/store.ts'
let root: string
const opened: { close(): void | Promise<void> }[] = []
beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'workforce-web-assets-'))); chmodSync(root, 0o700) })
afterEach(async () => { for (const item of opened.splice(0).reverse()) await item.close(); rmSync(root, {recursive:true,force:true}) })
function build() {
  const webRoot = join(root, 'build'); mkdirSync(join(webRoot, 'assets'), {recursive:true})
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>Workforce</title><script type="module" src="/assets/main-abc.js"></script>')
  writeFileSync(join(webRoot, 'assets/main-abc.js'), 'export const app = true;')
  writeFileSync(join(webRoot, 'assets/main-def.css'), 'body{color:black}')
  return webRoot
}
function server(webRoot?: string, allowedOrigins = ['http://localhost:4310']) {
  const dataDir = join(root, 'data'); mkdirSync(dataDir, {mode:0o700})
  const store = new LocalStore(join(dataDir, 'workforce.sqlite')); opened.push(store); initializeApplicationSchema(store)
  const settings = defaultSettings({ownerId:'test-owner'})
  const token = randomBytes(32).toString('hex')
  const app = createApiServer({store,settings,dataDir,authenticator:createOwnerAuthenticator({token,ownerId:settings.ownerId}),allowedOrigins, ...(webRoot === undefined ? {} : {webRoot})}); opened.push(app)
  return {app,token}
}
describe('explicit bounded Web build serving', () => {
  it('serves only selected immutable public assets while all API routes stay authenticated', async () => {
    const webRoot = build(); const {app,token} = server(webRoot)
    const html = await app.inject({url:'/',headers:{host:'localhost:4310'}})
    expect(html.statusCode).toBe(200);expect(html.body).toContain('<!doctype html>');expect(html.headers['content-security-policy']).toContain("connect-src 'self'");expect(html.headers['cache-control']).toBe('no-store')
    expect((await app.inject({url:'/index.html',method:'HEAD',headers:{host:'localhost:4310'}})).body).toBe('')
    writeFileSync(join(webRoot,'assets/main-abc.js'), 'changed later')
    const js = await app.inject({url:'/assets/main-abc.js',headers:{host:'localhost:4310'}})
    expect(js.body).toBe('export const app = true;');expect(js.headers['content-type']).toContain('text/javascript')
    for(const url of ['/api/v1/health','/api/v1/me','/api/v1/tasks','/api-auth.json','/assets/missing.js','/src/main.tsx','/assets/../api/v1/tasks']) expect((await app.inject({url,headers:{host:'localhost:4310'}})).statusCode).toBe(401)
    expect((await app.inject({url:'/api/v1/health',headers:{host:'localhost:4310',authorization:`Bearer ${token}`}})).statusCode).toBe(200)
    expect(html.body).not.toContain(token);expect(js.body).not.toContain(token)
  })
  it('requires local Host and allowed Origin for public build too; only GET/HEAD bypass auth', async () => {
    const {app} = server(build())
    expect((await app.inject({url:'/',headers:{host:'evil.example'}})).statusCode).toBe(403)
    expect((await app.inject({url:'/',headers:{host:'localhost:4310',origin:'https://evil.example'}})).statusCode).toBe(403)
    expect((await app.inject({url:'/',method:'POST',headers:{host:'localhost:4310'},payload:{}})).statusCode).toBe(401)
  })
  it('uses the actual bound port for explicitly served Web on an ephemeral socket', async () => {
    const {app,token} = server(build(), [])
    await app.listen({host:'127.0.0.1',port:0})
    const bound = app.server.address()
    if (!bound || typeof bound === 'string') throw new Error('No test address')
    const origin = `http://127.0.0.1:${bound.port}`
    expect((await fetch(`${origin}/api/v1/me`, {headers:{Origin:origin,Authorization:`Bearer ${token}`}})).status).toBe(200)
    expect((await fetch(`${origin}/api/v1/me`, {headers:{Origin:'http://127.0.0.1:1',Authorization:`Bearer ${token}`}})).status).toBe(403)
  })
  it('does not expose a default root or create missing builds', async () => {
    const {app} = server()
    expect((await app.inject({url:'/',headers:{host:'localhost:4310'}})).statusCode).toBe(401)
    expect(() => loadWebAssets(join(root,'missing'))).toThrow('Invalid or incomplete Web build')
  })
  it('rejects symlinks, unsupported paths, too-large files and incomplete output', () => {
    const webRoot = build()
    symlinkSync(join(webRoot,'assets/main-abc.js'),join(webRoot,'assets/escape.js'))
    expect(() => loadWebAssets(webRoot)).toThrow('Invalid or incomplete Web build');rmSync(join(webRoot,'assets/escape.js'))
    writeFileSync(join(webRoot,'assets/private.json'), '{"token":"not-a-build-asset"}')
    expect(() => loadWebAssets(webRoot)).toThrow();rmSync(join(webRoot,'assets/private.json'))
    truncateSync(join(webRoot,'assets/main-abc.js'),9*1024*1024)
    expect(() => loadWebAssets(webRoot)).toThrow();rmSync(join(webRoot,'assets/main-abc.js'))
    rmSync(join(webRoot,'index.html'));expect(() => loadWebAssets(webRoot)).toThrow()
  })
})
