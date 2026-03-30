/**
 * Crab-Memory MCP Server — Agent 长期记忆写入能力
 *
 * 提供 store_memory 工具，让 Worker Agent 在任务执行中将信息写入长期记忆。
 * 通过 RPC 调用 Memory 模块的 write_long_term 端点，不直接修改 Memory 模块代码。
 *
 * @see crabot-docs/protocols/protocol-memory.md §3.2
 * @see crabot-docs/design-records/design-decisions.md §4.3 路径二
 */

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerConfig as SdkMcpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod/v4'
import type { RpcClient } from '../core/module-base.js'

// ============================================================================
// 依赖注入接口
// ============================================================================

export interface CrabMemoryDeps {
  rpcClient: RpcClient
  moduleId: string
  getMemoryPort: () => Promise<number>
}

/** 每次任务创建时传入的上下文，用于自动填充 source/visibility/scopes */
export interface MemoryTaskContext {
  taskId: string
  channelId?: string
  sessionId?: string
  visibility: 'private' | 'internal' | 'public'
  scopes: string[]
}

// ============================================================================
// MCP Server 创建
// ============================================================================

export function createCrabMemoryServer(
  deps: CrabMemoryDeps,
  ctx: MemoryTaskContext,
): SdkMcpServerConfig {
  const { rpcClient, moduleId, getMemoryPort } = deps

  const server = createSdkMcpServer({
    name: 'crab-memory',
    version: '1.0.0',
    tools: [
      tool(
        'store_memory',
        '将信息写入长期记忆。当用户明确要求记住某些信息时使用。',
        {
          content: z.string().describe('要记住的完整信息，应包含足够上下文'),
          category: z.enum(['profile', 'preference', 'entity', 'event', 'case', 'pattern'])
            .describe('分类：profile=身份属性, preference=偏好习惯, entity=项目/组织知识, event=重要事件, case=问题+方案, pattern=规律/流程'),
          importance: z.number().min(1).max(10).optional()
            .describe('重要性 1-10，日常偏好 3-5，重要决策 6-8，关键信息 9-10'),
          tags: z.array(z.string()).optional()
            .describe('分类标签'),
        },
        async (args) => {
          try {
            const memoryPort = await getMemoryPort()
            const result = await rpcClient.call(
              memoryPort,
              'write_long_term',
              {
                category: args.category,
                content: args.content,
                source: {
                  type: 'conversation' as const,
                  task_id: ctx.taskId,
                  channel_id: ctx.channelId,
                  session_id: ctx.sessionId,
                },
                importance: args.importance ?? 5,
                tags: args.tags,
                visibility: ctx.visibility,
                scopes: ctx.scopes,
              },
              moduleId
            ) as { action: string; memory: { id: string; abstract: string } }

            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: true,
                  action: result.action,
                  memory_id: result.memory?.id,
                  abstract: result.memory?.abstract,
                }),
              }],
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            console.error(`[${moduleId}] store_memory failed:`, message)
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  error: message,
                }),
              }],
            }
          }
        },
      ),
    ],
  })

  return server as unknown as SdkMcpServerConfig
}
