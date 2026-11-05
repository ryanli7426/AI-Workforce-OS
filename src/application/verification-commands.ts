/** Owner-authorized asynchronous verification requests. Commands enqueue facts; no filesystem/process work. */
import { createHash,randomUUID } from 'node:crypto'
import type { Rule } from '../assessor/rules.ts'
import { LocalTaskService } from './tasks.ts'
import type { LocalStore } from '../storage/store.ts'
import { VerificationJobRepository,type VerificationJobListQuery } from '../storage/verification-jobs.ts'
import type { VerificationJob,VerificationJobPlan } from '../verification/model.ts'
import { parseVerificationPlan,parseVerificationRequest,verificationCanonicalJson } from '../verification/request.ts'
export type VerificationCommandErrorCode='INVALID_COMMAND'|'NOT_FOUND'|'VERSION_CONFLICT'|'IDEMPOTENCY_CONFLICT'|'STATE_CONFLICT'
export class VerificationCommandError extends Error {
 constructor(readonly code:VerificationCommandErrorCode){super({INVALID_COMMAND:'Invalid verification command',NOT_FOUND:'Verification resource not found',VERSION_CONFLICT:'Verification version conflict',IDEMPOTENCY_CONFLICT:'Idempotency key conflict',STATE_CONFLICT:'Verification state conflict'}[code]);this.name='VerificationCommandError'}
}
export interface CreateVerificationInput {expectedVersion:number;executionId:string;artifactRevision:string;planId:string;planRevision:string;reason:string}
export interface CancelVerificationInput {expectedVersion:number;reason:string}
export interface VerificationCommandResult {verificationId:string;replayed:boolean}
export interface VerificationCommandsOptions {store:LocalStore;ownerId:string;workspaceId:string;rules:readonly Rule[];plans:readonly VerificationJobPlan[]}
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
function invalid():never{throw new VerificationCommandError('INVALID_COMMAND')}
function id(value:unknown):string{if(typeof value!=='string'||!ID.test(value))return invalid();return value}
function planKey(value:unknown):string{if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))return invalid();return value}
function reason(value:unknown):string{if(typeof value!=='string'||!value.trim()||value.includes('\0')||Buffer.byteLength(value)>4096)return invalid();return value.trim()}
function version(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<1)return invalid();return value}
function object(value:unknown,keys:readonly string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))return invalid();const input=value as Record<string,unknown>;if(Object.keys(input).length!==keys.length||keys.some(key=>!Object.hasOwn(input,key)))return invalid();return input}
function hash(value:unknown){return createHash('sha256').update(verificationCanonicalJson(value)).digest('hex')}
function repositoryError(error:unknown):never{
 if(error instanceof VerificationCommandError)throw error
 const message=error instanceof Error?error.message:''
 if(/already has an active verification|already reserved|cannot be cancelled|can only claim|Invalid verification transition|Conflicting verification receipt|Conflicting verification plan revision/.test(message))throw new VerificationCommandError('STATE_CONFLICT')
 if(message==='Verification version conflict')throw new VerificationCommandError('VERSION_CONFLICT')
 throw new Error('Verification persistence failed')
}
export class LocalVerificationCommands {
 private readonly store:LocalStore
 private readonly ownerId:string
 private readonly workspaceId:string
 private readonly repository:VerificationJobRepository
 private readonly tasks:LocalTaskService
 private readonly registered:VerificationJobPlan[]
 constructor(options:VerificationCommandsOptions){
  this.store=options.store;this.ownerId=id(options.ownerId);this.workspaceId=id(options.workspaceId)
  this.repository=new VerificationJobRepository(this.store.db)
  this.tasks=new LocalTaskService({store:this.store,ownerId:this.ownerId,workspaceId:this.workspaceId,rules:options.rules})
  if(!Array.isArray(options.plans)||options.plans.length>64) invalid()
  this.registered=options.plans.map(parseVerificationPlan)
  const keys=this.registered.map(plan=>JSON.stringify([plan.id,plan.revision]));if(new Set(keys).size!==keys.length) invalid()
 }
 plans():VerificationJobPlan[]{return this.registered.map(parseVerificationPlan)}
 get(verificationId:string):VerificationJob|undefined{
  id(verificationId)
  const job=this.repository.get(verificationId)
  if(!job||job.request.ownerId!==this.ownerId||job.request.workspaceId!==this.workspaceId||!this.tasks.get(job.request.ticketId))return undefined
  return job
 }
 history(verificationId:string){if(!this.get(verificationId))throw new VerificationCommandError('NOT_FOUND');return this.repository.history(verificationId)}
 list(ticketId:string,options:Pick<VerificationJobListQuery,'limit'|'beforeRowid'|'statuses'>={}){
  id(ticketId);if(!this.tasks.get(ticketId))throw new VerificationCommandError('NOT_FOUND')
  return this.repository.list({...options,ownerId:this.ownerId,workspaceId:this.workspaceId,ticketId})
 }
 create(key:string,ticketId:string,value:CreateVerificationInput):VerificationCommandResult{
  id(key);id(ticketId)
  const input=object(value,['expectedVersion','executionId','artifactRevision','planId','planRevision','reason'])
  const normalized:CreateVerificationInput={expectedVersion:version(input.expectedVersion),executionId:id(input.executionId),artifactRevision:typeof input.artifactRevision==='string'&&/^[a-f0-9]{64}$/.test(input.artifactRevision)?input.artifactRevision:invalid(),planId:planKey(input.planId),planRevision:planKey(input.planRevision),reason:reason(input.reason)}
  const receiptKey=`v-${hash(['create',ticketId,key])}`,commandHash=hash({kind:'create',ticketId,...normalized})
  try{return this.store.atomic(()=>{
   const replay=this.replay(receiptKey,commandHash,ticketId,'create');if(replay)return replay
   const ticket=this.tasks.get(ticketId);if(!ticket?.lifecycle)throw new VerificationCommandError('NOT_FOUND')
   const lifecycle=ticket.lifecycle
   if(lifecycle.version!==normalized.expectedVersion)throw new VerificationCommandError('VERSION_CONFLICT')
   if(lifecycle.policyVersion!==this.tasks.currentPolicyVersion)throw new VerificationCommandError('STATE_CONFLICT')
   const result=lifecycle.result
   if(lifecycle.status!=='REVIEW'||!result||result.executionId!==normalized.executionId||result.artifactRevision!==normalized.artifactRevision||result.terminal!=='success'||result.exitCode!==0)throw new VerificationCommandError('STATE_CONFLICT')
   const plan=this.registered.find(item=>item.id===normalized.planId&&item.revision===normalized.planRevision)
   if(!plan)throw new VerificationCommandError('INVALID_COMMAND')
   const now=new Date().toISOString(),verificationId=`v-${randomUUID()}`
   const request=parseVerificationRequest({verificationId,workspaceId:this.workspaceId,ownerId:this.ownerId,ticketId,expectedTaskVersion:lifecycle.version,policyVersion:lifecycle.policyVersion,executionId:result.executionId,artifactId:`artifact-${result.executionId}`,artifactRevision:result.artifactRevision,plan,reason:normalized.reason,createdAt:now})
   this.repository.reserve(request)
   this.repository.insertReceipt({workspaceId:this.workspaceId,ownerId:this.ownerId,key:receiptKey,commandHash,verificationId,resultJson:JSON.stringify({verificationId}),at:now})
   return {verificationId,replayed:false}
  })}catch(error){return repositoryError(error)}
 }
 cancel(key:string,verificationId:string,value:CancelVerificationInput):VerificationCommandResult{
  id(key);id(verificationId);const input=object(value,['expectedVersion','reason'])
  const normalized={expectedVersion:version(input.expectedVersion),reason:reason(input.reason)}
  const receiptKey=`v-${hash(['cancel',verificationId,key])}`,commandHash=hash({kind:'cancel',verificationId,...normalized})
  try{return this.store.atomic(()=>{
   const replay=this.replay(receiptKey,commandHash,verificationId,'cancel');if(replay)return replay
   const job=this.get(verificationId);if(!job)throw new VerificationCommandError('NOT_FOUND')
   const now=new Date().toISOString()
   this.repository.requestCancel(verificationId,{...normalized,actorId:this.ownerId,at:now})
   this.repository.insertReceipt({workspaceId:this.workspaceId,ownerId:this.ownerId,key:receiptKey,commandHash,verificationId,resultJson:JSON.stringify({verificationId}),at:now})
   return {verificationId,replayed:false}
  })}catch(error){return repositoryError(error)}
 }
 private replay(key:string,commandHash:string,target:string,kind:'create'|'cancel'):VerificationCommandResult|undefined{
  const receipt=this.repository.getReceipt({workspaceId:this.workspaceId,ownerId:this.ownerId,key})
  if(!receipt)return undefined
  if(receipt.commandHash!==commandHash)throw new VerificationCommandError('IDEMPOTENCY_CONFLICT')
  let parsed:unknown;try{parsed=JSON.parse(receipt.resultJson)}catch{throw new Error('Corrupt verification receipt')}
  if(!parsed||typeof parsed!=='object'||Array.isArray(parsed)||Object.keys(parsed).length!==1||!('verificationId' in parsed)||parsed.verificationId!==receipt.verificationId)throw new Error('Corrupt verification receipt')
  const job=this.get(receipt.verificationId)
  if(!job||(kind==='create'?job.request.ticketId!==target:job.request.verificationId!==target))throw new Error('Corrupt verification receipt')
  return {verificationId:receipt.verificationId,replayed:true}
 }
}
