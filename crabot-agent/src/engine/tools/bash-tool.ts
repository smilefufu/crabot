import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import * as fsp from 'fs/promises'
import * as path from 'path'
import { defineTool } from '../tool-framework'
import type { ToolDefinition, ToolCallContext, ToolCallResult } from '../types'
import type { BgEntityRegistry } from '../bg-entities/registry.js'
import type { BgEntityOwner } from '../bg-entities/types.js'
import type { BgEntityTraceContext } from '../bg-entities/trace.js'
import { runShellWithGrace } from '../bg-entities/bg-shell.js'
import { resolveBashPath, BASH_NOT_FOUND_MESSAGE } from '../../utils/resolve-bash-path.js'
import { getAgentDataDir } from '../../core/data-paths.js'
import { byteLength, truncateUtf8Tail } from '../byte-cap.js'

/** 截断阈值（UTF-8 字节）：自截产物恒 < 编排层 100KB 兜底，尾部 hint 不会被再截掉。 */
const MAX_OUTPUT_BYTES = 50000
/** 截断输出全文落盘的保留时长，超过即被惰性清理。 */
const TOOL_OUTPUT_RETENTION_MS = 24 * 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 120000
/** 无 bgCtx（legacy / subagent 未接 bg）时退回旧同步前台执行的 timeout 上限。 */
export const MAX_FOREGROUND_TIMEOUT_MS = 600_000

/**
 * 前台宽限期：命令先前台运行这么久。
 * 期内退出 → 同步内联返回（等同普通同步调用）；超过仍在跑 → 转后台（命令不中断）+
 * 按实际工具表引导 agent 用 wait_for_signal 或 blocking Output 等待。
 * 取代旧的「显式 timeout>60s 直接转 bg」破坏性逻辑。
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

/** 截断输出全文落盘目录：agent data 目录下 tmp/tool-outputs/。 */
function getToolOutputsDir(): string {
  return path.join(getAgentDataDir(), 'tmp', 'tool-outputs')
}

let toolOutputsCleanupDone = false

/**
 * 工具首次调用时惰性清理 tool-outputs/ 下超过 24h 的落盘文件
 *（worker 无统一启动钩子可挂，放这里；清理失败静默，不阻断工具执行）。
 */
function cleanupToolOutputsOnce(): void {
  if (toolOutputsCleanupDone) return
  toolOutputsCleanupDone = true
  void (async () => {
    try {
      const dir = getToolOutputsDir()
      const entries = await fsp.readdir(dir).catch(() => [] as string[])
      const cutoff = Date.now() - TOOL_OUTPUT_RETENTION_MS
      await Promise.all(
        entries.map(async (name) => {
          try {
            const filePath = path.join(dir, name)
            const stat = await fsp.stat(filePath)
            if (stat.isFile() && stat.mtimeMs < cutoff) {
              await fsp.unlink(filePath)
            }
          } catch {
            // 单文件清理失败忽略
          }
        }),
      )
    } catch {
      // 清理整体失败静默
    }
  })()
}

/**
 * 保留尾部截断（错误信息通常在结尾），字节口径（UTF-8 不切字符）——与编排层
 * 100KB 字节兜底同一口径，避免 CJK 输出按字符保留 50000 却超 100KB 被编排层
 * 按头部保留二次截断、把尾部和落盘路径 hint 切掉。
 * 截断时把完整输出落盘到 tmp/tool-outputs/，返回文本附全文路径，模型可用
 * Read/Grep 续查；落盘失败回退为纯截断，不阻断执行。
 */
async function truncateOutput(output: string): Promise<string> {
  const totalBytes = byteLength(output)
  if (totalBytes <= MAX_OUTPUT_BYTES) {
    return output
  }
  const tail = truncateUtf8Tail(output, MAX_OUTPUT_BYTES)
  let fullOutputPath: string | null = null
  try {
    const dir = getToolOutputsDir()
    await fsp.mkdir(dir, { recursive: true })
    fullOutputPath = path.join(dir, `${randomUUID()}.log`)
    await fsp.writeFile(fullOutputPath, output, 'utf8')
  } catch {
    fullOutputPath = null
  }
  const hint = fullOutputPath
    ? `[Showing last ${byteLength(tail)} bytes of ${totalBytes}. Full output: ${fullOutputPath}]`
    : `[Showing last ${byteLength(tail)} bytes of ${totalBytes}.]`
  return `${tail}\n${hint}`
}

