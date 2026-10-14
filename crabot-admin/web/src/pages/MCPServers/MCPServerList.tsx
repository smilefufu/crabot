import React, { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { computerUseService, desktopStatusText, type ComputerUseSetupStatus } from '../../services/computerUse'
import { mcpService } from '../../services/mcp'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Input } from '../../components/Common/Input'
import { Select } from '../../components/Common/Select'
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

const INSTALL_METHODS = [
  { value: '', label: '未指定' },
  { value: 'npm', label: 'npm' },
  { value: 'pip', label: 'pip' },
  { value: 'binary', label: 'binary' },
  { value: 'local', label: 'local' },
]

export const MCPServerList: React.FC = () => {
  const toast = useToast()
  const [servers, setServers] = useState<MCPServerRegistryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [desktop, setDesktop] = useState<ComputerUseSetupStatus | null>(null)
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
      const next = await mcpService.list()
      setServers(next)
      if (next.some(server => server.name === 'computer-use')) setDesktop(await computerUseService.status().catch(() => null))
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
    if (!jsonParsed) {
      handleParseJson()
      return
    }
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

  return (
    <MainLayout>
      <header className="page-header">
        <h1 className="page-header__title">MCP Servers</h1>
        <Button variant="primary" onClick={openCreate}>添加 MCP Server</Button>
      </header>

      {showForm && (
        <div className="mcp-form-wrapper">
          <Card>
            <h3 className="mcp-form__title">
              {editingId ? '编辑 MCP Server' : '添加 MCP Server'}
            </h3>

            {!editingId && (
              <div className="tabs-strip" role="tablist">
                <button
                  type="button"
                  role="tab"
                  aria-selected={createTab === 'manual'}
                  className={`tabs-strip__tab${createTab === 'manual' ? ' tabs-strip__tab--active' : ''}`}
                  onClick={() => setCreateTab('manual')}
                >手动填写</button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={createTab === 'json'}
                  className={`tabs-strip__tab${createTab === 'json' ? ' tabs-strip__tab--active' : ''}`}
                  onClick={() => setCreateTab('json')}
                >粘贴 JSON</button>
              </div>
            )}

            {createTab === 'manual' && (
              <div className="mcp-form__grid">
                <Input
                  label="名称 *"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. filesystem"
                />
                <Input
                  label="命令 *"
                  value={form.command}
                  onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                  placeholder="e.g. npx @modelcontextprotocol/server-filesystem"
                />
                <Input
                  label="参数（空格分隔）"
                  value={form.args}
                  onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                  placeholder="e.g. /path/to/dir"
                />
                <Input
                  label="描述"
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                />
                <Select
                  label="安装方式"
                  value={form.install_method ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, install_method: e.target.value as FormData['install_method'] }))}
                  options={INSTALL_METHODS}
                />
                <div className="mcp-form__actions">
                  <Button variant="primary" onClick={handleSave} disabled={saving}>
                    {saving ? '保存中…' : '保存'}
                  </Button>
                  <Button variant="secondary" onClick={() => setShowForm(false)}>取消</Button>
                </div>
              </div>
            )}

            {createTab === 'json' && (
              <div className="mcp-form__grid">
                <div className="form-group">
                  <label className="form-label" htmlFor="mcp-json-input">
                    粘贴 Claude Desktop 格式 JSON（mcpServers 格式或单 server 格式）
                  </label>
                  <textarea
                    id="mcp-json-input"
                    className="input mcp-form__json-input"
                    value={jsonInput}
                    onChange={(e) => { setJsonInput(e.target.value); setJsonParsed(null) }}
                    rows={8}
                    placeholder={'{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]\n    }\n  }\n}'}
                  />
                </div>
                {jsonParsed && (
                  <div className="mcp-form__preview" role="status">
                    <div className="mcp-form__preview-title">
                      解析结果（{jsonParsed.length} 个 Server）：
                    </div>
                    {jsonParsed.map((p, i) => (
                      <div key={i} className="mcp-form__preview-row">
                        • {p.name}：<code>{p.command}</code>
                      </div>
                    ))}
                  </div>
                )}
                <div className="mcp-form__actions">
                  <Button variant="secondary" onClick={handleParseJson}>解析预览</Button>
                  <Button variant="primary" onClick={handleImportJson} disabled={saving}>
                    {saving ? '导入中…' : '确认导入'}
                  </Button>
                  <Button variant="secondary" onClick={() => setShowForm(false)}>取消</Button>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      {servers.length === 0 ? (
        <Card>
          <p className="empty-state__text">暂无 MCP Server，点击「添加」创建一个</p>
        </Card>
      ) : (
        <div className="mcp-list">
          {servers.map((s) => (
            <Card key={s.id}>
              <div className="mcp-row">
                <div className="mcp-row__info">
                  <div className="mcp-row__header">
                    <span className="mcp-row__name">{s.name === 'computer-use' && desktop?.standard ? '桌面控制' : s.name}</span>
                    {s.is_builtin && <span className="tag tag--info">内置</span>}
                    {s.is_essential && <span className="tag tag--primary">必要</span>}
                    <span className={`tag ${s.enabled ? 'tag--success' : ''}`}>
                      {s.enabled ? '已启用' : '已禁用'}
                    </span>
                  </div>
                  <div className="mcp-row__cmd">
                    {s.name === 'computer-use' && desktop?.standard ? 'computer-use · ' : ''}{s.command}{s.args?.length ? ' ' + s.args.join(' ') : ''}
                  </div>
                  {s.name === 'computer-use' && desktop && (
                    <p className="mcp-row__desc">桌面控制：{desktopStatusText(desktop)} · <Link to="/settings#computer-use">设置桌面控制</Link></p>
                  )}
                  {s.description && (
                    <div className="mcp-row__desc">{s.description}</div>
                  )}
                </div>
                <div className="mcp-row__actions">
                  {s.can_disable && (
                    <Button variant="secondary" size="sm" onClick={() => handleToggle(s)}>
                      {s.enabled ? '禁用' : '启用'}
                    </Button>
                  )}
                  {!s.is_builtin && (
                    <>
                      <Button variant="secondary" size="sm" onClick={() => openEdit(s)}>编辑</Button>
                      <Button variant="danger" size="sm" onClick={() => handleDelete(s)}>删除</Button>
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
