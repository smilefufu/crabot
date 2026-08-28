/**
 * crab-memory MCP server ↔ 内置 SKILL.md 引用契约测试。
 *
 * 防御仓库保留的 Memory workflow 文档引用
 * mcp__crab-memory__quick_capture / update_long_term 等工具，但 crab-memory.ts
 * 没有注册。该文档不作为 Agent Skill 下发，静态对账只用于防止 workflow 规则漂移。
 *
 * 此测试静态对账两侧：
 *   - 左：crab-memory.ts 里 server.registerTool('NAME', ...) 注册集合
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
  const matches = src.matchAll(/server\.registerTool\(\s*['"]([a-z_][a-z0-9_]*)['"]/g)
  return new Set(Array.from(matches, (m) => m[1]))
}

function extractToolDescription(toolName: string): string {
  const src = fs.readFileSync(CRAB_MEMORY_TS, 'utf-8')
  // Locate the registerTool call for this tool, then grab 2000 chars after "description:" keyword.
  // This handles multi-line string concatenation correctly.
  const toolStart = src.search(
    new RegExp(`server\\.registerTool\\(\\s*['"]${toolName}['"]`),
  )
  if (toolStart === -1) return ''
  const descStart = src.indexOf('description:', toolStart)
  if (descStart === -1) return ''
  // Return 2000 chars of source starting from "description:" — callers do toContain checks.
  return src.slice(descStart, descStart + 2000)
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

describe('crab-memory 反思建链工具（P2-T6）', () => {
  it('注册了 list_entries 与 set_memory_links', () => {
    const tools = extractRegisteredToolNames()
    expect(tools).toContain('list_entries')
    expect(tools).toContain('set_memory_links')
  })

  it('set_memory_links 的 relation 词表恰好是 4 个受控值', () => {
    const src = fs.readFileSync(CRAB_MEMORY_TS, 'utf-8')
    const schemaIdx = src.indexOf('SET_MEMORY_LINKS_SCHEMA')
    expect(schemaIdx).toBeGreaterThan(-1)
    const enumMatch = src
      .slice(schemaIdx, schemaIdx + 600)
      .match(/relation:\s*z\.enum\(\[([^\]]*)\]\)/)
    expect(enumMatch).not.toBeNull()
    const relations = (enumMatch![1].match(/'([a-z_]+)'/g) ?? []).map((s) => s.replace(/'/g, ''))
    expect(relations.sort()).toEqual(['depends_on', 'part_of', 'refines', 'related'])
  })

  it('set_memory_links 底层映射到 update_long_term 的 links patch', () => {
    const desc = extractToolDescription('set_memory_links')
    // 注册体里透传 callRpc('update_long_term', { ... patch: { links } })
    const src = fs.readFileSync(CRAB_MEMORY_TS, 'utf-8')
    const toolStart = src.search(/server\.registerTool\(\s*['"]set_memory_links['"]/)
    const body = src.slice(toolStart, toolStart + 600)
    expect(body).toContain("callRpc('update_long_term'")
    expect(body).toContain('patch: { links:')
    expect(desc).toContain('relation')
  })
})

describe('crab-memory.set_scene_profile（合并版 E.1）', () => {
  it('工具列表中含 set_scene_profile，不含 set_scene_anchor / upsert_scene_profile', () => {
    const toolNames = extractRegisteredToolNames()
    expect(toolNames).toContain('set_scene_profile')
    expect(toolNames).not.toContain('set_scene_anchor')
    expect(toolNames).not.toContain('upsert_scene_profile')
  })

  it('description 强调"覆盖式写入"/"已在你 prompt 顶部"/"store_memory"边界', () => {
    const desc = extractToolDescription('set_scene_profile')
    expect(desc).toContain('覆盖')
    expect(desc).toContain('已在你 prompt 顶部')
    expect(desc).toContain('store_memory')
  })
})
