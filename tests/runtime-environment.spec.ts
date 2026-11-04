import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { RunnerClient } from '../src/runner/client.ts'
import { validateRuntimeEnvironment } from '../src/runner/environment.ts'
it('injects only explicitly authorized credentials without storing them in requests or output', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'runtime-env-')))
  const secret = 'private-scoped-key-value-123456'
  const client = new RunnerClient({ root, workerPath: resolve('dist/runner/worker.js'), runtimeEnvironment: { ANTHROPIC_AUTH_TOKEN: secret } })
  try {
    await client.start({ executionId: 'env1', assignmentId: 'a', ticketId: 't', generation: 1, cwd: root, command: process.execPath,
      args: ['-e', 'process.stdout.write(JSON.stringify({has:!!process.env.ANTHROPIC_AUTH_TOKEN,key:process.env.ANTHROPIC_AUTH_TOKEN}));'],
      timeoutMs: 2000, maxOutputBytes: 4096, graceMs: 100 })
    let state = await client.status('env1')
    for (let i = 0; !['SUCCEEDED','FAILED'].includes(state.state) && i < 150; i++) { await new Promise(r => setTimeout(r,20)); state = await client.status('env1') }
    expect(state.state).toBe('SUCCEEDED')
    const output = readFileSync(join(root,'env1','stdout.log'),'utf8')
    expect(output).not.toContain(secret)
    expect(JSON.parse(output)).toEqual({ has: true, key: '[REDACTED]' })
    for (const file of ['request.json','state.json','events.jsonl']) expect(readFileSync(join(root,'env1',file),'utf8')).not.toContain(secret)
  } finally { await client.stop('env1','cleanup').catch(()=>{}); rmSync(root,{recursive:true,force:true}) }
})
it('rejects arbitrary environment injection without exposing secret values', () => {
  expect(() => validateRuntimeEnvironment({ NODE_OPTIONS: '--require sensitive-value' })).toThrow('Unsupported')
})
