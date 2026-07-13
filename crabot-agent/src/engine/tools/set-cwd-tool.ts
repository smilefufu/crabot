import { promises as fs, constants as fsConstants } from 'node:fs'
import path from 'node:path'
import { defineTool } from '../tool-framework'
import type { ToolDefinition, ToolCallResult } from '../types'
import { resolvePath } from './utils'

export interface SetCwdContext {
  /** 当前 cwd getter（用于解析相对路径） */
  getCwd: () => string
  /** cwd setter（改 task-scoped state） */
  setCwd: (newCwd: string) => void
}

interface WorkspaceContextCandidateGroup {
  readonly title: string
  readonly paths: readonly string[]
}

const WORKSPACE_CONTEXT_CANDIDATES: readonly WorkspaceContextCandidateGroup[] = [
  {
    title: 'Agent 规则入口',
    paths: ['AGENTS.md'],
  },
  {
    title: '当前状态/交接上下文',
    paths: [
      'CURRENT_CONTEXT.md',
      'docs/CURRENT_CONTEXT.md',
      'PROGRESS.md',
      'HANDOFF.md',
      'TODO.md',
    ],
  },
  {
    title: '项目总览',
    paths: ['README.md'],
  },
  {
    title: '契约/产物登记',
    paths: [
      'docs/CONTRACT_INDEX.md',
      'docs/ARTIFACT_REGISTRY.md',
    ],
  },
  {
    title: '计划/规格',
    paths: [
      'docs/plans',
      'docs/specs',
    ],
  },
]

async function relativePathExists(root: string, relPath: string): Promise<boolean> {
  try {
    await fs.access(path.join(root, relPath), fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

async function buildWorkspaceOrientationNotice(root: string): Promise<string> {
  const foundSections: string[] = []
  const missing: string[] = []

  for (const group of WORKSPACE_CONTEXT_CANDIDATES) {
    const foundInGroup: string[] = []
    for (const candidate of group.paths) {
      const exists = await relativePathExists(root, candidate)
      const displayPath = candidate === 'docs/plans' || candidate === 'docs/specs'
        ? `${candidate}/`
        : candidate
      if (exists) {
        foundInGroup.push(displayPath)
      } else {
        missing.push(displayPath)
      }
    }

    if (foundInGroup.length > 0) {
      foundSections.push([
        `[${group.title}]`,
        ...foundInGroup.map((candidate) => `- ${candidate}`),
      ].join('\n'))
    }
  }

  const foundBlock = foundSections.length > 0
    ? foundSections.join('\n')
    : '- 未发现默认候选'
  const missingBlock = missing.length > 0
    ? missing.map((candidate) => `- ${candidate}`).join('\n')
    : '- 无'

  return [
    '工作区上下文提示：',
    '- 你已进入一个文件工作区。请先理解当前目录的长期上下文，再进行大范围搜索、修改或生成产物。',
    '- 若存在 AGENTS.md，它是本工作区的 agent 规则入口；请优先阅读并遵守。用户当前指令和 Crabot 记忆中的明确偏好优先级高于默认路径建议。',
    '- 若未发现 AGENTS.md，或本任务会修改文件、创建报告/脚本/数据产物、依赖工作区长期状态，请先使用 workspace-context-maintenance skill 判断是否需要初始化 AGENTS.md / CURRENT_CONTEXT.md；如果当前环境没有该 skill，请按本提示中的最小规则手动处理。',
    '- 按 Crabot 默认标准扫描到以下疑似上下文候选：',
    foundBlock,
    '- 未扫描到的默认候选：',
    missingBlock,
    '- 如果没有明确上下文文档，而本任务依赖工作区状态、会修改多个文件、会生成长期产物，或后续 agent 需要理解本次决策，请按 AGENTS.md、用户指令或当前记忆中的偏好创建最小上下文文档；没有覆盖时默认使用 docs/CURRENT_CONTEXT.md，若不适合创建 docs/ 则使用 CURRENT_CONTEXT.md。',
    '- 上下文文档只能记录已确认事实、当前任务目标、已读/权威文件、重要决策、待验证项和未知项；不得编造项目状态。',
    '- 任务结束前，如果本次工作改变了长期事实、工作流、契约、权威产物、废弃口径或后续注意事项，应更新相应上下文文档，或说明无需更新的原因。',
  ].join('\n')
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
      const orientationNotice = await buildWorkspaceOrientationNotice(absPath)

      return {
        output: `cwd 已切到 ${absPath}。后续工具调用和派出的 subagent 都自动用新 cwd。\n\n${orientationNotice}`,
        isError: false,
      }
    },
  })
}
