import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ChangeConnectionState,
  ChangeMessage,
  ChangeStreamClient,
} from './realtime-model.ts'
import { RealtimeStatus, useRealtimeChanges } from './realtime.tsx'

interface Subscription {
  signal: AbortSignal
  onEvent: (message: ChangeMessage) => void | Promise<void>
  onState: (state: ChangeConnectionState) => void
}

class ControlledStream implements ChangeStreamClient {
  readonly subscriptions: Subscription[] = []

  run(subscription: Subscription): Promise<void> {
    this.subscriptions.push(subscription)
    return new Promise(resolve => {
      if (subscription.signal.aborted) {
        resolve()
        return
      }
      subscription.signal.addEventListener('abort', () => resolve(), { once: true })
    })
  }

  get current(): Subscription {
    const subscription = this.subscriptions.at(-1)
    if (!subscription) throw new Error('stream is not subscribed')
    return subscription
  }

  event(message: ChangeMessage): void | Promise<void> {
    return this.current.onEvent(message)
  }

  state(state: ChangeConnectionState): void {
    this.current.onState(state)
  }
}

function createClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, refetchOnWindowFocus: false, refetchInterval: false },
      mutations: { retry: false },
    },
  })
}

function Probe({
  stream,
  onUnauthorized,
}: {
  stream?: ChangeStreamClient
  onUnauthorized?: () => void
}) {
  const state = useRealtimeChanges({ stream, onUnauthorized })
  return <output aria-label="connection-state">{state}</output>
}

