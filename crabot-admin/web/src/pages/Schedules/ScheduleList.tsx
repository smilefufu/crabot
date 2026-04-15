import React, { useState, useEffect, useCallback } from 'react'
import { scheduleService, type CreateScheduleData } from '../../services/schedule'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { ConfirmModal } from '../../components/Common/ConfirmModal'
import type {
  Schedule,
  ScheduleTrigger,
  ScheduleTriggerType,
  ScheduleTaskTemplate,
} from '../../types'
import { useToast } from '../../contexts/ToastContext'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTrigger(trigger: ScheduleTrigger): string {
  switch (trigger.type) {
    case 'cron':
      return `Cron: ${trigger.expression}${trigger.timezone ? ` (${trigger.timezone})` : ''}`
    case 'interval': {
      const s = trigger.seconds
      if (s >= 86400 && s % 86400 === 0) return `${s / 86400} 天`
      if (s >= 3600 && s % 3600 === 0) return `${s / 3600} 小时`
      if (s >= 60 && s % 60 === 0) return `${s / 60} 分钟`
      return `${s} 秒`
    }
    case 'once':
      return `单次: ${new Date(trigger.execute_at).toLocaleString()}`
  }
}

function triggerTypeLabel(type: ScheduleTriggerType): string {
  switch (type) {
    case 'cron': return 'Cron'
    case 'interval': return '定时'
    case 'once': return '单次'
  }
}

function triggerTypeColor(type: ScheduleTriggerType): string {
  switch (type) {
    case 'cron': return '#8b5cf6'     // purple
    case 'interval': return '#3b82f6' // blue
    case 'once': return '#e8b44a'     // amber
  }
}

function priorityLabel(p: string): string {
  switch (p) {
    case 'urgent': return '紧急'
    case 'high': return '高'
    case 'normal': return '普通'
    case 'low': return '低'
    default: return p
  }
}

