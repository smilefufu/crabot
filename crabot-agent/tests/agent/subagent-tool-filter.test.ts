import { describe, it, expect } from 'vitest'
import {
  buildCapabilitiesForSubAgent,
  buildToolsForSubAgent,
  classifyTool,
  filterToolsForSubAgent,
  permissionConfigForSubAgent,
  selectSubAgentSkills,
} from '../../src/agent/subagent-tool-filter.js'
import { checkToolPermission } from '../../src/engine/permission-checker.js'
import type { ToolDefinition } from '../../src/engine/types.js'
import type { BuiltinCapabilities, SkillConfig } from '../../src/types.js'

function fakeTool(name: string): ToolDefinition {
  return {
    name,
    description: '',
    inputSchema: { type: 'object', properties: {}, required: [] },
    isReadOnly: false,
    call: async (_input, _ctx) => ({ output: '', isError: false }),
  }
}

const ALL_ON: BuiltinCapabilities = {
  file_system: true, shell: true, task_intel: true, crab_memory: true, crab_messaging: true,
}
const ALL_OFF: BuiltinCapabilities = {
  file_system: false, shell: false, task_intel: false, crab_memory: false, crab_messaging: false,
}

const SKILLS: SkillConfig[] = [
  { id: 'skill-a', name: 'skill-a', description: 'A', skill_dir: '/skills/a' },
  { id: 'skill-b', name: 'skill-b', description: 'B', skill_dir: '/skills/b' },
  {
    id: 'builtin-systematic-debugging',
    name: 'systematic-debugging',
    description: 'Debugging',
    skill_dir: '/skills/systematic-debugging',
  },
  { id: 'tmp-page', name: 'tmp-page', description: 'Tmp page', skill_dir: '/skills/tmp-page' },
  {
    id: 'workspace-context',
    name: 'workspace-context-maintenance',
    description: 'Workspace context',
    skill_dir: '/skills/workspace-context-maintenance',
  },
  { id: 'crabot-cli', name: 'crabot-cli', description: 'CLI', skill_dir: '/skills/crabot-cli' },
  {
    id: 'memory-graph-linking',
    name: 'memory-graph-linking',
    description: 'Memory graph',
    skill_dir: '/skills/memory-graph-linking',
  },
]

describe('classifyTool', () => {
  it.each([
    ['Read', 'file_system'],
    ['Write', 'file_system'],
    ['Edit', 'file_system'],
    ['Glob', 'file_system'],
    ['Grep', 'file_system'],
    ['Bash', 'shell'],
    ['Output', 'shell'],
    ['Kill', 'shell'],
    ['ListEntities', 'shell'],
    ['find_task', 'task_intel'],
    ['get_task_progress', 'task_intel'],
    ['mcp__crab-memory__search_short_term', 'crab_memory'],
    ['mcp__crab-memory__remember', 'crab_memory'],
    ['mcp__crab-messaging__send_message', 'crab_messaging'],
    ['mcp__crab-image__generate_image', 'crab_image'],
    ['Skill', 'skill_loading'],
    ['mcp__user-mcp-x__some_tool', 'mcp_user'],
    ['delegate_task', 'delegate_task'],
    ['end_turn', 'unknown'],
    ['UnknownTool', 'unknown'],
  ])('classifyTool("%s") === %s', (name, expected) => {
    expect(classifyTool(name)).toBe(expected)
  })
})

