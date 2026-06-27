import { execFile } from 'child_process'
import { defineTool } from '../tool-framework'
import type { ToolDefinition, ToolCallContext, ToolCallResult } from '../types'
import type { BgEntityRegistry } from '../bg-entities/registry.js'
import type { BgEntityOwner } from '../bg-entities/types.js'
import type { BgEntityTraceContext } from '../bg-entities/trace.js'
import { runShellWithGrace } from '../bg-entities/bg-shell.js'
import { resolveBashPath, BASH_NOT_FOUND_MESSAGE } from '../../utils/resolve-bash-path.js'

const MAX_OUTPUT_LENGTH = 100000
const DEFAULT_TIMEOUT_MS = 120000
/** 无 bgCtx（legacy / subagent 未接 bg）时退回旧同步前台执行的 timeout 上限。 */
export const MAX_FOREGROUND_TIMEOUT_MS = 600_000

/**
 * 前台宽限期：默认路径（非 run_in_background）的命令先前台运行这么久。
 * 期内退出 → 同步内联返回（等同普通同步调用）；超过仍在跑 → 转后台（命令不中断）+
 * 引导 agent 用 wait_for_signal 挂起等待。取代旧的「显式 timeout>60s 直接转 bg」破坏性逻辑。
 */
export const FOREGROUND_GRACE_PERIOD_MS = 10_000

export interface BashBgContext {
  readonly registry: BgEntityRegistry
  readonly owner: BgEntityOwner
  readonly taskId: string
  readonly traceContext?: BgEntityTraceContext
  /** Push notification sink — bg shell（转后台后）退出时调，由 worker 唤醒挂起的 loop + 排队通知。 */
  readonly onShellExit?: (info: {
    entity_id: string
    command: string
    status: 'completed' | 'failed' | 'killed'
    exit_code: number
    runtime_ms: number
    spawned_at: string
  }) => void
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) {
    return output
  }
  const halfLimit = Math.floor((MAX_OUTPUT_LENGTH - 20) / 2)
  return `${output.slice(0, halfLimit)}\n[...truncated...]\n${output.slice(-halfLimit)}`
}

function execCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ToolCallResult> {
  const bashPath = resolveBashPath()
  if (bashPath === null) {
    return Promise.resolve({ output: BASH_NOT_FOUND_MESSAGE, isError: true })
  }
  return new Promise((resolve) => {
    const child = execFile(
      bashPath,
      ['-c', command],
      {
        cwd,
        timeout: timeoutMs,
        signal,
        maxBuffer: 10 * 1024 * 1024,
        // 显式透传父进程 env，确保 CRABOT_TOKEN / DATA_DIR 等环境变量进入子 shell。
        // execFile 默认 inherit 但显式传更稳定。
        env: process.env,
      },
      (error, stdout, stderr) => {
        const stderrTrimmed = stderr.trim()
        const stdoutTrimmed = stdout ?? ''

        if (error !== null) {
          // Timeout
          if (error.killed && (error as NodeJS.ErrnoException).code === undefined) {
            resolve({
              output: `Command timed out after ${timeoutMs}ms`,
              isError: true,
            })
            return
          }

          // Abort
          if (error.name === 'AbortError' || signal?.aborted === true) {
            resolve({
              output: 'Command aborted',
              isError: true,
            })
            return
          }

          // Command failure
          const parts: string[] = []
          if (error.message) {
            parts.push(error.message)
          }
          if (stdoutTrimmed) {
            parts.push(stdoutTrimmed)
          }
          if (stderrTrimmed) {
            parts.push(`stderr: ${stderrTrimmed}`)
          }
          resolve({
            output: truncateOutput(parts.join('\n') || 'Command failed'),
            isError: true,
          })
          return
        }

        // Success
        const outputParts: string[] = [stdoutTrimmed]
        if (stderrTrimmed) {
          outputParts.push(`stderr: ${stderrTrimmed}`)
        }
        resolve({
          output: truncateOutput(outputParts.join('\n')),
          isError: false,
        })
      },
    )

    // If signal is already aborted, kill the child
    if (signal?.aborted === true) {
      child.kill()
    }
  })
}

