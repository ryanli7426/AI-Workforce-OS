import {test,expect} from '@playwright/test'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {localWorkspace} from './local-workspace.ts'

test('Runtime registry shows actual configuration and unsupported capabilities without starting execution',async({page})=>{
  const fixture=await localWorkspace()
  try{
    await page.goto(fixture.address)
    await page.getByLabel('本地访问凭证').fill(fixture.token)
    await page.getByRole('button',{name:'连接工作空间',exact:true}).click()
    await expect(page.getByRole('heading',{name:'概览',exact:true})).toBeVisible()
    await page.getByRole('navigation',{name:'主导航'}).getByRole('link',{name:'Runtime 注册',exact:true}).click()
    await expect(page.getByRole('heading',{name:'Runtime 注册',exact:true})).toBeVisible()
    await expect(page.getByRole('heading',{name:'Claude Code CLI',exact:true})).toBeVisible()
    await expect(page.getByText('已配置',{exact:true})).toBeVisible()
    await expect(page.getByText('尚未检查',{exact:true})).toBeVisible()
    await expect(page.getByRole('row',{name:'文件系统隔离 不支持'})).toBeVisible()
    await expect(page.getByRole('row',{name:'执行中追加输入 不支持'})).toBeVisible()
    await page.getByRole('button',{name:'刷新',exact:true}).click()
    const catalog=await fixture.request('/runtimes')
    const cli=JSON.parse(execFileSync(process.execPath,[resolve('dist/cli/index.js'),'runtimes','--data-dir',fixture.dataDir],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}))
    expect(cli).toEqual(catalog)
    expect(JSON.stringify(catalog)).not.toContain('/usr/bin/true')
    expect(await fixture.request('/executions')).toMatchObject({items:[]})
    expect(fixture.credentialAbsentFromOutput()).toBe(true)
    await page.screenshot({path:resolve('test-results/web/runtime-registry.png'),fullPage:true})
    await page.setViewportSize({width:390,height:844})
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true)
  }finally{await fixture.stop()}
})