describe('filterToolsForSubAgent', () => {
  it('全开旧配置仍排除 Memory、父 Skill、mcp_user 与 delegate_task', () => {
    const tools = [
      fakeTool('Read'), fakeTool('Bash'), fakeTool('get_task_progress'),
      fakeTool('mcp__crab-memory__remember'), fakeTool('mcp__user-mcp-x__do'),
      fakeTool('Skill'), fakeTool('delegate_task'),
    ]
    const out = filterToolsForSubAgent(tools, ALL_ON, [])
    const names = out.map((t) => t.name)
    expect(names).toContain('Read')
    expect(names).toContain('Bash')
    expect(names).toContain('get_task_progress')
    expect(names).not.toContain('mcp__crab-memory__remember')
    expect(names).not.toContain('mcp__user-mcp-x__do')      // 白名单空
    expect(names).not.toContain('Skill')                    // skill 白名单空
    expect(names).not.toContain('delegate_task')            // 永远剔除
  })

  it('旧配置即使 crab_messaging=true 也不能向 direct child 下发人类消息工具', () => {
    const tools = [fakeTool('mcp__crab-messaging__send_message')]
    const out = filterToolsForSubAgent(tools, ALL_ON, [])
    expect(out).toHaveLength(0)
  })

  it('direct child 即使把 crab-image 写入 MCP 白名单也不能取得 builtin-only 生图', () => {
    const tools = [fakeTool('mcp__crab-image__generate_image')]
    const out = filterToolsForSubAgent(tools, ALL_ON, ['crab-image'])
    expect(out).toHaveLength(0)
  })

  it('按 allowed_skill_ids 从完整 catalog 重建专属 Skill loader，不复用父实例', () => {
    const parentSkill = fakeTool('Skill')
    const out = buildToolsForSubAgent({
      parentTools: [parentSkill],
      capabilities: ALL_ON,
      allowedMcpServerIds: [],
      allowedSkillIds: ['skill-b'],
      availableSkills: SKILLS,
    })

    expect(selectSubAgentSkills(SKILLS, ['skill-b']).map((skill) => skill.name)).toEqual(['skill-b'])
    expect(out.map((tool) => tool.name)).toEqual(['Skill'])
    expect(out[0]).not.toBe(parentSkill)
  })

  it('第三方 Skill 权限关闭时仍放行 profile 内置 Skill，并在执行期保留其它 deny', async () => {
    const capabilities = buildCapabilitiesForSubAgent({
      parentTools: [fakeTool('Skill'), fakeTool('Bash')],
      capabilities: ALL_ON,
      allowedMcpServerIds: [],
      allowedSkillIds: ['skill-b', 'builtin-systematic-debugging'],
      availableSkills: SKILLS,
      allowPermissionGatedSkills: false,
    })
    const permissionConfig = permissionConfigForSubAgent(
      { mode: 'denyList', toolNames: ['Skill', 'Bash'] },
      capabilities.skills,
    )
    const skillTool = capabilities.tools.find((tool) => tool.name === 'Skill')!
    const bashTool = capabilities.tools.find((tool) => tool.name === 'Bash')!

    expect(capabilities.skills.map((skill) => skill.name)).toEqual(['systematic-debugging'])
    await expect(checkToolPermission('Skill', { skill: 'systematic-debugging' }, skillTool, permissionConfig))
      .resolves.toEqual({ allowed: true })
    await expect(checkToolPermission('Bash', {}, bashTool, permissionConfig))
      .resolves.toMatchObject({ allowed: false })
  })

  it('allowed_skill_ids 引用缺失 Skill 时 fail-loud，空白名单不装 loader', () => {
    expect(() => buildToolsForSubAgent({
      parentTools: [fakeTool('Skill')],
      capabilities: ALL_ON,
      allowedMcpServerIds: [],
      allowedSkillIds: ['missing-skill'],
      availableSkills: SKILLS,
    })).toThrow('allowed Skill unavailable: missing-skill')

    expect(buildToolsForSubAgent({
      parentTools: [fakeTool('Skill')],
      capabilities: ALL_ON,
      allowedMcpServerIds: [],
      allowedSkillIds: [],
      availableSkills: SKILLS,
    })).toEqual([])
  })

  it('crabot-cli 和 memory-graph-linking 等非 Agent Skill 即使出现在旧白名单中也 fail-loud', () => {
    for (const id of ['crabot-cli', 'memory-graph-linking']) {
      expect(() => buildToolsForSubAgent({
        parentTools: [fakeTool('Skill')],
        capabilities: ALL_ON,
        allowedMcpServerIds: [],
        allowedSkillIds: [id],
        availableSkills: SKILLS,
      })).toThrow(`Skill not available to any Agent: ${id}`)
    }
  })

  it('主线 Worker 专用 Skill 即使写入白名单也不能下发给 direct child', () => {
    for (const id of ['tmp-page', 'workspace-context']) {
      expect(() => buildToolsForSubAgent({
        parentTools: [fakeTool('Skill')],
        capabilities: ALL_ON,
        allowedMcpServerIds: [],
        allowedSkillIds: [id],
        availableSkills: SKILLS,
      })).toThrow('Skill unavailable to builtin direct child')
    }
  })

  it('mcp 白名单按 server_id 过滤', () => {
    const tools = [fakeTool('mcp__alpha__do'), fakeTool('mcp__beta__do')]
    const out = filterToolsForSubAgent(tools, ALL_ON, ['alpha'])
    expect(out.map((t) => t.name)).toEqual(['mcp__alpha__do'])
  })

  it('全关 + 空白名单 → 空工具集（包括 delegate_task）', () => {
    const tools = [fakeTool('Read'), fakeTool('Bash'), fakeTool('delegate_task')]
    expect(filterToolsForSubAgent(tools, ALL_OFF, [])).toHaveLength(0)
  })

  it('UnknownTool（未分类）也被剔除', () => {
    const tools = [fakeTool('Read'), fakeTool('SomeRandomTool')]
    const out = filterToolsForSubAgent(tools, ALL_ON, [])
    expect(out.map((t) => t.name)).toEqual(['Read'])
  })

  it('end_turn 是 main-only，即使 shell capability 开启也不注入 subagent', () => {
    const tools = [fakeTool('Bash'), fakeTool('Output'), fakeTool('end_turn')]
    const out = filterToolsForSubAgent(tools, ALL_ON, [])
    expect(out.map((t) => t.name)).toEqual(['Bash', 'Output'])
  })
})
