/** Browser + compiled CLI + actual loopback HTTP + SQLite. No Runtime/model/IM invocation. */
import { test, expect } from '@playwright/test'
import { spawn, execFileSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createLocalApiCredentials } from '../../src/api/auth.ts'
import { createSettings, defaultSettings } from '../../src/config/settings.ts'
import { ProjectRepository } from '../../src/projects/projects.ts'
import { initializeApplicationSchema } from '../../src/storage/application-store.ts'
import { LocalStore } from '../../src/storage/store.ts'
import { EmployeeRepository } from '../../src/workforce/employees.ts'
let root: string
let dataDir: string
let api: ChildProcess | undefined
let address: string
let token: string
let output = ''
let diagnostics = ''
const screenshots = resolve('test-results/web')
async function waitUntil<T>(fn: () => T | undefined, ms = 10_000): Promise<T> {
  const deadline = Date.now()+ms
  while(Date.now()<deadline) { const value=fn();if(value!==undefined)return value;await new Promise(r=>setTimeout(r,30)) }
  throw new Error('Owned API did not become ready')
}
test.beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(),'workforce-web-browser-')));chmodSync(root,0o700)
  dataDir=join(root,'data');mkdirSync(dataDir,{mode:0o700})
  const repositoryPath=join(root,'project');mkdirSync(repositoryPath,{mode:0o700})
  const env={PATH:process.env.PATH,HOME:root,LANG:'C',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0'}
  for(const args of [['init'],['config','user.name','Web Acceptance'],['config','user.email','web@example.invalid']]) execFileSync('git',args,{cwd:repositoryPath,env,stdio:'ignore',timeout:10_000})
  writeFileSync(join(repositoryPath,'README.md'),'Browser fixture\n')
  for(const args of [['add','README.md'],['commit','-m','fixture']]) execFileSync('git',args,{cwd:repositoryPath,env,stdio:'ignore',timeout:10_000})
  const store=new LocalStore(join(dataDir,'workforce.sqlite'));initializeApplicationSchema(store)
  const settings=defaultSettings({ownerId:'browser-owner',claudeCommand:'/usr/bin/true'});createSettings(join(dataDir,'settings.json'),settings)
  new ProjectRepository(store.db).create({id:'browser-project',workspaceId:'local',name:'产品文档',ownerId:'browser-owner',repositoryPath,worktreeRoot:join(root,'worktrees'),allowedTaskTypes:['documentation']})
  new EmployeeRepository(store.db).create({id:'browser-writer',workspaceId:'local',name:'文档助手',role:'Technical Writer',responsibilities:['文档维护'],capabilities:['documentation'],runtimeId:'claude-local',projectIds:['browser-project'],maxConcurrency:1,timeoutMs:60_000})
  store.close();createLocalApiCredentials(dataDir)
  token=(JSON.parse(readFileSync(join(dataDir,'api-auth.json'),'utf8')) as {token:string}).token
  api=spawn(process.execPath,[resolve('dist/cli/index.js'),'api-serve','--data-dir',dataDir,'--port','0','--web-root',resolve('web/dist')],{cwd:root,env:{PATH:process.env.PATH,HOME:root,LANG:'C'},stdio:['ignore','pipe','pipe']})
  api.stdout!.on('data',data=>{output+=String(data)});api.stderr!.on('data',data=>{diagnostics+=String(data)})
  address=await waitUntil(()=>{for(const line of output.split('\n')){try{const value=JSON.parse(line) as {listening?:boolean;address?:string};if(value.listening&&value.address)return value.address}catch{ /* incomplete line */ }}return undefined})
})
test.afterAll(async () => {
  if(api && api.exitCode===null && api.signalCode===null) {
    const exited=once(api,'exit');api.kill('SIGTERM')
    let timer:ReturnType<typeof setTimeout>|undefined
    try { await Promise.race([exited,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned API did not stop')),8_000)})]) } finally {clearTimeout(timer)}
  }
  if(root) rmSync(root,{recursive:true,force:true})
})
test('Owner creates, approves and cancels a real persisted task; links, themes and credential boundaries work',async({page})=>{
  const publicPage=await fetch(address)
  expect(publicPage.status).toBe(200)
  expect(publicPage.headers.get('content-security-policy')).toContain("connect-src 'self'")
  expect(publicPage.headers.get('cache-control')).toBe('no-store')
  const html=await publicPage.text()
  const script=html.match(/src="(\/assets\/[^"?]+\.js)"/)
  if(!script?.[1])throw new Error('No production Web asset')
  const publicAsset=await fetch(`${address}${script[1]}`)
  expect(publicAsset.status).toBe(200);expect(publicAsset.headers.get('x-content-type-options')).toBe('nosniff')
  for(const route of ['/api/v1/health','/api/v1/tasks','/api/v1/employees','/api-auth.json']) expect((await fetch(`${address}${route}`)).status).toBe(401)
  const rejectedHost = await new Promise<number>((resolve,reject) => {
    const request = httpRequest(address, {headers:{Host:'attacker.example'},timeout:5_000},response => {response.resume();resolve(response.statusCode ?? 0)})
    request.on('error',reject);request.on('timeout',()=>request.destroy(new Error('Local Host probe timed out')));request.end()
  })
  expect(rejectedHost).toBe(403)
  expect((await fetch(address,{headers:{Origin:'https://attacker.example'}})).status).toBe(403)
  await page.setViewportSize({width:1440,height:1050});await page.goto(address)
  await expect(page.getByRole('heading',{name:'连接工作空间'})).toBeVisible()
  await page.getByLabel('本地访问凭证').fill(token)
  await page.getByRole('button',{name:'连接工作空间',exact:true}).click()
  await expect(page.getByRole('heading',{name:'概览',exact:true})).toBeVisible()
  await expect(page.getByLabel('概览计数')).toContainText('任务总数')
  await page.screenshot({path:join(screenshots,'overview-light.png'),fullPage:true})
  await page.getByRole('button',{name:'切换深色主题'}).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark')
  await page.screenshot({path:join(screenshots,'overview-dark.png'),fullPage:true})
  await page.getByRole('button',{name:'切换浅色主题'}).click()
  const nav=page.getByRole('navigation',{name:'主导航'})
  await nav.getByRole('link',{name:'任务中心'}).click()
  await page.getByLabel('创建项目').selectOption('browser-project')
  await page.getByLabel('任务类型').selectOption('documentation')
  await page.getByLabel('任务标题').fill('准备文档更新')
  await page.getByLabel('任务描述').fill('更新本地隔离项目中的说明；本次浏览器测试不启动 Agent。')
  await page.getByLabel('issueId',{exact:true}).fill('browser-flow-001')
  await page.getByRole('button',{name:'创建任务',exact:true}).click()
  const link=page.getByRole('link',{name:/打开任务 /});await expect(link).toBeVisible()
  const href=await link.getAttribute('href');const id=href!.split('/').at(-1)!
  await link.click()
  await expect(page.getByRole('heading',{name:'准备文档更新',exact:true})).toBeVisible()
  await page.getByRole('button',{name:'批准',exact:true}).click()
  await page.getByLabel('操作原因').fill('批准本次文档范围')
  await page.getByRole('button',{name:'预览确认'}).click()
  await page.getByRole('button',{name:'确认提交'}).click()
  const readTask=async()=>{const response=await fetch(`${address}/api/v1/tasks/${id}`,{headers:{Authorization:`Bearer ${token}`}});return await response.json() as {ticket:{lifecycle:{status:string}};history:{kind:string;decision?:string}[];executions:unknown[]}}
  await expect.poll(async()=>(await readTask()).ticket.lifecycle.status).toBe('QUEUED')
  await page.getByRole('button',{name:'请求取消',exact:true}).click()
  await page.getByLabel('操作原因').fill('结束浏览器验收，不启动执行')
  await page.getByRole('button',{name:'预览确认'}).click();await page.getByRole('button',{name:'确认提交'}).click()
  await expect.poll(async()=>(await readTask()).ticket.lifecycle.status).toBe('CANCELLED')
  const detail=await readTask();expect(detail.executions).toHaveLength(0);expect(detail.history.some(row=>row.kind==='approval'&&row.decision==='approved')).toBe(true)
  await nav.getByRole('link',{name:'AI 员工',exact:true}).click();await expect(page.getByRole('cell',{name:'文档助手',exact:true})).toBeVisible()
  const filtered=page.waitForRequest(request=>request.url().includes('/api/v1/tasks?')&&request.url().includes('employeeId=browser-writer'))
  await page.getByRole('link',{name:'按员工筛选任务'}).click();await filtered
  await expect(page.getByLabel('员工筛选')).toHaveValue('browser-writer')
  await nav.getByRole('link',{name:'项目空间',exact:true}).click();await expect(page.getByRole('cell',{name:'产品文档',exact:true})).toBeVisible()
  const projectFilter=page.waitForRequest(request=>request.url().includes('/api/v1/tasks?')&&request.url().includes('projectId=browser-project'))
  await page.getByRole('link',{name:'按项目筛选任务'}).click();await projectFilter;await expect(page.getByLabel('项目筛选')).toHaveValue('browser-project')
  await page.setViewportSize({width:390,height:844})
  await expect(page.getByRole('button',{name:'创建任务',exact:true})).toBeVisible()
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true)
  const saved=await page.evaluate(()=>JSON.stringify({local:{...localStorage},session:{...sessionStorage},cookie:document.cookie,hash:location.hash}))
  expect(saved.includes(token)).toBe(false)
  await page.screenshot({path:join(screenshots,'tasks-mobile.png'),fullPage:true})
  await page.getByRole('button',{name:'断开连接'}).click();await expect(page.getByRole('heading',{name:'连接工作空间'})).toBeVisible()
  await page.reload();await expect(page.getByRole('heading',{name:'连接工作空间'})).toBeVisible()
  expect((output+diagnostics).includes(token)).toBe(false)
})
