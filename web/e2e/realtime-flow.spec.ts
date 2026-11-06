/** Production browser + compiled API/CLI: external writes, restart replay and draft preservation. */
import {test,expect} from '@playwright/test'
import {execFileSync} from 'node:child_process'
import {writeFileSync} from 'node:fs'
import {dirname,join,resolve} from 'node:path'
import {localWorkspace} from './local-workspace.ts'

test('external CLI changes refresh the page and reconnect preserves both the cursor and an editing draft',async({page})=>{
  const fixture=await localWorkspace()
  const createEmployee=(id:string,name:string)=>{
    const file=join(dirname(fixture.dataDir),id+'.json')
    writeFileSync(file,JSON.stringify({id,name,role:'writer',responsibilities:['Docs'],capabilities:['documentation'],runtimeId:'claude-local',projectIds:[],maxConcurrency:1,timeoutMs:60000}),{mode:0o600})
    execFileSync(process.execPath,[resolve('dist/cli/index.js'),'employee-create','--data-dir',fixture.dataDir,'--file',file],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000})
  }
  try{
    await page.goto(fixture.address)
    await page.getByLabel('本地访问凭证').fill(fixture.token)
    await page.getByRole('button',{name:'连接工作空间',exact:true}).click()
    await expect(page.getByRole('heading',{name:'概览',exact:true})).toBeVisible()
    await expect(page.getByText('实时更新已连接',{exact:true})).toBeVisible()
    await page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'AI 员工',exact:true}).click()
    await expect(page.getByRole('heading',{name:'AI 员工管理',exact:true})).toBeVisible()
    createEmployee('external-first','外部创建员工一')
    // Normal page polling is 5s; this update must arrive via the live change feed first.
    await expect(page.getByRole('cell',{name:'外部创建员工一',exact:true})).toBeVisible({timeout:2000})
    await page.getByRole('button',{name:'编辑员工 外部创建员工一',exact:true}).click()
    await page.getByLabel('员工名称',{exact:true}).fill('尚未提交的编辑草稿')
    await fixture.stop({preserveData:true})
    createEmployee('external-offline','离线期间创建员工二')
    const resumed=page.waitForRequest(request=>request.url().endsWith('/api/v1/events')&&typeof request.headers()['last-event-id']==='string')
    await fixture.restart()
    await resumed
    await expect(page.getByText('实时更新已连接',{exact:true})).toBeVisible({timeout:10000})
    await expect(page.getByRole('cell',{name:'离线期间创建员工二',exact:true})).toBeVisible()
    await expect(page.getByLabel('员工名称',{exact:true})).toHaveValue('尚未提交的编辑草稿')
    expect(fixture.credentialAbsentFromOutput()).toBe(true)
    await page.screenshot({path:resolve('test-results/web/realtime-reconnected.png'),fullPage:true})
    await page.setViewportSize({width:390,height:844})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  }finally{await fixture.stop()}
})