function relativeTime(iso?: string): string {
  if (!iso) return '从未'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86400_000)} 天前`
}

// ---------------------------------------------------------------------------
// Form types
// ---------------------------------------------------------------------------

interface ScheduleFormState {
  name: string
  description: string
  enabled: boolean
  triggerType: ScheduleTriggerType
  cronExpression: string
  cronTimezone: string
  intervalSeconds: string
  onceAt: string
  taskTitle: string
  taskDescription: string
  taskPriority: string
  taskTags: string
}

const EMPTY_FORM: ScheduleFormState = {
  name: '',
  description: '',
  enabled: true,
  triggerType: 'interval',
  cronExpression: '0 9 * * *',
  cronTimezone: '',
  intervalSeconds: '3600',
  onceAt: '',
  taskTitle: '',
  taskDescription: '',
  taskPriority: 'normal',
  taskTags: '',
}

function formToPayload(form: ScheduleFormState): CreateScheduleData {
  let trigger: ScheduleTrigger
  switch (form.triggerType) {
    case 'cron':
      trigger = {
        type: 'cron',
        expression: form.cronExpression.trim(),
        ...(form.cronTimezone.trim() ? { timezone: form.cronTimezone.trim() } : {}),
      }
      break
    case 'interval':
      trigger = { type: 'interval', seconds: parseInt(form.intervalSeconds, 10) || 60 }
      break
    case 'once':
      trigger = { type: 'once', execute_at: new Date(form.onceAt).toISOString() }
      break
  }

  const task_template: ScheduleTaskTemplate = {
    title: form.taskTitle.trim(),
    description: form.taskDescription.trim() || undefined,
    priority: form.taskPriority as ScheduleTaskTemplate['priority'],
    tags: form.taskTags.split(',').map(s => s.trim()).filter(Boolean),
  }

  return {
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    enabled: form.enabled,
    trigger,
    task_template,
  }
}

function scheduleToForm(s: Schedule): ScheduleFormState {
  const base: ScheduleFormState = {
    ...EMPTY_FORM,
    name: s.name,
    description: s.description ?? '',
    enabled: s.enabled,
    triggerType: s.trigger.type,
    taskTitle: s.task_template.title,
    taskDescription: s.task_template.description ?? '',
    taskPriority: s.task_template.priority,
    taskTags: s.task_template.tags.join(', '),
  }
  switch (s.trigger.type) {
    case 'cron':
      base.cronExpression = s.trigger.expression
      base.cronTimezone = s.trigger.timezone ?? ''
      break
    case 'interval':
      base.intervalSeconds = String(s.trigger.seconds)
      break
    case 'once':
      base.onceAt = s.trigger.execute_at.slice(0, 16) // datetime-local format
      break
  }
  return base
}

// ---------------------------------------------------------------------------
// Inline styles (follows codebase pattern — inline + CSS class hybrid)
// ---------------------------------------------------------------------------

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: '0.25rem',
  fontSize: '0.8rem',
  color: 'var(--text-secondary)',
  fontWeight: 500,
  letterSpacing: '0.03em',
  textTransform: 'uppercase' as const,
  fontFamily: 'var(--font-mono)',
}

const sectionTitle: React.CSSProperties = {
  fontSize: '0.7rem',
  fontWeight: 600,
  color: 'var(--text-muted)',
  textTransform: 'uppercase' as const,
  letterSpacing: '0.1em',
  marginBottom: '0.75rem',
  fontFamily: 'var(--font-mono)',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const ScheduleList: React.FC = () => {
  const toast = useToast()
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [triggerFilter, setTriggerFilter] = useState<ScheduleTriggerType | ''>('')
  const [enabledFilter, setEnabledFilter] = useState<'' | 'true' | 'false'>('')

  // Form state
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<ScheduleFormState>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)

  // Delete
  const [deleteTarget, setDeleteTarget] = useState<Schedule | null>(null)
  const [deleting, setDeleting] = useState(false)

  // Trigger now
  const [triggering, setTriggering] = useState<string | null>(null)

  const loadSchedules = useCallback(async () => {
    try {
      setLoading(true)
      const result = await scheduleService.list({
        search: search || undefined,
        trigger_type: triggerFilter || undefined,
        enabled: enabledFilter === '' ? undefined : enabledFilter === 'true',
      })
      setSchedules(result.items)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [toast, search, triggerFilter, enabledFilter])

  useEffect(() => {
    loadSchedules()
  }, [loadSchedules])

  // Auto-refresh every 30s
  useEffect(() => {
    const timer = setInterval(() => {
      scheduleService.list({
        search: search || undefined,
        trigger_type: triggerFilter || undefined,
        enabled: enabledFilter === '' ? undefined : enabledFilter === 'true',
      }).then(result => setSchedules(result.items)).catch(() => {})
    }, 30_000)
    return () => clearInterval(timer)
  }, [search, triggerFilter, enabledFilter])

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }

  const openEdit = (s: Schedule) => {
    setEditingId(s.id)
    setForm(scheduleToForm(s))
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!form.name.trim()) { toast.error('名称不能为空'); return }
    if (!form.taskTitle.trim()) { toast.error('任务标题不能为空'); return }
    if (form.triggerType === 'interval') {
      const s = parseInt(form.intervalSeconds, 10)
      if (!s || s < 1) { toast.error('间隔秒数必须大于 0'); return }
    }
    if (form.triggerType === 'once' && !form.onceAt) { toast.error('请选择执行时间'); return }

    setSaving(true)
    try {
      const payload = formToPayload(form)
      if (editingId) {
        await scheduleService.update(editingId, payload)
        toast.success('更新成功')
      } else {
        await scheduleService.create(payload)
        toast.success('创建成功')
      }
      setShowForm(false)
      setEditingId(null)
      await loadSchedules()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleToggleEnabled = async (s: Schedule) => {
    try {
      await scheduleService.update(s.id, { enabled: !s.enabled })
      toast.success(s.enabled ? '已禁用' : '已启用')
      await loadSchedules()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await scheduleService.delete(deleteTarget.id)
      toast.success('已删除')
      setDeleteTarget(null)
      await loadSchedules()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeleting(false)
    }
  }

  const handleTriggerNow = async (s: Schedule) => {
    setTriggering(s.id)
    try {
      const result = await scheduleService.triggerNow(s.id)
      toast.success(`触发成功，任务 ID: ${result.task_id.slice(0, 8)}...`)
      await loadSchedules()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '触发失败')
    } finally {
      setTriggering(null)
    }
  }

  const updateForm = (patch: Partial<ScheduleFormState>) =>
    setForm(prev => ({ ...prev, ...patch }))

  if (loading) return <MainLayout><Loading /></MainLayout>

  return (
    <MainLayout>
      {/* Header */}
      <div style={{
        marginBottom: '1.5rem',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div>
          <h1 style={{
            fontSize: '1.75rem',
            fontWeight: 700,
            fontFamily: 'var(--font-display)',
            letterSpacing: '-0.02em',
          }}>
            Schedule
          </h1>
          <p style={{
            fontSize: '0.85rem',
            color: 'var(--text-secondary)',
            marginTop: '0.25rem',
          }}>
            {schedules.length} 个计划任务
            {schedules.filter(s => s.enabled).length > 0 &&
              ` / ${schedules.filter(s => s.enabled).length} 个活跃`}
          </p>
        </div>
        <Button variant="primary" onClick={openCreate}>
          + 新建计划
        </Button>
      </div>

      {/* Filters */}
      <div className="sched-filter-bar">
        <input
          className="input"
          placeholder="搜索名称或描述..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, maxWidth: 280 }}
        />
        <select
          className="select"
          value={triggerFilter}
          onChange={e => setTriggerFilter(e.target.value as ScheduleTriggerType | '')}
        >
          <option value="">全部类型</option>
          <option value="cron">Cron</option>
          <option value="interval">定时</option>
          <option value="once">单次</option>
        </select>
        <select
          className="select"
          value={enabledFilter}
          onChange={e => setEnabledFilter(e.target.value as '' | 'true' | 'false')}
        >
          <option value="">全部状态</option>
          <option value="true">启用</option>
          <option value="false">禁用</option>
        </select>
      </div>

      {/* Create / Edit Form */}
      {showForm && (
        <div className="sched-form-panel">
          <div className="sched-form-header">
            <h3 style={{
              fontFamily: 'var(--font-display)',
              fontSize: '1.1rem',
              fontWeight: 600,
            }}>
              {editingId ? '编辑计划' : '新建计划'}
            </h3>
            <button
              className="sched-form-close"
              onClick={() => { setShowForm(false); setEditingId(null) }}
            >
              &times;
            </button>
          </div>

          <div className="sched-form-body">
            {/* Basic info */}
            <div style={sectionTitle}>基本信息</div>
            <div className="sched-form-grid-2">
              <div>
                <label style={labelStyle}>名称 *</label>
                <input
                  className="input"
                  value={form.name}
                  onChange={e => updateForm({ name: e.target.value })}
                  placeholder="例: 每日反思"
                />
              </div>
              <div>
                <label style={labelStyle}>描述</label>
                <input
                  className="input"
                  value={form.description}
                  onChange={e => updateForm({ description: e.target.value })}
                  placeholder="可选"
                />
              </div>
            </div>

            {/* Trigger config */}
            <div style={{ ...sectionTitle, marginTop: '1.25rem' }}>触发方式</div>
            <div className="sched-trigger-tabs">
              {(['interval', 'cron', 'once'] as ScheduleTriggerType[]).map(t => (
                <button
                  key={t}
                  className={`sched-trigger-tab ${form.triggerType === t ? 'active' : ''}`}
                  onClick={() => updateForm({ triggerType: t })}
                >
                  <span
                    className="sched-trigger-dot"
                    style={{ background: triggerTypeColor(t) }}
                  />
                  {triggerTypeLabel(t)}
                </button>
              ))}
            </div>

            {form.triggerType === 'interval' && (
              <div style={{ marginTop: '0.75rem' }}>
                <label style={labelStyle}>间隔（秒）</label>
                <input
                  className="input"
                  type="number"
                  min="1"
                  value={form.intervalSeconds}
                  onChange={e => updateForm({ intervalSeconds: e.target.value })}
                  style={{ maxWidth: 200 }}
                />
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                  = {formatTrigger({ type: 'interval', seconds: parseInt(form.intervalSeconds, 10) || 0 })}
                </div>
              </div>
            )}

            {form.triggerType === 'cron' && (
              <div className="sched-form-grid-2" style={{ marginTop: '0.75rem' }}>
                <div>
                  <label style={labelStyle}>Cron 表达式</label>
                  <input
                    className="input mono"
                    value={form.cronExpression}
                    onChange={e => updateForm({ cronExpression: e.target.value })}
                    placeholder="0 9 * * *"
                  />
                  <div style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                    分 时 日 月 周
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>时区（可选）</label>
                  <input
                    className="input"
                    value={form.cronTimezone}
                    onChange={e => updateForm({ cronTimezone: e.target.value })}
                    placeholder="Asia/Shanghai"
                  />
                </div>
              </div>
            )}

            {form.triggerType === 'once' && (
              <div style={{ marginTop: '0.75rem' }}>
                <label style={labelStyle}>执行时间</label>
                <input
                  className="input"
                  type="datetime-local"
                  value={form.onceAt}
                  onChange={e => updateForm({ onceAt: e.target.value })}
                  style={{ maxWidth: 280 }}
                />
              </div>
            )}

            {/* Task template */}
            <div style={{ ...sectionTitle, marginTop: '1.25rem' }}>任务模板</div>
            <div className="sched-form-grid-2">
              <div>
                <label style={labelStyle}>任务标题 *</label>
                <input
                  className="input"
                  value={form.taskTitle}
                  onChange={e => updateForm({ taskTitle: e.target.value })}
                  placeholder="支持 {{date}} {{time}} {{schedule_name}}"
                />
              </div>
              <div>
                <label style={labelStyle}>优先级</label>
                <select
                  className="select"
                  value={form.taskPriority}
                  onChange={e => updateForm({ taskPriority: e.target.value })}
                >
                  <option value="low">低</option>
                  <option value="normal">普通</option>
                  <option value="high">高</option>
                  <option value="urgent">紧急</option>
                </select>
              </div>
            </div>
            <div style={{ marginTop: '0.75rem' }}>
              <label style={labelStyle}>任务描述</label>
              <textarea
                className="input"
                value={form.taskDescription}
                onChange={e => updateForm({ taskDescription: e.target.value })}
                rows={3}
                placeholder="详细描述任务内容（支持模板变量）"
                style={{ resize: 'vertical' }}
              />
            </div>
            <div style={{ marginTop: '0.75rem' }}>
              <label style={labelStyle}>标签（逗号分隔）</label>
              <input
                className="input"
                value={form.taskTags}
                onChange={e => updateForm({ taskTags: e.target.value })}
                placeholder="例: reflection, reminder, builtin"
              />
            </div>

            {/* Enabled toggle */}
            <div style={{ marginTop: '1.25rem', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <label className="sched-toggle">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={e => updateForm({ enabled: e.target.checked })}
                />
                <span className="sched-toggle-track" />
              </label>
              <span style={{ fontSize: '0.85rem', color: form.enabled ? 'var(--success)' : 'var(--text-muted)' }}>
                {form.enabled ? '创建后立即启用' : '创建后暂不启用'}
              </span>
            </div>
          </div>

          <div className="sched-form-footer">
            <Button variant="secondary" onClick={() => { setShowForm(false); setEditingId(null) }}>
              取消
            </Button>
            <Button variant="primary" onClick={handleSave} disabled={saving}>
              {saving ? '保存中...' : editingId ? '更新' : '创建'}
            </Button>
          </div>
        </div>
      )}

      {/* Schedule List */}
      {schedules.length === 0 ? (
        <div className="sched-empty">
          <div className="sched-empty-icon">&#128197;</div>
          <p>暂无计划任务</p>
          <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            创建一个计划来定时执行任务
          </p>
        </div>
      ) : (
        <div className="sched-grid">
          {schedules.map(s => (
            <div
              key={s.id}
              className={`sched-card ${!s.enabled ? 'disabled' : ''}`}
            >
              {/* Left accent bar */}
              <div
                className="sched-card-accent"
                style={{
                  background: s.enabled
                    ? triggerTypeColor(s.trigger.type)
                    : 'var(--text-muted)',
                }}
              />

              <div className="sched-card-body">
                {/* Top row: name + badges */}
                <div className="sched-card-header">
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: 1, minWidth: 0 }}>
                    <span className="sched-card-name">{s.name}</span>
                    <span
                      className="sched-badge"
                      style={{
                        background: `${triggerTypeColor(s.trigger.type)}20`,
                        color: triggerTypeColor(s.trigger.type),
                      }}
                    >
                      {triggerTypeLabel(s.trigger.type)}
                    </span>
                    {s.is_builtin && (
                      <span className="sched-badge" style={{
                        background: 'rgba(139,92,246,0.15)',
                        color: '#8b5cf6',
                      }}>
                        内置
                      </span>
                    )}
                    {!s.enabled && (
                      <span className="sched-badge" style={{
                        background: 'var(--error-glow)',
                        color: 'var(--error)',
                      }}>
                        已禁用
                      </span>
                    )}
                  </div>
                  <div className="sched-card-actions">
                    <button
                      className="sched-action-btn"
                      title={s.enabled ? '禁用' : '启用'}
                      onClick={() => handleToggleEnabled(s)}
                    >
                      {s.enabled ? '||' : '\u25B6'}
                    </button>
                    <button
                      className="sched-action-btn trigger"
                      title="立即触发"
                      disabled={triggering === s.id}
                      onClick={() => handleTriggerNow(s)}
                    >
                      {triggering === s.id ? '...' : '\u26A1'}
                    </button>
                    <button
                      className="sched-action-btn"
                      title="编辑"
                      onClick={() => openEdit(s)}
                    >
                      &#9998;
                    </button>
                    {!s.is_builtin && (
                      <button
                        className="sched-action-btn danger"
                        title="删除"
                        onClick={() => setDeleteTarget(s)}
                      >
                        &times;
                      </button>
                    )}
                  </div>
                </div>

                {/* Description */}
                {s.description && (
                  <div className="sched-card-desc">{s.description}</div>
                )}

                {/* Trigger detail */}
                <div className="sched-card-trigger mono">
                  {formatTrigger(s.trigger)}
                </div>

                {/* Stats row */}
                <div className="sched-card-stats">
                  <div className="sched-stat">
                    <span className="sched-stat-label">执行次数</span>
                    <span className="sched-stat-value">{s.execution_count}</span>
                  </div>
                  <div className="sched-stat">
                    <span className="sched-stat-label">上次触发</span>
                    <span className="sched-stat-value">{relativeTime(s.last_triggered_at)}</span>
                  </div>
                  <div className="sched-stat">
                    <span className="sched-stat-label">下次触发</span>
                    <span className="sched-stat-value">
                      {s.enabled && s.next_trigger_at
                        ? new Date(s.next_trigger_at).toLocaleString()
                        : '--'}
                    </span>
                  </div>
                  <div className="sched-stat">
                    <span className="sched-stat-label">任务模板</span>
                    <span className="sched-stat-value" style={{ fontSize: '0.75rem' }}>
                      {s.task_template.title.length > 30
                        ? s.task_template.title.slice(0, 30) + '...'
                        : s.task_template.title}
                      <span style={{ color: 'var(--text-muted)', marginLeft: '0.5rem' }}>
                        [{priorityLabel(s.task_template.priority)}]
                      </span>
                    </span>
                  </div>
                </div>

                {/* Tags */}
                {s.task_template.tags.length > 0 && (
                  <div className="sched-card-tags">
                    {s.task_template.tags.map(tag => (
                      <span key={tag} className="sched-tag">{tag}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delete confirm */}
      <ConfirmModal
        open={!!deleteTarget}
        title="删除计划"
        message={`确定要删除「${deleteTarget?.name}」吗？此操作不可撤销。`}
        confirmVariant="danger"
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </MainLayout>
  )
}
