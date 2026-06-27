/**
 * wait_for_signal 工具：通用挂起原语。
 *
 * 适用场景：
 * 1) worker 派出了 async subagent（delegate_task），此刻没有别的事可干；
 * 2) 系统注入 [audit_pending]，告知 worker 有审计正在跑；
 * 3) worker 起了 bg shell（Bash run_in_background），等它退出再看结果；
 * 4) 定时等待：带 timeout_ms 挂起 N 毫秒后自动唤醒（如"10 分钟后复查长任务进度"）。
 *
 * 实现：复用 humanQueue.setBarrier 机制（跟 ask_human 同一套 barrier 路径）。
 * 任何 humanQueue.push（subagent 完成 / bg shell 退出 / 用户补充 / 系统结果）会自动
 * clearBarrier 唤醒 worker；带 timeout_ms 时超时自动 push [wait_timeout] 标记唤醒。
 *
 * spec: 2026-06-07-goal-audit-async-buffered-info-design.md Task 2
 */

import { z } from 'zod'
import type { HumanMessageQueue } from '../engine/human-message-queue.js'
import type { ToolCallContext, ToolDefinition, ToolCallResult } from '../engine/types.js'

/**
 * 兜底超时：跟 ASK_HUMAN_BARRIER_TIMEOUT_MS 一致（24 小时）。
 * Agent 不感知此 timeout——只要有 push 就会被 clearBarrier 唤醒。
 */
export const WAIT_FOR_SIGNAL_TIMEOUT_MS = 24 * 60 * 60 * 1000

/** timeout_ms 下限：防止 LLM 传毫秒级小值把挂起退化成空转 */
export const WAIT_FOR_SIGNAL_MIN_TIMEOUT_MS = 1_000

export interface WaitForSignalDeps {
  readonly humanQueue: HumanMessageQueue
  readonly hasActiveAudit: () => boolean
  readonly hasActiveAsyncSubagent: () => boolean
  /** 本 task 是否有 running 的 bg shell——它退出时会 push 唤醒。查 bgRegistry，故异步。 */
  readonly hasRunningBgEntity: () => boolean | Promise<boolean>
}

const inputSchema = z.object({
  reason: z.string().describe('挂起原因（trace 可读），如 "等 code_writer 完成"'),
  timeout_ms: z.number().int().positive().optional()
    .describe('最长等待毫秒数；超时自动唤醒并注入 [wait_timeout] 标记'),
})

const TOOL_DESCRIPTION =
  '挂起当前任务，等待外部异步事件唤醒。适用场景：' +
  '1) 你派出了 async subagent（delegate_task）没有别的事可干；' +
  '2) 你起了 bg shell（Bash run_in_background），等它退出再处理结果——shell 退出会自动唤醒你；' +
  '3) 定时等待：带 timeout_ms 最长挂起 N 毫秒（如周期性复查长任务：timeout_ms=600000 即最多等 10 分钟，' +
  '期间 bg shell 退出等任何事件都会提前唤醒；醒来后可再次调用继续等）。' +
  '注意：等待可能永不退出的进程（监控、服务）必须带 timeout_ms，否则会拒绝或挂到 24h 兜底。' +
  '交付审计的等待不需要调本工具——系统在你 end_turn 时自动挂起。'

export function createWaitForSignalTool(deps: WaitForSignalDeps): ToolDefinition {
  return {
    name: 'wait_for_signal',
    description: TOOL_DESCRIPTION,
    isReadOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '挂起原因（trace 可读）' },
        timeout_ms: {
          type: 'integer',
          description: '可选：最长等待毫秒数，超时自动唤醒（注入 [wait_timeout] 标记）。定时复查场景必带。',
        },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    call: async (rawInput: Record<string, unknown>, _context: ToolCallContext): Promise<ToolCallResult> => {
      const parseResult = inputSchema.safeParse(rawInput)
      if (!parseResult.success) {
        return { isError: true, output: `invalid input: ${parseResult.error.message}` }
      }
      const { reason, timeout_ms } = parseResult.data

      const hasPending = deps.humanQueue.hasPending
      const hasAudit = deps.hasActiveAudit()
      const hasSubagent = deps.hasActiveAsyncSubagent()
      const hasBgEntity = await deps.hasRunningBgEntity()

      if (!hasPending && !hasAudit && !hasSubagent && !hasBgEntity && timeout_ms === undefined) {
        return {
          isError: true,
          output:
            '当前无 pending 异步事件（无 audit / async subagent / queue 消息 / 运行中的 bg entity），' +
            '不带 timeout_ms 的挂起会被拒绝。' +
            '若要定时等待（如 N 分钟后复查进度），带 timeout_ms 重新调用；' +
            '若任务已全部完成，end_turn。',
        }
      }

      if (timeout_ms !== undefined) {
        const clamped = Math.min(Math.max(timeout_ms, WAIT_FOR_SIGNAL_MIN_TIMEOUT_MS), WAIT_FOR_SIGNAL_TIMEOUT_MS)
        const waitedSec = Math.round(clamped / 1000)
        deps.humanQueue.setBarrier(clamped, () => {
          deps.humanQueue.push(
            `[wait_timeout] 等待超时（${reason}，已等 ${waitedSec}s），无外部事件到达。` +
            '请检查相关 bg entity 输出（Output 工具）或继续后续工作；如需继续等，可再次调用 wait_for_signal。',
          )
        })
        return {
          isError: false,
          output: `已挂起等待 (${reason})；最长 ${waitedSec}s，期间任何事件 push 都会提前唤醒。`,
        }
      }

      deps.humanQueue.setBarrier(WAIT_FOR_SIGNAL_TIMEOUT_MS)
      return {
        isError: false,
        output: `已挂起等待 (${reason})；下次 push 唤醒后继续。`,
      }
    },
  }
}
