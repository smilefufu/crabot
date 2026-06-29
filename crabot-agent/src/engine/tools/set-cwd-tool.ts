import { promises as fs, constants as fsConstants } from 'node:fs'
import { defineTool } from '../tool-framework'
import type { ToolDefinition, ToolCallResult } from '../types'
import { resolvePath } from './utils'

export interface SetCwdContext {
  /** 当前 cwd getter（用于解析相对路径） */
  getCwd: () => string
  /** cwd setter（改 task-scoped state） */
  setCwd: (newCwd: string) => void
}

export function createSetCwdTool(ctx: SetCwdContext): ToolDefinition {
  return defineTool({
    name: 'set_cwd',
    category: 'file_io',
    description:
      '**作用**：把当前 task 的工作根目录锚定到 path。' +
      '调用后，本 task 后续所有工具调用（Bash / Read / Grep / Glob / Write / Edit）' +
      '以及通过 delegate_task 派出的 subagent 都自动以 path 为根' +
      '——不必每次写绝对路径。\n' +
      '未调用时默认是 agent 进程启动目录（通常是 home），不一定是用户期望的项目根。\n\n' +
      '**何时调**：任务关联一个具体代码项目时。' +
      '典型流程：search_memory 找到项目目录 → set_cwd。' +
      '本 task 内一次就够，不需要反复切。\n\n' +
      '**何时不调**：任务跟具体项目无关（讨论 / 闲聊 / 通用问答 / 纯配置问题）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '项目根目录的绝对路径，或相对当前 cwd 的相对路径（会自动解析为绝对）。支持前导 `~`（展开到 home）。',
        },
      },
      required: ['path'],
    },
    isReadOnly: false,
    permissionLevel: 'safe',
    async call(input: Record<string, unknown>): Promise<ToolCallResult> {
      const inputPath = input.path as string
      // resolvePath 统一处理前导 `~` 展开 + 相对 cwd 解析（见 utils.ts）。
      const absPath = resolvePath(ctx.getCwd(), inputPath)

      // 校验：路径必须存在、是目录、可读
      try {
        const stat = await fs.stat(absPath)
        if (!stat.isDirectory()) {
          return {
            output: `set_cwd failed: ${absPath} 不是目录`,
            isError: true,
          }
        }
        await fs.access(absPath, fsConstants.R_OK)
      } catch (err) {
        const e = err as NodeJS.ErrnoException
        const reason = e.code === 'ENOENT' ? '路径不存在' : `无法访问 (${e.code ?? e.message})`
        return {
          output: `set_cwd failed: ${absPath} ${reason}`,
          isError: true,
        }
      }

      // 改 cwd state
      ctx.setCwd(absPath)

      return {
        output: `cwd 已切到 ${absPath}。后续工具调用和派出的 subagent 都自动用新 cwd。`,
        isError: false,
      }
    },
  })
}
