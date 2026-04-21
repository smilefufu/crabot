import { describe, expect, it } from 'vitest'
import type { FriendPermissionEffectiveConfig } from './friend-permission-utils'
import {
  buildExplicitFriendPermissionConfig,
  parseMemoryScopes,
  summarizeFriendMemoryScopes,
  summarizeFriendStorage,
} from './friend-permission-utils'

describe('friend-permission-utils', () => {
  it('summarizes storage permissions', () => {
    expect(summarizeFriendStorage(null)).toBe('未开启')
    expect(
      summarizeFriendStorage({ workspace_path: '/workspace', access: 'readwrite' })
    ).toBe('/workspace · 读写')
  })

  it('summarizes memory scopes', () => {
    expect(summarizeFriendMemoryScopes('session-1', ['session-1'])).toBe('当前会话')
    expect(summarizeFriendMemoryScopes('session-1', [])).toBe('未设置范围')
    expect(summarizeFriendMemoryScopes('session-1', ['scope-a', 'scope-b'])).toBe('scope-a, scope-b')
  })

  it('parses memory scopes from multiline or comma-separated input', () => {
    expect(parseMemoryScopes(' scope-a, scope-b\n\nscope-c ')).toEqual([
      'scope-a',
      'scope-b',
      'scope-c',
    ])
  })

  it('builds an explicit permission config from effective values', () => {
    const config: FriendPermissionEffectiveConfig = {
      tool_access: {
        memory: true,
        messaging: false,
        task: true,
        mcp_skill: false,
        file_io: true,
        browser: false,
        shell: true,
        remote_exec: false,
        desktop: false,
      },
      storage: { workspace_path: '/workspace', access: 'read' },
      memory_scopes: ['scope-a'],
    }

    const next = buildExplicitFriendPermissionConfig(config)

    expect(next).toEqual(config)
    expect(next.tool_access).not.toBe(config.tool_access)
    expect(next.memory_scopes).not.toBe(config.memory_scopes)
    expect(next.storage).not.toBe(config.storage)
  })
})
