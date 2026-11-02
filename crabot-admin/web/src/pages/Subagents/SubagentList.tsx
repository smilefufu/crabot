import React, { useState, useEffect, useCallback } from 'react'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { Tooltip } from '../../components/Common/Tooltip'
import { subagentService } from '../../services/subagent'
import type { SubAgentRegistryEntry } from '../../types'
import { useToast } from '../../contexts/ToastContext'
import { SubagentEditor } from './SubagentEditor'

export const SubagentList: React.FC = () => {
  const toast = useToast()
  const [entries, setEntries] = useState<SubAgentRegistryEntry[] | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null) // 'new' | <id> | null
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    try {
      const data = await subagentService.list()
      setEntries(data)
    } catch (err) {
      toast.error('加载 subagent 列表失败：' + (err instanceof Error ? err.message : String(err)))
      setEntries([])
    }
  }, [toast])

  useEffect(() => {
    void reload()
  }, [reload])

  const handleToggleEnabled = useCallback(async (entry: SubAgentRegistryEntry) => {
    if (busy) return
    setBusy(true)
    const next = !entry.enabled
    try {
      await subagentService.update(entry.id, { enabled: next })
      await reload()
    } catch (err) {
      toast.error('切换状态失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setBusy(false)
    }
  }, [busy, reload, toast])

  const handleDelete = useCallback(async (entry: SubAgentRegistryEntry) => {
    if (entry.is_builtin) return
    if (!confirm(`确认删除 subagent "${entry.name}"?`)) return
    try {
      await subagentService.remove(entry.id)
      toast.success(`已删除 ${entry.name}`)
      await reload()
    } catch (err) {
      toast.error('删除失败：' + (err instanceof Error ? err.message : String(err)))
    }
  }, [reload, toast])

  if (entries === null) {
    return <MainLayout><Loading /></MainLayout>
  }

  return (
    <MainLayout>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <h2 style={{ margin: 0 }}>专长助手</h2>
            <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 4 }}>
              管理可被 main agent 委派的 subagent；内置项可编辑可禁用但不可删除
            </div>
          </div>
          <Button onClick={() => setEditingId('new')}>+ 新建</Button>
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid #eee', textAlign: 'left' }}>
              <th style={{ padding: '8px 6px' }}>名称</th>
              <th style={{ padding: '8px 6px' }}>说明</th>
              <th style={{ padding: '8px 6px' }}>类型</th>
              <th style={{ padding: '8px 6px' }}>启用</th>
              <th style={{ padding: '8px 6px' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <td style={{ padding: '8px 6px', fontFamily: 'var(--font-mono)' }}>
                  <Tooltip content={`delegate_task(subagent_type="${entry.name}")`}>
                    <span>{entry.name}</span>
                  </Tooltip>
                </td>
                <Tooltip content={entry.description}>
                  <td style={{ padding: '8px 6px', color: 'var(--text-secondary)', maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.description}
                  </td>
                </Tooltip>
                <td style={{ padding: '8px 6px' }}>
                  <span style={{
                    display: 'inline-block',
                    padding: '2px 8px',
                    borderRadius: 4,
                    fontSize: 12,
                    background: entry.is_builtin ? '#eee' : '#d4edda',
                    color: entry.is_builtin ? '#555' : '#155724',
                  }}>
                    {entry.is_builtin ? '内置' : '自定义'}
                  </span>
                </td>
                <td style={{ padding: '8px 6px' }}>
                  <input
                    type="checkbox"
                    aria-label={`enabled-${entry.name}`}
                    checked={entry.enabled}
                    onChange={() => void handleToggleEnabled(entry)}
                    disabled={busy}
                  />
                </td>
                <td style={{ padding: '8px 6px' }}>
                  <Button
                    onClick={() => setEditingId(entry.id)}
                    style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem' }}
                  >
                    编辑
                  </Button>
                  <Tooltip content={entry.is_builtin ? '内置 subagent 不可删除，可禁用' : '删除此 subagent'}>
                    <Button
                      variant="danger"
                      size="sm"
                      onClick={() => void handleDelete(entry)}
                      disabled={entry.is_builtin}
                      style={{ marginLeft: 6 }}
                    >
                      删除
                    </Button>
                  </Tooltip>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {entries.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '40px 0' }}>
            还没有 subagent。点击右上角「+ 新建」创建第一个。
          </div>
        )}
      </Card>

      {editingId !== null && (
        <SubagentEditor
          mode={editingId === 'new' ? 'create' : 'edit'}
          entry={editingId === 'new' ? null : (entries.find((e) => e.id === editingId) ?? null)}
          onClose={() => setEditingId(null)}
          onSaved={async () => {
            setEditingId(null)
            await reload()
          }}
        />
      )}
    </MainLayout>
  )
}
