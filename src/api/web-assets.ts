/** Immutable, bounded public Web build snapshot. Never serves arbitrary filesystem paths. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { FastifyInstance } from 'fastify'
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 16 * 1024 * 1024
const MAX_ASSETS = 64
const ASSET_NAME = /^[A-Za-z0-9_-]+\.(?:js|css|woff2|svg|png|ico)$/
const TYPES: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', woff2: 'font/woff2', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon' }
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'"
export interface WebAssets {
  isPublicRequest(method: string, url: string): boolean
  register(app: FastifyInstance): void
}
function readAsset(path: string): Buffer {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES) throw new Error('Invalid Web build')
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.ino !== before.ino || info.dev !== before.dev || info.size > MAX_FILE_BYTES) throw new Error('Invalid Web build')
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (count === 0) throw new Error('Web build changed during startup')
      offset += count
    }
    const after = fstatSync(fd)
    if (bytes.length !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw new Error('Web build changed during startup')
    return bytes
  } finally { closeSync(fd) }
}
export function loadWebAssets(root: string): WebAssets {
  try {
    if (typeof root !== 'string' || !isAbsolute(root)) throw new Error('Invalid Web build')
    const rootInfo = lstatSync(root)
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Invalid Web build')
    const canonical = realpathSync(root)
    const index = readAsset(join(canonical, 'index.html'))
    if (!index.toString('utf8').toLowerCase().includes('<!doctype html>')) throw new Error('Invalid Web build')
    const assetsPath = join(canonical, 'assets')
    const assetsInfo = lstatSync(assetsPath)
    if (!assetsInfo.isDirectory() || assetsInfo.isSymbolicLink()) throw new Error('Invalid Web build')
    const entries = readdirSync(assetsPath)
    if (entries.length > MAX_ASSETS || entries.length === 0) throw new Error('Invalid Web build')
    const files = new Map<string, { bytes: Buffer; type: string }>()
    files.set('/', { bytes: index, type: 'text/html; charset=utf-8' })
    files.set('/index.html', { bytes: index, type: 'text/html; charset=utf-8' })
    let total = index.length
    for (const name of entries) {
      if (!ASSET_NAME.test(name)) throw new Error('Unsupported Web asset')
      const bytes = readAsset(join(assetsPath, name))
      total += bytes.length
      if (total > MAX_TOTAL_BYTES) throw new Error('Web build is too large')
      files.set(`/assets/${name}`, { bytes, type: TYPES[name.split('.').at(-1)!]! })
    }
    // A snapshot excludes subsequent path replacement/traversal; all routes are exact.
    return Object.freeze({
      isPublicRequest(method: string, url: string) { return (method === 'GET' || method === 'HEAD') && files.has(url.split('?', 1)[0]!) },
      register(app: FastifyInstance) {
        for (const [path, asset] of files) app.get(path, async (_request, reply) => reply
          .header('Content-Security-Policy', CSP)
          .header('Referrer-Policy', 'no-referrer')
          .header('X-Frame-Options', 'DENY')
          .type(asset.type).send(asset.bytes))
      },
    })
  } catch { throw new Error('Invalid or incomplete Web build; run web:build and select its output directory') }
}
