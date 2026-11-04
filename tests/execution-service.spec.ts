import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LocalStore } from '../src/storage/store.ts'
import { ExecutionRepository, initializeExecutionSchema } from '../src/execution/repository.ts'
import { ExecutionService } from '../src/application/execution-service.ts'
import { RunnerClient } from '../src/runner/client.ts'
import type { ExecutionSpec } from '../src/execution/model.ts'
import type { LaunchSpec } from '../src/runner/protocol.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup() })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'execution-service-')))
  const path = join(root, 'db.sqlite')
  let store = new LocalStore(path)
  initializeExecutionSchema(store.db)
  let repository = new ExecutionRepository(store.db)
  const runner = new RunnerClient({ root: join(root, 'runners'), workerPath: resolve('dist/runner/worker.js') })
  const spec: ExecutionSpec = { executionId: 'exec1', assignmentId: 'assign1', ticketId: 'task1', agentId: 'employee1', runtime: 'fixture', generation: 1,
    cwd: root, inputRevision: 'input-v1', policyVersion: 'policy-v1' }
  const launch: LaunchSpec = { executionId: spec.executionId, assignmentId: spec.assignmentId, ticketId: spec.ticketId, generation: 1,
    cwd: root, command: process.execPath, args: [resolve('tests/fixtures/runner-child.mjs'), 'delay', '300'], timeoutMs: 5_000, maxOutputBytes: 4096, graceMs: 100 }
  cleanups.push(async () => {
    try {
      const snapshot = await runner.status(spec.executionId)
      if (!['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(snapshot.state)) {
        await runner.stop(spec.executionId, 'test cleanup')
        if (snapshot.processId) { try { process.kill(-snapshot.processId, 'SIGKILL') } catch {} }
      }
    } catch {}
    try { store.close() } catch {}
    rmSync(root, { recursive: true, force: true })
  })
  const service = () => new ExecutionService(repository, runner, { authorize: () => {} })
  const reopen = () => { store.close(); store = new LocalStore(path); repository = new ExecutionRepository(store.db); return service() }
  return { root, runner, spec, launch, service, reopen, repository: () => repository }
}
async function finish(service: ExecutionService, id: string) {
  for (let i = 0; i < 200; i++) {
    const result = await service.synchronize(id)
    if (['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'CANCELLED'].includes(result.execution.state)) return result.execution
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('execution did not finish')
}
it('persists real Runner events and recovers observation after closing the control database', async () => {
  const f = fixture()
  await f.service().start(f.spec, f.launch)
  const recovered = f.reopen()
  const result = await finish(recovered, f.spec.executionId)
  expect(result.state).toBe('SUCCEEDED')
  expect(result.exitCode).toBe(0)
  expect(f.repository().events(f.spec.executionId).map(e => e.state)).toEqual(['STARTING', 'RUNNING', 'SUCCEEDED'])
  expect(f.repository().get(f.spec.executionId)?.lastSequence).toBe(3)
})
it('requires authorization before reserving resources or starting processes', async () => {
  const f = fixture()
  const denied = new ExecutionService(f.repository(), f.runner, { authorize: () => { throw new Error('denied') } })
  await expect(denied.start(f.spec, f.launch)).rejects.toThrow('denied')
  expect(f.repository().list()).toEqual([])
  await expect(f.runner.status(f.spec.executionId)).rejects.toThrow()
})
it('does not release occupancy when a Runner disappears', async () => {
  const f = fixture()
  await f.service().start(f.spec, { ...f.launch, args: [resolve('tests/fixtures/runner-child.mjs'), 'wait', '30000'] })
  let observed = await f.runner.status(f.spec.executionId)
  for (let i = 0; !observed.processId && i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 20)); observed = await f.runner.status(f.spec.executionId)
  }
  expect(observed.processId).toBeGreaterThan(1)
  process.kill(observed.runnerPid, 'SIGKILL')
  await new Promise(resolve => setTimeout(resolve, 100))
  const reconciled = await f.service().synchronize(f.spec.executionId)
  expect(reconciled.execution.state).toBe('UNKNOWN')
  expect(() => f.repository().reserve({ ...f.spec, executionId: 'exec2', assignmentId: 'assign2' })).toThrow()
  await expect(f.service().start(f.spec, f.launch)).rejects.toThrow('UNKNOWN')
})
it('retains sequence cursors when local observation becomes uncertain', async () => {
  const f = fixture()
  await f.service().start(f.spec, f.launch)
  const previous = f.repository().get(f.spec.executionId)!
  f.repository().markUnknown(f.spec.executionId, 'connection interrupted')
  expect(f.repository().get(f.spec.executionId)?.lastSequence).toBe(previous.lastSequence)
  expect((await finish(f.service(), f.spec.executionId)).state).toBe('SUCCEEDED')
})

it('observes a detached worker after its actual controller process exits', async () => {
  const f = fixture()
  const launch = { ...f.launch, args: [resolve('tests/fixtures/runner-child.mjs'), 'delay', '1500'] }
  f.repository().reserve(f.spec)
  const controller = spawnSync(process.execPath, [resolve('tests/fixtures/runner-controller.mjs'),
    resolve('dist/runner/client.js'), join(f.root, 'runners'), resolve('dist/runner/worker.js'), JSON.stringify(launch)],
    { encoding: 'utf8', timeout: 6000 })
  expect(controller.error).toBeUndefined()
  expect(controller.status, controller.stderr).toBe(0)
  const identity = JSON.parse(controller.stdout) as { runnerPid: number }
  expect(() => process.kill(identity.runnerPid, 0)).not.toThrow()
  const recovered = f.reopen()
  expect((await finish(recovered, f.spec.executionId)).state).toBe('SUCCEEDED')
  expect(f.repository().list()).toHaveLength(1)
})
