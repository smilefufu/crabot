/**
 * Crabot 内置 Skill 注入数据。
 *
 * SKILL.md 内容来自 ./builtin-skills/<name>/SKILL.md（snapshot of superpowers v5.0.7 MIT）。
 * Task 6 起改成 filesystem-native：每个 builtin 是一个目录，skill_dir 指向源目录。
 *
 * 由 AdminModule.initialize() 在 SkillManager.initialize() 之后调用 seedBuiltinSkills。
 * Spec: crabot-docs/superpowers/specs/2026-05-18-subagent-phase2b-builtin-design.md §2
 */

import { join } from 'path'
import type { SkillRegistryEntry } from './mcp-skill-manager.js'

// CommonJS: __dirname 在 tsconfig module: "commonjs" 下自动可用
// dev（vitest）: __dirname = .../crabot-admin/src → ../builtin-skills = crabot-admin/builtin-skills ✅
// prod（编译后）: __dirname = .../crabot-admin/dist → ../builtin-skills = crabot-admin/builtin-skills ✅
const SKILL_ROOT = join(__dirname, '..', 'builtin-skills')
const SEED_TIMESTAMP = '2026-05-18T00:00:00.000Z'

export const BUILTIN_SKILL_IDS = {
  writingPlans: 'builtin-skill-writing-plans',
  systematicDebugging: 'builtin-skill-systematic-debugging',
  verificationBeforeCompletion: 'builtin-skill-verification-before-completion',
  workspaceContextMaintenance: 'builtin-skill-workspace-context-maintenance',
} as const

export function getBuiltinSkills(): SkillRegistryEntry[] {
  return [
    {
      id: BUILTIN_SKILL_IDS.writingPlans,
      name: 'writing-plans',
      description: 'planner 输出 plan 的标准（含自检流程）；用于 code_planner 的核心行为规范',
      version: '1.0.0-superpowers-5.0.7',
      skill_dir: join(SKILL_ROOT, 'writing-plans'),
      source_type: 'builtin',
      is_builtin: true,
      is_essential: false,
      can_disable: true,
      enabled: true,
      created_at: SEED_TIMESTAMP,
      updated_at: SEED_TIMESTAMP,
    },
    {
      id: BUILTIN_SKILL_IDS.systematicDebugging,
      name: 'systematic-debugging',
      description: '调试时找根因而非随机 fix；用于 code_writer 在测试失败时的策略',
      version: '1.0.0-superpowers-5.0.7',
      skill_dir: join(SKILL_ROOT, 'systematic-debugging'),
      source_type: 'builtin',
      is_builtin: true,
      is_essential: false,
      can_disable: true,
      enabled: true,
      created_at: SEED_TIMESTAMP,
      updated_at: SEED_TIMESTAMP,
    },
    {
      id: BUILTIN_SKILL_IDS.verificationBeforeCompletion,
      name: 'verification-before-completion',
      description: '完成前必须运行 verification 命令再上报；用于 code_writer 防"假完成"',
      version: '1.0.0-superpowers-5.0.7',
      skill_dir: join(SKILL_ROOT, 'verification-before-completion'),
      source_type: 'builtin',
      is_builtin: true,
      is_essential: false,
      can_disable: true,
      enabled: true,
      created_at: SEED_TIMESTAMP,
      updated_at: SEED_TIMESTAMP,
    },
    {
      id: BUILTIN_SKILL_IDS.workspaceContextMaintenance,
      name: 'workspace-context-maintenance',
      description: '在文件工作区遵守 AGENTS.md，按任务读取 README、架构、决策和领域文档，并报告长期事实缺口',
      version: '2.0.0-crabot',
      skill_dir: join(SKILL_ROOT, 'workspace-context-maintenance'),
      source_type: 'builtin',
      is_builtin: true,
      is_essential: false,
      can_disable: false,
      enabled: true,
      created_at: SEED_TIMESTAMP,
      updated_at: SEED_TIMESTAMP,
    },
  ]
}