function stripOneTrailingNewline(value: string): string {
  return value.replace(/\n$/, '')
}

async function formatBashToolOutput(
  exitCode: number | null,
  stdout: string,
  stderr: string,
): Promise<string> {
  const exit = exitCode === null ? 'null' : String(exitCode)
  const truncated = await truncateOutput(
    [
      `exit_code: ${exit}`,
      'stdout:',
      stripOneTrailingNewline(stdout),
      'stderr:',
      stripOneTrailingNewline(stderr),
    ].join('\n'),
  )
  return truncated.trim()
}

async function formatBashToolExecutionError(
  message: string,
  stdout: string,
  stderr: string,
): Promise<string> {
  const parts = [`Command execution failed: ${message}`]
  const stdoutText = stripOneTrailingNewline(stdout)
  const stderrText = stripOneTrailingNewline(stderr)
  if (stdoutText) {
    parts.push('stdout:', stdoutText)
  }
  if (stderrText) {
    parts.push('stderr:', stderrText)
  }
  const truncated = await truncateOutput(parts.join('\n'))
  return truncated.trim()
}

function extractExitCode(error: { code?: string | number | null }): number | null {
  return typeof error.code === 'number' ? error.code : null
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
        void (async () => {
          const stdoutText = stdout ?? ''
          const stderrText = stderr ?? ''

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

            const exitCode = extractExitCode(error)
            if (exitCode === null) {
              resolve({
                output: await formatBashToolExecutionError(error.message, stdoutText, stderrText),
                isError: true,
              })
              return
            }

            resolve({
              output: await formatBashToolOutput(exitCode, stdoutText, stderrText),
              isError: false,
            })
            return
          }

          resolve({
            output: await formatBashToolOutput(0, stdoutText, stderrText),
            isError: false,
          })
        })()
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
 * - 超过宽限期仍在跑：转后台（注册 bgRegistry，命令**不中断**），返回 entity_id + 条件等待引导；
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
          `若你还有别的事可做，现在就去做。若工具列表中有 wait_for_signal，可调 ` +
          `wait_for_signal(reason="等 ${command.slice(0, 40)}") 挂起，命令退出会唤醒主任务；` +
          `若工具列表中没有 wait_for_signal，请调 Output("${result.entity_id}", block=true, timeout_ms=600000) 阻塞等待并读取输出。`,
        isError: false,
      }
    }
    case 'inline': {
      return {
        output: await formatBashToolOutput(result.exitCode, result.stdout, result.stderr),
        isError: false,
      }
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
      '随后可继续做别的。工具列表中有 wait_for_signal 时可挂起等待主任务唤醒；没有该工具时用 Output(entity_id, block=true, timeout_ms=600000) 阻塞等待。',
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

      // 首次调用时惰性清理 24h 前的截断落盘文件
      cleanupToolOutputsOnce()

      // 軟攔截：命令中直接引用 channel-configs 路徑
      if (containsSensitivePath(command)) {
        return {
          output: '命令引用了渠道憑證路徑（channel-configs/），禁止直接訪問。要讀取飛書文檔請使用 read_feishu_document 工具。',
          isError: true,
        }
      }

      // 默认路径：前台宽限期内完成则同步内联返回；超期仍在跑则转后台 + 条件等待引导。
      if (bgCtx) {
        return runForegroundWithGrace(command, bgCtx, getCwd(), context.abortSignal, gracePeriodMs)
      }

      // 无 bgCtx（legacy / subagent 未接 bg）：退回旧同步前台执行，默认 timeout 兜底。
      const timeoutMs = Math.min(effectiveDefault, MAX_FOREGROUND_TIMEOUT_MS)
      return execCommand(command, getCwd(), timeoutMs, context.abortSignal)
    },
  })
}
