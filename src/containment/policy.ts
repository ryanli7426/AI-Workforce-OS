/** Declarative, non-secret requirements; no IO and no model/Runtime dependency. */
import {isIP} from 'node:net'
import { isAbsolute } from 'node:path'

export interface ContainmentRequirement {
  version: 1
  mode: 'required'
  provider: 'srt-macos'
  /** Explicit trusted read exceptions for executables/libraries; never write roots. */
  readOnlyPaths: string[]
  allowedDomains: string[]
}

export interface ContainmentEvidence {
  version: 1
  provider: 'srt-macos'
  providerVersion: '0.0.81'
  policySha256: string
  worktreeDevice: number
  worktreeInode: number
  verifiedAt: string
  checks: 'passed'
}

export function validateContainmentRequirement(value: unknown): asserts value is ContainmentRequirement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid containment requirement')
  const row=value as Record<string,unknown>
  const fields=['version','mode','provider','readOnlyPaths','allowedDomains']
  if(Object.keys(row).length!==fields.length || Object.keys(row).some(key=>!fields.includes(key))
    ||row.version!==1||row.mode!=='required'||row.provider!=='srt-macos'
    ||!Array.isArray(row.readOnlyPaths)||row.readOnlyPaths.length>64
    ||row.readOnlyPaths.some(path=>typeof path!=='string'||!isAbsolute(path)||path==='/'||path.length>4096||/[\x00-\x1f\x7f]/.test(path))
    ||!Array.isArray(row.allowedDomains)||row.allowedDomains.length>32
    ||row.allowedDomains.some(domain=>typeof domain!=='string'||domain.length>253||!domain.includes('.')||isIP(domain)!==0
      ||domain.split('.').some(label=>label.length>63)||!/[a-z]{2,63}$/.test(domain.split('.').at(-1)!)||/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(domain)||! /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(domain))) {
    throw new Error('Invalid containment requirement')
  }
  if(new Set(row.readOnlyPaths).size!==row.readOnlyPaths.length||new Set(row.allowedDomains).size!==row.allowedDomains.length)throw new Error('Duplicate containment policy entry')
}

export function cloneContainment(value: ContainmentRequirement): ContainmentRequirement {
  validateContainmentRequirement(value)
  return {version:1,mode:'required',provider:'srt-macos',readOnlyPaths:[...value.readOnlyPaths],allowedDomains:[...value.allowedDomains]}
}

export function validateContainmentEvidence(value:unknown):asserts value is ContainmentEvidence {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid containment evidence')
  const row=value as Record<string,unknown>,keys=['version','provider','providerVersion','policySha256','worktreeDevice','worktreeInode','verifiedAt','checks']
  if(Object.keys(row).length!==keys.length||Object.keys(row).some(key=>!keys.includes(key))||row.version!==1||row.provider!=='srt-macos'||row.providerVersion!=='0.0.81'
    ||typeof row.policySha256!=='string'||!/^[a-f0-9]{64}$/.test(row.policySha256)
    ||!Number.isSafeInteger(row.worktreeDevice)||(row.worktreeDevice as number)<0||!Number.isSafeInteger(row.worktreeInode)||(row.worktreeInode as number)<1
    ||typeof row.verifiedAt!=='string'||!Number.isFinite(Date.parse(row.verifiedAt))||new Date(row.verifiedAt).toISOString()!==row.verifiedAt||row.checks!=='passed')throw new Error('Invalid containment evidence')
}
