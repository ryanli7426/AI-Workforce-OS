import { useEffect, useRef, useState } from 'react'
import { useQueryClient, type QueryKey } from '@tanstack/react-query'
import type {
  ChangeConnectionState,
  ChangeNotice,
  ChangeStreamClient,
} from './realtime-model.ts'

const CHANGE_BATCH_MS = 50

export interface UseRealtimeChangesOptions {
  stream?: ChangeStreamClient
  onUnauthorized?: () => void
}

function noticeQueryKeys(notice: ChangeNotice): QueryKey[] {
  switch (notice.entity) {
    case 'task':
      return [
        ['task', notice.resourceId],
        ['tasks'],
        ['executions'],
        ['execution'],
        ['verification'],
        ['task-verifications', notice.resourceId],
        ['task-logs', notice.resourceId],
        ['logs', notice.resourceId],
        ['overview'],
      ]
    case 'execution':
      return [
        ['execution', notice.resourceId],
        ['executions'],
        ...(notice.ticketId ? [['task', notice.ticketId] satisfies QueryKey] : []),
        ...(notice.ticketId ? [['task-logs', notice.ticketId] satisfies QueryKey, ['logs', notice.ticketId, notice.resourceId] satisfies QueryKey] : []),
        ['overview'],
      ]
    case 'verification':
      return [
        ['verification', notice.resourceId],
        notice.ticketId
          ? ['task-verifications', notice.ticketId]
          : ['task-verifications'],
        ...(notice.ticketId ? [['task', notice.ticketId] satisfies QueryKey] : []),
        ['tasks'],
        ['overview'],
      ]
    case 'employee':
      return [
        ['employees'],
        ['management-history', 'employee', notice.resourceId],
        ['tasks'],
        ['overview'],
      ]
    case 'project':
      return [
        ['projects'],
        ['management-history', 'project', notice.resourceId],
        ['tasks'],
        ['task'],
        ['executions'],
        ['execution'],
        ['verification'],
        ['task-verifications'],
        ['task-logs'],
        ['logs'],
        ['overview'],
      ]
  }
}

function queryKeyIdentity(queryKey: QueryKey): string {
  return JSON.stringify(queryKey)
}

export function useRealtimeChanges({
  stream,
  onUnauthorized,
}: UseRealtimeChangesOptions): ChangeConnectionState {
  const queryClient = useQueryClient()
  const onUnauthorizedRef = useRef(onUnauthorized)
  const generationRef = useRef(0)
  const [state, setState] = useState<ChangeConnectionState>(stream ? 'connecting' : 'offline')

  onUnauthorizedRef.current = onUnauthorized

  useEffect(() => {
    const generation = ++generationRef.current
    let active = true

    if (!stream) {
      setState('offline')
      return () => {
        active = false
        if (generationRef.current === generation) generationRef.current += 1
      }
    }

    const controller = new AbortController()
    const pendingKeys = new Map<string, QueryKey>()
    let batchTimer: ReturnType<typeof setTimeout> | undefined
    let unauthorizedNotified = false

    const isCurrent = (): boolean => (
      active
      && generationRef.current === generation
      && !controller.signal.aborted
    )

    const discardPending = (): void => {
      if (batchTimer !== undefined) {
        clearTimeout(batchTimer)
        batchTimer = undefined
      }
      pendingKeys.clear()
    }

    const flushPending = (): void => {
      batchTimer = undefined
      if (!isCurrent()) {
        pendingKeys.clear()
        return
      }

      const keys = [...pendingKeys.values()]
      pendingKeys.clear()
      void Promise.all(keys.map(queryKey => queryClient.invalidateQueries({ queryKey }))).catch(() => undefined)
    }

    const enqueueNotice = (notice: ChangeNotice): void => {
      for (const queryKey of noticeQueryKeys(notice)) {
        pendingKeys.set(queryKeyIdentity(queryKey), queryKey)
      }
      if (batchTimer === undefined) batchTimer = setTimeout(flushPending, CHANGE_BATCH_MS)
    }

    setState('connecting')

    void (async () => {
      try {
        await stream.run({
          signal: controller.signal,
          onEvent: async message => {
            if (!isCurrent()) return

            if (message.type === 'change') {
              enqueueNotice(message.notice)
              return
            }

            if (message.type === 'reset') {
              discardPending()
              setState('connecting')
              await queryClient.cancelQueries()
              if (!isCurrent()) return
              await queryClient.invalidateQueries({ refetchType: 'active' })
              return
            }

            setState('live')
          },
          onState: nextState => {
            if (!isCurrent()) return

            if (nextState === 'unauthorized') {
              if (!unauthorizedNotified) {
                unauthorizedNotified = true
                setState('unauthorized')
                try {
                  onUnauthorizedRef.current?.()
                } catch {
                  // Authentication cleanup belongs to the parent and must not restart the stream.
                }
              }
              controller.abort()
              discardPending()
              return
            }

            // A transport connection is not live until the server's ready frame is parsed.
            if (nextState !== 'live') setState(nextState)
          },
        })
        if (isCurrent()) setState('offline')
      } catch {
        if (isCurrent()) setState('offline')
      }
    })()

    return () => {
      active = false
      if (generationRef.current === generation) generationRef.current += 1
      discardPending()
      if (!controller.signal.aborted) controller.abort()
    }
  }, [queryClient, stream])

  return state
}

const CONNECTION_LABELS: Record<ChangeConnectionState, string> = {
  connecting: '正在连接实时更新',
  live: '实时更新已连接',
  reconnecting: '正在重新连接实时更新',
  offline: '实时更新离线，页面将继续轮询',
  unauthorized: '实时更新未授权',
}

export function RealtimeStatus(options: UseRealtimeChangesOptions) {
  const state = useRealtimeChanges(options)
  return <span className="realtime-status" role="status" aria-live="polite" title={CONNECTION_LABELS[state]}>{CONNECTION_LABELS[state]}</span>
}
