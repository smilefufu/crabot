/**
 * 新建 Channel 入口页
 *
 * 数据驱动：从 /channel-implementations 读取实现列表 + 每个实现声明的 onboarding_methods，
 * 每个 (implementation, method) 渲一张卡片。点击进入 /channels/new/:implId/:methodId。
 *
 * 没有声明 onboarding_methods 的实现额外提供"手动填写"入口（指向 /channels/config 旧表单）。
 * OpenClaw 兼容路径单独保留指向 /channels/pty。
 */

import React, { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Loading } from '../../components/Common/Loading'
import { channelService } from '../../services/channel'
import type { ChannelImplementation } from '../../types'

interface CardEntry {
  key: string
  title: string
  description: string
  badge?: string
  onClick: () => void
}

export const NewChannel: React.FC = () => {
  const navigate = useNavigate()
  const [impls, setImpls] = useState<ChannelImplementation[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    channelService.listImplementations()
      .then((r) => setImpls(r.items))
      .catch((e) => setError(e instanceof Error ? e.message : '加载失败'))
      .finally(() => setLoading(false))
  }, [])

  const cards: CardEntry[] = []

  for (const impl of impls) {
    if (impl.id === 'channel-host') continue // OpenClaw 单独入口

    if (impl.onboarding_methods && impl.onboarding_methods.length > 0) {
      for (const method of impl.onboarding_methods) {
        cards.push({
          key: `${impl.id}:${method.id}`,
          title: `${impl.name} · ${method.name}`,
          description: method.description ?? '交互式配置入口',
          badge: '推荐',
          onClick: () => navigate(`/channels/new/${encodeURIComponent(impl.id)}/${encodeURIComponent(method.id)}`),
        })
      }
    }

    // 始终提供"手动填写"入口
    cards.push({
      key: `${impl.id}:schema`,
      title: `${impl.name} · 手动填写`,
      description: methodFallbackDescription(impl),
      onClick: () => navigate(`/channels/config?implementation_id=${encodeURIComponent(impl.id)}`),
    })
  }

  // OpenClaw 单独卡（保留过渡期）
  if (impls.some((i) => i.id === 'channel-host')) {
    cards.push({
      key: 'openclaw',
      title: 'OpenClaw 兼容',
      description: '仅用于安装其他 OpenClaw 插件。已有原生模块的平台请优先用上方专用入口。',
      onClick: () => navigate('/channels/pty'),
    })
  }

  return (
    <MainLayout>
      <div style={{ padding: '1.5rem 2rem', maxWidth: 900, margin: '0 auto' }}>
        <div style={{ marginBottom: '1.5rem' }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.375rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            新建 Channel
          </h1>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            选择平台 + 入口方式。"推荐"标签的入口由模块自带交互式流程（如扫码授权），手动填写适合已有凭证的场景。
          </p>
        </div>

        {error && <div className="error-message">{error}</div>}

        {loading ? (
          <Loading />
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
            {cards.map((card) => (
              <button
                key={card.key}
                type="button"
                onClick={card.onClick}
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '1.25rem',
                  textAlign: 'left',
                  cursor: 'pointer',
                  transition: 'border-color .15s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent)' }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                  <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                    {card.title}
                  </h3>
                  {card.badge && (
                    <span style={{
                      fontSize: '0.6875rem',
                      fontWeight: 600,
                      color: 'var(--success, #16a34a)',
                      background: 'rgba(22, 163, 74, 0.12)',
                      padding: '2px 8px',
                      borderRadius: 999,
                    }}>
                      {card.badge}
                    </span>
                  )}
                </div>
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {card.description}
                </p>
              </button>
            ))}
          </div>
        )}

        <div style={{ marginTop: '1.5rem', textAlign: 'right' }}>
          <button
            type="button"
            onClick={() => navigate('/channels/config')}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--text-muted)',
              fontSize: '0.8125rem',
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            ← 返回 Channel 列表
          </button>
        </div>
      </div>
    </MainLayout>
  )
}

function methodFallbackDescription(impl: ChannelImplementation): string {
  const required = impl.config_schema?.required ?? []
  if (required.length > 0) return `手动填入：${required.slice(0, 3).join(' / ')}${required.length > 3 ? ' 等' : ''}`
  return '手动填入凭证后启动'
}

