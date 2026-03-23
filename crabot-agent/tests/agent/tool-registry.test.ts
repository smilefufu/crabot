import { describe, it, expect, vi } from 'vitest'
import { ToolRegistry } from '../../src/agent/tool-registry.js'
import type { ToolDeclaration, ToolHandler } from '../../src/types.js'

describe('ToolRegistry', () => {
  describe('registerTool', () => {
    it('应该成功注册工具', () => {
      const registry = new ToolRegistry()
      const declaration: ToolDeclaration = {
        name: 'test_tool',
        description: 'A test tool',
        source: 'builtin',
        input_schema: { type: 'object', properties: {} }
      }
      const handler: ToolHandler = vi.fn().mockResolvedValue({ success: true })

      registry.registerTool(declaration, handler)

      expect(registry.count).toBe(1)
    })

    it('应该覆盖同名工具', () => {
      const registry = new ToolRegistry()
      const declaration1: ToolDeclaration = {
        name: 'test_tool',
        description: 'First version',
        source: 'builtin',
        input_schema: { type: 'object', properties: {} }
      }
      const declaration2: ToolDeclaration = {
        name: 'test_tool',
        description: 'Second version',
        source: 'builtin',
        input_schema: { type: 'object', properties: {} }
      }
      const handler1: ToolHandler = vi.fn()
      const handler2: ToolHandler = vi.fn()

      registry.registerTool(declaration1, handler1)
      registry.registerTool(declaration2, handler2)

      expect(registry.count).toBe(1)
      const declarations = registry.getToolDeclarations()
      expect(declarations[0].description).toBe('Second version')
    })
  })

  describe('getToolDeclarations', () => {
    it('应该返回所有工具声明', () => {
      const registry = new ToolRegistry()
      const decl1: ToolDeclaration = {
        name: 'tool1',
        description: 'Tool 1',
        source: 'builtin',
        input_schema: { type: 'object', properties: {} }
      }
      const decl2: ToolDeclaration = {
        name: 'tool2',
        description: 'Tool 2',
        source: 'builtin',
        input_schema: { type: 'object', properties: {} }
      }

      registry.registerTool(decl1, vi.fn())
      registry.registerTool(decl2, vi.fn())

      const declarations = registry.getToolDeclarations()
      expect(declarations).toHaveLength(2)
      expect(declarations.map(d => d.name)).toEqual(['tool1', 'tool2'])
    })
  })

  describe('toAnthropicTools', () => {
    it('应该转换为 Anthropic 工具格式', () => {
      const registry = new ToolRegistry()
      const declaration: ToolDeclaration = {
        name: 'test_tool',
        description: 'A test tool',
        source: 'builtin',
        input_schema: {
          type: 'object',
          properties: {
            param1: { type: 'string' }
          },
          required: ['param1']
        }
      }

      registry.registerTool(declaration, vi.fn())

      const anthropicTools = registry.toAnthropicTools()
      expect(anthropicTools).toHaveLength(1)
      expect(anthropicTools[0]).toEqual({
        name: 'test_tool',
        description: 'A test tool',
        input_schema: {
          type: 'object',
          properties: {
            param1: { type: 'string' }
          },
          required: ['param1']
        }
      })
    })
  })

  describe('executeTool', () => {
    it('应该成功执行工具', async () => {
      const registry = new ToolRegistry()
      const declaration: ToolDeclaration = {
        name: 'test_tool',
        description: 'A test tool',
        source: 'builtin',
        input_schema: { type: 'object', properties: {} }
      }
      const handler: ToolHandler = vi.fn().mockResolvedValue({ result: 'success' })

      registry.registerTool(declaration, handler)

      const result = await registry.executeTool('test_tool', { input: 'test' })

      expect(result).toEqual({ result: 'success' })
      expect(handler).toHaveBeenCalledWith({ input: 'test' })
    })

    it('应该抛出错误如果工具不存在', async () => {
      const registry = new ToolRegistry()

      await expect(
        registry.executeTool('nonexistent_tool', {})
      ).rejects.toThrow('Tool not found: nonexistent_tool')
    })

    it('应该捕获工具执行错误', async () => {
      const registry = new ToolRegistry()
      const declaration: ToolDeclaration = {
        name: 'failing_tool',
        description: 'A failing tool',
        source: 'builtin',
        input_schema: { type: 'object', properties: {} }
      }
      const handler: ToolHandler = vi.fn().mockRejectedValue(new Error('Tool failed'))

      registry.registerTool(declaration, handler)

      await expect(
        registry.executeTool('failing_tool', {})
      ).rejects.toThrow('Tool execution failed: Tool failed')
    })
  })

  describe('count', () => {
    it('应该返回正确的工具数量', () => {
      const registry = new ToolRegistry()

      expect(registry.count).toBe(0)

      registry.registerTool(
        { name: 'tool1', description: 'Tool 1', source: 'builtin', input_schema: {} },
        vi.fn()
      )
      expect(registry.count).toBe(1)

      registry.registerTool(
        { name: 'tool2', description: 'Tool 2', source: 'builtin', input_schema: {} },
        vi.fn()
      )
      expect(registry.count).toBe(2)
    })
  })
})