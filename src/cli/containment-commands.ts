/** Explicit no-model OS probe. Does not open databases or read Runtime authentication. */
import {mkdtempSync,mkdirSync,realpathSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {prepareContainment} from '../containment/srt.ts'
import type {ContainmentRequirement} from '../containment/policy.ts'

export async function runContainmentCommand(argv:readonly string[],io:{stdout:{write(value:string):unknown};stderr:{write(value:string):unknown}}=process):Promise<number|undefined>{
  if(argv[0]!=='containment-probe')return undefined
  const readOnlyPaths:string[]=[]
  for(let index=1;index<argv.length;index++){
    if(argv[index]!=='--read-path'||!argv[index+1]||argv[index+1]!.startsWith('-')){
      io.stderr.write('Error: containment-probe accepts repeated --read-path ABSOLUTE_PATH only\n');return 1
    }
    readOnlyPaths.push(argv[++index]!)
  }
  let root:string|undefined,uncertain=false
  try{
    const requirement:ContainmentRequirement={version:1,mode:'required',provider:'srt-macos',readOnlyPaths,allowedDomains:[]}
    root=realpathSync(mkdtempSync(join(tmpdir(),'workforce-containment-doctor-')))
    const cwd=join(root,'work');mkdirSync(cwd,{mode:0o700})
    const prepared=await prepareContainment(cwd,requirement)
    const evidence=prepared.evidence
    await prepared.close()
    io.stdout.write(JSON.stringify({available:true,evidence})+'\n')
    return 0
  }catch(error){
    uncertain=!!error&&typeof error==='object'&&'code' in error&&error.code==='CONTAINMENT_UNKNOWN'
    io.stdout.write(JSON.stringify({available:false,code:'CONTAINMENT_UNAVAILABLE',targetLaunched:false})+'\n');return 1
  }finally{if(root&&!uncertain)rmSync(root,{recursive:true,force:true})}
}
