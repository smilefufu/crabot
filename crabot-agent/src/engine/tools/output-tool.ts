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
import type { TransientShellRegistry } from '../bg-entities/bg-shell'
import { BG_OUTPUT_MAX_BYTES } from '../bg-entities/types'

export interface BgToolDeps {
  readonly registry: BgEntityRegistry
  readonly transient: TransientShellRegistry
  readonly cursorMap: Map<string, number>
  readonly taskId: string
  readonly ownerFriendId?: string
  /** Sub-agent abortControllers map (key=entity_id); used to abort a running bg agent on Kill */
  readonly agentAbortControllers?: Map<string, AbortController>
}

// block 模式参数（参 Claude Code BashOutput）
const BLOCK_DEFAULT_TIMEOUT_MS = 30_000
const BLOCK_MAX_TIMEOUT_MS = 120_000
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
  // 1. Check transient first (in-memory ring buffer, no offset concept)
  const transientState = deps.transient.get(entityId)
  if (transientState) {
    const header = `[status: ${transientState.status}, exit_code: ${transientState.exit_code ?? 'null'}]`
    const output = `${header}\n${transientState.ringBuffer}`
    return { output, isError: false, isRunning: transientState.status === 'running' }
  }

  // 2. Check persistent registry (disk log file with per-task cursor)
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

async function readLastJsonlLines(file: string, n: number): Promise<string> {
  try {
    const text = await fs.readFile(file, 'utf-8')
    const lines = text.split('\n').filter((l) => l.trim())
    return lines.slice(-n).join('\n')
  } catch {
    return '(no activity log)'
  }
}

async function readAgentOutput(
  id: string,
  _explicitOffset: number | undefined,
  deps: BgToolDeps,
): Promise<ReadResult> {
  const record = await deps.registry.get(id)
  if (!record) {
    return { output: `Entity not found: ${id}`, isError: true, isRunning: false }
  }
  if (record.type !== 'agent') {
    return { output: `Mismatched entity type for ${id}: expected agent, got ${record.type}`, isError: true, isRunning: false }
  }

  if (record.status === 'completed' && record.result_file) {
    try {
      const content = await fs.readFile(record.result_file, 'utf-8')
      await deps.registry.update(id, { last_activity_at: new Date().toISOString() })
      return {
        output: `[status: completed, exit_code: ${record.exit_code}]\n${content}`,
        isError: false,
        isRunning: false,
      }
    } catch (err) {
      return { output: `[status: completed but result_file read failed: ${err}]`, isError: true, isRunning: false }
    }
  }

  if (record.status === 'failed' || record.status === 'killed' || record.status === 'stalled') {
    const recent = await readLastJsonlLines(record.messages_log_file, 5)
    const tail = record.status === 'stalled' ? `, ended_at: ${record.ended_at}` : `, exit_code: ${record.exit_code}`
    return {
      output: `[status: ${record.status}${tail}]\n${recent}`,
      isError: false,
      isRunning: false,
    }
  }

  // running → return last 10 lines of messages_log
  const recent = await readLastJsonlLines(record.messages_log_file, 10)
  await deps.registry.update(id, { last_activity_at: new Date().toISOString() })
  return {
    output: `[status: running, in progress; recent activity:]\n${recent}`,
    isError: false,
    isRunning: true,
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOutputTool(deps: BgToolDeps): ToolDefinition {
  return defineTool({
    name: 'Output',
    category: 'shell',
    description:
      'Read incremental output from a background entity (shell or sub-agent). ' +
      '默认非阻塞 snapshot 读。' +
      '若 entity 还在 running 且想等下一段输出，**强烈建议**用 `block=true` 阻塞等到有新输出 / 状态变 terminal / 超时——' +
      '避免在 agent 主循环里反复短间隔 poll 污染上下文。' +
      '注意：bg entity 的 exit / kill 事件本身会通过下一轮 prompt 的 <bg-notification> 自动通知到 agent，' +
      '通常不需要主动 block 等终止——block 仅适用于"我要立刻拿到下一段输出再继续"的场景。',
    inputSchema: {
      type: 'object',
      properties: {
        entity_id: {
          type: 'string',
          description: 'shell_xxx or agent_xxx',
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

      const readOnce = async (): Promise<ReadResult> => {
        if (entityId.startsWith('shell_')) {
          return readShellOutput(entityId, explicitOffset, deps)
        }
        if (entityId.startsWith('agent_')) {
          return readAgentOutput(entityId, explicitOffset, deps)
        }
        return { output: `Invalid entity_id format: ${entityId}`, isError: true, isRunning: false }
      }

      const toResult = (r: ReadResult) => ({ output: r.output, isError: r.isError })

      const first = await readOnce()
      if (!block || first.isError || !first.isRunning || !first.output.includes(NO_NEW_OUTPUT_MARKER)) {
        return toResult(first)
      }

      // 进入 poll loop：每 2s 重读，等到有新内容 / 状态变化 / 超时 / abort
      const startMs = Date.now()
      let last = first
      while (Date.now() - startMs < timeoutMs) {
        try {
          await sleep(BLOCK_POLL_INTERVAL_MS, abortSignal)
        } catch {
          break  // abort
        }
        last = await readOnce()
        if (last.isError || !last.isRunning || !last.output.includes(NO_NEW_OUTPUT_MARKER)) break
      }
      return toResult(last)
    },
  })
}
