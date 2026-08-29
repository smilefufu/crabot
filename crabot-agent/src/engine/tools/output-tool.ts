/**
 * Output tool — read incremental output from a background entity.
 *
 * Plan 2 Tasks 7–9: crabot-docs/superpowers/plans/2026-05-01-long-running-agent-plan-2.md
 */

import fs from 'node:fs/promises'
import { defineTool } from '../tool-framework'
import { sleep } from '../retry-utils'
import type { ToolDefinition } from '../types'
import type { BgEntityRegistry } from '../bg-entities/registry'
import { BG_OUTPUT_MAX_BYTES } from '../bg-entities/types'

export interface BgToolDeps {
  readonly registry: BgEntityRegistry
  readonly cursorMap: Map<string, number>
  readonly taskId: string
  readonly ownerFriendId?: string
  /** Sub-agent abortControllers map (key=entity_id); used to abort a running bg agent on Kill */
  readonly agentAbortControllers?: Map<string, AbortController>
}

// block 模式参数（参 Claude Code BashOutput）
const BLOCK_DEFAULT_TIMEOUT_MS = 30_000
const BLOCK_MAX_TIMEOUT_MS = 600_000
const BLOCK_POLL_INTERVAL_MS = 2_000
const NO_NEW_OUTPUT_MARKER = '(no new output)'

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function cursorKey(taskId: string, entityId: string): string {
  return `${taskId}:${entityId}`
}


interface ReadResult {
  output: string
  isError: boolean
  /** 用于 block 模式判断是否值得继续 poll；终态（completed/failed/killed/stalled/error）下为 false */
  isRunning: boolean
}