function Providers({ client, children }: { client: QueryClient; children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function change(
  entity: 'task' | 'execution' | 'verification' | 'employee' | 'project',
  resourceId: string,
  ticketId?: string,
): ChangeMessage {
  return {
    type: 'change',
    cursor: `cursor-${entity}-${resourceId}`,
    notice: {
      entity,
      resourceId,
      ...(ticketId ? { ticketId } : {}),
      at: '2026-11-05T12:00:00.000Z',
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('useRealtimeChanges', () => {
  it('subscribes once, requires ready before showing live, and aborts on unmount', async () => {
    const client = createClient()
    const stream = new ControlledStream()
    const unauthorized = vi.fn()
    const view = render(
      <Providers client={client}>
        <Probe stream={stream} onUnauthorized={unauthorized} />
      </Providers>,
    )

    expect(stream.subscriptions).toHaveLength(1)
    expect(screen.getByLabelText('connection-state').textContent).toBe('connecting')

    act(() => stream.state('live'))
    expect(screen.getByLabelText('connection-state').textContent).toBe('connecting')

    await act(async () => {
      await stream.event({ type: 'ready', cursor: 'cursor-ready' })
    })
    expect(screen.getByLabelText('connection-state').textContent).toBe('live')

    view.rerender(
      <Providers client={client}>
        <Probe stream={stream} onUnauthorized={vi.fn()} />
      </Providers>,
    )
    expect(stream.subscriptions).toHaveLength(1)

    const signal = stream.current.signal
    view.unmount()
    expect(signal.aborted).toBe(true)
    expect(unauthorized).not.toHaveBeenCalled()
  })

  it('deduplicates a burst into the exact query-key invalidation set', async () => {
    vi.useFakeTimers()
    const client = createClient()
    const stream = new ControlledStream()
    const keys = [
      ['task', 'task-1'],
      ['tasks', { projectId: 'project-1' }],
      ['overview'],
      ['execution', 'execution-1'],
      ['executions', { ticketId: 'task-1' }],
      ['verification', 'verification-1'],
      ['task-verifications', 'task-1'],
      ['employees'],
      ['management-history', 'employee', 'employee-1'],
      ['projects'],
      ['management-history', 'project', 'project-1'],
    ] as const
    for (const key of keys) client.setQueryData(key, { cached: true })
    const invalidate = vi.spyOn(client, 'invalidateQueries')

    const view = render(
      <Providers client={client}>
        <Probe stream={stream} />
      </Providers>,
    )

    await act(async () => {
      await stream.event(change('task', 'task-1'))
      await stream.event(change('execution', 'execution-1', 'task-1'))
      await stream.event(change('verification', 'verification-1', 'task-1'))
      await stream.event(change('employee', 'employee-1'))
      await stream.event(change('project', 'project-1'))
      await stream.event(change('task', 'task-1'))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(49)
    })
    expect(invalidate).not.toHaveBeenCalled()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    const invalidatedKeys = invalidate.mock.calls.map(call => JSON.stringify(call[0]?.queryKey))
    expect(invalidatedKeys).toEqual(expect.arrayContaining([
      '["task","task-1"]',
      '["tasks"]',
      '["overview"]',
      '["execution","execution-1"]',
      '["executions"]',
      '["verification","verification-1"]',
      '["task-verifications","task-1"]',
      '["employees"]',
      '["management-history","employee","employee-1"]',
      '["projects"]',
      '["management-history","project","project-1"]',
    ]))
    expect(new Set(invalidatedKeys).size).toBe(invalidatedKeys.length)
    for (const key of keys) expect(client.getQueryState(key)?.isInvalidated).toBe(true)

    view.unmount()
  })

  it('refreshes dependent execution, verification and requested log views when a Task or Project changes',async()=>{
    vi.useFakeTimers()
    const client=createClient(),stream=new ControlledStream()
    const keys=[['execution','execution-1'],['executions'],['verification','job-1'],['task-verifications','task-1'],['task-logs','task-1'],['logs','task-1','execution-1'],['task','task-1']]
    for(const key of keys)client.setQueryData(key,{cached:true})
    const view=render(<Providers client={client}><Probe stream={stream}/></Providers>)
    await act(async()=>{await stream.event(change('task','task-1'));await vi.advanceTimersByTimeAsync(50)})
    for(const key of keys)expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    for(const key of keys)client.setQueryData(key,{cached:'new'})
    await act(async()=>{await stream.event(change('project','project-1'));await vi.advanceTimersByTimeAsync(50)})
    for(const key of keys)expect(client.getQueryState(key)?.isInvalidated).toBe(true)
    view.unmount()
  })

  it('cancels an active read before reset refreshes it from server truth', async () => {
    const client = createClient()
    const stream = new ControlledStream()
    const order: string[] = []
    let calls = 0
    const query = vi.fn(({ signal }: { signal: AbortSignal }) => {
      calls += 1
      order.push(`start-${calls}`)
      if (calls > 1) return Promise.resolve('fresh')
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          order.push('abort-1')
          reject(new DOMException('Aborted', 'AbortError'))
        }, { once: true })
      })
    })

    function ActiveQuery() {
      useQuery({ queryKey: ['active'], queryFn: query })
      return null
    }

    const view = render(
      <Providers client={client}>
        <Probe stream={stream} />
        <ActiveQuery />
      </Providers>,
    )
    await waitFor(() => expect(query).toHaveBeenCalledTimes(1))

    await act(async () => {
      await stream.event({ type: 'reset', cursor: 'cursor-reset', reason: 'expired' })
    })

    expect(query).toHaveBeenCalledTimes(2)
    expect(order).toEqual(['start-1', 'abort-1', 'start-2'])
    expect(client.getQueryData(['active'])).toBe('fresh')
    view.unmount()
  })

  it('invalidates every task-verification list when an optional ticket id is absent', async () => {
    vi.useFakeTimers()
    const client = createClient()
    const stream = new ControlledStream()
    client.setQueryData(['task-verifications', 'task-1'], { cached: true })
    client.setQueryData(['task-verifications', 'task-2'], { cached: true })
    const view = render(
      <Providers client={client}>
        <Probe stream={stream} />
      </Providers>,
    )

    await act(async () => {
      await stream.event(change('verification', 'verification-1'))
      await vi.advanceTimersByTimeAsync(50)
    })

    expect(client.getQueryState(['task-verifications', 'task-1'])?.isInvalidated).toBe(true)
    expect(client.getQueryState(['task-verifications', 'task-2'])?.isInvalidated).toBe(true)
    view.unmount()
  })

  it('lets reset supersede a queued change batch', async () => {
    vi.useFakeTimers()
    const client = createClient()
    const stream = new ControlledStream()
    const order: string[] = []
    vi.spyOn(client, 'cancelQueries').mockImplementation(async () => {
      order.push('cancel')
    })
    const invalidate = vi.spyOn(client, 'invalidateQueries').mockImplementation(async () => {
      order.push('invalidate')
    })

    const view = render(
      <Providers client={client}>
        <Probe stream={stream} />
      </Providers>,
    )
    await act(async () => {
      await stream.event(change('task', 'task-1'))
      await stream.event({ type: 'reset', cursor: 'cursor-reset', reason: 'replaced' })
      await vi.advanceTimersByTimeAsync(100)
    })

    expect(order).toEqual(['cancel', 'invalidate'])
    expect(invalidate).toHaveBeenCalledWith({ refetchType: 'active' })
    view.unmount()
  })

  it('drops queued work and callbacks from a replaced or unmounted stream', async () => {
    vi.useFakeTimers()
    const client = createClient()
    const first = new ControlledStream()
    const second = new ControlledStream()
    const unauthorized = vi.fn()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const view = render(
      <Providers client={client}>
        <Probe stream={first} onUnauthorized={unauthorized} />
      </Providers>,
    )
    const firstSignal = first.current.signal
    await act(async () => {
      await first.event(change('task', 'stale-before-replacement'))
    })

    view.rerender(
      <Providers client={client}>
        <Probe stream={second} onUnauthorized={unauthorized} />
      </Providers>,
    )
    expect(firstSignal.aborted).toBe(true)
    expect(second.subscriptions).toHaveLength(1)

    await act(async () => {
      await first.event(change('task', 'stale-after-replacement'))
      first.state('unauthorized')
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(invalidate).not.toHaveBeenCalled()
    expect(unauthorized).not.toHaveBeenCalled()

    await act(async () => {
      await second.event(change('task', 'current'))
      await vi.advanceTimersByTimeAsync(50)
    })
    expect(invalidate.mock.calls.some(call => JSON.stringify(call[0]?.queryKey) === '[\"task\",\"current\"]')).toBe(true)

    const secondSignal = second.current.signal
    view.unmount()
    expect(secondSignal.aborted).toBe(true)
    invalidate.mockClear()
    await second.event(change('task', 'after-unmount'))
    await vi.advanceTimersByTimeAsync(100)
    expect(invalidate).not.toHaveBeenCalled()
    expect(unauthorized).not.toHaveBeenCalled()
  })

  it('stops on unauthorized and invokes only the latest parent callback once', () => {
    const client = createClient()
    const stream = new ControlledStream()
    const firstCallback = vi.fn()
    const latestCallback = vi.fn()
    const view = render(
      <Providers client={client}>
        <Probe stream={stream} onUnauthorized={firstCallback} />
      </Providers>,
    )
    view.rerender(
      <Providers client={client}>
        <Probe stream={stream} onUnauthorized={latestCallback} />
      </Providers>,
    )

    const signal = stream.current.signal
    act(() => {
      stream.state('unauthorized')
      stream.state('unauthorized')
    })

    expect(screen.getByLabelText('connection-state').textContent).toBe('unauthorized')
    expect(signal.aborted).toBe(true)
    expect(firstCallback).not.toHaveBeenCalled()
    expect(latestCallback).toHaveBeenCalledTimes(1)
    expect(stream.subscriptions).toHaveLength(1)

    view.unmount()
    expect(latestCallback).toHaveBeenCalledTimes(1)
  })

  it('renders an accessible status without claiming live before ready', async () => {
    const client = createClient()
    const stream = new ControlledStream()
    render(
      <Providers client={client}>
        <RealtimeStatus stream={stream} />
      </Providers>,
    )

    expect(screen.getByRole('status').textContent).toBe('正在连接实时更新')
    await act(async () => {
      await stream.event({ type: 'ready', cursor: 'cursor-ready' })
    })
    expect(screen.getByRole('status').textContent).toBe('实时更新已连接')
  })
})
