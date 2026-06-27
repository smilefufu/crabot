import * as cp from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, openSync } from 'node:fs'
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

export interface RestartInstanceToolDeps {
  /** Crabot 安装根（定位 scripts/restart.mjs）。 */
  readonly crabotHome: string
  /** admin 数据目录（restart-status.json / upgrade-status.json 所在）。 */
  readonly adminDataDir: string
}

const DESCRIPTION =
  '重启整个 Crabot 实例（停掉并重新拉起 MM 与所有模块，含你自己）。' +
  '用于：改完配置/代码后需整体重启生效，或 master 明确要求重启。' +
  '这是 fire-and-forget：调用后本实例即将停止，你不会收到重启结果回执。'

export function createRestartInstanceTool(deps: RestartInstanceToolDeps): ToolDefinition {
  return defineTool({
    name: 'restart_instance',
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

      const script = join(deps.crabotHome, 'scripts', 'restart.mjs')
      if (!existsSync(script)) {
        return { output: `找不到重启脚本：${script}`, isError: true }
      }

      // 日志落顶层 data/logs/restart.log（adminDataDir 的兄弟）
      const logDir = join(deps.adminDataDir, '..', 'logs')
      mkdirSync(logDir, { recursive: true })
      const logFd = openSync(join(logDir, 'restart.log'), 'a')

      const child = cp.spawn(process.execPath, [script], {
        cwd: deps.crabotHome,
        detached: true,
        stdio: ['ignore', logFd, logFd],
        env: { ...process.env, CRABOT_RESTART_REASON: reason ?? '' },
      })
      // 必须在 unref 前挂 error 监听：spawn 失败异步 emit 'error'，
      // 任何 await 间隙都会让它漏成 uncaughtException 干掉主进程。
      child.on('error', (err) => {
        console.error('[restart_instance] spawn restart.mjs failed:', err)
      })
      child.unref()

      return {
        output: '重启已发起，本实例（含 agent 自己）即将停止并重新拉起。这是我处理本次请求的最后一步。',
        isError: false,
      }
    },
  })
}
