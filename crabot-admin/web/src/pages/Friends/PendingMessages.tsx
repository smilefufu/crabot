import React, { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { useToast } from '../../contexts/ToastContext'
import { friendService } from '../../services/friend'
import type { PendingMessage } from '../../types'

const AVATAR_COLORS = [
  '#6366f1', '#8b5cf6', '#ec4899', '#f43f5e',
  '#f97316', '#eab308', '#22c55e', '#06b6d4',
]

function UserAvatar({ name, seed, size = 40 }: { name: string; seed: string; size?: number }) {
  const initials = name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('')
  const colorIdx = seed.split('').reduce((acc, c) => acc + c.charCodeAt(0), 0) % AVATAR_COLORS.length
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: AVATAR_COLORS[colorIdx],
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: '#fff', fontWeight: 700, fontSize: size * 0.38,
      flexShrink: 0, userSelect: 'none',
    }}>
      {initials || '?'}
    </div>
  )
}

export const PendingMessages: React.FC = () => {
  const toast = useToast()
  const [messages, setMessages] = useState<PendingMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [approving, setApproving] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState<string | null>(null)

  const [showModal, setShowModal] = useState(false)
  const [selectedMsg, setSelectedMsg] = useState<PendingMessage | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [templateId, setTemplateId] = useState('minimal')

  const loadMessages = useCallback(async () => {
    try {
      const result = await friendService.listPendingMessages()
      setMessages(result.items)
    } catch {
      toast.error('加载待审批消息失败')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    loadMessages()
    const interval = setInterval(loadMessages, 30000)
    return () => clearInterval(interval)
  }, [loadMessages])

  const openApproveModal = (msg: PendingMessage) => {
    setSelectedMsg(msg)
    setDisplayName(msg.platform_display_name)
    setTemplateId('minimal')
    setShowModal(true)
  }

  const handleApprove = async () => {
    if (!selectedMsg) return
    setApproving(selectedMsg.id)
    try {
      const isPair = selectedMsg.intent === 'pair'
      await friendService.approvePendingMessage(selectedMsg.id, {
        display_name: displayName,
        ...(isPair ? {} : { permission_template_id: templateId }),
      })
      toast.success(isPair ? '已批准为 Master' : '已批准，熟人已创建')
      setShowModal(false)
      setSelectedMsg(null)
      await loadMessages()
    } catch {
      toast.error('批准失败')
    } finally {
      setApproving(null)
    }
  }

  const handleReject = async (id: string) => {
    setRejecting(id)
    try {
      await friendService.rejectPendingMessage(id)
      toast.success('已拒绝')
      await loadMessages()
    } catch {
      toast.error('拒绝失败')
    } finally {
      setRejecting(null)
    }
  }

  const formatTimeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime()
    const minutes = Math.floor(diff / 60000)
    if (minutes < 60) return `${minutes} 分钟前`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} 小时前`
    return `${Math.floor(hours / 24)} 天前`
  }

  const getExpiresIn = (dateStr: string) => {
    const diff = new Date(dateStr).getTime() - Date.now()
    if (diff <= 0) return '已过期'
    const hours = Math.floor(diff / 3600000)
    const minutes = Math.floor((diff % 3600000) / 60000)
    return `${hours}h ${minutes}m`
  }

  if (loading) {
    return <MainLayout><Loading /></MainLayout>
  }

  return (
    <MainLayout>
      <div style={{ maxWidth: '900px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
          <div>
            <h1 style={{ fontSize: '1.5rem', fontWeight: 700, marginBottom: '0.25rem' }}>待审批消息</h1>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
              未注册用户发送的消息，需要审批后才能与 Crabot 交互
            </p>
          </div>
          <Link to="/friends" style={{ textDecoration: 'none' }}>
            <Button variant="secondary">返回熟人列表</Button>
          </Link>
        </div>

        {messages.length === 0 ? (
          <Card>
            <div style={{ textAlign: 'center', padding: '3rem', color: 'var(--text-secondary)' }}>
              暂无待审批消息
            </div>
          </Card>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {messages.map((msg) => (
              <Card key={msg.id}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div style={{ display: 'flex', gap: '0.875rem', flex: 1 }}>
                    <UserAvatar name={msg.platform_display_name} seed={msg.platform_user_id} size={44} />
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', marginBottom: '0.375rem', flexWrap: 'wrap' }}>
                        <span style={{ fontWeight: 600, fontSize: '1rem' }}>
                          {msg.platform_display_name}
                        </span>
                        <span style={{
                          fontSize: '0.75rem', padding: '0.125rem 0.5rem', borderRadius: '9999px',
                          background: msg.intent === 'pair' ? 'rgba(234, 179, 8, 0.1)' : 'rgba(59, 130, 246, 0.1)',
                          color: msg.intent === 'pair' ? 'var(--warning)' : 'var(--primary)',
                        }}>
                          {msg.intent === 'pair' ? '申请 Master' : '申请加入'}
                        </span>
                        <span style={{
                          fontSize: '0.75rem', padding: '0.125rem 0.5rem', borderRadius: '9999px',
                          background: 'rgba(100, 116, 139, 0.1)', color: 'var(--text-secondary)',
                        }}>
                          {msg.channel_id}
                        </span>
                      </div>
                      <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '0.375rem', lineHeight: 1.5 }}>
                        {msg.content_preview}
                      </p>
                      <div style={{ display: 'flex', gap: '1rem', fontSize: '0.75rem', color: 'var(--text-tertiary)', flexWrap: 'wrap' }}>
                        <span>ID: {msg.platform_user_id}</span>
                        <span>{formatTimeAgo(msg.received_at)}</span>
                        <span style={{ color: 'var(--warning)' }}>过期: {getExpiresIn(msg.expires_at)}</span>
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', marginLeft: '1rem', flexShrink: 0 }}>
                    <Button
                      variant="primary"
                      onClick={() => openApproveModal(msg)}
                      disabled={approving === msg.id}
                      style={{ fontSize: '0.8125rem', padding: '0.375rem 0.75rem' }}
                    >
                      {approving === msg.id ? '处理中...' : '批准'}
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => handleReject(msg.id)}
                      disabled={rejecting === msg.id}
                      style={{ fontSize: '0.8125rem', padding: '0.375rem 0.75rem' }}
                    >
                      {rejecting === msg.id ? '处理中...' : '拒绝'}
                    </Button>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      {showModal && selectedMsg && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0, 0, 0, 0.5)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
          onClick={() => setShowModal(false)}
        >
          <div
            style={{ background: 'var(--bg-primary)', borderRadius: '12px', padding: '2rem', width: '400px', maxWidth: '90vw' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
              <UserAvatar name={selectedMsg.platform_display_name} seed={selectedMsg.platform_user_id} size={48} />
              <h3 style={{ fontSize: '1.125rem', margin: 0 }}>
                {selectedMsg.intent === 'pair' ? '批准为 Master' : '批准用户'}
              </h3>
            </div>
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
              为 <strong>{selectedMsg.platform_display_name}</strong> 创建熟人档案
              {selectedMsg.intent === 'pair' && (
                <span style={{ display: 'block', marginTop: '0.25rem', color: 'var(--warning)' }}>
                  将被设为 Master，拥有最高权限
                </span>
              )}
            </p>

            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                显示名称
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                style={{
                  width: '100%', padding: '0.5rem 0.75rem', borderRadius: '6px',
                  border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                  color: 'var(--text-primary)', fontSize: '0.875rem', boxSizing: 'border-box',
                }}
              />
            </div>

            {selectedMsg.intent !== 'pair' && (
              <div style={{ marginBottom: '1.5rem' }}>
                <label style={{ display: 'block', fontSize: '0.875rem', fontWeight: 500, marginBottom: '0.25rem' }}>
                  权限模板
                </label>
                <select
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                  style={{
                    width: '100%', padding: '0.5rem 0.75rem', borderRadius: '6px',
                    border: '1px solid var(--border)', background: 'var(--bg-secondary)',
                    color: 'var(--text-primary)', fontSize: '0.875rem', boxSizing: 'border-box',
                  }}
                >
                  <option value="minimal">最低权限</option>
                  <option value="group_default">群聊默认</option>
                  <option value="standard">普通权限</option>
                </select>
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.5rem' }}>
              <Button variant="secondary" onClick={() => setShowModal(false)}>取消</Button>
              <Button
                variant="primary"
                onClick={handleApprove}
                disabled={!displayName.trim() || approving !== null}
              >
                {approving ? '处理中...' : '确认批准'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </MainLayout>
  )
}
