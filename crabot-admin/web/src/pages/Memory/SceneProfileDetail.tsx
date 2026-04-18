import React, { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { ConfirmModal } from '../../components/Common/ConfirmModal'
import { useToast } from '../../contexts/ToastContext'
import {
  sceneProfileService,
  type SceneProfile,
  type SceneProfileSection,
} from '../../services/memory'

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

export const SceneProfileDetail: React.FC = () => {
  const { key = '' } = useParams<{ key: string }>()
  const navigate = useNavigate()
  const toast = useToast()

  const [profile, setProfile] = useState<SceneProfile | null | undefined>(undefined)
  const [serviceError, setServiceError] = useState('')
  const [label, setLabel] = useState('')
  const [sections, setSections] = useState<SceneProfileSection[]>([])
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      const result = await sceneProfileService.get(key)
      setProfile(result.profile)
      if (result.profile) {
        setLabel(result.profile.label)
        setSections(result.profile.sections)
      }
      setServiceError('')
    } catch (err) {
      const msg = 'Memory 服务未运行，请确认 Memory 模块已启动'
      setServiceError(msg)
      toast.error(err instanceof Error ? err.message : msg)
    }
  }, [key, toast])

  useEffect(() => {
    load()
  }, [load])

  const updateSection = useCallback(
    (index: number, field: keyof SceneProfileSection, value: string) => {
      setSections(prev =>
        prev.map((s, i) =>
          i === index ? { ...s, [field]: value } : s,
        ),
      )
    },
    [],
  )

  const removeSection = useCallback((index: number) => {
    setSections(prev => prev.filter((_, i) => i !== index))
  }, [])

  const addSection = useCallback(() => {
    setSections(prev => [
      ...prev,
      { topic: '', body: '', visibility: 'private' as const },
    ])
  }, [])

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await sceneProfileService.patch(key, { label, sections })
      toast.success('已保存')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }, [key, label, sections, toast])

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      await sceneProfileService.delete(key)
      toast.success('已删除')
      navigate('/memory/scenes')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
      setDeleting(false)
    }
  }, [key, toast, navigate])

  // Loading state
  if (profile === undefined && !serviceError) {
    return (
      <MainLayout>
        <Loading />
      </MainLayout>
    )
  }

  // Service error
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

  // Profile not found
  if (profile === null) {
    return (
      <MainLayout>
        <div style={{ marginBottom: '2rem' }}>
          <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '0.5rem' }}>场景画像详情</h1>
        </div>
        <Card>
          <div style={{ textAlign: 'center', padding: '2rem' }}>
            <div style={{ color: 'var(--text-secondary)', marginBottom: '1rem' }}>场景画像不存在</div>
            <Button variant="secondary" onClick={() => navigate('/memory/scenes')}>
              返回列表
            </Button>
          </div>
        </Card>
      </MainLayout>
    )
  }

  const sceneType = profile.scene.type
  const badgeStyle = SCENE_TYPE_COLORS[sceneType] ?? { bg: 'rgba(0,0,0,0.1)', color: 'var(--text-secondary)' }
  const isFriend = sceneType === 'friend'

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '0.5rem' }}>场景画像详情</h1>
        <p style={{ color: 'var(--text-secondary)' }}>{profile.label || key}</p>
      </div>

      {/* 顶部信息区（只读） */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={() => navigate('/memory/scenes')}>
            ← 返回
          </Button>
          <span style={{
            padding: '0.1rem 0.5rem',
            borderRadius: '4px',
            fontSize: '0.75rem',
            fontWeight: 600,
            background: badgeStyle.bg,
            color: badgeStyle.color,
          }}>
            {SCENE_TYPE_LABELS[sceneType] ?? sceneType}
          </span>
        </div>

        <div style={{ marginBottom: '0.75rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>原始 scene：</span>
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', marginLeft: '0.5rem', fontFamily: 'monospace' }}>
            {JSON.stringify(profile.scene)}
          </span>
        </div>

        <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.85rem', color: 'var(--text-secondary)', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
          <span>创建时间：{new Date(profile.created_at).toLocaleString('zh-CN')}</span>
          <span>更新时间：{new Date(profile.updated_at).toLocaleString('zh-CN')}</span>
          {profile.last_declared_at && (
            <span>最近声明：{new Date(profile.last_declared_at).toLocaleString('zh-CN')}</span>
          )}
        </div>

        <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          来源记忆 ID：
          {profile.source_memory_ids && profile.source_memory_ids.length > 0
            ? profile.source_memory_ids.join('、')
            : '—'}
        </div>
      </Card>

      {/* label 编辑 */}
      <div style={{ marginTop: '1.5rem', marginBottom: '1.5rem' }}>
        <label style={{ display: 'block', fontWeight: 500, marginBottom: '0.5rem', fontSize: '0.9rem' }}>
          标签（label）
        </label>
        <input
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="场景标签"
          style={inputStyle}
        />
      </div>

      {/* Sections 编辑 */}
      <div style={{ marginBottom: '1.5rem' }}>
        <div style={{ fontWeight: 500, marginBottom: '0.75rem', fontSize: '0.9rem' }}>
          Sections（{sections.length} 个）
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {sections.map((section, index) => (
            <div
              key={index}
              style={{
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '0.75rem 1rem',
                position: 'relative',
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.5rem' }}>
                <Button
                  variant="danger"
                  onClick={() => removeSection(index)}
                  style={{ padding: '0.2rem 0.6rem', fontSize: '0.8rem' }}
                >
                  删除
                </Button>
              </div>

              <div style={{ marginBottom: '0.5rem' }}>
                <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                  主题
                </label>
                <input
                  value={section.topic}
                  onChange={e => updateSection(index, 'topic', e.target.value)}
                  placeholder="分节主题"
                  style={inputStyle}
                />
              </div>

              <div style={{ marginBottom: isFriend ? '0.5rem' : 0 }}>
                <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                  正文
                </label>
                <textarea
                  value={section.body}
                  onChange={e => updateSection(index, 'body', e.target.value)}
                  placeholder="分节正文"
                  rows={4}
                  style={{ ...inputStyle, resize: 'vertical' }}
                />
              </div>

              {isFriend && (
                <div>
                  <label style={{ display: 'block', fontSize: '0.8rem', color: 'var(--text-secondary)', marginBottom: '0.25rem' }}>
                    可见性
                  </label>
                  <select
                    value={section.visibility}
                    onChange={e => updateSection(index, 'visibility', e.target.value)}
                    style={inputStyle}
                  >
                    <option value="private">private</option>
                    <option value="public">public</option>
                  </select>
                </div>
              )}
            </div>
          ))}
        </div>
        <div style={{ marginTop: '0.75rem' }}>
          <Button variant="secondary" onClick={addSection}>
            + 新增分节
          </Button>
        </div>
      </div>

      {/* 操作按钮区 */}
      <div style={{ display: 'flex', gap: '1rem', justifyContent: 'space-between', alignItems: 'center' }}>
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中...' : '保存'}
        </Button>
        <Button variant="danger" onClick={() => setConfirmOpen(true)}>
          删除整份画像
        </Button>
      </div>

      <ConfirmModal
        open={confirmOpen}
        title="删除场景画像"
        message="此操作不可撤销。画像内所有 section 将被永久删除。"
        confirmText="删除"
        confirmVariant="danger"
        loading={deleting}
        onConfirm={handleDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </MainLayout>
  )
}