/**
 * 默认前台执行：委托 runShellWithGrace（spawn 即 OS 直写磁盘日志，前台宽限 gracePeriodMs）。
 * - 宽限期内退出：读日志内联同步返回（不入 bgRegistry）。
 * - 超过宽限期仍在跑：转后台（注册 bgRegistry，命令**不中断**），返回 entity_id + 引导 wait_for_signal；
 *   其后退出经 onShellExit 唤醒挂起的 worker。
 * - 期间 abort：kill + 清文件，返回 aborted。
 */
async function runForegroundWithGrace(
  command: string,
  bgCtx: BashBgContext,
  cwd: string,
  signal: AbortSignal | undefined,
  gracePeriodMs: number,
): Promise<ToolCallResult> {
  const result = await runShellWithGrace({
    command,
    cwd,
    owner: bgCtx.owner,
    spawned_by_task_id: bgCtx.taskId,
    registry: bgCtx.registry,
    gracePeriodMs,
    ...(bgCtx.traceContext ? { traceContext: bgCtx.traceContext } : {}),
    ...(signal ? { abortSignal: signal } : {}),
    ...(bgCtx.onShellExit ? { onShellExit: bgCtx.onShellExit } : {}),
  })

  switch (result.kind) {
    case 'aborted':
      return { output: 'Command aborted', isError: true }
    case 'spawn_error':
      return { output: result.message, isError: true }
    case 'background': {
      const sec = Math.round(gracePeriodMs / 1000)
      return {
        output:
          `命令运行已超过 ${sec}s，转入后台继续运行（entity_id: ${result.entity_id}）——命令未中断。\n` +
          `若你还有别的事可做，现在就去做；若没有，调 wait_for_signal(reason="等 ${command.slice(0, 40)}") 挂起，` +
          `该命令退出时会自动唤醒你，届时用 Output("${result.entity_id}") 读取完整输出。`,
        isError: false,
      }
    }
    case 'inline': {
      const body = truncateOutput(result.output.replace(/\n$/, ''))
      const suffix =
        result.status === 'completed' && result.exitCode === 0
          ? ''
          : `\n[command exited with code ${result.exitCode}]`
      return { output: `${body}${suffix}`.trim(), isError: result.status !== 'completed' }
    }
  }
}

const SENSITIVE_CMD_RE = /channel-configs[/\\]/

function containsSensitivePath(command: string): boolean {
  return SENSITIVE_CMD_RE.test(command)
}

export function createBashTool(
  getCwd: () => string,
  defaultTimeout?: number,
  bgCtx?: BashBgContext,
  /** 前台宽限期（ms）。默认 FOREGROUND_GRACE_PERIOD_MS；仅测试需要注入短值快速覆盖慢路径。 */
  gracePeriodMs: number = FOREGROUND_GRACE_PERIOD_MS,
): ToolDefinition {
  const effectiveDefault = defaultTimeout ?? DEFAULT_TIMEOUT_MS
  return defineTool({
    name: 'Bash',
    category: 'shell',
    description:
      'Executes a bash command and returns its output. ' +
      `命令前台运行；若运行超过 ${Math.round(FOREGROUND_GRACE_PERIOD_MS / 1000)}s 仍未结束，自动转入后台并返回 entity_id（命令**继续运行、不中断**），` +
      '随后你可继续做别的，或调 wait_for_signal 挂起等待其退出（退出会自动唤醒你），届时用 Output(entity_id) 读完整输出。',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
      },
      required: ['command'],
    },
    isReadOnly: false,
    permissionLevel: 'dangerous',
    call: async (input: Record<string, unknown>, context: ToolCallContext): Promise<ToolCallResult> => {
      const command = input.command as string

      // 軟攔截：命令中直接引用 channel-configs 路徑
      if (containsSensitivePath(command)) {
        return {
          output: '命令引用了渠道憑證路徑（channel-configs/），禁止直接訪問。要讀取飛書文檔請使用 read_feishu_document 工具。',
          isError: true,
        }
      }

      // 默认路径：前台宽限期内完成则同步内联返回；超期仍在跑则转后台 + 引导 wait_for_signal。
      if (bgCtx) {
        return runForegroundWithGrace(command, bgCtx, getCwd(), context.abortSignal, gracePeriodMs)
      }

      // 无 bgCtx（legacy / subagent 未接 bg）：退回旧同步前台执行，默认 timeout 兜底。
      const timeoutMs = Math.min(effectiveDefault, MAX_FOREGROUND_TIMEOUT_MS)
      return execCommand(command, getCwd(), timeoutMs, context.abortSignal)
    },
  })
}
