/** Actual browser → authenticated API → controller → compiled detached verifier → human review. */
import { test, expect } from '@playwright/test'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalTaskService } from '../../src/application/tasks.ts'
import { ArtifactStore } from '../../src/artifacts/snapshots.ts'
import { loadSettings } from '../../src/config/settings.ts'
import { createVerificationPlans } from '../../src/config/verification-plans.ts'
import { ProjectRepository } from '../../src/projects/projects.ts'
import { LocalStore } from '../../src/storage/store.ts'
import { VerificationJobRepository } from '../../src/storage/verification-jobs.ts'
import { VerificationRunnerClient } from '../../src/verification/client.ts'
import { localWorkspace } from './local-workspace.ts'

async function stopController(child: ChildProcess): Promise<void> {
  if(child.exitCode !== null || child.signalCode !== null) return
  const exited=once(child,'exit')
  child.kill('SIGTERM')
  let timer:ReturnType<typeof setTimeout>|undefined
  try {await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned verifier controller did not stop')),8000)})])}
  finally {clearTimeout(timer)}
}

test('Owner enqueues trusted verification, observes a real check, then explicitly accepts only that artifact',async({page})=>{
  let ticketId='',executionId='',artifactRevision=''
  const fixture=await localWorkspace(async({root,dataDir,repositoryPath})=>{
    const store=new LocalStore(join(dataDir,'workforce.sqlite'))
    try {
      const settings=loadSettings(join(dataDir,'settings.json'))
      new ProjectRepository(store.db).create({id:'verification-project',workspaceId:'local',name:'验证验收项目',ownerId:settings.ownerId,
        repositoryPath,worktreeRoot:join(root,'worktrees'),allowedTaskTypes:['documentation']})
      const tasks=new LocalTaskService({store,ownerId:settings.ownerId,workspaceId:'local',rules:settings.rules})
      const created=tasks.create({issueId:'verification-browser-fixture',projectId:'verification-project',title:'验证交付产物',description:'自有测试 fixture，准备 REVIEW 后执行真实独立检查。',taskType:'documentation'})
      ticketId=created.id
      tasks.approve(ticketId,'Fixture execution authorization')
      const assigned=tasks.engine.assignTask(ticketId,'fixture-worker','fixture',join(root,'fixture-work'))
      const assignmentId=assigned.assignments.at(-1)!.id
      tasks.engine.assignmentStarted(ticketId,assignmentId)
      executionId='browser-verification-execution'
      const baseRevision=execFileSync('git',['rev-parse','HEAD'],{cwd:repositoryPath,encoding:'utf8',timeout:5000}).trim()
      const manifest=await new ArtifactStore({root:join(dataDir,'artifacts')}).capture({artifactId:`artifact-${executionId}`,executionId,cwd:repositoryPath,baseRevision})
      artifactRevision=manifest.revision
      tasks.engine.recordExecution(ticketId,{executionId,assignmentId,artifactRevision,exitCode:0,terminal:'success',summary:'Deterministic owned REVIEW fixture; no model execution claimed'})
      createVerificationPlans(dataDir,{ownerId:settings.ownerId,workspaceId:'local'},[{id:'artifact.content',revision:'r1.0',checks:[{
        id:'readme.content',command:process.execPath,args:['-e',"const fs=require('node:fs');if(!fs.readFileSync('README.md','utf8').includes('fixture'))process.exit(9)"],timeoutMs:5000,
      }]}])
    } finally {store.close()}
  })
  let controller:ChildProcess|undefined
  let preserveData=false
  try {
    await page.goto(fixture.address)
    await page.getByLabel('本地访问凭证').fill(fixture.token)
    await page.getByRole('button',{name:'连接工作空间',exact:true}).click()
    await expect(page.getByRole('heading',{name:'概览',exact:true})).toBeVisible()
    await page.evaluate(id=>{location.hash=`#/tasks/${id}`},ticketId)
    const verification=page.getByRole('region',{name:'异步验证',exact:true})
    await expect(page.getByRole('heading',{name:'验证交付产物',exact:true})).toBeVisible()
    await expect(page.getByRole('button',{name:'审核通过',exact:true})).toBeDisabled()
    await verification.getByLabel('可信验证计划').selectOption('artifact.content::r1.0')
    await verification.getByLabel('验证原因').fill('独立检查本次交付的 README 内容')
    await verification.getByRole('button',{name:'预览确认',exact:true}).click()
    await expect(verification.getByRole('region',{name:'验证入队确认预览'})).toContainText(artifactRevision)
    const accepted=page.waitForResponse(response=>response.url().endsWith(`/api/v1/tasks/${ticketId}/verifications`)&&response.request().method()==='POST')
    await verification.getByRole('button',{name:'确认入队',exact:true}).click()
    expect((await accepted).status()).toBe(202)
    await expect(verification.getByText('QUEUED',{exact:true})).toBeVisible()
    controller=spawn(process.execPath,[resolve('dist/cli/index.js'),'start','--foreground','--data-dir',fixture.dataDir],{
      env:{PATH:process.env.PATH,LANG:'C',HOME:fixture.dataDir},stdio:['ignore','pipe','pipe'],
    })
    await expect(verification.getByRole('cell',{name:'passed',exact:true})).toBeVisible({timeout:15000})
    await expect(verification.getByRole('cell',{name:'已应用',exact:true})).toBeVisible()
    await expect(page.getByRole('button',{name:'审核通过',exact:true})).toBeEnabled()
    const read=async()=>await fixture.request(`/tasks/${ticketId}`) as {ticket:{assignments:unknown[];lifecycle:{status:string;result:{verification:string;artifactRevision:string}}};history:{verificationProvenance?:{verificationId:string;reportSha256:string}}[];executions:unknown[]}
    const reviewed=await read()
    expect(reviewed.ticket.lifecycle.status).toBe('REVIEW')
    expect(reviewed.ticket.lifecycle.result).toMatchObject({verification:'passed',artifactRevision})
    expect(reviewed.executions).toHaveLength(0)
    expect(reviewed.ticket.assignments).toHaveLength(1)
    expect(reviewed.history.some(item=>item.verificationProvenance?.reportSha256.length===64)).toBe(true)
    await page.screenshot({path:resolve('test-results/web/verification-reviewed.png'),fullPage:true})
    await page.getByRole('button',{name:'审核通过',exact:true}).click()
    await page.getByLabel('操作原因').fill('明确接受已独立验证的自有测试产物')
    await page.getByRole('region',{name:'任务操作'}).getByRole('button',{name:'预览确认',exact:true}).click()
    await page.getByRole('button',{name:'确认提交',exact:true}).click()
    await expect.poll(async()=>(await read()).ticket.lifecycle.status).toBe('DONE')
    const saved=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage},cookie:document.cookie,hash:location.hash}))
    expect(saved).not.toContain(fixture.token)
    expect(fixture.credentialAbsentFromOutput()).toBe(true)
    expect(executionId).toBe('browser-verification-execution')
  } finally {
    if(controller)await stopController(controller)
    // Query only this owned fixture; stop via the authenticated channel and require signed terminal proof.
    const db=new DatabaseSync(join(fixture.dataDir,'workforce.sqlite'),{readOnly:true})
    try {
      const jobs=new VerificationJobRepository(db).list({ownerId:'browser-owner',workspaceId:'local'}).items
      const client=new VerificationRunnerClient({dataDir:fixture.dataDir})
      for(const job of jobs){
        if(job.status==='QUEUED'||job.status==='CANCELLED'&&job.lastSequence===0)continue
        try {
          await client.stop(job.request.verificationId,'Owned browser verification cleanup')
          const deadline=Date.now()+10000
          for(;;){try{await client.collect(job.request);break}catch{if(Date.now()>=deadline)throw new Error('Owned verification stop unconfirmed');await new Promise(resolve=>setTimeout(resolve,50))}}
        }catch{preserveData=true}
      }
    }finally{db.close();await fixture.stop({preserveData})}
    if(preserveData)throw new Error('Verification fixture stop unconfirmed; preserving private evidence')
  }
})
