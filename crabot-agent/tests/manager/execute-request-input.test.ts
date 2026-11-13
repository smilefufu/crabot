import { describe, expect, it } from 'vitest'
import { parseExecuteRequestInput, resolveExecuteRequestSource } from '../../src/manager/conversation-request-runner.js'
import type { TrustedHumanInput } from '../../src/manager/trusted-human-input.js'

const input = (source_id: string, text: string): TrustedHumanInput => ({
  source_id, manager_key: 'voice::shared', sequence: 1, received_at: '2026-11-13T00:00:00.000Z',
  identity_status: 'friend', sender_friend_id: 'f-owner',
  message: { platform_message_id: source_id, session: { channel_id: 'voice', session_id: 'shared', type: 'group' },
    sender: { platform_user_id: 'owner', platform_display_name: 'Owner' }, content: { type: 'text', text },
    features: { is_mention_crab: true }, platform_timestamp: '2026-11-13T00:00:00.000Z' },
})

describe('execute_request host input', () => {
  it('accepts only delivery and quote; never a model-supplied source_id', () => {
    expect(parseExecuteRequestInput({ delivery: 'origin' })).toEqual({ delivery: 'origin' })
    expect(parseExecuteRequestInput({ delivery: 'requester_private', quote: '查这件事' })).toEqual({ delivery: 'requester_private', quote: '查这件事' })
    expect(() => parseExecuteRequestInput({ source_id: 'old', delivery: 'origin' })).toThrow(/only quote and delivery/)
    expect(() => parseExecuteRequestInput({ delivery: 'origin', permission: 'master' })).toThrow(/only quote and delivery/)
  })

  it('binds the single admitted input automatically', () => {
    const a = input('a', '只查这一次。')
    expect(resolveExecuteRequestSource([a], undefined)).toBe(a)
    expect(resolveExecuteRequestSource([a], '只查')).toBe(a)
  })

  it('requires a unique quote when several inputs were admitted', () => {
    const a = input('a', '只查 A。'), b = input('b', '只查 B。')
    expect(() => resolveExecuteRequestSource([a, b], undefined)).toThrow(/多条人类输入/)
    expect(resolveExecuteRequestSource([a, b], '只查 B')).toBe(b)
    expect(() => resolveExecuteRequestSource([a, b], '只查')).toThrow(/唯一匹配/)
    expect(() => resolveExecuteRequestSource([a, b], '不存在')).toThrow(/唯一匹配/)
  })

  it('rejects when the episode has no human input', () => {
    expect(() => resolveExecuteRequestSource([], undefined)).toThrow(/需要本轮人类输入/)
  })
})
