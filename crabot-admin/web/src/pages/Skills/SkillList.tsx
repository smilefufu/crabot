import React, { useState, useEffect, useRef } from 'react'
import { skillService, type GitSkillItem, isDuplicateSkillError, type DuplicateSkillErrorBody } from '../../services/skill'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Input } from '../../components/Common/Input'
import { Loading } from '../../components/Common/Loading'
import { StatusBadge } from '../../components/Common/StatusBadge'
import type { SkillRegistryEntry } from '../../types'
import { useToast } from '../../contexts/ToastContext'
import { SkillDiffModal } from './SkillDiffModal'

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

function confirmOverwrite(body: DuplicateSkillErrorBody): boolean {
  const { existing, incoming } = body
  if (existing.is_builtin) {
    alert(`"${existing.name}" 是内置 Skill，不可通过导入覆盖。`)
    return false
  }
  return confirm(
    `已存在同名 Skill "${existing.name}" (当前 v${existing.version})。\n\n` +
    `是否用上传的 v${incoming.version} 覆盖？\n` +
    `点击"确定"覆盖更新，点击"取消"放弃本次上传。`
  )
}

async function importWithOverwritePrompt<T>(
  runImport: (overwrite?: boolean) => Promise<T>
): Promise<T | null> {
  try {
    return await runImport(false)
  } catch (err) {
    if (!isDuplicateSkillError(err)) throw err
    if (!confirmOverwrite(err.body)) return null
    return runImport(true)
  }
}

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
  const [gitUrl, setGitUrl] = useState('')
  const [gitScanning, setGitScanning] = useState(false)
  const [gitSkills, setGitSkills] = useState<GitSkillItem[] | null>(null)
  const [gitSelected, setGitSelected] = useState<Set<string>>(new Set())
  const [gitInstalling, setGitInstalling] = useState(false)
  const [localPath, setLocalPath] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [diffSkill, setDiffSkill] = useState<SkillRegistryEntry | null>(null)
  const [restoringId, setRestoringId] = useState<string | null>(null)

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
    const installedIds: string[] = []
    let skippedCount = 0
    for (const url of gitSelected) {
      try {
        const result = await importWithOverwritePrompt(overwrite =>
          skillService.installFromGit(url, gitUrl.trim(), overwrite)
        )
        if (result) installedIds.push(result.id)
        else skippedCount++
      } catch (err) {
        toast.error(`安装失败: ${err instanceof Error ? err.message : url}`)
      }
    }
    setGitInstalling(false)
    if (installedIds.length > 0) {
      toast.success(`成功安装 ${installedIds.length} 个 Skill`)
      setShowForm(false)
      await load()
    } else if (skippedCount > 0) {
      toast.success(`已取消 ${skippedCount} 个同名 Skill 的覆盖`)
    }
  }

  const handleImportLocal = async () => {
    if (!localPath.trim()) { toast.error('请输入本地目录路径'); return }
    setSaving(true)
    try {
      const imported = await importWithOverwritePrompt(overwrite =>
        skillService.importFromLocal(localPath.trim(), overwrite)
      )
      if (!imported) {
        toast.success('已取消，未做任何变更')
        return
      }
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
          resolve(result.split(',')[1] ?? '')
        }
        reader.onerror = () => reject(new Error('文件读取失败'))
        reader.readAsDataURL(file)
      })
      const imported = await importWithOverwritePrompt(overwrite =>
        skillService.importFromUpload(base64, file.name, overwrite)
      )
      if (!imported) {
        toast.success('已取消，未做任何变更')
        return
      }
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

  const handleToggle = async (s: SkillRegistryEntry) => {
    if (!s.can_disable && s.enabled) {
      toast.error('此 Skill 不允许禁用')
      return
    }
    try {
      await skillService.update(s.id, { enabled: !s.enabled })
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败')
    }
  }

  const handleDelete = async (s: SkillRegistryEntry) => {
    if (s.is_builtin) { toast.error('内置 Skill 不可删除'); return }
    const hint = s.source_type === 'scanned'
      ? `\n\n注意：源文件不会被删除。重新扫描后该 skill 将重新出现。`
      : ''
    if (!confirm(`确定删除 "${s.name}"？${hint}`)) return
    try {
      await skillService.delete(s.id)
      toast.success('已删除')
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  const handleRestore = async (s: SkillRegistryEntry) => {
    if (!s.previous_snapshot) return
    if (!confirm(
      `将「${s.name}」与上一版交换（当前 v${s.version} ↔ 上一版 v${s.previous_snapshot.version}）。\n` +
      `当前版本会被保存为新的上一版，可再次点击撤销。继续？`
    )) return
    setRestoringId(s.id)
    try {
      await skillService.restore(s.id)
      toast.success(`已恢复 ${s.name} 到上一版`)
      await load()
    } catch (err) {
      toast.error(`恢复失败: ${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setRestoringId(null)
    }
  }

  const handleRescan = async () => {
    try {
      const result = await skillService.scanWorkspace()
      if (result.added > 0) {
        toast.success(`扫描完成，新增 ${result.added} 个 skill`)
        await load()
      } else {
        toast.success('扫描完成，未发现新 skill')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '扫描失败')
    }
  }

  if (loading) return <MainLayout><Loading /></MainLayout>

  return (
    <MainLayout>
      <header className="page-header">
        <h1 className="page-header__title">技能</h1>
        <div className="page-header__actions">
          <Button variant="secondary" onClick={handleRescan}>重新扫描</Button>
          <Button variant="primary" onClick={openCreate}>添加 Skill</Button>
        </div>
      </header>

      {showForm && (
        <div className="skill-form-wrapper">
          <Card>
            <h3 className="skill-form__title">
              {editingId ? '编辑 Skill' : '添加 Skill'}
            </h3>

            {editingId ? (
              <div className="skill-form__grid">
                <Input
                  label="名称"
                  value={form.name}
                  onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
                />
                <div className="skill-form__two-col">
                  <Input
                    label="版本"
                    value={form.version}
                    onChange={(e) => setForm(prev => ({ ...prev, version: e.target.value }))}
                  />
                  <Input
                    label="触发词（逗号分隔）"
                    value={form.trigger_phrases}
                    onChange={(e) => setForm(prev => ({ ...prev, trigger_phrases: e.target.value }))}
                    placeholder="例：代码审查, review"
                  />
                </div>
                <Input
                  label="描述"
                  value={form.description}
                  onChange={(e) => setForm(prev => ({ ...prev, description: e.target.value }))}
                />
                <div className="form-group">
                  <label className="form-label" htmlFor="skill-content">内容（Markdown）</label>
                  <textarea
                    id="skill-content"
                    className="input skill-form__content"
                    value={form.content}
                    onChange={(e) => handleContentChange(e.target.value)}
                    rows={12}
                  />
                </div>
                <div className="skill-form__actions">
                  <Button variant="primary" onClick={handleSave} disabled={saving}>
                    {saving ? '保存中…' : '保存'}
                  </Button>
                  <Button variant="secondary" onClick={() => { setShowForm(false); setEditingId(null) }}>取消</Button>
                </div>
              </div>
            ) : (
              <>
                <div className="tabs-strip" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={createTab === 'git'}
                    className={`tabs-strip__tab${createTab === 'git' ? ' tabs-strip__tab--active' : ''}`}
                    onClick={() => setCreateTab('git')}
                  >从 Git 仓库</button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={createTab === 'local'}
                    className={`tabs-strip__tab${createTab === 'local' ? ' tabs-strip__tab--active' : ''}`}
                    onClick={() => setCreateTab('local')}
                  >本地路径</button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={createTab === 'upload'}
                    className={`tabs-strip__tab${createTab === 'upload' ? ' tabs-strip__tab--active' : ''}`}
                    onClick={() => setCreateTab('upload')}
                  >上传文件</button>
                </div>

                {createTab === 'git' && (
                  <div className="skill-form__grid">
                    <div className="form-group">
                      <label className="form-label" htmlFor="skill-git-url">GitHub 仓库 URL</label>
                      <div className="skill-form__inline">
                        <input
                          id="skill-git-url"
                          className="input"
                          value={gitUrl}
                          onChange={(e) => { setGitUrl(e.target.value); setGitSkills(null) }}
                          placeholder="https://github.com/user/repo 或 https://github.com/user/repo/tree/main/skills"
                        />
                        <Button variant="secondary" onClick={handleScanGit} disabled={gitScanning}>
                          {gitScanning ? '扫描中…' : '扫描'}
                        </Button>
                      </div>
                    </div>
                    {gitSkills !== null && (
                      <div>
                        {gitSkills.length === 0 ? (
                          <div className="skill-form__hint">未找到 Skill（仓库中没有 SKILL.md 文件）</div>
                        ) : (
                          <>
                            <div className="skill-form__hint">
                              找到 {gitSkills.length} 个 Skill，选择要安装的：
                            </div>
                            <div className="skill-pick-list">
                              {gitSkills.map(skill => (
                                <label key={skill.skill_md_url} className="skill-pick-list__row">
                                  <input
                                    type="checkbox"
                                    checked={gitSelected.has(skill.skill_md_url)}
                                    onChange={(e) => {
                                      const next = new Set(gitSelected)
                                      if (e.target.checked) next.add(skill.skill_md_url)
                                      else next.delete(skill.skill_md_url)
                                      setGitSelected(next)
                                    }}
                                  />
                                  <div>
                                    <div className="skill-pick-list__name">{skill.name}</div>
                                    {skill.description && (
                                      <div className="skill-pick-list__desc">{skill.description}</div>
                                    )}
                                  </div>
                                </label>
                              ))}
                            </div>
                            <div className="skill-pick-list__quickactions">
                              <button
                                type="button"
                                className="link-button link-button--primary"
                                onClick={() => setGitSelected(new Set(gitSkills.map(s => s.skill_md_url)))}
                              >全选</button>
                              <button
                                type="button"
                                className="link-button"
                                onClick={() => setGitSelected(new Set())}
                              >取消全选</button>
                            </div>
                          </>
                        )}
                      </div>
                    )}
                    <div className="skill-form__actions">
                      <Button
                        variant="primary"
                        onClick={handleInstallGit}
                        disabled={gitInstalling || gitSelected.size === 0}
                      >
                        {gitInstalling ? '安装中…' : `安装选中 (${gitSelected.size})`}
                      </Button>
                      <Button variant="secondary" onClick={() => setShowForm(false)}>取消</Button>
                    </div>
                  </div>
                )}

                {createTab === 'local' && (
                  <div className="skill-form__grid">
                    <Input
                      label="本地目录路径（包含 SKILL.md 的目录）"
                      value={localPath}
                      onChange={(e) => setLocalPath(e.target.value)}
                      placeholder="/path/to/my-skill"
                    />
                    <div className="skill-form__actions">
                      <Button variant="primary" onClick={handleImportLocal} disabled={saving}>
                        {saving ? '导入中…' : '导入'}
                      </Button>
                      <Button variant="secondary" onClick={() => setShowForm(false)}>取消</Button>
                    </div>
                  </div>
                )}

                {createTab === 'upload' && (
                  <div className="skill-form__grid">
                    <div className="form-group">
                      <label className="form-label" htmlFor="skill-file">上传 .zip 或 .skill 文件</label>
                      <input
                        id="skill-file"
                        ref={fileInputRef}
                        type="file"
                        accept=".zip,.skill"
                        onChange={handleFileUpload}
                        disabled={saving}
                        className="skill-form__file"
                      />
                      {saving && <div className="skill-form__hint">上传中…</div>}
                    </div>
                    <div className="skill-form__actions">
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
          <p className="empty-state__text">暂无 Skill，点击「添加」创建一个</p>
        </Card>
      ) : (
        <div className="skill-list">
          {skills.map(s => (
            <Card key={s.id}>
              <div className="skill-row">
                <div className="skill-row__info">
                  <div className="skill-row__header">
                    <span className="skill-row__name">{s.name}</span>
                    <span className="skill-row__version">v{s.version}</span>
                    {s.previous_snapshot && (
                      <span className="skill-row__prev">(上一版 v{s.previous_snapshot.version})</span>
                    )}
                    {s.is_builtin && <span className="tag tag--info">内置</span>}
                    {s.source_type === 'scanned' && <span className="tag tag--warning">扫描发现</span>}
                    {s.is_essential && <span className="tag tag--primary">必要</span>}
                    <StatusBadge status={s.enabled ? 'active' : 'inactive'}>
                      {s.enabled ? '已启用' : '已禁用'}
                    </StatusBadge>
                  </div>
                  {s.description && (
                    <div className="skill-row__desc">{s.description}</div>
                  )}
                  {s.trigger_phrases?.length ? (
                    <div className="skill-row__triggers">
                      触发词：{s.trigger_phrases.join(', ')}
                    </div>
                  ) : null}
                  {previewId === s.id && (
                    <pre className="skill-row__preview">{s.content}</pre>
                  )}
                  {!s.is_builtin && s.previous_snapshot && (
                    <div className="skill-snapshot">
                      <span className="skill-snapshot__label">上一版</span>
                      <span className="skill-snapshot__meta">
                        v{s.previous_snapshot.version}
                        （快照于 {new Date(s.previous_snapshot.snapshotted_at).toLocaleString()}）
                      </span>
                      <div className="skill-snapshot__actions">
                        <Button variant="secondary" size="sm" onClick={() => setDiffSkill(s)}>
                          查看对比
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => handleRestore(s)}
                          disabled={restoringId === s.id}
                        >
                          {restoringId === s.id ? '应用中…' : '应用上一版'}
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
                <div className="skill-row__actions">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setPreviewId(previewId === s.id ? null : s.id)}
                  >
                    {previewId === s.id ? '收起' : '预览'}
                  </Button>
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

      {diffSkill && (
        <SkillDiffModal
          skill={diffSkill}
          open={!!diffSkill}
          onClose={() => setDiffSkill(null)}
        />
      )}
    </MainLayout>
  )
}
