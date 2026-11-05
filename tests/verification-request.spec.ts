import { describe, expect,it } from 'vitest'
import { parseVerificationPlan,parseVerificationRequest,verificationRequestSha256,verificationCanonicalJson } from '../src/verification/request.ts'
function request(){return {verificationId:'verify-1',workspaceId:'local',ownerId:'owner',ticketId:'ticket-1',expectedTaskVersion:2,policyVersion:'policy-1',executionId:'exec-1',artifactId:'artifact-exec-1',artifactRevision:'a'.repeat(64),plan:{id:'docs',revision:'v1',checks:[{id:'check-1',command:'/usr/bin/true',args:[] as string[],timeoutMs:1000}]},reason:'Approved local check',createdAt:'2026-11-05T00:00:00.000Z'}}
describe('shared verification contracts',()=>{
 it('clones the immutable normalized request and hashes canonical values',()=>{
  const value=request();const parsed=parseVerificationRequest(value);const hash=verificationRequestSha256(value)
  expect(verificationRequestSha256(Object.fromEntries(Object.entries(value).reverse()))).toBe(hash)
  value.plan.checks[0]!.args.push('changed');expect(parsed.plan.checks[0]!.args).toEqual([]);expect(verificationRequestSha256(value)).not.toBe(hash)
 })
 it('rejects secret fields, malformed identities, unbounded or arbitrary plans with static errors',()=>{
  const secret='b'.repeat(64)
  for(const value of [{...request(),[secret]:secret},{...request(),expectedTaskVersion:0},{...request(),artifactRevision:'not-hash'},{...request(),createdAt:'today'},{...request(),plan:{...request().plan,checks:[]}},{...request(),plan:{...request().plan,env:{TOKEN:secret}}}]) {
   expect(()=>parseVerificationRequest(value)).toThrow('Invalid verification request')
   try{parseVerificationRequest(value)}catch(error){expect(String(error)).not.toContain(secret)}
  }
  for(const check of [{id:'check-1',command:'relative',args:[],timeoutMs:1},{id:'check-1',command:'/usr/bin/true',args:['x'.repeat(65537)],timeoutMs:1},{id:'check-1',command:'/usr/bin/true',args:[],timeoutMs:3600001}]) expect(()=>parseVerificationPlan({id:'plan',revision:'v1',checks:[check]})).toThrow()
 })
 it('rejects cycles and non-JSON canonical inputs but allows shared values without cycles',()=>{
  const repeated={same:'value'};expect(verificationCanonicalJson({b:repeated,a:repeated})).toBe('{"a":{"same":"value"},"b":{"same":"value"}}')
  const cyclic:Record<string,unknown>={};cyclic.self=cyclic
  expect(()=>verificationCanonicalJson(cyclic)).toThrow();expect(()=>verificationCanonicalJson({value:undefined})).toThrow()
 })
})
