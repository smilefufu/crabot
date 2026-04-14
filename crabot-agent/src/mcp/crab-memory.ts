/**
 * Crab-Memory MCP Server — Agent 长期记忆写入能力
 *
 * 提供 store_memory 工具，让 Worker Agent 在任务执行中将信息写入长期记忆。
 * 通过 RPC 调用 Memory 模块的 write_long_term 端点，不直接修改 Memory 模块代码。
 *
 * @see crabot-docs/protocols/protocol-memory.md §3.2
 * @see crabot-docs/design-records/design-decisions.md §4.3 路径二
 */

import { createMcpServer, type McpServer } from './mcp-helpers.js'
import { z } from 'zod/v4'
import type { RpcClient } from 'crabot-shared'

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
  /** 记忆来源类型，默认 'conversation' */
  sourceType?: 'conversation' | 'reflection' | 'system'
}

// ============================================================================
// MCP Server 创建
// ============================================================================

export function createCrabMemoryServer(
  deps: CrabMemoryDeps,
  ctx: MemoryTaskContext,
): McpServer {
  const { rpcClient, moduleId, getMemoryPort } = deps

  const server = createMcpServer({ name: 'crab-memory', version: '1.0.0' })

  server.tool(
        'store_memory',
        '将信息写入长期记忆。用户要求记住时必须使用；发现有价值的偏好、案例、模式等信息时也应主动使用。',
        {
          content: z.string().describe('要记住的完整信息，应包含足够上下文'),
          importance: z.number().min(1).max(10).optional()
            .describe('重要性 1-10，日常偏好 3-5，重要决策 6-8，关键信息 9-10'),
          tags: z.array(z.string()).optional()
            .describe('分类标签'),
          abstract: z.string().optional()
            .describe('L0 摘要（可选）。面向召回场景写，包含关键场景词和结论'),
          overview: z.string().optional()
            .describe('L1 概览（可选）。结构化经验描述：场景、问题、方案、适用范围'),
        },
        async (args) => {
          try {
            const memoryPort = await getMemoryPort()
            const result = await rpcClient.call(
              memoryPort,
              'write_long_term',
              {
                content: args.content,
                ...(args.abstract && { abstract: args.abstract }),
                ...(args.overview && { overview: args.overview }),
                source: {
                  type: ctx.sourceType ?? 'conversation',
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
  server.tool(
        'search_memory',
        '搜索记忆，返回摘要列表（L0 级别）。可按语义查询、按分类过滤。',
        {
          query: z.string().describe('自然语言搜索查询'),
          level: z.enum(['short_term', 'long_term']).default('long_term')
            .describe('搜索范围：short_term=近期事件流水账, long_term=认知知识库'),
          limit: z.number().min(1).max(20).default(5)
            .describe('返回数量上限'),
        },
        async (args) => {
          try {
            const memoryPort = await getMemoryPort()
            if (args.level === 'short_term') {
              const result = await rpcClient.call(
                memoryPort, 'search_short_term',
                {
                  query: args.query, limit: args.limit,
                  min_visibility: ctx.visibility,
                  ...(ctx.scopes.length > 0 ? { accessible_scopes: ctx.scopes } : {}),
                },
                moduleId
              ) as { results: Array<{ id: string; content: string; event_time: string; topic?: string }> }
              return { content: [{ type: 'text' as const, text: JSON.stringify({ results: result.results }) }] }
            }
            const result = await rpcClient.call(
              memoryPort, 'search_long_term',
              {
                query: args.query, detail: 'L0', limit: args.limit,
                min_visibility: ctx.visibility,
                ...(ctx.scopes.length > 0 ? { accessible_scopes: ctx.scopes } : {}),
              },
              moduleId
            ) as { results: Array<{ memory: { id: string; abstract: string; importance: number; tags: string[]; category: string }; relevance: number }> }
            return {
              content: [{ type: 'text' as const, text: JSON.stringify({
                results: result.results.map(r => ({ ...r.memory, relevance: r.relevance })),
              }) }],
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }] }
          }
        },
      ),
  server.tool(
        'get_memory_detail',
        '获取某条长期记忆的详细内容。先用 search_memory 找到记忆 ID，再用此工具查看详情。',
        {
          memory_id: z.string().describe('记忆 ID'),
          detail: z.enum(['L1', 'L2']).default('L1')
            .describe('详细程度：L1=概览(~2k token), L2=完整内容'),
        },
        async (args) => {
          try {
            const memoryPort = await getMemoryPort()
            const result = await rpcClient.call(
              memoryPort, 'get_memory',
              { memory_id: args.memory_id },
              moduleId
            ) as { memory: Record<string, unknown> }
            const mem = result.memory
            const output = args.detail === 'L1'
              ? { id: mem.id, category: mem.category, abstract: mem.abstract, overview: mem.overview, entities: mem.entities, keywords: mem.keywords, importance: mem.importance, tags: mem.tags, source: mem.source }
              : mem
            return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: message }) }] }
          }
        },
  )

  return server
}
