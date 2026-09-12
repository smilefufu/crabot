import { describe, expect, it } from 'vitest'
import { assembleBuiltinWorkerPrompt } from '../../src/prompts/builtin-worker.js'
import { assembleManagerSystemPrompt } from '../../src/manager/prompt.js'

describe('独立角色提示词', () => {
  it('builtin 保留任务切分与委派闭环，不包含主控、人格或模型槽位', () => {
    const options = { workspaceRoot: '/tmp/prompt-review', imageAvailable: false }
    const prompt = assembleBuiltinWorkerPrompt(options)
    expect(assembleBuiltinWorkerPrompt({ ...options, adminPersonality: 'PERSONALITY_SENTINEL' } as typeof options)).toBe(prompt)
    for (const name of ['code_planner', 'code_writer', 'task_reviewer', '前置依赖', '整体验收', 'finish_task']) expect(prompt).toContain(name)
    for (const absent of ['PERSONALITY_SENTINEL', '主控', 'Manager', 'powerful', 'cost_effective', 'send_message', 'get_subagent_output', 'set_task_goal']) expect(prompt).not.toContain(absent)
    expect(prompt).toContain('默认工作目录：/tmp/prompt-review')
    expect(prompt).toContain('不要求每个任务都创建文件')
    expect(prompt).toContain('Permission denied')
    expect(prompt).not.toContain('所有中间产物和最终产出都要落在这个目录')
  })

  it('builtin 动态能力与项目快照完整且不重复装配', () => {
    const prompt = assembleBuiltinWorkerPrompt({
      workspaceRoot: '/tmp/prompt-review', imageAvailable: true,
      skillListing: '<available_skills>SKILL_SENTINEL</available_skills>',
      availableSubAgents: [{ toolName: 'code_writer', workerHint: '实现任务' }],
      workspaceInstructions: 'PROJECT_SENTINEL',
    })
    expect(prompt).toContain('generate_image')
    expect(prompt).toContain('SKILL_SENTINEL')
    expect(prompt).toContain('- code_writer：实现任务')
    expect(prompt).toContain('<workspace-agents-md>\nPROJECT_SENTINEL\n</workspace-agents-md>')
    expect(prompt.split('## 验证与交付')).toHaveLength(2)
  })

  it('主控保留及时响应的理由和同项目上下文复用条件', () => {
    const prompt = assembleManagerSystemPrompt({ managerKey: 'admin-web::admin-chat', isSystemThread: false, adminPersonality: 'PERSONALITY_SENTINEL' })
    expect(prompt).toContain('以为你失去了响应')
    expect(prompt).toContain('不等待确认')
    expect(prompt).toContain('同一项目内')
    expect(prompt).toContain('上下文对当前任务仍有可复用价值')
    expect(prompt).toContain('PERSONALITY_SENTINEL')
  })

  it('每日反思独立装配，不继承主控常规派工、项目和人类请求确认', () => {
    const prompt = assembleManagerSystemPrompt({ managerKey: 'admin-web::system-tasks', isSystemThread: true, isBuiltinDailyReflection: true })
    for (const required of ['每日反思', 'promote_inbox_entry', 'promote_to_rule', 'send_daily_reflection_summary', '至少三条']) expect(prompt).toContain(required)
    for (const absent of ['对话与任务负责人', '项目与上下文', 'inspect_workboard', '项目目录绑定', '以为你失去了响应', 'reach_master', '## 群聊']) expect(prompt).not.toContain(absent)
  })
})