async function readShellOutput(
  entityId: string,
  explicitOffset: number | undefined,
  deps: BgToolDeps,
): Promise<ReadResult> {
  // Persistent registry (disk log file with per-task cursor)
  const record = await deps.registry.get(entityId)
  if (!record) {
    return { output: `Entity not found: ${entityId}`, isError: true, isRunning: false }
  }

  if (record.type !== 'shell') {
    return { output: `Entity ${entityId} is not a shell entity`, isError: true, isRunning: false }
  }

  const key = cursorKey(deps.taskId, entityId)
  const currentOffset = explicitOffset ?? deps.cursorMap.get(key) ?? 0
  const isRunning = record.status === 'running'

  let fileStats: { size: number }
  try {
    fileStats = await fs.stat(record.log_file)
  } catch {
    return { output: `Log file not accessible for ${entityId}`, isError: true, isRunning }
  }

  const fileSize = fileStats.size
  if (fileSize <= currentOffset) {
    const header = `[status: ${record.status}, exit_code: ${record.exit_code ?? 'null'}]`
    return { output: `${header}\n(no new output)`, isError: false, isRunning }
  }

  const bytesToRead = Math.min(BG_OUTPUT_MAX_BYTES, fileSize - currentOffset)
  const remaining = fileSize - currentOffset - bytesToRead

  let chunk: Buffer
  const fh = await fs.open(record.log_file, 'r')
  try {
    const buf = Buffer.allocUnsafe(bytesToRead)
    const { bytesRead } = await fh.read(buf, 0, bytesToRead, currentOffset)
    chunk = buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }

  const newOffset = currentOffset + chunk.length
  deps.cursorMap.set(key, newOffset)

  // Update last_activity_at on the registry record
  await deps.registry.update(entityId, { last_activity_at: new Date().toISOString() })

  const header = `[status: ${record.status}, exit_code: ${record.exit_code ?? 'null'}]`
  let output = `${header}\n${chunk.toString('utf8')}`

  if (remaining > 0) {
    output += `\n[truncated, more available with from_offset=${newOffset}]`
  }

  return { output, isError: false, isRunning }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOutputTool(deps: BgToolDeps): ToolDefinition {
  return defineTool({
    name: 'Output',
    category: 'shell',
    description:
      'Read incremental output from a background shell (shell_xxx). ' +
      '默认非阻塞 snapshot 读。' +
      '若 shell 还在 running 且想等下一段输出，**强烈建议**用 `block=true` 阻塞等到有新输出 / 状态变 terminal / 超时——' +
      '避免在 agent 主循环里反复短间隔 poll 污染上下文。' +
      '主控 agent 可以自然结束当前回合，等待 <bg-notification> 唤醒；' +
      'subagent 收不到该通知，需要结果时必须用 block=true 等待。' +
      '读 subagent 结果请用 get_subagent_output(agent_id)，不是本工具。',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description: 'shell_xxx',
        },
        from_offset: {
          type: 'integer',
          description: 'Optional: explicit byte offset; default uses per-task cursor',
        },
        block: {
          type: 'boolean',
          description:
            '为 true 时，若 entity 仍在 running 且当前无新输出，工具内部 poll 等到有新输出 / 状态结束 / 超时再返回。' +
            '默认 false（snapshot 读，立即返回）。',
        },
        timeout_ms: {
          type: 'integer',
          description: `block=true 时的最长等待时间（默认 ${BLOCK_DEFAULT_TIMEOUT_MS}，最大 ${BLOCK_MAX_TIMEOUT_MS}）。`,
        },
      },
      required: ['entity_id'],
    },
    isReadOnly: true,
    permissionLevel: 'safe',
    call: async (input, context) => {
      const entityId = input.entity_id as string
      const explicitOffset = input.from_offset as number | undefined
      const block = input.block === true
      const requestedTimeout = typeof input.timeout_ms === 'number' ? input.timeout_ms : BLOCK_DEFAULT_TIMEOUT_MS
      const timeoutMs = Math.min(Math.max(0, requestedTimeout), BLOCK_MAX_TIMEOUT_MS)
      const abortSignal = context.abortSignal
      // 外部输入 pending 探针（spec 2026-08-29-worker-input-turn-boundary-delivery）：
      // block 等待期间 worker inbox 有排队输入时立即返回让位——本工具返回后就是 turn
      // 边界，输入在下一轮 LLM 调用前注入。engine 从 options 透传，未接线的调用方为 undefined。
      const hasPendingExternalInput = context.hasPendingExternalInput

      const readOnce = async (): Promise<ReadResult> => {
        if (entityId.startsWith('shell_')) {
          return readShellOutput(entityId, explicitOffset, deps)
        }
        if (entityId.startsWith('agent_')) {
          // Output 只读 shell；subagent 结果走专门的 get_subagent_output（读 result_file）。
          return {
            output: `Output 只读 shell；读 subagent 结果请用 get_subagent_output("${entityId}")。`,
            isError: true,
            isRunning: false,
          }
        }
        return { output: `Invalid entity_id format: ${entityId}`, isError: true, isRunning: false }
      }

      const toResult = (r: ReadResult) => ({ output: r.output, isError: r.isError })

      const first = await readOnce()
      if (!block || first.isError || !first.isRunning || !first.output.includes(NO_NEW_OUTPUT_MARKER)) {
        return toResult(first)
      }

      // 进入 poll loop：每 2s 重读，等到有新内容 / 状态变化 / 超时 / abort / 外部输入 pending
      const startMs = Date.now()
      let last = first
      while (Date.now() - startMs < timeoutMs) {
        try {
          await sleep(BLOCK_POLL_INTERVAL_MS, abortSignal)
        } catch {
          break  // abort
        }
        // 外部输入（如 manager 投递）已排队：立即返回让位——本工具返回后就是 turn 边界，
        // 输入会在下一轮 LLM 调用前注入，LLM 优先处理新输入。
        if (hasPendingExternalInput?.()) break
        last = await readOnce()
        if (last.isError || !last.isRunning || !last.output.includes(NO_NEW_OUTPUT_MARKER)) break
      }
      return toResult(last)
    },
  })
}
