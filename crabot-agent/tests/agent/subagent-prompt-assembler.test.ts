import { describe, it, expect } from 'vitest'
import { assembleSubAgentPrompt } from '../../src/agent/subagent-prompt-assembler.js'
import type { SubAgentConfig } from '../../src/types.js'

const baseEntry: SubAgentConfig = {
  id: 'a1',
  name: 'tester',
  description: '',
  when_to_use: 'Use this subagent when test.',
  role: '你是测试员',
  workflow: '1. 执行 2. 验证',
  deliverables: '返回测试报告',
  model: {} as any,
  builtin_capabilities: { file_system: true, shell: true, task_intel: true, crab_memory: true, crab_messaging: false },
  allowed_mcp_server_ids: [],
  allowed_skill_ids: [],
  max_turns: 20,
}

describe('assembleSubAgentPrompt', () => {
  it('5 段按顺序拼接，含头尾守则', () => {
    const out = assembleSubAgentPrompt(baseEntry, { parentTaskId: 't-001', callerLabel: 'main worker' })
    expect(out).toContain('Subagent')
    expect(out).toContain('—— 你的角色 ——')
    expect(out).toContain('你是测试员')
    expect(out).toContain('—— 何时介入 ——')
    expect(out).toContain('Use this subagent when test.')
    expect(out).toContain('—— 工作流 ——')
    expect(out).toContain('1. 执行 2. 验证')
    expect(out).toContain('—— 交付物 ——')
    expect(out).toContain('返回测试报告')
    expect(out).toContain('Subagent name: tester')
    expect(out).toContain('Parent task id: t-001')
    expect(out).toContain('Caller: main worker')
  })

  it('verification 选填，未填时不渲染该段', () => {
    const out = assembleSubAgentPrompt(baseEntry, { parentTaskId: 't', callerLabel: 'x' })
    expect(out).not.toContain('—— 完成前自检 ——')
  })

  it('verification 填了时渲染', () => {
    const out = assembleSubAgentPrompt(
      { ...baseEntry, verification: '检查输出非空' },
      { parentTaskId: 't', callerLabel: 'x' }
    )
    expect(out).toContain('—— 完成前自检 ——')
    expect(out).toContain('检查输出非空')
  })

  it('verification 是空字符串视为未填', () => {
    const out = assembleSubAgentPrompt(
      { ...baseEntry, verification: '   ' },
      { parentTaskId: 't', callerLabel: 'x' }
    )
    expect(out).not.toContain('—— 完成前自检 ——')
  })

  it('段序固定：role 在 when_to_use 之前，workflow 在 deliverables 之前', () => {
    const out = assembleSubAgentPrompt(baseEntry, { parentTaskId: 't', callerLabel: 'x' })
    const idxRole = out.indexOf('—— 你的角色 ——')
    const idxWhen = out.indexOf('—— 何时介入 ——')
    const idxFlow = out.indexOf('—— 工作流 ——')
    const idxDeli = out.indexOf('—— 交付物 ——')
    expect(idxRole).toBeLessThan(idxWhen)
    expect(idxWhen).toBeLessThan(idxFlow)
    expect(idxFlow).toBeLessThan(idxDeli)
  })

  it('头部含通用守则关键词', () => {
    const out = assembleSubAgentPrompt(baseEntry, { parentTaskId: 't', callerLabel: 'x' })
    expect(out).toContain('Subagent 身份运行')
    expect(out).toContain('不要轮询')
    expect(out).toContain('不要持久化')
  })

  it('只列出调用方已过滤的 direct child Skill，并要求先加载', () => {
    const out = assembleSubAgentPrompt(baseEntry, {
      parentTaskId: 't',
      callerLabel: 'x',
      availableSkills: [{
        id: 'verification',
        name: 'verification-before-completion',
        description: '完成前验证',
        skill_dir: '/skills/verification-before-completion',
      }],
    })

    expect(out).toContain('<available_skills>')
    expect(out).toContain('<name>verification-before-completion</name>')
    expect(out).toContain('必须先调用 Skill 工具')
  })
})
