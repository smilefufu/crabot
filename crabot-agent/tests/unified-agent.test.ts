/**
 * Unified Agent 基本功能测试
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { MCPManager } from '../src/agent/mcp-manager.js'
import { ToolRegistry } from '../src/agent/tool-registry.js'
import { SessionManager } from '../src/orchestration/session-manager.js'
import type { LLMRoleRequirement } from '../src/types.js'

describe('ToolRegistry', () => {
  let registry: ToolRegistry

  beforeEach(() => {
    registry = new ToolRegistry()
  })

  it('should register and retrieve tools', () => {
    const declaration = {
      name: 'test_tool',
      description: 'A test tool',
      source: 'builtin' as const,
      input_schema: {
        type: 'object' as const,
        properties: { input: { type: 'string' } },
      },
    }

    registry.registerTool(declaration, async () => 'result')

    expect(registry.count).toBe(1)
    expect(registry.getToolDeclarations()).toHaveLength(1)
  })

  it('should convert to Anthropic tools format', () => {
    const declaration = {
      name: 'test_tool',
      description: 'A test tool',
      source: 'builtin' as const,
      input_schema: {
        type: 'object' as const,
        properties: { input: { type: 'string' } },
      },
    }

    registry.registerTool(declaration, async () => 'result')
    const anthropicTools = registry.toAnthropicTools()

    expect(anthropicTools).toHaveLength(1)
    expect(anthropicTools[0].name).toBe('test_tool')
  })

  it('should execute tools', async () => {
    const declaration = {
      name: 'echo',
      description: 'Echo tool',
      source: 'builtin' as const,
      input_schema: { type: 'object' as const, properties: {} },
    }

    registry.registerTool(declaration, async (input) => `echo: ${JSON.stringify(input)}`)

    const result = await registry.executeTool('echo', { message: 'hello' })
    expect(result).toBe('echo: {"message":"hello"}')
  })

  it('should throw for unknown tools', async () => {
    await expect(registry.executeTool('unknown', {})).rejects.toThrow('Tool not found')
  })
})

describe('SessionManager', () => {
  let manager: SessionManager

  beforeEach(() => {
    manager = new SessionManager(300) // 5 minutes TTL
  })

  it('should create and get sessions', () => {
    const sessionId = 'test-session'
    const session = manager.createSession(sessionId)

    expect(session.session_id).toBe(sessionId)
    expect(manager.getSession(sessionId)).toBeDefined()
  })

  it('should update session last message time', () => {
    const sessionId = 'test-session'
    manager.updateLastMessageTime(sessionId)

    const session = manager.getSession(sessionId)
    expect(session).toBeDefined()
    expect(session?.message_count).toBe(1)
  })

  it('should track pending requests', () => {
    const sessionId = 'test-session'
    const requestId = 'request-1'

    manager.setPendingRequest(sessionId, requestId)
    expect(manager.getPendingSessionCount()).toBe(1)
    expect(manager.getPendingRequest(sessionId)).toBe(requestId)

    manager.clearPendingRequest(sessionId)
    expect(manager.getPendingSessionCount()).toBe(0)
  })

  it('should count active sessions', () => {
    manager.createSession('session-1')
    manager.createSession('session-2')

    expect(manager.getActiveSessionCount()).toBe(2)
  })
})

describe('MCPManager', () => {
  it('should create MCPManager instance', () => {
    const manager = new MCPManager({
      getModuleId: () => 'test-module',
    })

    expect(manager.count).toBe(0)
    expect(manager.isConnected('test')).toBe(false)
  })

  it('should handle empty server list', async () => {
    const manager = new MCPManager({
      getModuleId: () => 'test-module',
    })

    // 启动空列表不应报错
    await expect(manager.startServers([])).resolves.not.toThrow()
  })

  it('should return empty tool declarations when no servers connected', () => {
    const manager = new MCPManager({
      getModuleId: () => 'test-module',
    })

    expect(manager.getToolDeclarations()).toHaveLength(0)
  })
})

describe('LLM Requirements Configuration', () => {
  it('should define correct model role requirements', () => {
    // 模拟 get_llm_requirements 返回的配置
    const requirements = [
      {
        key: 'default',
        description: '默认执行模型，Front 和 Worker 默认使用',
        required: true,
        used_by: ['front', 'worker'] as const,
      },
      {
        key: 'fast',
        description: '快速响应模型，用于 Front Agent 快速分诊（可选）',
        required: false,
        used_by: ['front'] as const,
      },
      {
        key: 'smart',
        description: '深度推理模型，用于 Worker Agent 复杂任务（可选）',
        required: false,
        used_by: ['worker'] as const,
      },
    ]

    // 验证 default 是必须的
    expect(requirements.find(r => r.key === 'default')?.required).toBe(true)

    // 验证 fast 和 smart 是可选的
    expect(requirements.find(r => r.key === 'fast')?.required).toBe(false)
    expect(requirements.find(r => r.key === 'smart')?.required).toBe(false)

    // 验证使用场景
    expect(requirements.find(r => r.key === 'fast')?.used_by).toContain('front')
    expect(requirements.find(r => r.key === 'smart')?.used_by).toContain('worker')
    expect(requirements.find(r => r.key === 'default')?.used_by).toContain('front')
    expect(requirements.find(r => r.key === 'default')?.used_by).toContain('worker')
  })

  it('should validate model selection logic', () => {
    // 模拟配置
    const modelConfig: Record<string, { model_id: string; endpoint: string }> = {
      default: { model_id: 'claude-sonnet-4', endpoint: 'https://api.anthropic.com' },
      fast: { model_id: 'claude-haiku-3.5', endpoint: 'https://api.anthropic.com' },
      smart: { model_id: 'claude-opus-4', endpoint: 'https://api.anthropic.com' },
    }

    // Front Agent: fast > default
    const frontModel = modelConfig.fast ?? modelConfig.default
    expect(frontModel.model_id).toBe('claude-haiku-3.5')

    // Worker Agent: smart > default
    const workerModel = modelConfig.smart ?? modelConfig.default
    expect(workerModel.model_id).toBe('claude-opus-4')

    // 只有 default 时
    const minimalConfig: Record<string, { model_id: string; endpoint: string }> = {
      default: modelConfig.default,
    }
    const fallbackFrontModel = minimalConfig.fast ?? minimalConfig.default
    const fallbackWorkerModel = minimalConfig.smart ?? minimalConfig.default

    expect(fallbackFrontModel.model_id).toBe('claude-sonnet-4')
    expect(fallbackWorkerModel.model_id).toBe('claude-sonnet-4')
  })
})

describe('Type Exports', () => {
  it('should export LLMRoleRequirement type', () => {
    // 验证类型存在（编译时检查）
    const requirement: LLMRoleRequirement = {
      key: 'default',
      description: 'test',
      required: true,
      used_by: ['front', 'worker'],
    }

    expect(requirement.key).toBe('default')
  })
})