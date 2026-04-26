export interface MemoryContextQuery {
  friendId?: string
  accessibleScopes: string[]
  contextLabel?: string
  memoryId?: string
}

interface BuildMemoryEntriesHrefInput {
  tab?: 'short' | 'long'
  mode?: 'browse' | 'search' | 'context'
  friendId?: string
  accessibleScopes?: string[]
  contextLabel?: string
  memoryId?: string
}

export function parseMemoryContextQuery(search: string): MemoryContextQuery {
  const params = new URLSearchParams(search)

  const friendId = params.get('friend_id')?.trim() || undefined
  const contextLabel = params.get('context_label')?.trim() || undefined
  const memoryId = params.get('memory_id')?.trim() || undefined
  const accessibleScopes = params
    .getAll('accessible_scope')
    .map((scope) => scope.trim())
    .filter(Boolean)

  return {
    friendId,
    accessibleScopes,
    contextLabel,
    memoryId,
  }
}

export function buildMemoryEntriesHref(input: BuildMemoryEntriesHrefInput): string {
  const params = new URLSearchParams()

  if (input.tab) {
    params.set('tab', input.tab)
  }
  if (input.mode) {
    params.set('mode', input.mode)
  }
  if (input.friendId) {
    params.set('friend_id', input.friendId)
  }

  input.accessibleScopes?.forEach((scope) => {
    const normalizedScope = scope.trim()
    if (normalizedScope) {
      params.append('accessible_scope', normalizedScope)
    }
  })

  if (input.contextLabel) {
    params.set('context_label', input.contextLabel)
  }
  if (input.memoryId) {
    params.set('memory_id', input.memoryId)
  }

  const prefix = input.mode === 'search' || input.mode === 'context'
    ? '/memory/short-term'
    : '/memory/long-term'
  const query = params.toString()
  return query ? `${prefix}?${query}` : prefix
}
