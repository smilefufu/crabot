import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineTool } from '../engine/tool-framework.js'
import type { ToolDefinition } from '../engine/types.js'

const IN_PROGRESS_WINDOW_MS = 10 * 60 * 1000

/** 复用 upgrade 的 stale-lock 判定：phase 处于进行态且未超 10 分钟才算「进行中」。 */
function isInProgress(adminDataDir: string, file: string, activePhases: ReadonlySet<string>): boolean {
  const p = join(adminDataDir, file)
  if (!existsSync(p)) return false
  try {
    const s = JSON.parse(readFileSync(p, 'utf-8')) as { phase?: string; started_at?: string }
    if (!s.phase || !activePhases.has(s.phase)) return false
    const started = new Date(s.started_at ?? '').getTime()
    if (!Number.isFinite(started)) return false
    return Date.now() - started < IN_PROGRESS_WINDOW_MS
  } catch {
    return false
  }
}

export interface RequestRestartToolDeps {
  /** admin 数据目录（restart-status.json / upgrade-status.json 所在）。 */
  readonly adminDataDir: string
  /** 向 agent-handler 登记重启申请（barrier 挂起当前 worker + spawn 重启）。 */
  readonly requestRestart: (reason?: string) => void
}

const DESCRIPTION =
  '向系统提交重启申请；本任务会在重启后被自动恢复并继续/收尾。' +
  '用于：改完配置/代码后需整体重启生效，或 master 明确要求重启。' +
  '调用后 worker loop 会先收尾落盘当前进度，再重启整个实例，重启完成后本任务自动恢复。'

export function createRequestRestartTool(deps: RequestRestartToolDeps): ToolDefinition {
  return defineTool({
    name: 'request_restart',
    description: DESCRIPTION,
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '重启原因（落入 restart-status.json，供事后排查）' },
      },
    },
    isReadOnly: false,
    call: async (input) => {
      const { reason } = input as { reason?: string }

      if (isInProgress(deps.adminDataDir, 'restart-status.json', new Set(['restarting']))) {
        return { output: '已有重启正在进行中，忽略本次请求。', isError: true }
      }
      if (isInProgress(deps.adminDataDir, 'upgrade-status.json', new Set(['preparing', 'upgrading', 'restarting']))) {
        return { output: '升级正在进行中，不能同时重启。', isError: true }
      }

      deps.requestRestart(reason)
      return {
        output:
          '重启申请已受理。系统会先把本任务收尾落盘，再重启整个实例，并在重启后自动恢复本任务。',
        isError: false,
      }
    },
  })
}
