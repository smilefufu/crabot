import React, { useState, useEffect, useRef } from 'react'
import { skillService, type GitSkillItem } from '../../services/skill'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import type { SkillRegistryEntry } from '../../types'
import { useToast } from '../../contexts/ToastContext'

type FormData = {
  name: string
  description: string
  version: string
  content: string
  trigger_phrases: string
}

const EMPTY_FORM: FormData = {
  name: '',
  description: '',
  version: '1.0.0',
  content: '',
  trigger_phrases: '',
}

function parseSkillMdFrontmatter(content: string): { name?: string; version?: string; description?: string; trigger_phrases?: string[] } {
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return {}
  const meta: Record<string, string | string[]> = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    if (key === 'trigger_phrases') {
      try {
        meta[key] = JSON.parse(val)
      } catch {
        meta[key] = val.split(',').map(s => s.trim()).filter(Boolean)
      }
    } else {
      meta[key] = val
    }
  }
  return meta as { name?: string; version?: string; description?: string; trigger_phrases?: string[] }
}

type CreateTab = 'git' | 'local' | 'upload'

export const SkillList: React.FC = () => {
  const toast = useToast()
  const [skills, setSkills] = useState<SkillRegistryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormData>(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [previewId, setPreviewId] = useState<string | null>(null)
  const [createTab, setCreateTab] = useState<CreateTab>('git')
  // Git import state
  const [gitUrl, setGitUrl] = useState('')
  const [gitScanning, setGitScanning] = useState(false)
  const [gitSkills, setGitSkills] = useState<GitSkillItem[] | null>(null)
  const [gitSelected, setGitSelected] = useState<Set<string>>(new Set())
  const [gitInstalling, setGitInstalling] = useState(false)
  // Local import state
  const [localPath, setLocalPath] = useState('')
  // Upload state
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { load() }, [])

  const load = async () => {
    try {
      setLoading(true)
      setSkills(await skillService.list())
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  const openCreate = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setCreateTab('git')
    setGitUrl('')
    setGitSkills(null)
    setGitSelected(new Set())
    setLocalPath('')
    setShowForm(true)
    setPreviewId(null)
  }

  const openEdit = (s: SkillRegistryEntry) => {
    setEditingId(s.id)
    setForm({
      name: s.name,
      description: s.description,
      version: s.version,
      content: s.content,
      trigger_phrases: (s.trigger_phrases ?? []).join(', '),
    })
    setShowForm(true)
    setPreviewId(null)
  }

  const handleContentChange = (content: string) => {
    const parsed = parseSkillMdFrontmatter(content)
    setForm(prev => ({
      ...prev,
      content,
      ...(parsed.name ? { name: parsed.name } : {}),
      ...(parsed.version ? { version: parsed.version } : {}),
      ...(parsed.description ? { description: parsed.description } : {}),
      ...(parsed.trigger_phrases ? { trigger_phrases: parsed.trigger_phrases.join(', ') } : {}),
    }))
  }

  const handleSave = async () => {
    if (!editingId) return
    if (!form.name.trim()) { toast.error('名称不能为空'); return }
    setSaving(true)
    try {
      const triggerPhrases = form.trigger_phrases
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
      await skillService.update(editingId, {
        name: form.name.trim(),
        description: form.description.trim(),
        version: form.version.trim(),
        content: form.content,
        trigger_phrases: triggerPhrases,
      })
      toast.success('保存成功')
      setShowForm(false)
      setEditingId(null)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleScanGit = async () => {
    if (!gitUrl.trim()) { toast.error('请输入 GitHub URL'); return }
    setGitScanning(true)
    setGitSkills(null)
    setGitSelected(new Set())
    try {
      const result = await skillService.scanGitRepo(gitUrl.trim())
      setGitSkills(result.skills)
      if (result.skills.length === 1) {
        setGitSelected(new Set([result.skills[0].skill_md_url]))
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '扫描失败')
    } finally {
      setGitScanning(false)
    }
  }

  const handleInstallGit = async () => {
    if (gitSelected.size === 0) { toast.error('请选择要安装的 Skill'); return }
    setGitInstalling(true)
    let successCount = 0
    for (const url of gitSelected) {
      try {
        await skillService.installFromGit(url, gitUrl.trim())
        successCount++
      } catch (err) {
        toast.error(`安装失败: ${err instanceof Error ? err.message : url}`)
      }
    }
    setGitInstalling(false)
    if (successCount > 0) {
      toast.success(`成功安装 ${successCount} 个 Skill`)
      setShowForm(false)
      await load()
    }
  }

  const handleImportLocal = async () => {
    if (!localPath.trim()) { toast.error('请输入本地目录路径'); return }
    setSaving(true)
    try {
      await skillService.importFromLocal(localPath.trim())
      toast.success('导入成功')
      setShowForm(false)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '导入失败')
    } finally {
      setSaving(false)
    }
  }

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setSaving(true)
    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const result = reader.result as string
          // data:application/zip;base64,XXXXX -> 提取 base64 部分
          resolve(result.split(',')[1] ?? '')
        }
        reader.onerror = () => reject(new Error('文件读取失败'))
        reader.readAsDataURL(file)
      })
      await skillService.importFromUpload(base64, file.name)
      toast.success('上传导入成功')
      setShowForm(false)
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '上传失败')
    } finally {
      setSaving(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const handleDelete = async (s: SkillRegistryEntry) => {
    if (s.is_builtin) { toast.error('内置 Skill 不可删除'); return }
    if (!confirm(`确定删除 "${s.name}"？`)) return
    try {
      await skillService.delete(s.id)
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
        <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>Skills</h1>
        <Button variant="primary" onClick={openCreate}>添加 Skill</Button>
      </div>

      {showForm && (
        <div style={{ marginBottom: '1.5rem' }}>
        <Card>
          <h3 style={{ marginBottom: '1rem', fontWeight: 600 }}>
            {editingId ? '编辑 Skill' : '添加 Skill'}
          </h3>

          {editingId ? (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>名称</label>
                <input className="input" value={form.name} onChange={e => setForm(prev => ({ ...prev, name: e.target.value }))} />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>版本</label>
                  <input className="input" value={form.version} onChange={e => setForm(prev => ({ ...prev, version: e.target.value }))} />
                </div>
                <div>
                  <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>触发词（逗号分隔）</label>
                  <input className="input" value={form.trigger_phrases} onChange={e => setForm(prev => ({ ...prev, trigger_phrases: e.target.value }))} placeholder="例: 代码审查, review" />
                </div>
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>描述</label>
                <input className="input" value={form.description} onChange={e => setForm(prev => ({ ...prev, description: e.target.value }))} />
              </div>
              <div>
                <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>内容（Markdown）</label>
                <textarea
                  className="input"
                  value={form.content}
                  onChange={e => handleContentChange(e.target.value)}
                  rows={12}
                  style={{ fontFamily: 'monospace', fontSize: '0.85rem', resize: 'vertical' }}
                />
              </div>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <Button variant="primary" onClick={handleSave} disabled={saving}>{saving ? '保存中...' : '保存'}</Button>
                <Button variant="secondary" onClick={() => { setShowForm(false); setEditingId(null) }}>取消</Button>
              </div>
            </div>
          ) : (
            <>
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', marginBottom: '1rem', flexWrap: 'wrap' }}>
              <button style={tabStyle(createTab === 'git')} onClick={() => setCreateTab('git')}>从 Git 仓库</button>
              <button style={tabStyle(createTab === 'local')} onClick={() => setCreateTab('local')}>本地路径</button>
              <button style={tabStyle(createTab === 'upload')} onClick={() => setCreateTab('upload')}>上传文件</button>
            </div>

          {createTab === 'git' && (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>GitHub 仓库 URL</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input
                    className="input"
                    value={gitUrl}
                    onChange={e => { setGitUrl(e.target.value); setGitSkills(null) }}
                    placeholder="https://github.com/user/repo 或 https://github.com/user/repo/tree/main/skills"
                    style={{ flex: 1 }}
                  />
                  <Button variant="secondary" onClick={handleScanGit} disabled={gitScanning}>
                    {gitScanning ? '扫描中...' : '扫描'}
                  </Button>
                </div>
              </div>
              {gitSkills !== null && (
                <div>
                  {gitSkills.length === 0 ? (
                    <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>未找到 Skill（仓库中没有 SKILL.md 文件）</div>
                  ) : (
                    <>
                      <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>
                        找到 {gitSkills.length} 个 Skill，选择要安装的：
                      </div>
                      <div style={{ maxHeight: '300px', overflow: 'auto', border: '1px solid var(--border)', borderRadius: '6px' }}>
                        {gitSkills.map(skill => (
                          <label key={skill.skill_md_url} style={{
                            display: 'flex', alignItems: 'start', gap: '0.75rem',
                            padding: '0.75rem', borderBottom: '1px solid var(--border)',
                            cursor: 'pointer',
                          }}>
                            <input
                              type="checkbox"
                              checked={gitSelected.has(skill.skill_md_url)}
                              onChange={e => {
                                const next = new Set(gitSelected)
                                if (e.target.checked) next.add(skill.skill_md_url)
                                else next.delete(skill.skill_md_url)
                                setGitSelected(next)
                              }}
                              style={{ marginTop: '0.2rem' }}
                            />
                            <div>
                              <div style={{ fontWeight: 600, fontSize: '0.9rem' }}>{skill.name}</div>
                              {skill.description && <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{skill.description}</div>}
                            </div>
                          </label>
                        ))}
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.5rem', fontSize: '0.8rem' }}>
                        <button style={{ background: 'none', border: 'none', color: 'var(--primary)', cursor: 'pointer' }}
                          onClick={() => setGitSelected(new Set(gitSkills.map(s => s.skill_md_url)))}>全选</button>
                        <button style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer' }}
                          onClick={() => setGitSelected(new Set())}>取消全选</button>
                      </div>
                    </>
                  )}
                </div>
              )}
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <Button variant="primary" onClick={handleInstallGit} disabled={gitInstalling || gitSelected.size === 0}>
                  {gitInstalling ? '安装中...' : `安装选中 (${gitSelected.size})`}
                </Button>
                <Button variant="secondary" onClick={() => setShowForm(false)}>取消</Button>
              </div>
            </div>
          )}

          {createTab === 'local' && (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>本地目录路径（包含 SKILL.md 的目录）</label>
                <input
                  className="input"
                  value={localPath}
                  onChange={e => setLocalPath(e.target.value)}
                  placeholder="/path/to/my-skill"
                />
              </div>
              <div style={{ display: 'flex', gap: '0.75rem' }}>
                <Button variant="primary" onClick={handleImportLocal} disabled={saving}>{saving ? '导入中...' : '导入'}</Button>
                <Button variant="secondary" onClick={() => setShowForm(false)}>取消</Button>
              </div>
            </div>
          )}

          {createTab === 'upload' && (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <div>
                <label style={{ display: 'block', marginBottom: '0.25rem', fontSize: '0.875rem', color: 'var(--text-secondary)' }}>上传 .zip 或 .skill 文件</label>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".zip,.skill"
                  onChange={handleFileUpload}
                  disabled={saving}
                  style={{ display: 'block', padding: '0.5rem 0' }}
                />
                {saving && <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>上传中...</div>}
              </div>
              <div>
                <Button variant="secondary" onClick={() => setShowForm(false)}>取消</Button>
              </div>
            </div>
          )}
          </>
          )}
        </Card>
        </div>
      )}

      {skills.length === 0 ? (
        <Card>
          <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
            暂无 Skill，点击"添加"创建一个
          </p>
        </Card>
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {skills.map(s => (
            <Card key={s.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.25rem' }}>
                    <span style={{ fontWeight: 600, fontSize: '1rem' }}>{s.name}</span>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>v{s.version}</span>
                    {s.is_builtin && (
                      <span style={{ fontSize: '0.75rem', padding: '0.1rem 0.5rem', background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', borderRadius: '4px' }}>内置</span>
                    )}
                    {s.is_essential && (
                      <span style={{ fontSize: '0.75rem', padding: '0.1rem 0.5rem', background: 'rgba(59,130,246,0.15)', color: '#3b82f6', borderRadius: '4px' }}>必要</span>
                    )}
                  </div>
                  {s.description && (
                    <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>{s.description}</div>
                  )}
                  {s.trigger_phrases?.length ? (
                    <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                      触发词: {s.trigger_phrases.join(', ')}
                    </div>
                  ) : null}
                  {previewId === s.id && (
                    <pre style={{
                      marginTop: '0.75rem', padding: '0.75rem',
                      background: 'var(--bg-secondary)', borderRadius: '6px',
                      fontSize: '0.8rem', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      maxHeight: '200px', overflow: 'auto',
                    }}>
                      {s.content}
                    </pre>
                  )}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0 }}>
                  <Button
                    variant="secondary"
                    onClick={() => setPreviewId(previewId === s.id ? null : s.id)}
                    style={{ fontSize: '0.8rem', padding: '0.3rem 0.75rem' }}
                  >
                    {previewId === s.id ? '收起' : '预览'}
                  </Button>
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

