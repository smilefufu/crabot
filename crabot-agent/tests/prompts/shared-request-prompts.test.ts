import { describe, expect, it } from 'vitest'
import { assembleManagerSystemPrompt, GROUP_CHAT_DISCIPLINE, SHARED_REQUEST_BOUNDARY, REQUEST_CONTEXT_PROMPT, VOICE_REPLY_PROMPT } from '../../src/manager/prompt.js'
import { createGuidanceTool, renderGuidance } from '../../src/guidance/catalog.js'

const group = { managerKey: 'voice::shared', isSystemThread: false, isGroup: true } as const

describe('approved shared request prompt projections', () => {
  it('replaces conflicting latest-speaker and session authority rules instead of just appending an exception', () => {
    const prompt = assembleManagerSystemPrompt({ ...group, requestAuthorization: 'shared' })
    expect(prompt).toContain('另一人的新要求不自动覆盖原请求')
    expect(prompt).toContain('调用 execute_request 交给独立请求上下文处理')
    expect(prompt).toContain(SHARED_REQUEST_BOUNDARY)
    expect(prompt).toContain(GROUP_CHAT_DISCIPLINE)
    expect(prompt).not.toContain('以人类最新提出或确认的要求为准')
    expect(prompt).not.toContain('在现有会话授权覆盖时由你直接组织执行并代表人类委托')
    expect(prompt).not.toContain(REQUEST_CONTEXT_PROMPT)
  })

  it('gives an isolated request its fixed-source instructions without recursively handing off or claiming only public authority', () => {
    const prompt = assembleManagerSystemPrompt({ ...group, requestAuthorization: 'request' })
    expect(prompt).toContain(REQUEST_CONTEXT_PROMPT)
    expect(prompt).not.toContain('你的基础工具只有群公共授权')
    expect(prompt).not.toContain('调用 execute_request')
    expect(prompt).not.toContain('以人类最新提出或确认的要求为准')
    expect(prompt).not.toContain('在现有会话授权覆盖时')
    expect(prompt).toContain('当前会话：{"channel_id":"voice","session_id":"shared"}')
  })

  it.each(['shared', 'request'] as const)('keeps the whole voice tag contract in %s and no conflicting text delivery rule', requestAuthorization => {
    const prompt = assembleManagerSystemPrompt({ ...group, requestAuthorization, voice: true })
    expect(prompt).toContain(VOICE_REPLY_PROMPT)
    expect(prompt).not.toContain('用工具投递答复，普通文本不外发')
    expect(prompt).not.toContain('按需用表格、图示或页面帮助人类理解')
  })

  it.each([
    { ...group, isGroup: false },
    { ...group, isSystemThread: true },
    { ...group, isSystemThread: true, isBuiltinDailyReflection: true },
  ])('does not propagate request rules into other prompt profiles: %j', inputs => {
    const ordinary = assembleManagerSystemPrompt(inputs)
    expect(assembleManagerSystemPrompt({ ...inputs, requestAuthorization: 'shared' })).toBe(ordinary)
    expect(assembleManagerSystemPrompt({ ...inputs, requestAuthorization: 'request' })).toBe(ordinary)
  })

  it('projects both lazy and automatic guidance, preserving private and worker wording', async () => {
    const old = renderGuidance('manager', 'manager.delegation')
    const bound = renderGuidance('manager', 'manager.delegation', { requestAware: true })
    expect(bound).toContain('另一人的新指令先独立核验')
    expect(bound).toContain('请求归属、授权上限和投递目标一致')
    expect(bound).not.toContain('1. 对照当前要求和已有成果')
    expect(old).not.toContain('另一人的新指令')
    const tool = createGuidanceTool('manager', { requestAware: true })
    expect((await tool.call({ name: 'manager.delegation' })).output).toBe(bound)
    const events = renderGuidance('manager', 'manager.worker-events', { requestAware: true })
    expect(events.indexOf('先沿系统保留的请求关联')).toBeLessThan(events.indexOf('1. 使用本回合证据'))
    expect(renderGuidance('worker', 'worker.project-context', { requestAware: true })).toBe(renderGuidance('worker', 'worker.project-context'))
  })
})
