import { QueryClient } from '@tanstack/react-query'
import { useSyncExternalStore } from 'react'
import { ClientError, type ChatMessage, type ChatTaskSnapshot } from 'crabot-client'

export const serverQueries = new QueryClient({ defaultOptions: {
  queries: { retry: false, refetchOnWindowFocus: false }, mutations: { retry: false },
} })
let scope = 'browser'
const listeners = new Set<() => void>()
export const getServerScope = () => scope
export function useServerScope() { return useSyncExternalStore(callback => { listeners.add(callback); return () => { listeners.delete(callback) } }, getServerScope) }
export function setServerScope(next: string) {
  if (next === scope) return
  const previous = scope; scope = next
  void serverQueries.cancelQueries({ queryKey: ['server', previous] })
  serverQueries.removeQueries({ queryKey: ['server', previous] })
  listeners.forEach(listener => listener())
}

export interface ChatSnapshot {
  messages: ChatMessage[]
  tasks: Map<string, ChatTaskSnapshot | null>
  incomplete: boolean
  hasMore: boolean
}

// WS invalidates; one HTTP snapshot of the displayed range corrects additions, edits and deletions.
// An epoch protects the view even if a test transport/late server response ignores AbortSignal.
export class ChatSnapshotController {
  private epoch = 0
  private readonly queryRoot: readonly unknown[]
  constructor(private readonly readers: {
    history(limit: number, before?: string, signal?: AbortSignal): Promise<ChatMessage[]>
    task(id: string, signal?: AbortSignal): Promise<ChatTaskSnapshot | null>
  }, private readonly session = getServerScope(), private readonly cache = serverQueries) {
    this.queryRoot = ['server', session, 'chat-snapshot']
  }
  dispose() { this.epoch++; void this.cache.cancelQueries({ queryKey: this.queryRoot }) }
  async refresh(known: readonly ChatMessage[], pageSize = 30): Promise<ChatSnapshot | null> {
    const epoch = ++this.epoch
    await this.cache.cancelQueries({ queryKey: this.queryRoot })
    if (epoch !== this.epoch || this.session !== getServerScope()) return null
    const oldest = known.reduce<string | undefined>((value, message) => !value || message.timestamp < value ? message.timestamp : value, undefined)
    try {
      const snapshot = await this.cache.fetchQuery({
        queryKey: [...this.queryRoot, oldest ?? 'latest', known.length],
        queryFn: async ({ signal }): Promise<ChatSnapshot> => {
          let limit = Math.max(pageSize, known.length + pageSize)
          let messages = await this.readers.history(limit, undefined, signal)
          const cutoff = oldest ?? (messages.length === limit ? messages.at(-1)?.timestamp : undefined)
          // Increase the window until it covers the oldest displayed timestamp, including ties.
          // This uses the existing latest-N API and does not need a new cursor/event log.
          while (cutoff && messages.length === limit && messages.at(-1)!.timestamp >= cutoff) {
            signal.throwIfAborted(); limit *= 2
            messages = await this.readers.history(limit, undefined, signal)
          }
          const hasMore = Boolean(cutoff && messages.some(message => message.timestamp < cutoff))
          if (cutoff) messages = messages.filter(message => message.timestamp >= cutoff)
          const tasks = new Map<string, ChatTaskSnapshot | null>()
          let incomplete = false
          const taskIds = [...new Set(messages.map(message => message.task_id).filter((id): id is string => Boolean(id)))]
          let index = 0
          await Promise.all(Array.from({ length: Math.min(4, taskIds.length) }, async () => {
            while (index < taskIds.length) {
              signal.throwIfAborted()
              const id = taskIds[index++]
              try { tasks.set(id, await this.readers.task(id, signal)) }
              catch (error) {
                if (error instanceof ClientError && error.status === 404) tasks.set(id, null)
                else incomplete = true
              }
            }
          }))
          signal.throwIfAborted()
          return { messages, tasks, incomplete, hasMore }
        },
      })
      return epoch === this.epoch && this.session === getServerScope() ? snapshot : null
    } catch (error) {
      if (epoch !== this.epoch || this.session !== getServerScope()) return null
      throw error
    }
  }
}
