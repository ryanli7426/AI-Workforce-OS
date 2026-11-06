import {QueryClient,QueryClientProvider} from '@tanstack/react-query'
import {fireEvent,render,screen,within,waitFor} from '@testing-library/react'
import {expect,it,vi} from 'vitest'
import type {ApiClient,RuntimeCatalog} from '../api.ts'
import {RuntimesPage} from './runtimes.tsx'

it('shows configuration separately from health and unsupported interaction capabilities',async()=>{
  const data:RuntimeCatalog={drivers:[{id:'claude-code',displayName:'Claude Code CLI',protocolVersion:1,capabilities:{activeInput:false,continueSession:false,reattachMonitor:false,pause:false,structuredResult:true,filesystemIsolation:false}}],instances:[{id:'claude-local',driver:'claude-code',configured:true,health:'not_checked'}]}
  const runtimes=vi.fn().mockResolvedValue(data)
  const cache=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})
  const ui=render(<QueryClientProvider client={cache}><RuntimesPage api={{runtimes} as unknown as ApiClient}/></QueryClientProvider>)
  try{
    await screen.findByRole('heading',{name:'Claude Code CLI'})
    expect(screen.getByText('已配置')).toBeTruthy();expect(screen.getByText('尚未检查')).toBeTruthy()
    expect(within(screen.getByRole('row',{name:'文件系统隔离 不支持'})).getByRole('cell',{name:'不支持'})).toBeTruthy()
    expect(screen.getByRole('row',{name:'结构化结果 支持'})).toBeTruthy()
    expect(screen.queryByRole('button',{name:'启动'})).toBeNull()
    data.instances[0]!.configured=false
    fireEvent.click(screen.getByRole('button',{name:'刷新'}))
    await waitFor(()=>expect(runtimes).toHaveBeenCalledTimes(2))
    await screen.findByText('未配置')
  }finally{ui.unmount();cache.clear()}
})

it('reports API failure instead of displaying assumed Runtime status',async()=>{
  const runtimes=vi.fn().mockRejectedValue(new Error('offline'))
  const cache=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}})
  const ui=render(<QueryClientProvider client={cache}><RuntimesPage api={{runtimes} as unknown as ApiClient}/></QueryClientProvider>)
  try{expect(await screen.findByRole('alert')).toBeTruthy();expect(screen.queryByText('已配置')).toBeNull()}
  finally{ui.unmount();cache.clear()}
})
