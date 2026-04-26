import React, { useCallback, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { ConfirmModal } from '../../components/Common/ConfirmModal'
import { useToast } from '../../contexts/ToastContext'
import {
  defaultSceneProfileLabel,
  parseSceneKey,
  sceneProfileService,
  type SceneProfile,
} from '../../services/memory'
import { memoryV2Service, type MemoryEntryV2 } from '../../services/memoryV2'
import { buildMemoryEntriesHref } from './memoryContextQuery'

const SCENE_TYPE_LABELS: Record<string, string> = {
  friend: '好友',
  group_session: '群聊',
  global: '全局',
}

const SCENE_TYPE_COLORS: Record<string, { bg: string; color: string }> = {
  friend: { bg: 'rgba(59, 130, 246, 0.12)', color: '#3b82f6' },
  group_session: { bg: 'rgba(34, 197, 94, 0.12)', color: '#22c55e' },
  global: { bg: 'rgba(168, 85, 247, 0.12)', color: '#a855f7' },
}

const inputStyle: React.CSSProperties = {
  padding: '0.4rem 0.8rem',
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border)',
  borderRadius: '6px',
  color: 'var(--text-primary)',
  width: '100%',
  boxSizing: 'border-box',
}

type DetailMode = 'view' | 'edit'

type SceneProfileDraft = {
  label: string
  abstract: string
  overview: string
  content: string
}

const EMPTY_DRAFT: SceneProfileDraft = {
  label: '',
  abstract: '',
  overview: '',
  content: '',
}

function toDraft(profile: SceneProfile): SceneProfileDraft {
  return {
    label: profile.label,
    abstract: profile.abstract,
    overview: profile.overview,
    content: profile.content,
  }
}

function renderDocumentValue(value: string, emptyText: string) {
  if (!value.trim()) {
    return <div style={{ color: 'var(--text-secondary)' }}>{emptyText}</div>
  }

  return <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{value}</div>
}

