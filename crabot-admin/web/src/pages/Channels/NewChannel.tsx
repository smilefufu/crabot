/**
 * 新建 Channel 入口页：按平台列卡片
 *
 * 飞书 → /channels/new/feishu（扫码 onboarding）
 * 微信 / Telegram → /channels/config（保留旧的 schema 表单流程）
 * OpenClaw 兼容 → /channels/pty（仅用于其他 OpenClaw 插件）
 */

import React from 'react'
import { useNavigate } from 'react-router-dom'
import { MainLayout } from '../../components/Layout/MainLayout'

interface PlatformOption {
  id: string
  name: string
  description: string
  badge?: string
  onSelect: (nav: ReturnType<typeof useNavigate>) => void
}

const OPTIONS: PlatformOption[] = [
  {
    id: 'feishu',
    name: '飞书 / Lark',
    description: '扫码授权一步建 Bot，长连接事件订阅，无需公网回调。',
    badge: '推荐',
    onSelect: (nav) => nav('/channels/new/feishu'),
  },
  {
    id: 'wechat',
    name: '微信',
    description: '通过 wechat-connector Bot API 接入。需要先填写 connector 地址与 API Key。',
    onSelect: (nav) => nav('/channels/config?implementation_id=channel-wechat'),
  },
  {
    id: 'telegram',
    name: 'Telegram',
    description: '通过 Bot Token 接入。需要先在 BotFather 创建 Bot 拿到 Token。',
    onSelect: (nav) => nav('/channels/config?implementation_id=channel-telegram'),
  },
  {
    id: 'openclaw',
    name: 'OpenClaw 兼容',
    description: '仅用于安装其他 OpenClaw 插件（飞书请用上方"飞书 / Lark"专用流程，已不推荐走 OpenClaw）。',
    onSelect: (nav) => nav('/channels/pty'),
  },
]

export const NewChannel: React.FC = () => {
  const navigate = useNavigate()

  return (
    <MainLayout>
      <div style={{ padding: '1.5rem 2rem', maxWidth: 900, margin: '0 auto' }}>
        <div style={{ marginBottom: '1.5rem' }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.375rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            新建 Channel
          </h1>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            选择要接入的平台。每张卡片对应一种实现路径。
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem' }}>
          {OPTIONS.map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => opt.onSelect(navigate)}
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '1.25rem',
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'border-color .15s, transform .15s',
                position: 'relative',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent)' }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
                <h3 style={{ fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>
                  {opt.name}
                </h3>
                {opt.badge && (
                  <span style={{
                    fontSize: '0.6875rem',
                    fontWeight: 600,
                    color: 'var(--success, #16a34a)',
                    background: 'rgba(22, 163, 74, 0.12)',
                    padding: '2px 8px',
                    borderRadius: '999px',
                  }}>
                    {opt.badge}
                  </span>
                )}
              </div>
              <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {opt.description}
              </p>
            </button>
          ))}
        </div>

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
