import { describe, it, expect } from 'vitest'
import { classifyTool, filterToolsForSubAgent } from '../../src/agent/subagent-tool-filter.js'
import type { ToolDefinition } from '../../src/engine/types.js'
import type { BuiltinCapabilities } from '../../src/types.js'

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
  it('全开能力 + 空 mcp/skill 白名单 → 通过 builtin + 排除 mcp_user/skill/delegate_task', () => {
    const tools = [
      fakeTool('Read'), fakeTool('Bash'), fakeTool('get_task_progress'),
      fakeTool('mcp__crab-memory__remember'), fakeTool('mcp__user-mcp-x__do'),
      fakeTool('Skill'), fakeTool('delegate_task'),
    ]
    const out = filterToolsForSubAgent(tools, ALL_ON, [], [])
    const names = out.map((t) => t.name)
    expect(names).toContain('Read')
    expect(names).toContain('Bash')
    expect(names).toContain('get_task_progress')
    expect(names).toContain('mcp__crab-memory__remember')
    expect(names).not.toContain('mcp__user-mcp-x__do')      // 白名单空
    expect(names).not.toContain('Skill')                    // skill 白名单空
    expect(names).not.toContain('delegate_task')            // 永远剔除
  })

  it('crab_messaging=off 时排除 messaging 工具', () => {
    const tools = [fakeTool('mcp__crab-messaging__send_message')]
    const out = filterToolsForSubAgent(tools, { ...ALL_ON, crab_messaging: false }, [], [])
    expect(out).toHaveLength(0)
  })

  it('skill 白名单非空时注入 Skill 工具', () => {
    const tools = [fakeTool('Skill')]
    const out = filterToolsForSubAgent(tools, ALL_ON, [], ['skill-id-1'])
    expect(out.map((t) => t.name)).toContain('Skill')
  })

  it('mcp 白名单按 server_id 过滤', () => {
    const tools = [fakeTool('mcp__alpha__do'), fakeTool('mcp__beta__do')]
    const out = filterToolsForSubAgent(tools, ALL_ON, ['alpha'], [])
    expect(out.map((t) => t.name)).toEqual(['mcp__alpha__do'])
  })

  it('全关 + 空白名单 → 空工具集（包括 delegate_task）', () => {
    const tools = [fakeTool('Read'), fakeTool('Bash'), fakeTool('delegate_task')]
    expect(filterToolsForSubAgent(tools, ALL_OFF, [], [])).toHaveLength(0)
  })

  it('UnknownTool（未分类）也被剔除', () => {
    const tools = [fakeTool('Read'), fakeTool('SomeRandomTool')]
    const out = filterToolsForSubAgent(tools, ALL_ON, [], [])
    expect(out.map((t) => t.name)).toEqual(['Read'])
  })

  it('end_turn 是 main-only，即使 shell capability 开启也不注入 subagent', () => {
    const tools = [fakeTool('Bash'), fakeTool('Output'), fakeTool('end_turn')]
    const out = filterToolsForSubAgent(tools, ALL_ON, [], [])
    expect(out.map((t) => t.name)).toEqual(['Bash', 'Output'])
  })
})
