import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { useToast } from '../../contexts/ToastContext'
import { sceneProfileService, sceneToKey, type SceneProfile } from '../../services/memory'

type FilterType = '' | 'friend' | 'group_session' | 'global'
type GovernanceFilter = 'all' | 'missing-summary' | 'missing-overview' | 'missing-source' | 'recent-updated' | 'recent-declared'

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

function isRecent(value?: string | null): boolean {
  if (!value) return false
  return Date.now() - new Date(value).getTime() < 7 * 24 * 60 * 60 * 1000
}

function buildGovernanceTags(profile: SceneProfile): string[] {
  const tags: string[] = []
  if (!profile.abstract.trim()) tags.push('缺摘要')
  if (!profile.overview.trim()) tags.push('缺概览')
  if (!profile.source_memory_ids || profile.source_memory_ids.length === 0) tags.push('无来源')
  if (isRecent(profile.updated_at)) tags.push('最近更新')
  if (isRecent(profile.last_declared_at)) tags.push('最近声明')
  return tags
}

function matchesGovernanceFilter(profile: SceneProfile, filter: GovernanceFilter): boolean {
  switch (filter) {
    case 'missing-summary':
      return !profile.abstract.trim()
    case 'missing-overview':
      return !profile.overview.trim()
    case 'missing-source':
      return !profile.source_memory_ids || profile.source_memory_ids.length === 0
    case 'recent-updated':
      return isRecent(profile.updated_at)
    case 'recent-declared':
      return isRecent(profile.last_declared_at)
    default:
      return true
  }
}

export const SceneProfileList: React.FC = () => {
  const toast = useToast()
  const navigate = useNavigate()

  const [profiles, setProfiles] = useState<SceneProfile[]>([])
  const [filter, setFilter] = useState<FilterType>('')
  const [governanceFilter, setGovernanceFilter] = useState<GovernanceFilter>('all')
  const [loading, setLoading] = useState(true)
  const [serviceError, setServiceError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await sceneProfileService.list({
        sceneType: filter || undefined,
      })
      setProfiles(result.profiles)
      setServiceError('')
    } catch (err) {
      const msg = 'Memory 服务未运行，请确认 Memory 模块已启动'
      setServiceError(msg)
      toast.error(err instanceof Error ? err.message : msg)
    } finally {
      setLoading(false)
    }
  }, [filter, toast])

  useEffect(() => {
    load()
  }, [load])

  const visibleProfiles = useMemo(
    () => profiles.filter((profile) => matchesGovernanceFilter(profile, governanceFilter)),
    [governanceFilter, profiles],
  )

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '0.5rem' }}>场景画像</h1>
        <p style={{ color: 'var(--text-secondary)' }}>查看 Memory 模块中各场景的画像数据</p>
      </div>

      {serviceError && (
        <Card>
          <div style={{ color: 'var(--danger)', textAlign: 'center', padding: '2rem' }}>
            <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>⚠️</div>
            <div>{serviceError}</div>
          </div>
        </Card>
      )}

      {!serviceError && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '1.5rem', flexWrap: 'wrap' }}>
            <span style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>场景类型：</span>
            <select
              value={filter}
              onChange={e => setFilter(e.target.value as FilterType)}
              style={{
                padding: '0.4rem 0.8rem',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: '6px',
                color: 'var(--text-primary)',
              }}
            >
              <option value="">全部</option>
              <option value="friend">好友</option>
              <option value="group_session">群聊</option>
              <option value="global">全局</option>
            </select>
            <label style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              治理筛选
              <select
                aria-label="治理筛选"
                value={governanceFilter}
                onChange={e => setGovernanceFilter(e.target.value as GovernanceFilter)}
                style={{
                  padding: '0.4rem 0.8rem',
                  background: 'var(--bg-secondary)',
                  border: '1px solid var(--border)',
                  borderRadius: '6px',
                  color: 'var(--text-primary)',
                }}
              >
                <option value="all">全部</option>
                <option value="missing-summary">仅看缺摘要</option>
                <option value="missing-overview">仅看缺概览</option>
                <option value="missing-source">仅看无来源</option>
                <option value="recent-updated">最近更新</option>
                <option value="recent-declared">最近声明</option>
              </select>
            </label>
            <Button variant="secondary" onClick={load}>
              刷新
            </Button>
          </div>

          <Card>
            {loading ? (
              <Loading />
            ) : visibleProfiles.length === 0 ? (
              <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: '2rem' }}>
                暂无场景画像
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {visibleProfiles.map(profile => {
                  const key = sceneToKey(profile.scene)
                  const sceneType = profile.scene.type
                  const badgeStyle = SCENE_TYPE_COLORS[sceneType] ?? { bg: 'rgba(0,0,0,0.1)', color: 'var(--text-secondary)' }
                  const lastDeclared = profile.last_declared_at
                    ? new Date(profile.last_declared_at).toLocaleString('zh-CN')
                    : '—'
                  const updatedAt = new Date(profile.updated_at).toLocaleString('zh-CN')
                  const tags = buildGovernanceTags(profile)

                  return (
                    <div
                      key={key}
                      style={{
                        border: '1px solid var(--border)',
                        borderRadius: '8px',
                        padding: '0.75rem 1rem',
                        display: 'flex',
                        alignItems: 'flex-start',
                        gap: '1rem',
                      }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem', flexWrap: 'wrap' }}>
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
                          <span style={{ fontWeight: 500, fontSize: '0.95rem' }}>
                            {profile.label || key}
                          </span>
                        </div>
                        <div
                          style={{
                            color: 'var(--text-secondary)',
                            fontSize: '0.9rem',
                            marginBottom: '0.5rem',
                            whiteSpace: 'pre-wrap',
                            lineHeight: 1.5,
                          }}
                        >
                          {profile.abstract || '暂无摘要'}
                        </div>
                        {tags.length > 0 && (
                          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginBottom: '0.5rem' }}>
                            {tags.map(tag => (
                              <span
                                key={tag}
                                style={{
                                  padding: '0.1rem 0.5rem',
                                  borderRadius: '999px',
                                  background: 'var(--bg-secondary)',
                                  fontSize: '0.75rem',
                                }}
                              >
                                {tag}
                              </span>
                            ))}
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: '1.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)', flexWrap: 'wrap' }}>
                          <span>更新：{updatedAt}</span>
                          <span>最近声明：{lastDeclared}</span>
                        </div>
                      </div>
                      <Button
                        variant="secondary"
                        onClick={() => navigate('/memory/scenes/' + encodeURIComponent(key))}
                        style={{ flexShrink: 0, padding: '0.25rem 0.75rem', fontSize: '0.85rem' }}
                      >
                        详情
                      </Button>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>
        </>
      )}
    </MainLayout>
  )
}
