import {randomBytes,randomUUID} from 'node:crypto'
import {chmodSync,linkSync,mkdtempSync,rmSync,symlinkSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,beforeEach,describe,expect,it} from 'vitest'
import {readContainmentEvidence,signContainmentEvidence,type SignedContainmentEvidence} from '../src/containment/evidence.ts'
import {validateContainmentEvidence,type ContainmentEvidence} from '../src/containment/policy.ts'
import {canonicalLaunchSpec,type RunnerRequest} from '../src/runner/protocol.ts'

describe('signed containment evidence',()=>{
  let root:string

  beforeEach(()=>{
    root=mkdtempSync(join(tmpdir(),'containment-evidence-'))
    chmodSync(root,0o700)
  })
  afterEach(()=>rmSync(root,{recursive:true,force:true}))

  const token=()=>randomBytes(32).toString('hex')
  const evidence=():ContainmentEvidence=>({
    version:1,provider:'srt-macos',providerVersion:'0.0.81',policySha256:randomBytes(32).toString('hex'),
    worktreeDevice:1,worktreeInode:1,verifiedAt:'2026-11-07T00:00:00.000Z',checks:'passed',
  })
  const request=(executionId='proof-request',requestToken=token()):RunnerRequest=>({
    version:2,token:requestToken,spec:canonicalLaunchSpec({
      executionId,assignmentId:`assignment-${executionId}`,ticketId:`ticket-${executionId}`,generation:1,
      command:process.execPath,args:['--version'],cwd:root,timeoutMs:1000,maxOutputBytes:4096,graceMs:1000,
      containment:{version:1,mode:'required',provider:'srt-macos',readOnlyPaths:[],allowedDomains:[]},
    }),
  })
  const writeProof=(name:string,proof:unknown):string=>{
    const path=join(root,name)
    writeFileSync(path,JSON.stringify(proof),{mode:0o600})
    return path
  }

  it('accepts a valid signed proof only for its exact canonical RunnerRequest v2 and Runner',()=>{
    const input=request(),runnerId=randomUUID(),expected=evidence()
    validateContainmentEvidence(expected)
    const path=writeProof('valid.json',signContainmentEvidence(input,runnerId,expected))

    expect(readContainmentEvidence(path,input,runnerId)).toEqual(expected)
  })

  it('rejects the wrong token, Runner ID, changed containment, and a proof replayed for another request',()=>{
    const requestToken=token(),input=request('original',requestToken),runnerId=randomUUID()
    const path=writeProof('bound.json',signContainmentEvidence(input,runnerId,evidence()))
    const changedContainment:RunnerRequest={...input,spec:canonicalLaunchSpec({
      ...input.spec,
      containment:{...input.spec.containment!,allowedDomains:['example.com']},
    })}
    const replayTarget=request('different-execution',requestToken)

    expect(()=>readContainmentEvidence(path,{...input,token:token()},runnerId)).toThrow()
    expect(()=>readContainmentEvidence(path,input,randomUUID())).toThrow()
    expect(()=>readContainmentEvidence(path,changedContainment,runnerId)).toThrow()
    expect(()=>readContainmentEvidence(path,replayTarget,runnerId)).toThrow()
  })

  it('rejects authenticated-shape evidence whose contents were tampered after signing',()=>{
    const input=request(),runnerId=randomUUID()
    const proof=signContainmentEvidence(input,runnerId,evidence())
    const tampered:SignedContainmentEvidence={...proof,evidence:{...proof.evidence,policySha256:randomBytes(32).toString('hex')}}
    const path=writeProof('tampered.json',tampered)

    expect(()=>readContainmentEvidence(path,input,runnerId)).toThrow()
  })

  it('fails closed for non-private modes, hard links, symlinks, malformed, oversized, and incomplete proofs',()=>{
    const input=request(),runnerId=randomUUID(),proof=signContainmentEvidence(input,runnerId,evidence())

    const publicPath=writeProof('public.json',proof);chmodSync(publicPath,0o644)
    expect(()=>readContainmentEvidence(publicPath,input,runnerId)).toThrow()

    const linkedPath=writeProof('linked.json',proof);linkSync(linkedPath,join(root,'hard-link.json'))
    expect(()=>readContainmentEvidence(linkedPath,input,runnerId)).toThrow()

    const targetPath=writeProof('target.json',proof),symlinkPath=join(root,'symbolic-link.json')
    symlinkSync(targetPath,symlinkPath)
    expect(()=>readContainmentEvidence(symlinkPath,input,runnerId)).toThrow()

    const malformedPath=join(root,'malformed.json');writeFileSync(malformedPath,'{',{mode:0o600})
    expect(()=>readContainmentEvidence(malformedPath,input,runnerId)).toThrow()

    const oversizedPath=join(root,'oversized.json');writeFileSync(oversizedPath,'x'.repeat(32769),{mode:0o600})
    expect(()=>readContainmentEvidence(oversizedPath,input,runnerId)).toThrow()

    const {mac:_mac,...incomplete}=proof
    expect(()=>readContainmentEvidence(writeProof('incomplete.json',incomplete),input,runnerId)).toThrow()
  })

  it('refuses malformed evidence before a proof can be signed',()=>{
    const invalid={...evidence(),checks:'failed'}
    expect(()=>signContainmentEvidence(request(),randomUUID(),invalid as unknown as ContainmentEvidence)).toThrow()
  })
})
