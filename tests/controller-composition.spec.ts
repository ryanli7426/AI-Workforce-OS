import { mkdtempSync,rmSync,realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,beforeEach,expect,it } from 'vitest'
import { composeController } from '../src/application/controller.ts'
import { LocalTaskService } from '../src/application/tasks.ts'
import { defaultSettings } from '../src/config/settings.ts'
import { initializeApplicationSchema } from '../src/storage/application-store.ts'
import { LocalStore } from '../src/storage/store.ts'

let root:string,store:LocalStore
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'controller-composition-')));store=new LocalStore(join(root,'workforce.sqlite'));initializeApplicationSchema(store)})
afterEach(()=>{store.close();rmSync(root,{recursive:true,force:true})})
function options(){
  const settings=defaultSettings({ownerId:'owner',claudeCommand:'/usr/bin/true'})
  return {store,dataDir:root,settings,tasks:new LocalTaskService({store,ownerId:'owner',workspaceId:'local',rules:settings.rules}),
    execution:{async tick(){return 'executions'},async reconcile(){return 'observed'}}}
}
it('preserves a historical execution-only controller without implicitly installing verification schema',async()=>{
  const input=options()
  store.db.exec("DROP TABLE verification_job_receipt;DROP TABLE verification_job_audit;DROP TABLE verification_job_event;DROP TABLE verification_job;DELETE FROM kv WHERE key='verification-schema'")
  const controller=composeController(input)
  expect(controller).toBe(input.execution)
  expect(await controller.reconcile()).toBe('observed')
  expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name='verification_job'").get()).toBeUndefined()
  expect(store.get('verification-schema')).toBeUndefined()
})
it('rejects orphaned verification tables and future metadata rather than silently ignoring jobs',()=>{
  const input=options()
  store.db.prepare("DELETE FROM kv WHERE key='verification-schema'").run()
  expect(()=>composeController(input)).toThrow(/metadata is missing/)
  expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name='verification_job'").get()).toBeDefined()
  store.set('verification-schema',2)
  expect(()=>composeController(input)).toThrow(/Unsupported verification schema/)
  expect(store.get('verification-schema')).toBe(2)
})
