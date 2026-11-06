import {afterEach,expect,it,vi} from 'vitest'
import {createApiClient,type RuntimeCatalog} from './api.ts'

const token='a'.repeat(64)
const catalog:RuntimeCatalog={drivers:[{id:'claude-code',displayName:'Claude Code CLI',protocolVersion:1,capabilities:{activeInput:false,continueSession:false,reattachMonitor:false,pause:false,structuredResult:true,filesystemIsolation:false}}],instances:[{id:'claude-local',driver:'claude-code',configured:true,health:'not_checked'}]}
afterEach(()=>vi.unstubAllGlobals())

it('requests only authenticated static Runtime facts via private HTTP transport',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog),{status:200}))
  vi.stubGlobal('fetch',fetch)
  const client=createApiClient(token),controller=new AbortController()
  expect(await client.runtimes(controller.signal)).toEqual(catalog)
  const [url,init]=fetch.mock.calls[0]!
  expect(url).toBe('/api/v1/runtimes')
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer '+token)
  expect(init.credentials).toBe('omit');expect(init.redirect).toBe('error')
  expect(JSON.stringify(client)).not.toContain(token)
})

it('rejects invented health, unknown driver references and overbroad DTOs',async()=>{
  for(const altered of [
    {...catalog,instances:[{...catalog.instances[0],health:'healthy'}]},
    {...catalog,instances:[{...catalog.instances[0],driver:'unknown'}]},
    {...catalog,drivers:[...catalog.drivers,...catalog.drivers]},
    {...catalog,drivers:[{...catalog.drivers[0],capabilities:{structuredResult:true}}]},
    {...catalog,instances:[{...catalog.instances[0],command:'/private/path'}]},
  ]){
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(altered),{status:200})))
    await expect(createApiClient(token).runtimes()).rejects.toMatchObject({code:'INVALID_RESPONSE'})
  }
})
