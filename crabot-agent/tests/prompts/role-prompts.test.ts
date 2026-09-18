import { describe, expect, it } from 'vitest'
import { assembleBuiltinWorkerPrompt } from '../../src/prompts/builtin-worker.js'
import { assembleManagerSystemPrompt } from '../../src/manager/prompt.js'

describe('独立角色提示词', () => {
  it('builtin 使用简短助手定位并保留执行闭环，不继承主控人格或模型槽位', () => {
    const options = { workspaceRoot: '/tmp/prompt-review', imageAvailable: false }
    const prompt = assembleBuiltinWorkerPrompt(options)
    expect(assembleBuiltinWorkerPrompt({ ...options, adminPersonality: 'PERSONALITY_SENTINEL' } as typeof options)).toBe(prompt)
    for (const absent of ['PERSONALITY_SENTINEL', '主控', '执行器', 'Manager', 'powerful', 'cost_effective', 'send_message', 'get_subagent_output', 'set_task_goal']) expect(prompt).not.toContain(absent)
    expect(prompt).toContain('worker.project-context')
    expect(prompt).toContain('默认工作目录：/tmp/prompt-review')
    expect(prompt).not.toContain('所有中间产物和最终产出都要落在这个目录')
  })

  it('builtin 动态能力与项目快照完整且不重复装配', () => {
    const prompt = assembleBuiltinWorkerPrompt({
      workspaceRoot: '/tmp/prompt-review', imageAvailable: true,
      skillListing: '<available_skills>SKILL_SENTINEL</available_skills>',
      workspaceInstructions: 'PROJECT_SENTINEL',
    })
    expect(prompt).not.toContain('## 生图能力')
    expect(prompt).toContain('SKILL_SENTINEL')
    expect(prompt).not.toContain('## 可用子 Agent')
    expect(prompt).toContain('<workspace-agents-md>\nPROJECT_SENTINEL\n</workspace-agents-md>')
    expect(prompt.split('依据实际产物和必要检查验证结果')).toHaveLength(2)
  })

  it('主控保留职责与权限原则，工作流只提供目录', () => {
    const prompt = assembleManagerSystemPrompt({ managerKey: 'admin-web::admin-chat', isSystemThread: false, adminPersonality: 'PERSONALITY_SENTINEL' })
    expect(prompt).toContain('派发前核实权限与能力')
    expect(prompt).toContain('manager.delegation')
    expect(prompt).not.toContain('处理：')
    expect(prompt).toContain('PERSONALITY_SENTINEL')
  })

  it('每日反思独立装配，不继承主控常规派工、项目和人类请求确认', () => {
    const prompt = assembleManagerSystemPrompt({ managerKey: 'admin-web::system-tasks', isSystemThread: true, isBuiltinDailyReflection: true })
    for (const required of ['每日反思', '至少有三条', '指定的摘要渠道', '不编造案例']) expect(prompt).toContain(required)
    for (const absent of ['对话与任务负责人', '项目与上下文', 'inspect_workboard', '项目目录绑定', '以为你失去了响应', 'reach_master', '## 群聊']) expect(prompt).not.toContain(absent)
  })

  it.each([
    ['bot-2::2eais6e9', 'bot-2', '2eais6e9'],
    ['wechat::a::b', 'wechat', 'a::b'],
    ['bot-2::a"b\\c$&', 'bot-2', 'a"b\\c$&'],
  ] as const)('主控会话字段由代码解析并完整注入：%s', (managerKey, channelId, sessionId) => {
    const prompt = assembleManagerSystemPrompt({ managerKey, isSystemThread: false })
    const targetLine = prompt.split('\n').find(line => line.startsWith('当前会话：'))!
    expect(JSON.parse(targetLine.slice('当前会话：'.length))).toEqual({ channel_id: channelId, session_id: sessionId })
  })
})
