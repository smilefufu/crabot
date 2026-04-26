/**
 * crab-memory MCP server ↔ 内置 SKILL.md 引用契约测试。
 *
 * 防御真实踩过的坑：daily-reflection / quick-reflection SKILL.md 写了一堆
 * mcp__crab-memory__quick_capture / update_long_term / run_maintenance 等
 * 工具调用，但 crab-memory.ts 里压根没注册——内置 schedule 触发反思时全
 * "tool not found"，自学习闭环空转。
 *
 * 此测试静态对账两侧：
 *   - 左：crab-memory.ts 里 server.tool('NAME', ...) 注册集合
 *   - 右：crabot-admin/builtins/skills/<*>/SKILL.md 里 mcp__crab-memory__NAME 引用集合
 * 任何 SKILL 引用的 tool 不在注册集合里 → 直接 fail。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.join(__dirname, '..', '..', '..')
const CRAB_MEMORY_TS = path.join(REPO_ROOT, 'crabot-agent', 'src', 'mcp', 'crab-memory.ts')
const SKILLS_DIR = path.join(REPO_ROOT, 'crabot-admin', 'builtins', 'skills')

function extractRegisteredToolNames(): Set<string> {
  const src = fs.readFileSync(CRAB_MEMORY_TS, 'utf-8')
  const matches = src.matchAll(/server\.tool\(\s*['"]([a-z_][a-z0-9_]*)['"]/g)
  return new Set(Array.from(matches, (m) => m[1]))
}

function extractSkillReferences(): Map<string, Set<string>> {
  const refsBySkill = new Map<string, Set<string>>()
  if (!fs.existsSync(SKILLS_DIR)) return refsBySkill
  for (const skillDir of fs.readdirSync(SKILLS_DIR)) {
    const skillFile = path.join(SKILLS_DIR, skillDir, 'SKILL.md')
    if (!fs.existsSync(skillFile)) continue
    const md = fs.readFileSync(skillFile, 'utf-8')
    const refs = new Set<string>()
    for (const m of md.matchAll(/mcp__crab-memory__([a-z_][a-z0-9_]*)/g)) {
      refs.add(m[1])
    }
    if (refs.size > 0) refsBySkill.set(skillDir, refs)
  }
  return refsBySkill
}

describe('crab-memory MCP server ↔ SKILL.md 引用契约', () => {
  it('crab-memory.ts 至少注册 4 个工具（基础锚点）', () => {
    const tools = extractRegisteredToolNames()
    expect(tools.size).toBeGreaterThanOrEqual(4)
  })

  it('SKILL.md 引用的每个 mcp__crab-memory__* 都必须在 crab-memory.ts 注册', () => {
    const registered = extractRegisteredToolNames()
    const refsBySkill = extractSkillReferences()

    const violations: string[] = []
    for (const [skill, refs] of refsBySkill) {
      for (const ref of refs) {
        if (!registered.has(ref)) {
          violations.push(`${skill}/SKILL.md → mcp__crab-memory__${ref}`)
        }
      }
    }

    expect(
      violations,
      `SKILL 引用了未在 crab-memory.ts 注册的工具，跑起来必 "tool not found":\n  ` +
        violations.join('\n  '),
    ).toEqual([])
  })
})
