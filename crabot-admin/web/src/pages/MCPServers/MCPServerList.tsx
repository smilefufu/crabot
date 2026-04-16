import React, { useState, useEffect } from 'react'
import { mcpService } from '../../services/mcp'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import type { MCPServerRegistryEntry } from '../../types'
import { useToast } from '../../contexts/ToastContext'

type FormData = {
  name: string
  command: string
  args: string
  description: string
  install_method: MCPServerRegistryEntry['install_method'] | ''
}

const EMPTY_FORM: FormData = {
  name: '',
  command: '',
  args: '',
  description: '',
  install_method: '',
}

type CreateTab = 'manual' | 'json'

export const MCPServerList: React.FC = () => {
  const toast = useToast()
  const [servers, setServers] = useState<MCPServerRegistryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormData>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [createTab, setCreateTab] = useState<CreateTab>('manual')
  const [jsonInput, setJsonInput] = useState('')
  const [jsonParsed, setJsonParsed] = useState<Array<{ name: string; command: string }> | null>(null)

  useEffect(() => {
    load()
  }, [])

  const load = async () => {
    try {
      setLoading(true)
      setServers(await mcpService.list())
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setCreateTab('manual')
    setJsonInput('')
    setJsonParsed(null)
    setShowForm(true)
  }

  const openEdit = (s: MCPServerRegistryEntry) => {
    setEditingId(s.id)
    setForm({
      name: s.name,
      command: s.command,
      args: (s.args ?? []).join(' '),
      description: s.description ?? '',
      install_method: s.install_method ?? '',
    })
    setCreateTab('manual')
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!form.name.trim() || !form.command.trim()) {
      toast.error('名称和命令不能为空')
      return
    }
    setSaving(true)
    try {
      const args = form.args.trim() ? form.args.trim().split(/\s+/) : undefined
      const payload = {
        name: form.name.trim(),
        command: form.command.trim(),
        args,
        description: form.description.trim() || undefined,
        install_method: (form.install_method || undefined) as MCPServerRegistryEntry['install_method'],
      }
      if (editingId) {
        await mcpService.update(editingId, payload)
        toast.success('已更新')
      } else {
        await mcpService.create(payload)
        toast.success('已创建')
      }
      setShowForm(false)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleParseJson = () => {
    try {
      const parsed = JSON.parse(jsonInput)
      const preview: Array<{ name: string; command: string }> = []
      if (parsed.mcpServers && typeof parsed.mcpServers === 'object') {
        for (const [name, cfg] of Object.entries(parsed.mcpServers as Record<string, { command?: string }>)) {
          if (cfg.command) preview.push({ name, command: cfg.command })
        }
      } else if (typeof parsed.command === 'string') {
        const parts = parsed.command.split(/[\s/\\]/)
        preview.push({ name: parts[parts.length - 1] || 'mcp-server', command: parsed.command })
      } else {
        toast.error('无法识别的 JSON 格式')
        return
      }
      setJsonParsed(preview)
    } catch {
      toast.error('JSON 解析失败，请检查格式')
    }
  }

  const handleImportJson = async () => {
    if (!jsonInput.trim()) {
      toast.error('请粘贴 JSON 内容')
      return
    }
    // 先解析预览，如果还没解析的话
    if (!jsonParsed) {
      handleParseJson()
      return
    }
    // 安全确认：显示将要注册的命令列表
    const commandList = jsonParsed.map(p => `• ${p.name}: ${p.command}`).join('\n')
    if (!confirm(`即将注册以下 MCP Server（启用后会作为子进程执行）：\n\n${commandList}\n\n请确认命令来源可信。`)) return
    setSaving(true)
    try {
      const result = await mcpService.importFromJson(jsonInput)
      toast.success(`成功导入 ${result.count} 个 MCP Server`)
      setShowForm(false)
      setJsonInput('')
      setJsonParsed(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败')
    } finally {
      setSaving(false)
    }
  }

  const handleToggle = async (s: MCPServerRegistryEntry) => {
    if (!s.can_disable && s.enabled) {
      toast.error('此 MCP Server 不允许禁用')
      return
    }
    try {
      await mcpService.update(s.id, { enabled: !s.enabled })
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  const handleDelete = async (s: MCPServerRegistryEntry) => {
    if (s.is_builtin) {
      toast.error('内置 MCP Server 不可删除')
      return
    }
    if (!confirm(`确定删除 "${s.name}"？`)) return
    try {
      await mcpService.delete(s.id)
      toast.success('已删除')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  if (loading) return <MainLayout><Loading /></MainLayout>

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: '0.4rem 1rem',
    border: 'none',
    borderBottom: active ? '2px solid var(--primary)' : '2px solid transparent',
    background: 'transparent',
    color: active ? 'var(--primary)' : 'var(--text-secondary)',
    cursor: 'pointer',
    fontWeight: active ? 600 : 400,
    fontSize: '0.9rem',
  })

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>MCP Servers</h1>
        <Button variant="primary" onClick={openCreate}>添加 MCP Server</Button>
      </div>

      {showForm && (
        <div style={{ marginBottom: '1.5rem' }}>
        <Card>
          <h3 style={{ marginBottom: '1rem', fontWeight: 600 }}>
            {editingId ? '编辑 MCP Server' : '添加 MCP Server'}
          </h3>

          {!editingId && (
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: '1rem' }}>
              <button style={tabStyle(createTab === 'manual')} onClick={() => setCreateTab('manual')}>手动填写</button>
              <button style={tabStyle(createTab === 'json')} onClick={() => setCreateTab('json')}>粘贴 JSON</button>
            </div>
          )}

          {createTab === 'manual' && (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>名称 *</label>
                <input className="input" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. filesystem" />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>命令 *</label>
                <input className="input" value={form.command} onChange={e => setForm(f => ({ ...f, command: e.target.value }))} placeholder="e.g. npx @modelcontextprotocol/server-filesystem" />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>参数（空格分隔）</label>
                <input className="input" value={form.args} onChange={e => setForm(f => ({ ...f, args: e.target.value }))} placeholder="e.g. /path/to/dir" />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>描述</label>
                <input className="input" value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>安装方式</label>
                <select className="input" value={form.install_method} onChange={e => setForm(f => ({ ...f, install_method: e.target.value as FormData['install_method'] }))}>
                  <option value="">未指定</option>
                  <option value="npm">npm</option>
                  <option value="pip">pip</option>
                  <option value="binary">binary</option>
                  <option value="local">local</option>
                </select>
              </div>
              <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.25rem' }}>
                <Button variant="primary" onClick={handleSave} disabled={saving}>{saving ? '保存中...' : '保存'}</Button>
                <Button variant="secondary" onClick={() => setShowForm(false)}>取消</Button>
              </div>
            </div>
          )}

          {createTab === 'json' && (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                  粘贴 Claude Desktop 格式 JSON（mcpServers 格式或单 server 格式）
                </label>
                <textarea
                  className="input"
                  value={jsonInput}
                  onChange={e => { setJsonInput(e.target.value); setJsonParsed(null) }}
                  rows={8}
                  style={{ fontFamily: 'monospace', resize: 'vertical' }}
                  placeholder={'{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]\n    }\n  }\n}'}
                />
              </div>
              {jsonParsed && (
                <div style={{ padding: '0.75rem', background: 'var(--bg-secondary)', borderRadius: '6px', fontSize: '0.85rem' }}>
                  <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>解析结果（{jsonParsed.length} 个 Server）：</div>
                  {jsonParsed.map((p, i) => (
                    <div key={i} style={{ color: 'var(--text-secondary)' }}>• {p.name}: <code>{p.command}</code></div>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <Button variant="secondary" onClick={handleParseJson}>解析预览</Button>
                <Button variant="primary" onClick={handleImportJson} disabled={saving}>{saving ? '导入中...' : '确认导入'}</Button>
                <Button variant="secondary" onClick={() => setShowForm(false)}>取消</Button>
              </div>
            </div>
          )}
        </Card>
        </div>
      )}

      {servers.length === 0 ? (
        <Card>
          <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
            暂无 MCP Server，点击"添加"创建一个
          </p>
        </Card>
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {servers.map(s => (
            <Card key={s.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem' }}>
                    <span style={{ fontWeight: 600, fontSize: '1rem' }}>{s.name}</span>
                    {s.is_builtin && (
                      <span style={{ fontSize: '0.75rem', padding: '0.1rem 0.5rem', background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', borderRadius: '4px' }}>内置</span>
                    )}
                    {s.is_essential && (
                      <span style={{ fontSize: '0.75rem', padding: '0.1rem 0.5rem', background: 'rgba(59,130,246,0.15)', color: '#3b82f6', borderRadius: '4px' }}>必要</span>
                    )}
                    <span style={{
                      fontSize: '0.75rem', padding: '0.1rem 0.5rem', borderRadius: '4px',
                      background: s.enabled ? 'rgba(34,197,94,0.15)' : 'rgba(107,114,128,0.15)',
                      color: s.enabled ? '#22c55e' : '#6b7280',
                    }}>
                      {s.enabled ? '已启用' : '已禁用'}
                    </span>
                  </div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                    {s.command}{s.args?.length ? ' ' + s.args.join(' ') : ''}
                  </div>
                  {s.description && (
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: '0.25rem' }}>{s.description}</div>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
                  {s.can_disable && (
                    <Button variant="secondary" onClick={() => handleToggle(s)} style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem' }}>
                      {s.enabled ? '禁用' : '启用'}
                    </Button>
                  )}
                  {!s.is_builtin && (
                    <>
                      <Button variant="secondary" onClick={() => openEdit(s)} style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem' }}>编辑</Button>
                      <Button variant="danger" onClick={() => handleDelete(s)} style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem' }}>删除</Button>
                    </>
                  )}
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </MainLayout>
  )
}
