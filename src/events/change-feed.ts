/** Invalidation facts only. These events grant no execution or completion authority. */
export const CHANGE_ENTITIES = ['task','execution','verification','employee','project'] as const
export type ChangeEntity = typeof CHANGE_ENTITIES[number]
export interface ChangeNotice { entity: ChangeEntity; resourceId: string; ticketId?: string; at: string }
export interface ChangeFeedEvent { cursor: string; notice: ChangeNotice }
export type ChangeResetReason = 'initial' | 'expired' | 'replaced' | 'future'
export interface ChangeFeedPage {
  changes: ChangeFeedEvent[]
  cursor: string
  hasMore: boolean
  reset?: { cursor: string; reason: ChangeResetReason }
}
export interface ChangeFeedReader { readPage(input?: {cursor?: string; limit?: number}): ChangeFeedPage }
export class ChangeFeedInputError extends Error {
  constructor(){super('Invalid change feed cursor or query');this.name='ChangeFeedInputError'}
}
