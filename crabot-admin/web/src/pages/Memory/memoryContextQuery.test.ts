import { describe, expect, it } from 'vitest'
import {
  buildMemoryEntriesHref,
  parseMemoryContextQuery,
} from './memoryContextQuery'

describe('memoryContextQuery', () => {
  it('builds friend-scoped long-term href when mode is unspecified', () => {
    expect(
      buildMemoryEntriesHref({
        friendId: 'friend-1',
        contextLabel: 'Alice',
      }),
    ).toBe('/memory/long-term?friend_id=friend-1&context_label=Alice')
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

  it('routes browse mode to /memory/long-term', () => {
    expect(
      buildMemoryEntriesHref({
        tab: 'long',
        mode: 'browse',
        accessibleScopes: ['scope-1', ' scope-2 '],
      }),
    ).toBe('/memory/long-term?tab=long&mode=browse&accessible_scope=scope-1&accessible_scope=scope-2')
  })

  it('routes search mode to /memory/short-term', () => {
    expect(
      buildMemoryEntriesHref({
        tab: 'long',
        mode: 'search',
        memoryId: 'mem-1',
      }),
    ).toBe('/memory/short-term?tab=long&mode=search&memory_id=mem-1')

    expect(parseMemoryContextQuery('?memory_id=mem-1')).toEqual({
      friendId: undefined,
      accessibleScopes: [],
      contextLabel: undefined,
      memoryId: 'mem-1',
    })
  })
})

describe('buildMemoryEntriesHref — after /memory split', () => {
  it('defaults to /memory/long-term when mode is not search/context', () => {
    expect(buildMemoryEntriesHref({ mode: 'browse' })).toBe('/memory/long-term?mode=browse')
  })

  it('routes search mode to /memory/short-term', () => {
    expect(buildMemoryEntriesHref({ mode: 'search' })).toBe('/memory/short-term?mode=search')
  })

  it('routes context mode to /memory/short-term', () => {
    const href = buildMemoryEntriesHref({ mode: 'context', friendId: 'f1' })
    expect(href.startsWith('/memory/short-term')).toBe(true)
    expect(href).toContain('mode=context')
  })

  it('returns bare /memory/long-term when no params provided', () => {
    expect(buildMemoryEntriesHref({})).toBe('/memory/long-term')
  })
})
