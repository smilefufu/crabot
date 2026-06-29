import { describe, it, expect } from 'vitest'
import {
  isResumable,
  buildResumeWakeupMessage,
  buildTerminalSupplementWakeupMessage,
  redactCheckpoint,
} from '../../src/core/resume-checkpoint.js'

const base = {
  agent_version: '1.0.0',
  system_prompt: 'SP',
  messages: [{ id: 'm1', role: 'user' as const, content: 'hi', timestamp: 1 }],
  worker_state: { todo_items: [] },
}

describe('isResumable', () => {
  it('版本一致 + 有 messages → 可 resume', () => {
    expect(isResumable(base, '1.0.0').ok).toBe(true)
  })
  it('版本不符 → 拒绝', () => {
    const r = isResumable(base, '2.0.0')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('version_mismatch')
  })
  it('空 messages → 拒绝', () => {
    const r = isResumable({ ...base, messages: [] }, '1.0.0')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('empty_checkpoint')
  })
})

describe('buildResumeWakeupMessage', () => {
  it('返回 user 角色、含「重启」「自查」字样', () => {
    const m = buildResumeWakeupMessage()
    expect(m.role).toBe('user')
    expect(String(m.content)).toContain('重启')
    expect(String(m.content)).toContain('自查')
  })
})

describe('buildTerminalSupplementWakeupMessage', () => {
  it('builds a user message containing supplement text', () => {
    const msg = buildTerminalSupplementWakeupMessage('继续刚才失败的任务')
    expect(msg.role).toBe('user')
    expect(String(msg.content)).toContain('此 task 已结束')
    expect(String(msg.content)).toContain('继续刚才失败的任务')
  })
})

describe('redactCheckpoint', () => {
  const SECRET = 'sk-super-secret-key-12345'

  it('system_prompt 中的 secret 被脱敏', () => {
    const cp = {
      ...base,
      system_prompt: `使用 API_KEY=${SECRET} 初始化`,
    }
    const result = redactCheckpoint(cp, [SECRET])
    expect(result.system_prompt).not.toContain(SECRET)
    expect(result.system_prompt).toContain('[REDACTED]')
  })

  it('messages 中的 secret 被脱敏', () => {
    const cp = {
      ...base,
      messages: [
        { id: 'm1', role: 'user' as const, content: `我的 key 是 ${SECRET}`, timestamp: 1 },
        { id: 'm2', role: 'assistant' as const, content: `好的，已收到 ${SECRET}`, timestamp: 2 },
      ],
    }
    const result = redactCheckpoint(cp, [SECRET])
    const serialized = JSON.stringify(result.messages)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).toContain('[REDACTED]')
  })

  it('messages 中含 ContentBlock 数组时 secret 也被脱敏', () => {
    const cp = {
      ...base,
      messages: [
        {
          id: 'm1',
          role: 'user' as const,
          content: [{ type: 'text', text: `key=${SECRET}` }],
          timestamp: 1,
        },
      ],
    }
    const result = redactCheckpoint(cp, [SECRET])
    const serialized = JSON.stringify(result.messages)
    expect(serialized).not.toContain(SECRET)
    expect(serialized).toContain('[REDACTED]')
  })

  it('返回新对象，不修改原 checkpoint（不可变）', () => {
    const cp = {
      ...base,
      system_prompt: `token=${SECRET}`,
    }
    const result = redactCheckpoint(cp, [SECRET])
    expect(result).not.toBe(cp)
    // 原 cp 保持不变
    expect(cp.system_prompt).toContain(SECRET)
  })

  it('无 secret 时原样返回结构', () => {
    const cp = { ...base, system_prompt: 'no secrets here' }
    const result = redactCheckpoint(cp, [])
    expect(result.system_prompt).toBe('no secrets here')
    expect(result.messages).toEqual(base.messages)
  })

  it('worker_state 和其他字段保持不变', () => {
    const cp = {
      ...base,
      system_prompt: `key=${SECRET}`,
      worker_state: { todo_items: [{ id: 't1', content: 'task', status: 'pending' as const, created_at: 1 }] },
    }
    const result = redactCheckpoint(cp, [SECRET])
    expect(result.worker_state).toEqual(cp.worker_state)
    expect(result.agent_version).toBe(cp.agent_version)
  })
})
