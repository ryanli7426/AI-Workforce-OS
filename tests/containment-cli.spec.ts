import {execFileSync,spawnSync} from 'node:child_process'
import {existsSync,mkdtempSync,realpathSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {afterEach,beforeEach,expect,it} from 'vitest'

let root:string
const cli=resolve('dist/cli/index.js')
beforeEach(()=>{root=realpathSync(mkdtempSync(join(tmpdir(),'containment-cli-')))})
afterEach(()=>rmSync(root,{recursive:true,force:true}))

it('rejects unknown and invalid policy options without creating an application database',()=>{
  for(const args of [['--allow-dangerous'],['--read-path'],['--read-path','/']]){
    const result=spawnSync(process.execPath,[cli,'containment-probe',...args],{cwd:root,encoding:'utf8',timeout:12000,env:{PATH:process.env.PATH,HOME:root,LANG:'C'}})
    expect(result.status).toBe(1)
    expect(result.stdout+result.stderr).not.toContain('owned-sensitive-fixture')
  }
  expect(existsSync(join(root,'.workforce'))).toBe(false)
})

if(process.platform==='darwin'){
  it('runs the compiled explicit OS probe without a database or any model authentication',()=>{
    const args=existsSync('/opt/homebrew/Cellar')?['--read-path','/opt/homebrew/Cellar']:[]
    const stdout=execFileSync(process.execPath,[cli,'containment-probe',...args],{cwd:root,encoding:'utf8',timeout:15000,env:{PATH:process.env.PATH,HOME:root,LANG:'C'}})
    const result=JSON.parse(stdout)
    expect(result).toMatchObject({available:true,evidence:{provider:'srt-macos',providerVersion:'0.0.81',checks:'passed'}})
    expect(stdout).not.toContain(root)
    expect(existsSync(join(root,'.workforce'))).toBe(false)
  },20000)
}
