/**
 * 消息气泡旁任务状态小图标
 * 运行中 → spinner；等待 → ⏸；完成 → ✓；失败 → ✗；无快照 → 灰色 ○
 * hover tooltip 显示标题 + 状态 + 当前步骤；点击跳 /traces?task_id=
 */
import React from 'react'
import { useNavigate } from 'react-router-dom'
import { Tooltip } from '../../components/Common/Tooltip'
import type { ChatTaskSnapshot } from '../../types/chat'

/**
 * 状态中文映射。上半段是 v2 存量任务的状态，下半段是 protocol-agent-v3 §5.2 的精简状态机
 * （cutover 之后 agent 事件推过来的就是这几个值）。两套并存：历史卡片仍要看得懂。
 */
const STATUS_LABELS: Record<string, string> = {
  pending: '排队中',
  planning: '规划中',
  executing: '执行中',
  waiting: '等待中',
  waiting_human: '等回复',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  // protocol-agent-v3 §5.2(2026-08-31 状态机修正:4 态)
  queued: '排队中',
  running: '执行中',
  halted: '已停止待处置',
  closed: '已关闭',
  // 旧值兼容(历史数据)
  waiting_input: '等回复',
}

/** 运行中状态（显示 spinner） */
const SPINNING_STATUSES = new Set(['pending', 'planning', 'executing', 'queued', 'running'])

/** 等待状态（显示 ⏸） */
const WAITING_STATUSES = new Set(['waiting', 'waiting_human', 'waiting_input', 'halted'])

interface TaskStatusIconProps {
  taskId: string
  snapshot?: ChatTaskSnapshot
}

export const TaskStatusIcon: React.FC<TaskStatusIconProps> = ({ taskId, snapshot }) => {
  const navigate = useNavigate()

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    navigate(`/traces?task_id=${encodeURIComponent(taskId)}`)
  }

  // Tooltip 内容
  const tooltipContent = (
    <div style={{ fontSize: '0.8rem', lineHeight: 1.5, maxWidth: 220 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>
        {snapshot ? snapshot.title : taskId.slice(0, 12)}
      </div>
      {snapshot && (
        <div style={{ color: 'rgba(255,255,255,0.85)' }}>
          状态：{STATUS_LABELS[snapshot.status] ?? snapshot.status}
        </div>
      )}
      {snapshot?.step && (
        <div style={{ color: 'rgba(255,255,255,0.75)', marginTop: 2 }}>
          进度 {snapshot.step.index + 1}/{snapshot.step.total}：{snapshot.step.description}
        </div>
      )}
    </div>
  )

  // 图标主体
  let icon: React.ReactNode
  if (!snapshot) {
    // 无快照：灰色空心圆
    icon = (
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          border: '1.5px solid var(--text-secondary)',
          opacity: 0.5,
        }}
      />
    )
  } else if (SPINNING_STATUSES.has(snapshot.status)) {
    icon = (
      <div className="spinner" style={{ width: 14, height: 14, borderWidth: 2, flexShrink: 0 }} />
    )
  } else if (WAITING_STATUSES.has(snapshot.status)) {
    icon = (
      <span
        style={{ fontSize: 14, lineHeight: 1, color: 'var(--warning)', userSelect: 'none' }}
        aria-label="等待"
      >
        ⏸
      </span>
    )
  } else if (snapshot.status === 'completed') {
    icon = (
      <span
        style={{ fontSize: 13, lineHeight: 1, color: 'var(--success)', fontWeight: 700, userSelect: 'none' }}
        aria-label="已完成"
      >
        ✓
      </span>
    )
  } else if (snapshot.status === 'failed' || snapshot.status === 'cancelled') {
    icon = (
      <span
        style={{ fontSize: 13, lineHeight: 1, color: 'var(--error)', fontWeight: 700, userSelect: 'none' }}
        aria-label="失败"
      >
        ✗
      </span>
    )
  } else {
    // 未知状态：灰色空心圆
    icon = (
      <div
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          border: '1.5px solid var(--text-secondary)',
          opacity: 0.4,
        }}
      />
    )
  }

  return (
    <Tooltip content={tooltipContent} placement="top" size="md">
      <div
        onClick={handleClick}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 20,
          height: 20,
          cursor: 'pointer',
          flexShrink: 0,
        }}
        role="button"
        aria-label={snapshot ? `任务：${snapshot.title}` : `任务 ${taskId.slice(0, 8)}`}
      >
        {icon}
      </div>
    </Tooltip>
  )
}
