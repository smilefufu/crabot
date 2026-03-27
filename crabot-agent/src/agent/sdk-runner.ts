/**
 * SDK Runner - 统一的 Claude Agent SDK 调用封装
 *
 * Front/Worker 通过不同参数调用，共用一套 SDK 调用逻辑
 *
 * @see @anthropic-ai/claude-agent-sdk
 */

import {
  query,
  createSdkMcpServer,
  tool,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  Options as SdkOptions,
  SDKMessage,
  McpServerConfig as SdkMcpServerConfig,
} from '@anthropic-ai/claude-agent-sdk'
import type { SdkRunResult, TraceCallback } from '../types.js'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'

const LOG_FILE = path.join(process.cwd(), '../data/sdk-runner-debug.log')
function log(msg: string) {
  const ts = new Date().toISOString()
  try { fs.appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`) } catch { /* ignore */ }
}

/** 查找 Claude Code CLI 路径 */
function findClaudeCodePath(): string | undefined {
  try {
    return execSync('which claude', { encoding: 'utf-8' }).trim() || undefined
  } catch {
    return undefined
  }
}

/**
 * SDK 调用参数
 */
export interface SdkRunOptions {
  /** 组装好的用户消息 */
  prompt: string
  /** 系统提示词 */
  systemPrompt: string
  /** LiteLLM 模型名 */
  model: string
  /** 环境变量（ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY） */
  env: Record<string, string>
  /** 最大轮次（Front: 1, Worker: 20） */
  maxTurns?: number
  /** MCP 工具服务器 */
  mcpServers?: Record<string, SdkMcpServerConfig>
  /** 允许的工具列表 */
  allowedTools?: string[]
  /** 结构化输出（Front 用） */
  outputFormat?: { type: 'json_schema'; schema: Record<string, unknown> }
  /** 取消控制器 */
  abortController?: AbortController
  /** Trace 回调 */
  traceCallback?: TraceCallback
  /** Trace loop 标签（front / worker） */
  loopLabel?: string
  /** Working directory for the SDK process */
  cwd?: string
  /** Callback for progress reporting */
  progressCallback?: (summary: string) => Promise<void>
}

/** 导出 SDK 工具创建函数供 Worker 使用 */
export { createSdkMcpServer, tool }
export type { SdkMcpServerConfig }

/**
 * 执行 SDK 调用
 *
 * 调用 query() 获取 async iterator，遍历 SDKMessage 按类型处理：
 * - system (init) → 记录 tools、model、mcp_servers、skills
 * - assistant → 提取文本和工具调用
 * - result → 提取最终结果和 token 用量
 */
export async function runSdk(options: SdkRunOptions): Promise<SdkRunResult> {
  const {
    prompt,
    systemPrompt,
    model,
    env,
    maxTurns,
    mcpServers,
    allowedTools,
    outputFormat,
    abortController,
    traceCallback,
    loopLabel,
    cwd,
    progressCallback,
  } = options

  // 构建 SDK Options — 清理环境变量，确保不被 shell 残留值干扰
  const claudePath = findClaudeCodePath()
  log(`claudePath: ${claudePath ?? 'NOT FOUND'}`)
  const cleanEnv = { ...process.env, ...env } as Record<string, string | undefined>
  // 清除可能干扰的 auth token
  // ~/.claude/settings.json 的 env.ANTHROPIC_AUTH_TOKEN 会让 CLI 优先连 Anthropic 官方 API
  // 而非我们指定的 ANTHROPIC_BASE_URL（LiteLLM），必须显式覆盖
  // 注意：必须用 delete 而非赋空字符串。空字符串会让 Anthropic SDK 发 "Authorization: Bearer "
  // (空 token)，LiteLLM 1.82+ 会拒绝认证。undefined 才能让 SDK 跳过 Authorization header。
  delete cleanEnv.ANTHROPIC_AUTH_TOKEN
  const sdkOptions: SdkOptions = {
    systemPrompt,
    model,
    env: cleanEnv,
    maxTurns,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    persistSession: false,
    settingSources: ['project'],
    // 不设置 tools，让 SDK 使用默认工具集（Bash, Read, Write, Glob, Grep 等）
    // LiteLLM 代理的非 Anthropic 模型不支持 thinking，必须禁用
    thinking: { type: 'disabled' },
    // 使用全局安装的 claude 命令
    ...(claudePath && { pathToClaudeCodeExecutable: claudePath }),
    ...(mcpServers && { mcpServers }),
    ...(allowedTools && { allowedTools }),
    ...(outputFormat && { outputFormat }),
    ...(abortController && { abortController }),
    ...(cwd && { cwd }),
    stderr: (data: string) => {
      if (data.trim()) log(`stderr: ${data.trim().slice(0, 500)}`)
    },
  }

  const result: SdkRunResult = {
    text: '',
    toolCalls: [],
  }

  let loopSpanId: string | undefined
  let turnCount = 0
  let lastProgressTime = Date.now()

  try {
    log(`Starting query: model=${model}, maxTurns=${maxTurns}, hasOutputFormat=${!!outputFormat}`)
    log(`env: ANTHROPIC_BASE_URL=${env.ANTHROPIC_BASE_URL}, ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY?.slice(0, 8)}...`)
    const stream = query({ prompt, options: sdkOptions })

    for await (const message of stream) {
      const msg = message as SDKMessage & Record<string, unknown>
      log(`Message type=${msg.type}, subtype=${(msg as Record<string, unknown>).subtype ?? 'none'}`)


      switch (msg.type) {
        case 'system': {
          // init 事件 — 记录 SDK 初始化信息
          if (msg.subtype === 'init') {
            log(`System init: model=${msg.model}, tools=${JSON.stringify(msg.tools)}, permissionMode=${(msg as Record<string, unknown>).permissionMode}`)
            result.initEvent = {
              tools: (msg.tools as string[]) ?? [],
              mcp_servers: (msg.mcp_servers as Array<{ name: string; status: string }>) ?? [],
              model: (msg.model as string) ?? model,
              skills: (msg.skills as string[]) ?? [],
            }

            loopSpanId = traceCallback?.onLoopStart(
              loopLabel ?? (maxTurns === 1 ? 'front' : 'worker'),
              { ...result.initEvent, system_prompt: systemPrompt }
            )
          }
          break
        }

        case 'assistant': {
          log(`Assistant: ${JSON.stringify(msg).slice(0, 500)}`)
          const betaMessage = msg.message as {
            content?: Array<{ type: string; text?: string; name?: string; input?: unknown; id?: string }>
            stop_reason?: string
          }

          // LLM call span — 每个 assistant 事件对应一次 LLM 调用
          const inputSummary = turnCount === 0
            ? prompt.slice(0, 150)
            : `(turn ${turnCount + 1}, continuation)`
          const llmSpanId = traceCallback?.onLlmCallStart(turnCount + 1, inputSummary)

          let turnText = ''
          let toolUseCount = 0

          if (betaMessage?.content) {
            for (const block of betaMessage.content) {
              if (block.type === 'text' && block.text) {
                result.text += block.text
                turnText += block.text
              }
              if (block.type === 'tool_use' && block.name) {
                result.toolCalls.push({
                  name: block.name,
                  input: block.input,
                  output: undefined as unknown,
                })
                toolUseCount++
                // 记录工具调用 span（SDK 内部执行，无法获取输出）
                const toolSpanId = traceCallback?.onToolCallStart(
                  block.name,
                  JSON.stringify(block.input ?? {}).slice(0, 200)
                )
                if (toolSpanId) {
                  traceCallback?.onToolCallEnd(toolSpanId, '(executed by Claude Agent SDK)')
                }
              }
            }
          }

          if (llmSpanId) {
            traceCallback?.onLlmCallEnd(llmSpanId, {
              stopReason: betaMessage?.stop_reason,
              outputSummary: turnText.slice(0, 200) || undefined,
              toolCallsCount: toolUseCount > 0 ? toolUseCount : undefined,
            })
          }

          turnCount++

          // Progress reporting
          if (progressCallback && turnCount > 0) {
            const shouldReport =
              turnCount === 1 ||
              turnCount % 3 === 0 ||
              (Date.now() - lastProgressTime) > 30_000

            if (shouldReport) {
              const summary = turnText.slice(0, 200) || `执行中 (第 ${turnCount} 轮)`
              try { await progressCallback(summary) } catch { /* ignore */ }
              lastProgressTime = Date.now()
            }
          }
          break
        }

        case 'result': {
          log(`Result: subtype=${msg.subtype}, isError=${msg.is_error}, result=${typeof msg.result === 'string' ? msg.result?.slice(0, 500) : 'non-string'}`)
          log(`Result full: ${JSON.stringify(msg).slice(0, 1000)}`)
          // success 或 error_max_turns（不一定是真正错误）都提取结果
          if (msg.subtype === 'success' || !msg.is_error) {
            if (msg.result && typeof msg.result === 'string') {
              result.text = msg.result
            }
            result.structuredOutput = (msg as Record<string, unknown>).structured_output
            result.numTurns = msg.num_turns as number | undefined
            result.totalCostUsd = msg.total_cost_usd as number | undefined
            result.durationMs = msg.duration_ms as number | undefined
            result.isError = !!msg.is_error

            const usage = msg.usage as { input_tokens?: number; output_tokens?: number } | undefined
            if (usage) {
              result.tokenUsage = {
                input: usage.input_tokens ?? 0,
                output: usage.output_tokens ?? 0,
              }
            }
          } else {
            result.isError = true
            result.errors = (msg.errors as string[]) ?? [msg.subtype as string]
          }
          break
        }
      }
    }
  } catch (error) {
    console.error(`[SdkRunner] Error:`, error instanceof Error ? error.message : String(error))
    log(`ERROR: ${error instanceof Error ? error.message : String(error)}`)
    result.isError = true
    result.errors = [error instanceof Error ? error.message : String(error)]
  }

  if (loopSpanId) {
    traceCallback?.onLoopEnd(
      loopSpanId,
      result.isError ? 'failed' : 'completed',
      turnCount
    )
  }

  return result
}
