import { describe, it, expect } from 'vitest'
import { isPersistentMode } from '../../../src/engine/bg-entities/permission.js'
import type { WorkerAgentContext } from '../../../src/types.js'

function makeCtx(overrides: Partial<WorkerAgentContext> = {}): WorkerAgentContext {
  return {
    short_term_memories: [],
    long_term_memories: [],
    available_tools: [],
    admin_endpoint: { module_id: 'admin_1', port: 3001 },
    memory_endpoint: { module_id: 'memory_1', port: 3002 },
    channel_endpoints: [],
    ...overrides,
  } as WorkerAgentContext
}

describe('isPersistentMode', () => {
  it('returns false for autonomous schedule (no task_origin)', () => {
    expect(isPersistentMode(makeCtx())).toBe(false)
  })

  it('returns false for group chat', () => {
    const ctx = makeCtx({
      task_origin: { channel_id: 'tg', session_id: 's1', session_type: 'group' },
      sender_friend: { id: 'f1', display_name: 'm', permission: 'master' } as any,
    })
    expect(isPersistentMode(ctx)).toBe(false)
  })

  it('returns false for non-master friend in private chat', () => {
    const ctx = makeCtx({
      task_origin: { channel_id: 'tg', session_id: 's1', session_type: 'private' },
      sender_friend: { id: 'f2', display_name: 'normal', permission: 'normal' } as any,
    })
    expect(isPersistentMode(ctx)).toBe(false)
  })

  it('returns false when sender_friend missing in private chat', () => {
    const ctx = makeCtx({
      task_origin: { channel_id: 'tg', session_id: 's1', session_type: 'private' },
    })
    expect(isPersistentMode(ctx)).toBe(false)
  })

  it('returns true for master in private chat', () => {
    const ctx = makeCtx({
      task_origin: { channel_id: 'tg', session_id: 's1', session_type: 'private' },
      sender_friend: { id: 'master', display_name: 'master', permission: 'master' } as any,
    })
    expect(isPersistentMode(ctx)).toBe(true)
  })
})
