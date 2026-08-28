/**
 * Subagent prompt 拼装器
 *
 * 把 SubAgentConfig 的 5 段（when_to_use/role/workflow/deliverables/verification?）
 * + 代码层自动头部守则 + 尾部 session context 拼成完整 system_prompt。
 *
 * Spec: crabot-docs/superpowers/specs/2026-05-17-subagent-customization-and-admin-ui-design.md §2.6
 */

import type { SkillConfig, SubAgentConfig } from '../types.js'

export interface AssembleContext {
  /** 父任务 id（运行时注入到 Session Context 段） */
  readonly parentTaskId: string
  /** 调用方标签（运行时注入到 Session Context 段，如 'main worker'） */
  readonly callerLabel: string
  /** 已按 direct child 白名单过滤的 Skill；为空时不注入 Skill 说明。 */
  readonly availableSkills?: ReadonlyArray<SkillConfig>
}

const HEADER = [
  '你正在以 Subagent 身份运行，由 Crabot 主 agent 委派。',
  '',
  '通用守则：',
  '- 不要轮询：你的子任务结果会自动推送回主 agent，不要自己 polling',
  '- 不要持久化：你的所有状态在任务结束后销毁',
  '- 不要主动初始化外部副作用（发邮件 / 写文件 / 调外部 API）除非任务明确要求',
  '- 收到截断提示（[... N 字符被截断]）时，用更小的 chunk 重新读',
  '',
].join('\n')

export function assembleSubAgentPrompt(
  config: SubAgentConfig,
  ctx: AssembleContext,
): string {
  const sections: string[] = [
    HEADER,
    '—— 你的角色 ——',
    config.role,
    '',
    '—— 何时介入 ——',
    config.when_to_use,
    '',
    '—— 工作流 ——',
    config.workflow,
    '',
    '—— 交付物 ——',
    config.deliverables,
    '',
  ]

  if (config.verification !== undefined && config.verification.trim().length > 0) {
    sections.push('—— 完成前自检 ——', config.verification, '')
  }

  if (ctx.availableSkills && ctx.availableSkills.length > 0) {
    const skills = ctx.availableSkills.map((skill) => [
      '<skill>',
      `<name>${skill.name}</name>`,
      `<description>${skill.description || skill.name}</description>`,
      '</skill>',
    ].join('\n')).join('\n')
    sections.push(
      '—— 可用 Skill ——',
      '任务匹配下列 Skill 时，必须先调用 Skill 工具加载完整指引，再开始工作。',
      `<available_skills>\n${skills}\n</available_skills>`,
      '',
    )
  }

  sections.push(
    'Session Context:',
    `- Subagent name: ${config.name}`,
    `- Parent task id: ${ctx.parentTaskId}`,
    `- Caller: ${ctx.callerLabel}`,
  )

  return sections.join('\n')
}
