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

  it.each([false, true])('assigns acknowledgement to the shared Manager without suppressing isolated request delivery (voice=%s)', voice => {
    const prompt = assembleManagerSystemPrompt({ ...group, requestAuthorization: 'request', voice })
    expect(prompt).toContain('任务，选定摘录不能抹掉原文中的否定、条件或私发要求。\n\n当前是独立请求的承接处理，接单确认由共享主控负责；本上下文不再发送接单确认。需要澄清、报告真实进展或交付结果时，仍按固定目标正常回复。\n\n只处理这个请求')
    for (const inputs of [
      { ...group, voice },
      { ...group, requestAuthorization: 'shared' as const, voice },
      { ...group, isGroup: false, voice },
      { ...group, isSystemThread: true, voice },
      { ...group, isSystemThread: true, isBuiltinDailyReflection: true, voice },
    ]) {
      expect(assembleManagerSystemPrompt(inputs)).not.toContain('接单确认由共享主控负责')
    }
  })

  it.each(['shared', 'request'] as const)('keeps the whole voice tag contract in %s and no conflicting text delivery rule', requestAuthorization => {
    const prompt = assembleManagerSystemPrompt({ ...group, requestAuthorization, voice: true })
    expect(prompt).toContain(VOICE_REPLY_PROMPT)
    expect(prompt).not.toContain('用工具投递答复，普通文本不外发')
    expect(prompt).not.toContain('按需用表格、图示或页面帮助人类理解')
  })

  it.each([false, true].flatMap(voice => [
    { ...group, isGroup: false, voice },
    { ...group, voice },
    { ...group, requestAuthorization: 'shared' as const, voice },
    { ...group, requestAuthorization: 'request' as const, voice },
  ]))('acknowledges tool work in the common Manager rule and only varies the delivery outlet: %j', inputs => {
    const prompt = assembleManagerSystemPrompt(inputs)
    expect(prompt).toContain('先用一句简短回应说明准备做什么，再进行工具查询、加载工具族、能力核对、查询或派发')
    expect(prompt).toContain('独立请求承接、执行器反馈和恢复事件不重复接单')
    expect(prompt).not.toContain('短任务完成后一次性汇报')
    expect(prompt).not.toContain('需要查询或执行操作时，可先简短说明下一步')
    if (inputs.voice) expect(prompt).toContain('接单与任务回报沿用主控通用规则')
    else {
      expect(prompt).toContain('用工具投递答复，普通文本不外发')
      expect(prompt).not.toContain('接单与任务回报沿用主控通用规则')
    }
  })

  it('keeps task reporting alive after an input turn and limits companion wording to Voice', () => {
    const voice = assembleManagerSystemPrompt({ ...group, requestAuthorization: 'shared', voice: true })
    expect(voice).toContain('原来那次语音交互结束不代表任务回报结束')
    expect(voice).toContain('待交付不代表已经播放')
    expect(voice).toContain('不为每件事重复索要播放许可')
    expect(voice).not.toContain('当前没有有效语音交互时，不承诺即时播报')
    for (const inputs of [{ ...group }, { ...group, isGroup: false }, { ...group, isSystemThread: true }]) {
      const other = assembleManagerSystemPrompt(inputs)
      expect(other).not.toContain('原来那次语音交互结束不代表任务回报结束')
      expect(other).not.toContain('不为每件事重复索要播放许可')
    }
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

  it('keeps request provenance in permanent rules and lazy delegation, preserving worker wording', async () => {
    const old = renderGuidance('manager', 'manager.delegation')
    const bound = renderGuidance('manager', 'manager.delegation', { requestAware: true })
    expect(bound).toContain('另一人的新指令先独立核验')
    expect(bound).toContain('请求归属、授权上限和投递目标一致')
    expect(bound).not.toContain('1. 对照当前要求和已有成果')
    expect(old).not.toContain('另一人的新指令')
    const tool = createGuidanceTool('manager', { requestAware: true })
    expect((await tool.call({ name: 'manager.delegation' })).output).toBe(bound)
    for (const requestAuthorization of ['shared', 'request'] as const) {
      const prompt = assembleManagerSystemPrompt({ ...group, requestAuthorization })
      expect(prompt).toContain('先沿系统保留的请求关联')
      expect(prompt).toContain('明确私发的正文不进入共享交付、任务板或记忆候选')
      expect(prompt).not.toContain('manager.worker-events')
    }
    expect(renderGuidance('worker', 'worker.project-context', { requestAware: true })).toBe(renderGuidance('worker', 'worker.project-context'))
  })
})