export const SceneProfileDetail: React.FC = () => {
  const { key = '' } = useParams<{ key: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const toast = useToast()
  const contextLabel = new URLSearchParams(location.search).get('context_label')?.trim() || ''

  const [profile, setProfile] = useState<SceneProfile | null | undefined>(undefined)
  const [profileExists, setProfileExists] = useState(false)
  const [serviceError, setServiceError] = useState('')
  const [mode, setMode] = useState<DetailMode>('view')
  const [draft, setDraft] = useState<SceneProfileDraft>(EMPTY_DRAFT)
  const [validationError, setValidationError] = useState('')
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [sourceMemories, setSourceMemories] = useState<MemoryEntryV2[]>([])

  const buildDraftProfile = useCallback((): SceneProfile => {
    const scene = parseSceneKey(key)
    const now = new Date().toISOString()
    return {
      scene,
      label: contextLabel || defaultSceneProfileLabel(scene),
      abstract: '',
      overview: '',
      content: '',
      source_memory_ids: [],
      created_at: now,
      updated_at: now,
      last_declared_at: null,
    }
  }, [contextLabel, key])

  const load = useCallback(async () => {
    let draftProfile: SceneProfile
    try {
      draftProfile = buildDraftProfile()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '场景 key 无效'
      setProfile(null)
      setProfileExists(false)
      setServiceError(msg)
      return
    }

    try {
      const result = await sceneProfileService.get(key)
      const nextProfile = result.profile ?? draftProfile
      setProfile(nextProfile)
      setProfileExists(result.profile != null)
      setDraft(toDraft(nextProfile))
      setValidationError('')
      setMode('view')
      setServiceError('')
    } catch (err) {
      const msg = 'Memory 服务未运行，请确认 Memory 模块已启动'
      setProfile(null)
      setProfileExists(false)
      setServiceError(msg)
      toast.error(err instanceof Error ? err.message : msg)
    }
  }, [buildDraftProfile, key, toast])

  useEffect(() => {
    load()
  }, [load])

  const enterEditMode = useCallback(() => {
    if (profile) {
      setDraft(toDraft(profile))
    }
    setValidationError('')
    setMode('edit')
  }, [profile])

  const exitEditMode = useCallback(() => {
    if (profile) {
      setDraft(toDraft(profile))
    }
    setValidationError('')
    setMode('view')
  }, [profile])

  const updateDraft = useCallback(
    (field: keyof SceneProfileDraft, value: string) => {
      setValidationError('')
      setDraft((prev) => ({ ...prev, [field]: value }))
    },
    [],
  )

  const handleSave = useCallback(async () => {
    const normalizedDraft: SceneProfileDraft = {
      label: draft.label.trim(),
      abstract: draft.abstract.trim(),
      overview: draft.overview.trim(),
      content: draft.content.trim(),
    }

    if (!normalizedDraft.abstract) {
      const message = '摘要（L0）不能为空'
      setValidationError(message)
      toast.error(message)
      return
    }

    if (!normalizedDraft.content) {
      const message = '正文（L2）不能为空'
      setValidationError(message)
      toast.error(message)
      return
    }

    setValidationError('')
    setSaving(true)
    try {
      const result = await sceneProfileService.patch(key, normalizedDraft)
      setProfile(result.profile)
      setProfileExists(true)
      setDraft(toDraft(result.profile))
      setValidationError('')
      setMode('view')
      toast.success(profileExists ? '已保存' : '场景画像已创建')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [draft, key, profileExists, toast])

  useEffect(() => {
    let cancelled = false
    const sourceMemoryIds = profile?.source_memory_ids ?? []

    const loadSourceMemories = async () => {
      if (!profileExists || sourceMemoryIds.length === 0) {
        setSourceMemories([])
        return
      }

      try {
        const uniqueIds = [...new Set(sourceMemoryIds)]
        const items = await Promise.all(
          uniqueIds.map(async (id) => {
            try {
              return await memoryV2Service.getEntry(id)
            } catch {
              return null
            }
          }),
        )

        if (!cancelled) {
          setSourceMemories(items.filter((item): item is MemoryEntryV2 => item !== null))
        }
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : '加载来源记忆失败')
          setSourceMemories([])
        }
      }
    }

    loadSourceMemories()
    return () => {
      cancelled = true
    }
  }, [profile?.source_memory_ids, profileExists, toast])

  const handleDelete = useCallback(async () => {
    if (!profileExists) {
      setConfirmOpen(false)
      return
    }
    setDeleting(true)
    try {
      await sceneProfileService.delete(key)
      toast.success('已删除')
      navigate('/memory/scenes')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
      setDeleting(false)
    }
  }, [key, navigate, profileExists, toast])

  if (profile === undefined) {
    return (
      <MainLayout>
        <Loading />
      </MainLayout>
    )
  }

  if (serviceError) {
    return (
      <MainLayout>
        <div style={{ marginBottom: '2rem' }}>
          <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '0.5rem' }}>场景画像详情</h1>
        </div>
        <Card>
          <div style={{ color: 'var(--danger)', textAlign: 'center', padding: '2rem' }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⚠️</div>
            <div>{serviceError}</div>
          </div>
        </Card>
      </MainLayout>
    )
  }

  if (profile === null) {
    return (
      <MainLayout>
        <Card>
          <div style={{ color: 'var(--text-secondary)' }}>无法解析当前场景画像。</div>
        </Card>
      </MainLayout>
    )
  }

  const activeProfile = profile
  const sceneType = activeProfile.scene.type
  const badgeStyle = SCENE_TYPE_COLORS[sceneType] ?? {
    bg: 'rgba(0,0,0,0.1)',
    color: 'var(--text-secondary)',
  }

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '0.5rem' }}>场景画像详情</h1>
        <p style={{ color: 'var(--text-secondary)' }}>{activeProfile.label || key}</p>
      </div>

      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={() => navigate('/memory/scenes')}>
            ← 返回
          </Button>
          <span
            style={{
              padding: '0.1rem 0.5rem',
              borderRadius: '4px',
              fontSize: '0.75rem',
              fontWeight: 600,
              background: badgeStyle.bg,
              color: badgeStyle.color,
            }}
          >
            {SCENE_TYPE_LABELS[sceneType] ?? sceneType}
          </span>
        </div>

        <div style={{ marginBottom: '0.75rem' }}>
          <div style={{ fontSize: '0.95rem', fontWeight: 600, marginBottom: '0.35rem' }}>
            场景画像是 Agent 进入该场景前优先读取的稳定文档。
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
            用 L0 摘要快速识别场景，用 L1 概览沉淀稳定规则，用 L2 正文保留完整约定。
          </div>
        </div>

        {contextLabel && (
          <div
            style={{
              marginBottom: '0.75rem',
              padding: '0.75rem 1rem',
              borderRadius: '8px',
              background: 'var(--bg-secondary)',
              color: 'var(--text-secondary)',
            }}
          >
            你当前查看的是“{contextLabel}”的场景画像入口。
          </div>
        )}

        <div style={{ marginBottom: '0.75rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>原始 scene：</span>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginLeft: '0.5rem', fontFamily: 'monospace' }}>
            {JSON.stringify(activeProfile.scene)}
          </span>
        </div>

        <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
          {profileExists ? (
            <>
              <span>创建时间：{new Date(activeProfile.created_at).toLocaleString('zh-CN')}</span>
              <span>更新时间：{new Date(activeProfile.updated_at).toLocaleString('zh-CN')}</span>
              {activeProfile.last_declared_at && (
                <span>最近声明：{new Date(activeProfile.last_declared_at).toLocaleString('zh-CN')}</span>
              )}
            </>
          ) : (
            <span>状态：尚未创建</span>
          )}
        </div>

        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          来源记忆 ID：
          {profileExists && activeProfile.source_memory_ids && activeProfile.source_memory_ids.length > 0
            ? activeProfile.source_memory_ids.join('、')
            : profileExists ? '—' : '尚未创建'}
        </div>

        <div style={{ marginTop: '1rem' }}>
          <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '0.5rem' }}>来源长期记忆</div>
          {sourceMemories.length === 0 ? (
            <div style={{ color: 'var(--text-secondary)' }}>暂无来源记忆</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {sourceMemories.map((memory) => (
                <Link
                  key={memory.id}
                  to={buildMemoryEntriesHref({ tab: 'long', mode: 'search', memoryId: memory.id })}
                  style={{ color: 'var(--primary)' }}
                >
                  {memory.brief}
                </Link>
              ))}
            </div>
          )}
        </div>
      </Card>

      {mode === 'view' ? (
        <>
          <Card>
            <div style={{ display: 'grid', gap: '0.65rem' }}>
              <div style={{ fontWeight: 600 }}>如何使用这份画像</div>
              <div style={{ color: 'var(--text-secondary)' }}>
                摘要（L0）适合写一句话身份提示，帮助你快速确认这是哪个场景。
              </div>
              <div style={{ color: 'var(--text-secondary)' }}>
                概览（L1）适合写稳定规则、协作边界和长期偏好。
              </div>
              <div style={{ color: 'var(--text-secondary)' }}>
                正文（L2）适合保留完整说明，不适合存放一次性聊天流水。
              </div>
            </div>
          </Card>

          {profileExists ? (
            <Card title="当前内容">
              <div style={{ display: 'grid', gap: '1rem' }}>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: '0.35rem' }}>标签</div>
                  {renderDocumentValue(activeProfile.label, '暂无标签。')}
                </div>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: '0.35rem' }}>摘要（L0）</div>
                  {renderDocumentValue(activeProfile.abstract, '暂无摘要。')}
                </div>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: '0.35rem' }}>概览（L1）</div>
                  {renderDocumentValue(activeProfile.overview, '暂无概览。')}
                </div>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: '0.35rem' }}>正文（L2）</div>
                  {renderDocumentValue(activeProfile.content, '暂无正文。')}
                </div>
              </div>
            </Card>
          ) : (
            <Card title="创建建议">
              <div style={{ display: 'grid', gap: '0.65rem' }}>
                <div style={{ color: 'var(--text-secondary)' }}>
                  当前还没有场景画像。只有当这个场景存在长期稳定规则、身份约束或协作边界时，才建议创建。
                </div>
                <div style={{ color: 'var(--text-secondary)' }}>先写一句摘要，说明这个场景的身份定位。</div>
                <div style={{ color: 'var(--text-secondary)' }}>再写概览，整理进入场景后必须遵守的长期约定。</div>
                <div style={{ color: 'var(--text-secondary)' }}>最后用正文补充完整说明和边界细节。</div>
              </div>
            </Card>
          )}

          <div style={{ display: 'flex', gap: '1rem', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="primary" onClick={enterEditMode}>
              {profileExists ? '编辑画像' : '创建画像'}
            </Button>
            {profileExists ? (
              <Button variant="danger" onClick={() => setConfirmOpen(true)}>
                删除画像
              </Button>
            ) : (
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                尚未创建的画像无需删除。
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <Card>
            <div style={{ color: 'var(--text-secondary)' }}>
              你正在编辑会影响 Agent 进入该场景时读取的 L0/L1/L2 文档。
            </div>
          </Card>

          {validationError && (
            <Card>
              <div style={{ color: 'var(--danger)' }}>{validationError}</div>
            </Card>
          )}

          <div style={{ marginTop: '1.5rem', marginBottom: '1.5rem' }}>
            <label htmlFor="scene-profile-label" style={{ display: 'block', fontWeight: 500, marginBottom: '0.5rem', fontSize: '0.9rem' }}>
              标签（label）
            </label>
            <input
              id="scene-profile-label"
              aria-label="标签（label）"
              value={draft.label}
              onChange={(event) => updateDraft('label', event.target.value)}
              placeholder="场景标签"
              style={inputStyle}
            />
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <label htmlFor="scene-profile-abstract" style={{ display: 'block', fontWeight: 500, marginBottom: '0.5rem', fontSize: '0.9rem' }}>
              摘要（L0）
            </label>
            <input
              id="scene-profile-abstract"
              aria-label="摘要（L0）"
              value={draft.abstract}
              onChange={(event) => updateDraft('abstract', event.target.value)}
              placeholder="一句话说明这个场景是谁、做什么"
              style={inputStyle}
            />
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <label htmlFor="scene-profile-overview" style={{ display: 'block', fontWeight: 500, marginBottom: '0.5rem', fontSize: '0.9rem' }}>
              概览（L1）
            </label>
            <textarea
              id="scene-profile-overview"
              aria-label="概览（L1）"
              value={draft.overview}
              onChange={(event) => updateDraft('overview', event.target.value)}
              placeholder="整理稳定规则、长期偏好和协作边界"
              rows={5}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <label htmlFor="scene-profile-content" style={{ display: 'block', fontWeight: 500, marginBottom: '0.5rem', fontSize: '0.9rem' }}>
              正文（L2）
            </label>
            <textarea
              id="scene-profile-content"
              aria-label="正文（L2）"
              value={draft.content}
              onChange={(event) => updateDraft('content', event.target.value)}
              placeholder="补充完整说明、行为边界和详细约定"
              rows={10}
              style={{ ...inputStyle, resize: 'vertical' }}
            />
          </div>

          <div style={{ display: 'flex', gap: '1rem', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <Button variant="primary" onClick={handleSave} disabled={saving}>
                {saving ? (profileExists ? '保存中...' : '创建中...') : (profileExists ? '保存' : '创建画像')}
              </Button>
              <Button variant="secondary" onClick={exitEditMode} disabled={saving}>
                取消
              </Button>
            </div>
            {profileExists ? (
              <Button variant="danger" onClick={() => setConfirmOpen(true)}>
                删除画像
              </Button>
            ) : (
              <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                尚未创建的画像无需删除。
              </div>
            )}
          </div>
        </>
      )}

      <ConfirmModal
        open={confirmOpen}
        title="删除场景画像"
        message="此操作不可撤销。画像内容将被永久删除。"
        confirmText="删除"
        confirmVariant="danger"
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </MainLayout>
  )
}
