import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {afterEach,beforeEach,expect,it} from 'vitest'
import {prepareContainment,type PreparedContainment} from '../src/containment/srt.ts'
import {validateContainmentRequirement,type ContainmentRequirement} from '../src/containment/policy.ts'
import {canonicalLaunchSpec,type LaunchSpec} from '../src/runner/protocol.ts'

let root:string,cwd:string,prepared:PreparedContainment|undefined
const libraries=existsSync('/opt/homebrew/Cellar')?['/opt/homebrew/Cellar']:[]
const policy=():ContainmentRequirement=>({version:1,mode:'required',provider:'srt-macos',readOnlyPaths:libraries,allowedDomains:[]})
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'containment-spec-')));cwd=join(root,'work');mkdirSync(cwd,{mode:0o700})})
afterEach(async()=>{await prepared?.close();prepared=undefined;rmSync(root,{recursive:true,force:true})})

it('rejects malformed policy, broad root, credential fields, URLs and wildcard network grants',()=>{
  for(const value of [{...policy(),mode:'optional'},{...policy(),readOnlyPaths:['/']},{...policy(),token:'must-not-be-accepted'},{...policy(),allowedDomains:['https://host.example']},{...policy(),allowedDomains:['*.example.com']},...['localhost','127.0.0.1','127.1','169.254.169.254','10.0.0.1','service.local','service.internal'].map(domain=>({...policy(),allowedDomains:[domain]}))])expect(()=>validateContainmentRequirement(value)).toThrow()
})

it('canonical launch identity includes an independent copy of the required policy',()=>{
  const spec:LaunchSpec={executionId:'e1',assignmentId:'a1',ticketId:'t1',generation:1,command:process.execPath,args:['-e',''],cwd,timeoutMs:1000,maxOutputBytes:4096,graceMs:1000,containment:policy()}
  const snapshot=canonicalLaunchSpec(spec)
  spec.containment!.allowedDomains.push('example.com')
  expect(snapshot.containment!.allowedDomains).toEqual([])
  expect(JSON.stringify(snapshot)).not.toBe(JSON.stringify(canonicalLaunchSpec(spec)))
})

if(process.platform==='darwin'){
  it('uses real OS denials for outside/sibling/symlink/descendant access before returning proof',async()=>{
    prepared=await prepareContainment(cwd,policy())
    expect(prepared.evidence).toMatchObject({version:1,provider:'srt-macos',providerVersion:'0.0.81',checks:'passed'})
    expect(prepared.evidence.policySha256).toMatch(/^[a-f0-9]{64}$/)
    const sentinel=join(root,'sentinel');writeFileSync(sentinel,'owned outside value')
    const fileName="literal-$(touch UNEXPECTED)-'quoted'"
    const code=`const fs=require('node:fs');fs.writeFileSync(process.argv[1],'inside');try{fs.readFileSync(process.argv[2]);process.exit(9)}catch(e){if(!['EPERM','EACCES','ENOENT'].includes(e.code))process.exit(8)};process.stdout.write('guarded')`
    const wrapped=await prepared.wrap(process.execPath,['-e',code,fileName,sentinel])
    const result=spawnSync(wrapped.command,wrapped.args,{cwd,env:{PATH:'/usr/bin:/bin',HOME:root,TMPDIR:prepared.tempDir},timeout:5000,encoding:'utf8',maxBuffer:8192})
    expect(result.status).toBe(0);expect(result.stdout).toBe('guarded')
    expect(readFileSync(join(cwd,fileName),'utf8')).toBe('inside')
    expect(existsSync(join(cwd,'UNEXPECTED'))).toBe(false)
    expect(readFileSync(sentinel,'utf8')).toBe('owned outside value')
  })

  it('fails closed if explicit read exceptions expose the outside probe area',async()=>{
    await expect(prepareContainment(cwd,{...policy(),readOnlyPaths:[...libraries,realpathSync(tmpdir())]})).rejects.toThrow(/overlaps|could not be established/)
  })

  it('enforces single dedicated ownership and no wrapping after close',async()=>{
    prepared=await prepareContainment(cwd,policy())
    await expect(prepareContainment(cwd,policy())).rejects.toThrow('dedicated Runner')
    await prepared.close()
    await expect(prepared.wrap(process.execPath,[])).rejects.toThrow('closed')
  })

  it('honors abort before performing any target preparation',async()=>{
    const controller=new AbortController();controller.abort()
    await expect(prepareContainment(cwd,policy(),controller.signal)).rejects.toThrow('interrupted')
  })
}else{
  it('reports required macOS provider as unavailable on other platforms',async()=>{
    await expect(prepareContainment(cwd,policy())).rejects.toThrow('unavailable')
  })
}
