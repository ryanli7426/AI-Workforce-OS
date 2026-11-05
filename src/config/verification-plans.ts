/** Explicit private local verification-plan registry. Loading is read-only and missing means no plans. */
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { assertVerificationPrivateDir,fsyncVerificationDirectory,readVerificationPrivateFile,writeVerificationExclusiveJson } from '../verification/protocol.ts'
import { parseVerificationPlan } from '../verification/request.ts'
import type { VerificationJobPlan } from '../verification/model.ts'
export interface VerificationPlanScope {ownerId:string;workspaceId:string}
const MAX_BYTES=512*1024
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
function fail():never {throw new Error('Invalid private verification plan configuration')}
function scope(input:VerificationPlanScope){if(!input||typeof input.ownerId!=='string'||typeof input.workspaceId!=='string'||!ID.test(input.ownerId)||!ID.test(input.workspaceId))fail();return {ownerId:input.ownerId,workspaceId:input.workspaceId}}
function dataDirectory(dataDir:string):string {return assertVerificationPrivateDir(dataDir,'verification plan directory')}
function parse(value:unknown,principal:VerificationPlanScope):VerificationJobPlan[]{
 if(!value||typeof value!=='object'||Array.isArray(value))return fail()
 const input=value as Record<string,unknown>
 if(Object.keys(input).length!==4||input.schemaVersion!==1||input.ownerId!==principal.ownerId||input.workspaceId!==principal.workspaceId||!Array.isArray(input.plans)||input.plans.length>64)return fail()
 const seen=new Set<string>();return input.plans.map(raw=>{const plan=parseVerificationPlan(raw);const key=JSON.stringify([plan.id,plan.revision]);if(seen.has(key))return fail();seen.add(key);return plan})
}
export function loadVerificationPlans(dataDir:string,principal:VerificationPlanScope):VerificationJobPlan[]{
 try{
  const owner=scope(principal),canonical=dataDirectory(dataDir),path=join(canonical,'verification-plans.json')
  try{lstatSync(path)}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw error}
  return parse(JSON.parse(readVerificationPrivateFile(path,MAX_BYTES,'verification plans').toString('utf8')),owner)
 }catch{return fail()}
}
export function createVerificationPlans(dataDir:string,principal:VerificationPlanScope,plans:unknown):{path:string}{
 try{
  const owner=scope(principal),canonical=dataDirectory(dataDir)
  const registry={schemaVersion:1,...owner,plans};const validated=parse(registry,owner)
  const path=join(canonical,'verification-plans.json')
  writeVerificationExclusiveJson(path,{...registry,plans:validated},MAX_BYTES)
  fsyncVerificationDirectory(canonical)
  return {path}
 }catch{return fail()}
}
