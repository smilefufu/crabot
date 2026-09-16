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
  '你是由执行器委派的子 Agent，依据本次输入和已提供的上下文完成子任务，向调用方返回结果与证据。',
  '',
  '子任务结束后不再接续；需保留的产物按任务要求保存。仅执行任务要求的外部操作。',
  '输出被截断时按更小范围补读。',
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
