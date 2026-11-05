import { chmodSync,linkSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync,symlinkSync,writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,beforeEach,describe,expect,it } from 'vitest'
import { createVerificationPlans,loadVerificationPlans } from '../src/config/verification-plans.ts'
let root:string
const owner={ownerId:'owner',workspaceId:'local'}
const plan={id:'docs',revision:'v1',checks:[{id:'content',command:'/usr/bin/true',args:[],timeoutMs:1000}]}
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'workforce-plans-')));chmodSync(root,0o700)})
afterEach(()=>rmSync(root,{recursive:true,force:true}))
describe('private verification plan registry',()=>{
 it('has no implicit creation and installs immutable private plans only explicitly',()=>{
  expect(loadVerificationPlans(root,owner)).toEqual([])
  const {path}=createVerificationPlans(root,owner,[plan]);expect(statSync(path).mode&0o777).toBe(0o600)
  const original=readFileSync(path);expect(loadVerificationPlans(root,owner)).toEqual([plan])
  expect(()=>createVerificationPlans(root,owner,[])).toThrow();expect(readFileSync(path)).toEqual(original)
  expect(()=>loadVerificationPlans(root,{...owner,ownerId:'other'})).toThrow()
 })
 it('rejects foreign scope, unknown fields, relative commands, duplicate revisions and symlink files',()=>{
  for(const plans of [[{...plan,env:{TOKEN:'private'}}],[{...plan,checks:[{...plan.checks[0],command:'relative'}]}],[plan,plan]])expect(()=>createVerificationPlans(root,owner,plans)).toThrow()
  const outside=join(root,'outside.json');writeFileSync(outside,JSON.stringify({schemaVersion:1,...owner,plans:[plan]}),{mode:0o600});symlinkSync(outside,join(root,'verification-plans.json'))
  expect(()=>loadVerificationPlans(root,owner)).toThrow();expect(readFileSync(outside,'utf8')).toContain('content')
 })
 it('fails closed on public data directories, oversized registries and malformed JSON without echoing data',()=>{
  const publicRoot=join(root,'public');mkdirSync(publicRoot,{mode:0o755});expect(()=>createVerificationPlans(publicRoot,owner,[plan])).toThrow()
  const secret='secret-not-an-error';writeFileSync(join(root,'verification-plans.json'),secret,{mode:0o600})
  try{loadVerificationPlans(root,owner)}catch(error){expect(String(error)).not.toContain(secret)}
  writeFileSync(join(root,'verification-plans.json'),'x'.repeat(512*1024+1));expect(()=>loadVerificationPlans(root,owner)).toThrow()
 })
 it('rejects ancestor symlinks and hard-linked trusted plans',()=>{
  const real=join(root,'real');mkdirSync(real,{mode:0o700})
  const alias=join(root,'alias');symlinkSync(real,alias)
  expect(()=>loadVerificationPlans(alias,owner)).toThrow()
  const {path}=createVerificationPlans(real,owner,[plan]);linkSync(path,join(root,'linked.json'))
  expect(()=>loadVerificationPlans(real,owner)).toThrow()
 })

})
