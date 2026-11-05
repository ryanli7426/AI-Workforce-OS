/** Pure verification request/plan contract shared by storage, worker and trusted plan configuration. */
import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import type { VerificationJobPlan, VerificationJobRequest } from './model.ts'
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
function fail(): never { throw new Error('Invalid verification request') }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
 if(!value || typeof value !== 'object' || Array.isArray(value)) return fail()
 const input=value as Record<string,unknown>
 if(Object.keys(input).length!==keys.length || keys.some(key=>!Object.hasOwn(input,key))) return fail()
 return input
}
function id(value:unknown):string { if(typeof value!=='string'||!ID.test(value)||value==='.'||value==='..')return fail();return value }
function text(value:unknown,maxBytes:number):string {if(typeof value!=='string'||!value.trim()||value.includes('\0')||Buffer.byteLength(value)>maxBytes)return fail();return value}
function integer(value:unknown,min:number,max=Number.MAX_SAFE_INTEGER):number {if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)return fail();return value}
export function parseVerificationPlan(value:unknown):VerificationJobPlan {
 const plan=object(value,['id','revision','checks'])
 if(!Array.isArray(plan.checks)||plan.checks.length<1||plan.checks.length>32)return fail()
 const seen=new Set<string>()
 const checks=plan.checks.map(raw=>{
  const check=object(raw,['id','command','args','timeoutMs']);const checkId=id(check.id)
  if(seen.has(checkId))return fail();seen.add(checkId)
  const command=text(check.command,4096);if(!isAbsolute(command))return fail()
  if(!Array.isArray(check.args)||check.args.length>256)return fail()
  let bytes=0
  const args=check.args.map(arg=>{if(typeof arg!=='string'||arg.includes('\0'))return fail();bytes+=Buffer.byteLength(arg);if(bytes>65536)return fail();return arg})
  return {id:checkId,command:resolve(command),args,timeoutMs:integer(check.timeoutMs,1,3600000)}
 })
 const parsed={id:id(plan.id),revision:id(plan.revision),checks}
 if(Buffer.byteLength(JSON.stringify(parsed))>128*1024)return fail()
 return parsed
}
export function parseVerificationRequest(value:unknown):VerificationJobRequest {
 const input=object(value,['verificationId','workspaceId','ownerId','ticketId','expectedTaskVersion','policyVersion','executionId','artifactId','artifactRevision','plan','reason','createdAt'])
 if(typeof input.artifactRevision!=='string'||!/^[a-f0-9]{64}$/.test(input.artifactRevision))return fail()
 const createdAt=text(input.createdAt,64);if(!Number.isFinite(Date.parse(createdAt))||new Date(createdAt).toISOString()!==createdAt)return fail()
 const request:VerificationJobRequest={verificationId:id(input.verificationId),workspaceId:id(input.workspaceId),ownerId:id(input.ownerId),ticketId:id(input.ticketId),expectedTaskVersion:integer(input.expectedTaskVersion,1),policyVersion:id(input.policyVersion),executionId:id(input.executionId),artifactId:id(input.artifactId),artifactRevision:input.artifactRevision,plan:parseVerificationPlan(input.plan),reason:text(input.reason,4096),createdAt}
 if(Buffer.byteLength(JSON.stringify(request))>128*1024)return fail()
 return request
}
/** JSON values only; canonical key order makes hashes independent of caller insertion order. */
export function verificationCanonicalJson(value:unknown):string {
 const active=new Set<object>()
 const normalize=(item:unknown):unknown=>{
  if(item===null||typeof item==='string'||typeof item==='boolean')return item
  if(typeof item==='number'){if(!Number.isFinite(item))return fail();return Object.is(item,-0)?0:item}
  if(typeof item!=='object'||active.has(item))return fail()
  active.add(item)
  try{
   if(Array.isArray(item))return item.map(normalize)
   return Object.fromEntries(Object.keys(item as Record<string,unknown>).sort().map(key=>[key,normalize((item as Record<string,unknown>)[key])]))
  }finally{active.delete(item)}
 }
 return JSON.stringify(normalize(value))
}
export function verificationRequestSha256(value:unknown):string {return createHash('sha256').update(verificationCanonicalJson(parseVerificationRequest(value))).digest('hex')}
