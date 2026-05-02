import { execFile } from 'child_process'
import { defineTool } from '../tool-framework'
import type { ToolDefinition, ToolCallContext, ToolCallResult } from '../types'
import type { BgEntityRegistry } from '../bg-entities/registry.js'
import type { TransientShellRegistry } from '../bg-entities/bg-shell.js'
import type { BgEntityOwner } from '../bg-entities/types.js'
import type { BgEntityTraceContext } from '../bg-entities/trace.js'
import type { WorkerAgentContext } from '../../types.js'
import { spawnPersistentShell } from '../bg-entities/bg-shell.js'
import { isPersistentMode } from '../bg-entities/permission.js'
import { BG_ENTITY_LIMIT_PER_OWNER } from '../bg-entities/types.js'

const MAX_OUTPUT_LENGTH = 100000
const DEFAULT_TIMEOUT_MS = 120000
export const MAX_FOREGROUND_TIMEOUT_MS = 600_000

export interface BashBgContext {
  readonly registry: BgEntityRegistry
  readonly transient: TransientShellRegistry
  readonly workerContext: WorkerAgentContext
  readonly owner: BgEntityOwner
  readonly taskId: string
  readonly traceContext?: BgEntityTraceContext
  /** Push notification sink — bg entity exit / 重要事件触发后调，由 worker 排到下一次 task 的 prompt */
  readonly onShellExit?: (info: {
    entity_id: string
    command: string
    status: 'completed' | 'failed' | 'killed'
    exit_code: number
    runtime_ms: number
    spawned_at: string
    mode: 'persistent' | 'transient'
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
  return new Promise((resolve) => {
    const child = execFile(
      '/bin/sh',
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

async function runBg(command: string, bgCtx: BashBgContext): Promise<ToolCallResult> {
  const persistent = isPersistentMode(bgCtx.workerContext)

  // 资源上限检查（仅持久路径，临时路径生命周期受 task 约束不会堆）
  if (persistent && bgCtx.owner.friend_id) {
    const count = await bgCtx.registry.countActiveByOwner(bgCtx.owner.friend_id)
    if (count >= BG_ENTITY_LIMIT_PER_OWNER) {
      return {
        output: `已达 ${BG_ENTITY_LIMIT_PER_OWNER} 个上限，请先 ListEntities + Kill 清理。`,
        isError: true,
      }
    }
  }

  if (persistent) {
    const id = await spawnPersistentShell({
      command,
      owner: bgCtx.owner,
      spawned_by_task_id: bgCtx.taskId,
      registry: bgCtx.registry,
      traceContext: bgCtx.traceContext,
      onExit: bgCtx.onShellExit
        ? (info) => bgCtx.onShellExit!({ ...info, mode: 'persistent' })
        : undefined,
    })
    return {
      output: `Shell spawned (persistent): ${id}\nUse Output("${id}") to poll, Kill("${id}") to terminate.`,
      isError: false,
    }
  } else {
    const id = bgCtx.transient.spawn({
      command,
      owner: bgCtx.owner,
      spawned_by_task_id: bgCtx.taskId,
      traceContext: bgCtx.traceContext,
      onExit: bgCtx.onShellExit
        ? (info) => bgCtx.onShellExit!({ ...info, mode: 'transient' })
        : undefined,
    })
    return {
      output: `Shell spawned (transient, dies with task): ${id}\nUse Output("${id}") to poll, Kill("${id}") to terminate.`,
      isError: false,
    }
  }
}

export function createBashTool(cwd: string, defaultTimeout?: number, bgCtx?: BashBgContext): ToolDefinition {
  const effectiveDefault = defaultTimeout ?? DEFAULT_TIMEOUT_MS
  return defineTool({
    name: 'Bash',
    category: 'shell',
    description: 'Executes a bash command in the working directory and returns its output.',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: {
          type: 'number',
          description: `Foreground timeout in ms (default ${effectiveDefault}, max ${MAX_FOREGROUND_TIMEOUT_MS}). 超过会被 cap。run_in_background=true 时此参数无效。`,
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Spawn in background and return entity_id immediately. master 私聊场景持久化（survive worker 重启）；其他场景仅 task 内活，task 结束自动 kill。',
        },
      },
      required: ['command'],
    },
    isReadOnly: false,
    permissionLevel: 'dangerous',
    call: async (input: Record<string, unknown>, context: ToolCallContext): Promise<ToolCallResult> => {
      const command = input.command as string
      const bg = input.run_in_background === true

      if (bg) {
        if (!bgCtx) {
          // 没传 bgCtx 说明 Bash 在 legacy 模式（如 sub-agent 内可能没接 bg）
          return {
            output: 'Background mode unavailable in this context. Run synchronously instead.',
            isError: true,
          }
        }
        return runBg(command, bgCtx)
      }

      // 前台路径：cap timeout（静默，不报错）
      const requested = typeof input.timeout === 'number' ? input.timeout : effectiveDefault
      const timeoutMs = Math.min(requested, MAX_FOREGROUND_TIMEOUT_MS)
      return execCommand(command, cwd, timeoutMs, context.abortSignal)
    },
  })
}
