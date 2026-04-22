import { describe, expect, it } from 'vitest'
import {
  buildMemoryEntriesHref,
  parseMemoryContextQuery,
} from './memoryContextQuery'

describe('memoryContextQuery', () => {
  it('builds friend-scoped entries links', () => {
    expect(
      buildMemoryEntriesHref({
        friendId: 'friend-1',
        contextLabel: 'Alice',
      }),
    ).toBe('/memory/entries?friend_id=friend-1&context_label=Alice')
  })

  it('parses multiple accessible scopes', () => {
    expect(
      parseMemoryContextQuery('?accessible_scope=g1&accessible_scope=g2&context_label=Group'),
    ).toEqual({
      friendId: undefined,
      accessibleScopes: ['g1', 'g2'],
      contextLabel: 'Group',
      memoryId: undefined,
    })
  })

  it('builds tab and mode links in a stable query order', () => {
    expect(
      buildMemoryEntriesHref({
        tab: 'long',
        mode: 'browse',
        accessibleScopes: ['scope-1', ' scope-2 '],
      }),
    ).toBe('/memory/entries?tab=long&mode=browse&accessible_scope=scope-1&accessible_scope=scope-2')
  })

  it('round-trips memory id links', () => {
    expect(
      buildMemoryEntriesHref({
        tab: 'long',
        mode: 'search',
        memoryId: 'mem-1',
      }),
    ).toBe('/memory/entries?tab=long&mode=search&memory_id=mem-1')

    expect(parseMemoryContextQuery('?memory_id=mem-1')).toEqual({
      friendId: undefined,
      accessibleScopes: [],
      contextLabel: undefined,
      memoryId: 'mem-1',
    })
  })
})
