/**
 * 飞书 / Lark 扫码 onboarding 页
 *
 * 流程：begin → SSE poll → success → finish → 跳到实例详情
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import QRCode from 'qrcode'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Button } from '../../components/Common/Button'
import { channelService } from '../../services/channel'
import { useToast } from '../../contexts/ToastContext'
import type { FeishuOnboardPollEvent } from '../../types'

type Step = 'idle' | 'scanning' | 'pending' | 'authorized' | 'creating' | 'done' | 'error' | 'expired'

interface Status {
  step: Step
  message?: string
  expiresAt?: number
  qrSvg?: string
  sessionId?: string
  successPayload?: Extract<FeishuOnboardPollEvent, { type: 'success' }>
}

const NAME_PATTERN = /^[a-z0-9-]{3,32}$/

export const NewFeishuChannel: React.FC = () => {
  const navigate = useNavigate()
  const toast = useToast()
  const [name, setName] = useState('')
  const [domain, setDomain] = useState<'feishu' | 'lark'>('feishu')
  const [status, setStatus] = useState<Status>({ step: 'idle' })
  const [now, setNow] = useState(Date.now())
  const sseRef = useRef<{ close: () => void } | null>(null)

  // tick for countdown
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])

  // cleanup SSE on unmount + cancel session
  useEffect(() => {
    return () => {
      sseRef.current?.close()
      const sessionId = status.sessionId
      if (sessionId) {
        channelService.feishuCancel(sessionId).catch(() => { /* best effort */ })
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const remainingSec = status.expiresAt ? Math.max(0, Math.floor((status.expiresAt - now) / 1000)) : 0
  if (status.expiresAt && remainingSec === 0 && status.step !== 'expired' && status.step !== 'done' && status.step !== 'error') {
    sseRef.current?.close()
    setStatus((s) => ({ ...s, step: 'expired', message: '二维码已过期，请重新生成' }))
  }

  const handleStart = useCallback(async () => {
    if (!NAME_PATTERN.test(name)) {
      toast.error('实例名只能包含小写字母 / 数字 / 连字符（3-32 字符）')
      return
    }
    setStatus({ step: 'scanning', message: '正在生成二维码…' })
    try {
      const res = await channelService.feishuBegin(domain)
      const qrSvg = await QRCode.toString(res.verification_uri, { type: 'svg', margin: 1, width: 240 })
      setStatus({
        step: 'pending',
        qrSvg,
        sessionId: res.session_id,
        expiresAt: res.expires_at,
      })

      const conn = channelService.feishuPoll(res.session_id, (ev) => handlePollEvent(res.session_id, ev))
      sseRef.current = conn
    } catch (err) {
      setStatus({ step: 'error', message: err instanceof Error ? err.message : '启动失败' })
    }
  }, [domain, name, toast])

  const handlePollEvent = useCallback((sessionId: string, ev: FeishuOnboardPollEvent) => {
    if (ev.type === 'pending') {
      setStatus((s) => ({ ...s, step: 'pending', message: '等待飞书 App 内扫码…' }))
    } else if (ev.type === 'slow_down') {
      setStatus((s) => ({ ...s, step: 'pending', message: '飞书要求降低轮询频率，已自动调整。' }))
    } else if (ev.type === 'success') {
      setStatus((s) => ({ ...s, step: 'authorized', successPayload: ev, message: '已授权，正在创建实例…' }))
      // close SSE
      sseRef.current?.close()
      sseRef.current = null
      finishOnboarding(sessionId).catch(() => { /* error already shown */ })
    } else if (ev.type === 'error') {
      const codeMap: Record<string, string> = {
        access_denied: '已取消授权',
        expired_token: '二维码已过期，请重新生成',
        session_not_found: '会话不存在',
        unknown: ev.message ?? '未知错误',
      }
      setStatus((s) => ({ ...s, step: 'error', message: codeMap[ev.code] ?? ev.message ?? ev.code }))
      sseRef.current?.close()
      sseRef.current = null
    }
  }, [])

  const finishOnboarding = async (sessionId: string) => {
    setStatus((s) => ({ ...s, step: 'creating', message: '正在创建 Channel 实例…' }))
    try {
      const r = await channelService.feishuFinish(sessionId, name)
      setStatus({ step: 'done', message: '实例已创建' })
      toast.success(`飞书 Channel "${name}" 创建成功，已自动启动`)
      const instanceId = (r.instance as { id?: string } | undefined)?.id
      if (instanceId) {
        navigate(`/channels/config?selected=${encodeURIComponent(instanceId)}`)
      } else {
        navigate('/channels/config')
      }
    } catch (err) {
      setStatus({ step: 'error', message: err instanceof Error ? err.message : '创建失败' })
    }
  }

  const handleRestart = () => {
    sseRef.current?.close()
    sseRef.current = null
    setStatus({ step: 'idle' })
  }

  const inProgress = status.step === 'pending' || status.step === 'authorized' || status.step === 'creating'

  return (
    <MainLayout>
      <div style={{ padding: '1.5rem 2rem', maxWidth: 720, margin: '0 auto' }}>
        <div style={{ marginBottom: '1.5rem' }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.375rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            飞书 / Lark Channel 新建
          </h1>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            扫码授权 → 自动建 Bot → 启动 Channel 实例。整个过程无需公网回调。
          </p>
        </div>

        {/* Step 1：表单 */}
        {status.step === 'idle' && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '1.25rem' }}>
            <div className="form-group" style={{ marginBottom: '1rem' }}>
              <label className="form-label">实例名称</label>
              <input
                className="input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="如：feishu-bot-1"
                style={{ width: '100%' }}
              />
              <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.375rem' }}>
                只能小写字母 / 数字 / 连字符，3-32 字符。这就是 module_id，全局唯一。
              </p>
            </div>
            <div className="form-group" style={{ marginBottom: '1.25rem' }}>
              <label className="form-label">接入域</label>
              <select className="select" value={domain} onChange={(e) => setDomain(e.target.value as 'feishu' | 'lark')}>
                <option value="feishu">国内（飞书 open.feishu.cn）</option>
                <option value="lark">国际版（Lark open.larksuite.com）</option>
              </select>
            </div>
            <div style={{ display: 'flex', gap: '0.625rem' }}>
              <Button variant="primary" onClick={handleStart}>开始扫码</Button>
              <Button variant="secondary" onClick={() => navigate('/channels/new')}>← 返回</Button>
            </div>
          </div>
        )}

        {/* Step 2-3：扫码进行中 */}
        {(status.step === 'pending' || status.step === 'authorized' || status.step === 'creating' || status.step === 'expired') && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '1.25rem', display: 'grid', gridTemplateColumns: '260px 1fr', gap: '1.5rem' }}>
            <div style={{ background: 'white', padding: 12, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {status.qrSvg ? (
                <div dangerouslySetInnerHTML={{ __html: status.qrSvg }} style={{ width: 240, height: 240 }} />
              ) : (
                <div style={{ color: '#888' }}>二维码加载中…</div>
              )}
            </div>
            <div>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
                请在飞书 App 内扫描二维码
              </h3>
              <ol style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', lineHeight: 1.7, paddingLeft: '1.25rem' }}>
                <li>打开飞书 App</li>
                <li>使用顶部"扫一扫"</li>
                <li>选择或新建 PersonalAgent，授权应用</li>
                <li>授权完成后会自动跳到下一步</li>
              </ol>

              <div style={{ marginTop: '1rem', padding: '0.625rem 0.875rem', background: 'var(--surface-subtle, rgba(0,0,0,0.03))', borderRadius: 4 }}>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>状态</div>
                <div style={{ fontSize: '0.875rem', color: 'var(--text-primary)', marginTop: 4 }}>
                  {status.message ?? '等待扫码…'}
                </div>
                {status.expiresAt && status.step !== 'expired' && status.step !== 'creating' && (
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
                    剩余 {remainingSec}s
                  </div>
                )}
              </div>

              <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
                {status.step === 'expired' && (
                  <Button variant="primary" onClick={handleRestart}>重新生成二维码</Button>
                )}
                {inProgress && status.step !== 'creating' && (
                  <Button variant="secondary" onClick={handleRestart}>取消</Button>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Step 4：错误 */}
        {status.step === 'error' && (
          <div style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.4)', borderRadius: 8, padding: '1.25rem' }}>
            <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--error, #ef4444)' }}>出错了</h3>
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-primary)', marginTop: '0.5rem' }}>
              {status.message}
            </p>
            <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
              <Button variant="primary" onClick={handleRestart}>重试</Button>
              <Button variant="secondary" onClick={() => navigate('/channels/new')}>返回选择</Button>
            </div>
          </div>
        )}
      </div>
    </MainLayout>
  )
}
