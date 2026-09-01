/**
 * Worker 任务状态的人话展示(spec 2026-08-31-worker-stop-oversight-design §11
 * 「Admin 任务页展示形态优化」)。
 *
 * 状态枚举只是机器判据(过滤/图标分支),给人看的文案一律由 evidence 推导:
 * 停因、worker 自报结论、时间,而不是一个干巴巴的状态词。
 */

import type { WorkerTaskStatus } from '../../services/agent-observability'

export interface WorkerTaskEvidenceShape {
  status: WorkerTaskStatus | string
  halt?: {
    halted_at?: string
    halt_reason?: string
    worker_self_report?: { outcome: 'completed' | 'failed'; summary: string }
    stop_unverified?: boolean
    detail?: string
  }
  closed?: { at?: string; by?: string; note?: string }
}

export type WorkerStateTone = 'muted' | 'info' | 'warn' | 'muted-strong'

export const TONE_COLOR: Record<WorkerStateTone, string> = {
  muted: 'var(--text-muted)',
  'muted-strong': 'var(--text-secondary)',
  info: 'var(--info)',
  warn: 'var(--warning)',
}

export interface WorkerStatePhrase {
  /** 给人看的一句话(已含停因/自报/时间)。 */
  phrase: string
  /** 色调:在跑=info,停止待处置=warn,已关闭/排队=muted。 */
  tone: WorkerStateTone
}

function hhmm(iso: string | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return ''
  const d = new Date(iso)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function haltReasonPhrase(reason: string | undefined, halt: NonNullable<WorkerTaskEvidenceShape['halt']>): string {
  switch (reason) {
    case 'worker_finalized': {
      const report = halt.worker_self_report
      if (report) return `自报${report.outcome === 'failed' ? '失败' : '完成'}：${report.summary}`
      return '自报收尾'
    }
    case 'crashed':
      return halt.detail ? `崩溃（${halt.detail}）` : '崩溃'
    case 'pre_migration':
      return 'v2 迁移归档'
    case 'unknown':
      return halt.stop_unverified ? '停止未核验' : '原因未知'
    case 'turn_end':
      return '回合结束'
    default:
      return '原因未知'
  }
}

/** 组出给人看的状态短语。枚举只作判据,不出现在文案里。 */
export function describeWorkerTask(task: WorkerTaskEvidenceShape): WorkerStatePhrase {
  switch (task.status) {
    case 'running':
      return { phrase: '在跑', tone: 'info' }
    case 'queued':
      return { phrase: '排队中', tone: 'muted' }
    case 'closed': {
      const at = hhmm(task.closed?.at)
      return { phrase: at ? `已关闭（${at}）` : '已关闭', tone: 'muted-strong' }
    }
    case 'halted': {
      const halt = task.halt ?? {}
      const at = hhmm(halt.halted_at)
      const time = at ? `，${at}` : ''
      return { phrase: `已停止：${haltReasonPhrase(halt.halt_reason, halt)}${time}`, tone: 'warn' }
    }
    default:
      return { phrase: String(task.status ?? ''), tone: 'muted' }
  }
}
