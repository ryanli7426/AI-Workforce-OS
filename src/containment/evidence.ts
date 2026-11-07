/** Durable private proof binds a successful OS probe to one exact request and Runner. */
import {createHash,createHmac,timingSafeEqual} from 'node:crypto'
import {closeSync,constants,fstatSync,lstatSync,openSync,readSync} from 'node:fs'
import {canonicalLaunchSpec,type RunnerRequest} from '../runner/protocol.ts'
import {validateContainmentEvidence,type ContainmentEvidence} from './policy.ts'

export interface SignedContainmentEvidence {
  version:1
  runnerId:string
  requestSha256:string
  evidence:ContainmentEvidence
  mac:string
}
const requestHash=(request:RunnerRequest)=>createHash('sha256').update(JSON.stringify({version:request.version,spec:canonicalLaunchSpec(request.spec)})).digest('hex')
const payload=(value:Omit<SignedContainmentEvidence,'mac'>)=>JSON.stringify(value)

export function signContainmentEvidence(request:RunnerRequest,runnerId:string,evidence:ContainmentEvidence):SignedContainmentEvidence {
  validateContainmentEvidence(evidence)
  const body={version:1 as const,runnerId,requestSha256:requestHash(request),evidence}
  return {...body,mac:createHmac('sha256',request.token).update(payload(body)).digest('hex')}
}

export function readContainmentEvidence(path:string,request:RunnerRequest,runnerId:string):ContainmentEvidence {
  const before=lstatSync(path)
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1||(before.mode&0o7777)!==0o600||before.size>32768
    ||(typeof process.getuid==='function'&&before.uid!==process.getuid()))throw new Error('Invalid private containment proof')
  const fd=openSync(path,constants.O_RDONLY|(constants.O_NOFOLLOW??0))
  let value:unknown
  try{
    const opened=fstatSync(fd)
    if(opened.dev!==before.dev||opened.ino!==before.ino||opened.size!==before.size||opened.nlink!==1||(opened.mode&0o7777)!==0o600||opened.uid!==before.uid)throw new Error('Containment proof changed')
    const bytes=Buffer.alloc(opened.size);let offset=0
    while(offset<bytes.length){const count=readSync(fd,bytes,offset,bytes.length-offset,offset);if(count===0)throw new Error('Containment proof is incomplete');offset+=count}
    value=JSON.parse(bytes.toString('utf8'))
    const after=fstatSync(fd),final=lstatSync(path)
    if(after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size||after.mtimeMs!==opened.mtimeMs||after.ctimeMs!==opened.ctimeMs
      ||final.isSymbolicLink()||final.dev!==after.dev||final.ino!==after.ino)throw new Error('Containment proof changed')
  }finally{closeSync(fd)}
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid containment proof')
  const row=value as SignedContainmentEvidence
  if(Object.keys(row).length!==5||Object.keys(row).some(key=>!['version','runnerId','requestSha256','evidence','mac'].includes(key))
    ||row.version!==1||row.runnerId!==runnerId||row.requestSha256!==requestHash(request)||typeof row.mac!=='string'||!/^[a-f0-9]{64}$/.test(row.mac))throw new Error('Containment proof identity mismatch')
  validateContainmentEvidence(row.evidence)
  const expected=signContainmentEvidence(request,runnerId,row.evidence)
  if(!timingSafeEqual(Buffer.from(row.mac,'hex'),Buffer.from(expected.mac,'hex')))throw new Error('Containment proof authentication failed')
  return row.evidence
}
