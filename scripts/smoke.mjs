/** Runs the built standalone artifact in a temporary directory with no Harness packages available. */
import { mkdtempSync, cpSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = mkdtempSync(join(tmpdir(), 'lao-standalone-'))
try {
  cpSync('dist/core', join(root, 'core'), { recursive: true })
  cpSync('dist/storage', join(root, 'storage'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"type":"module"}')
  writeFileSync(join(root, 'smoke.mjs'), `
    import { LocalStore } from './storage/store.js';
    import { createLocalEngine } from './core/local.js';
    const store = new LocalStore('./smoke.sqlite');
    const engine = createLocalEngine({repo: store, policy: () => ({version:'v1', paused:false, evalTimeoutMs:1000,
      gate: () => ({admissible:true,strength:'explicit',basis:{via:'listed'}}), revalidate:()=>true, admitsInferred:()=>true}),
      scope:{scope:()=>({listened:true,observed:false})}, assessor:{request(){}}, executor:{start(){throw Error('must queue first')},deliver(){},stop(){}},
      outbox:{send(){},withdraw(){},status(){}}});
    engine.receive({id:'e1',source:'manual',threads:[{source:'manual',id:'i1'}],actor:{source:'manual',id:'alice'},human:true,
      at:new Date().toISOString(),text:'Test',meta:{}});
    const decision=engine.decide('e1',{kind:'accept',title:'Test',scope:'test',reason:'test',task:{
      issue:{source:'manual',issueId:'i1',revision:'1',updatedAt:new Date().toISOString(),description:'test',priority:1,closed:false},
      taskType:'test',policy:{approvalRequired:true,reviewRequired:true,retryLimit:0}}});
    if(store.tickets.get(decision.ticketId).lifecycle.status!=='WAITING_APPROVAL') throw Error('bad lifecycle');
    store.close();
    console.log('Standalone Engine + SQLite smoke passed without node_modules');
  `)
  const result = spawnSync(process.execPath, ['smoke.mjs'], { cwd: root, encoding: 'utf8', timeout: 30_000,
    env: { PATH: process.env.PATH, LANG: 'C' } })
  process.stdout.write(result.stdout ?? '')
  process.stderr.write(result.stderr ?? '')
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error('Standalone library smoke failed')
  const cli = resolve('dist/cli/index.js')
  for (const args of [['--help'], ['doctor'], ['init', '--data-dir', join(root, 'data')], ['status', '--data-dir', join(root, 'data')], ['tickets', '--data-dir', join(root, 'data')]]) {
    const check = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 10000,
      env: { PATH: process.env.PATH, LANG: 'C' } })
    if (check.error || check.status !== 0) throw new Error('Compiled CLI smoke failed: '+args[0]+' '+check.stderr, { cause: check.error })
    if (args[0] !== '--help') JSON.parse(check.stdout)
  }
  console.log('Compiled CLI help/doctor/init/status/tickets smoke passed')
} finally { rmSync(root, { recursive: true, force: true }) }
