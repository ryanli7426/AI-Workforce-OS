import { describe,expect,it,vi } from 'vitest'
import { RuntimeRegistry } from '../src/runtime/registry.ts'
import { builtinRuntimeRegistry, LEGACY_CLAUDE_RUNTIME_FINGERPRINT } from '../src/runtime/builtins.ts'
import { runtimeCatalog } from '../src/application/runtime-catalog.ts'
import { defaultSettings } from '../src/config/settings.ts'
import type { RuntimeAdapterOptions, RuntimeDriver, RuntimeTaskInput } from '../src/runtime/ports.ts'

const input:RuntimeTaskInput={executionId:'e1',assignmentId:'a1',ticketId:'t1',generation:1,cwd:'/tmp/owned-worktree',title:'Title',description:'Task',inputRevision:'r1',policyVersion:'p1'}
const options:RuntimeAdapterOptions={command:'/usr/bin/true',timeoutMs:5000,maxOutputBytes:8192,graceMs:1000}
function driver():RuntimeDriver {
  return {id:'fixture',displayName:'Fixture',protocolVersion:1,capabilities:{activeInput:false,continueSession:false,reattachMonitor:false,pause:false,structuredResult:true,filesystemIsolation:false},
    create:config=>({runtime:'fixture',capabilities:driver().capabilities,
      createLaunch:task=>({executionId:task.executionId,assignmentId:task.assignmentId,ticketId:task.ticketId,generation:task.generation,cwd:task.cwd,...config,args:[]}),
      parseResult:()=>({terminal:'success',summary:'fixture'})})}
}

describe('trusted Runtime registry',()=>{
  it('snapshots capabilities and returns immutable descriptors without constructing adapters',()=>{
    const definition=driver(),create=vi.fn(definition.create);definition.create=create
    const registry=new RuntimeRegistry([definition])
    ;(definition.capabilities as {filesystemIsolation:boolean}).filesystemIsolation=true
    expect(registry.require('fixture').capabilities.filesystemIsolation).toBe(false)
    expect(Object.isFrozen(registry.list()[0])).toBe(true)
    expect(Object.isFrozen(registry.list()[0]!.capabilities)).toBe(true)
    registry.list().splice(0)
    expect(registry.list()).toHaveLength(1);expect(create).not.toHaveBeenCalled()
  })
  it('rejects duplicate, malformed, unknown drivers and missing capability declarations',()=>{
    expect(()=>new RuntimeRegistry([driver(),driver()])).toThrow('Duplicate')
    expect(()=>new RuntimeRegistry([{...driver(),id:undefined} as unknown as RuntimeDriver])).toThrow('Invalid')
    expect(()=>new RuntimeRegistry([{...driver(),capabilities:{} as never}])).toThrow('capabilities')
    expect(()=>new RuntimeRegistry([driver()]).create('unknown',options)).toThrow('Unsupported')
  })
  it('requires the adapter to implement its registered identity and capabilities',()=>{
    const definition=driver(),create=definition.create
    definition.create=config=>({...create(config),runtime:'different'})
    expect(()=>new RuntimeRegistry([definition]).create('fixture',options)).toThrow('does not match')
    definition.create=config=>({...create(config),capabilities:{...definition.capabilities,filesystemIsolation:true}})
    expect(()=>new RuntimeRegistry([definition]).create('fixture',options)).toThrow('does not match')
  })
  it('rejects adapter changes to execution identity, executable or execution budgets before spawn',()=>{
    for(const override of [{ticketId:'other'},{cwd:'/tmp/sibling'},{command:'/bin/sh'},{timeoutMs:5001},{maxOutputBytes:8193},{graceMs:1001}]){
      const definition=driver(),create=definition.create
      definition.create=config=>{const adapter=create(config);return {...adapter,createLaunch:task=>({...adapter.createLaunch(task),...override})}}
      expect(()=>new RuntimeRegistry([definition]).create('fixture',options).createLaunch(input)).toThrow(/identity|authority/)
    }
  })
  it('uses independent request/response snapshots and rejects malformed results',()=>{
    const definition=driver(),create=definition.create
    definition.create=config=>{const adapter=create(config);return {...adapter,createLaunch:task=>{const launch=adapter.createLaunch(task);task.title='mutated';return launch},parseResult:()=>({terminal:'success',summary:'x'.repeat(8193)})}}
    const adapter=new RuntimeRegistry([definition]).create('fixture',options)
    expect(adapter.createLaunch(input).ticketId).toBe('t1');expect(input.title).toBe('Title')
    expect(()=>adapter.parseResult({exitCode:0,stdout:''})).toThrow('Invalid Runtime result')
  })
  it('composes the real Claude adapter with existing CLI argv and truthful capabilities',()=>{
    const adapter=builtinRuntimeRegistry().create('claude-code',options)
    expect(builtinRuntimeRegistry().fingerprint('claude-code')).toBe(LEGACY_CLAUDE_RUNTIME_FINGERPRINT)
    expect(adapter.createLaunch(input).args).toContain('--print')
    expect(adapter.capabilities).toMatchObject({filesystemIsolation:false,activeInput:false,continueSession:false})
    expect(adapter.parseResult({exitCode:0,stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Done'})}).terminal).toBe('success')
    expect(adapter.parseResult({exitCode:0,stdout:JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Done',permission_denials:[{tool_name:'Bash'}]})}).terminal).toBe('error')
  })
  it('binds recovery fingerprints to protocol and capabilities, excluding display-only labels',()=>{
    const definition=driver(),original=new RuntimeRegistry([definition]).fingerprint('fixture')
    expect(new RuntimeRegistry([{...definition,displayName:'New label'}]).fingerprint('fixture')).toBe(original)
    expect(new RuntimeRegistry([{...definition,protocolVersion:2}]).fingerprint('fixture')).not.toBe(original)
    expect(new RuntimeRegistry([{...definition,capabilities:{...definition.capabilities,filesystemIsolation:true}}]).fingerprint('fixture')).not.toBe(original)
    expect(()=>new RuntimeRegistry([{...definition,protocolVersion:0}])).toThrow('Invalid')
  })
  it('publishes configuration without executable paths or fabricated health checks',()=>{
    const unconfigured=runtimeCatalog(defaultSettings({ownerId:'owner'}))
    expect(unconfigured.instances[0]).toEqual({id:'claude-local',driver:'claude-code',configured:false,health:'not_checked'})
    const configured=runtimeCatalog(defaultSettings({ownerId:'owner',claudeCommand:'/owned/command-that-must-not-run'}))
    expect(configured.instances[0]!.configured).toBe(true)
    expect(JSON.stringify(configured)).not.toContain('/owned/')
    expect(configured.drivers[0]!.capabilities.filesystemIsolation).toBe(false)
  })
})
