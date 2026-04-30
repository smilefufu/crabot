/**
 * 通用 Channel onboarding 页：URL = /channels/new/:implId/:methodId
 *
 * 流程：
 *   1. 等用户填实例名 + 任意 method 自定义参数（暂只支持飞书 domain，可后续按 method.type 扩展）
 *   2. POST /channels/onboard/begin → 获得 ui_mode + verification_uri
 *   3. 按 ui_mode 渲（qrcode → SVG QR / redirect → 打开链接 / pending → 状态文本）
 *   4. 同时建 SSE poll → success → POST /channels/onboard/finish 拿到 instance → 跳转
 */

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import { channelService } from '../../services/channel'
import { useToast } from '../../contexts/ToastContext'
import type { ChannelImplementation, ChannelOnboardingMethod, OnboardBeginResult, OnboardPollEvent } from '../../types'

type Step = 'idle' | 'starting' | 'pending' | 'authorized' | 'creating' | 'done' | 'error' | 'expired'

interface Status {
  step: Step
  message?: string
  begin?: OnboardBeginResult
  qrSvg?: string
}

const NAME_PATTERN = /^[a-z0-9-]{3,32}$/

export const NewChannelOnboarding: React.FC = () => {
  const navigate = useNavigate()
  const toast = useToast()
  const { implId = '', methodId = '' } = useParams()

  const [impl, setImpl] = useState<ChannelImplementation | null>(null)
  const [method, setMethod] = useState<ChannelOnboardingMethod | null>(null)
  const [implLoading, setImplLoading] = useState(true)
  const [implError, setImplError] = useState('')

  const [name, setName] = useState('')
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  const [status, setStatus] = useState<Status>({ step: 'idle' })
  const [now, setNow] = useState(Date.now())
  const sseRef = useRef<{ close: () => void } | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  // handlePollEvent 是 useCallback([])，闭包里的 name 永远是初始 ''
  // 用 ref 把当前 name 暴露给 finishOnboarding
  const nameRef = useRef('')
  nameRef.current = name

  useEffect(() => {
    channelService.getImplementation(implId)
      .then((r) => {
        setImpl(r.implementation)
        const m = r.implementation.onboarding_methods?.find((x) => x.id === methodId) ?? null
        setMethod(m)
        if (!m) setImplError(`实现 "${implId}" 不包含入口 "${methodId}"`)
      })
      .catch((e) => setImplError(e instanceof Error ? e.message : '加载实现失败'))
      .finally(() => setImplLoading(false))
  }, [implId, methodId])

  // 倒计时显示需要 1Hz 刷新；只在有 expires_at 时跑
  const expiresAt = status.begin?.expires_at
  useEffect(() => {
    if (!expiresAt) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [expiresAt])

  // unmount 时取消正在进行的 session
  useEffect(() => {
    return () => {
      sseRef.current?.close()
      const sessionId = sessionIdRef.current
      if (sessionId) channelService.onboardCancel(implId, methodId, sessionId).catch(() => {})
    }
  }, [implId, methodId])

  const remainingSec = expiresAt ? Math.max(0, Math.floor((expiresAt - now) / 1000)) : 0

  useEffect(() => {
    if (!expiresAt || remainingSec > 0) return
    if (status.step === 'expired' || status.step === 'done' || status.step === 'error' || status.step === 'creating') return
    sseRef.current?.close()
    setStatus((s) => ({ ...s, step: 'expired', message: '会话已过期，请重新开始' }))
  }, [expiresAt, remainingSec, status.step])

  const handleStart = useCallback(async () => {
    if (!NAME_PATTERN.test(name)) {
      toast.error('实例名只能包含小写字母 / 数字 / 连字符（3-32 字符）')
      return
    }
    setStatus({ step: 'starting', message: '正在初始化…' })
    try {
      const params: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(paramValues)) if (v) params[k] = v
      const r = await channelService.onboardBegin(implId, methodId, params)
      let qrSvg: string | undefined
      if (r.ui_mode === 'qrcode' && r.verification_uri) {
        qrSvg = await QRCode.toString(r.verification_uri, { type: 'svg', margin: 1, width: 240 })
      }
      sessionIdRef.current = r.session_id
      setStatus({ step: 'pending', begin: r, qrSvg, message: r.display?.description })
      const conn = channelService.onboardPoll(implId, methodId, r.session_id, (ev) => handlePollEvent(r.session_id, ev))
      sseRef.current = conn
      if (r.ui_mode === 'redirect' && r.verification_uri) {
        window.open(r.verification_uri, '_blank', 'noopener,noreferrer')
      }
    } catch (err) {
      setStatus({ step: 'error', message: err instanceof Error ? err.message : '启动失败' })
    }
  }, [implId, methodId, name, paramValues, toast])

  const handlePollEvent = useCallback((sessionId: string, ev: OnboardPollEvent) => {
    if (ev.type === 'pending') {
      setStatus((s) => ({ ...s, step: 'pending', message: '等待用户在平台侧完成授权…' }))
    } else if (ev.type === 'slow_down') {
      setStatus((s) => ({ ...s, step: 'pending', message: '平台要求降低轮询频率，已自动调整。' }))
    } else if (ev.type === 'success') {
      setStatus((s) => ({ ...s, step: 'authorized', message: '已授权，正在创建实例…' }))
      sseRef.current?.close()
      sseRef.current = null
      finishOnboarding(sessionId).catch(() => {})
    } else if (ev.type === 'error') {
      const codeMap: Record<string, string> = {
        access_denied: '已取消授权',
        expired_token: '会话已过期，请重新开始',
        session_not_found: '会话不存在',
        unknown: ev.message ?? '未知错误',
      }
      setStatus((s) => ({ ...s, step: 'error', message: codeMap[ev.code] ?? ev.message ?? ev.code }))
      sseRef.current?.close()
      sseRef.current = null
    }
  }, [])

  const finishOnboarding = async (sessionId: string) => {
    const instanceName = nameRef.current
    setStatus((s) => ({ ...s, step: 'creating', message: '正在创建 Channel 实例…' }))
    try {
      const r = await channelService.onboardFinish(implId, methodId, sessionId, instanceName)
      sessionIdRef.current = null
      setStatus({ step: 'done', message: '实例已创建' })
      toast.success(`Channel "${instanceName}" 创建成功，已自动启动`)
      const instanceId = r.instance?.id
      navigate(instanceId ? `/channels/config?selected=${encodeURIComponent(instanceId)}` : '/channels/config')
    } catch (err) {
      setStatus({ step: 'error', message: err instanceof Error ? err.message : '创建失败' })
    }
  }

  const handleRestart = () => {
    sseRef.current?.close()
    sseRef.current = null
    const sessionId = sessionIdRef.current
    if (sessionId) channelService.onboardCancel(implId, methodId, sessionId).catch(() => {})
    sessionIdRef.current = null
    setStatus({ step: 'idle' })
  }

  if (implLoading) return <MainLayout><Loading /></MainLayout>

  if (implError || !impl || !method) {
    return (
      <MainLayout>
        <div style={{ padding: '1.5rem 2rem', maxWidth: 720, margin: '0 auto' }}>
          <div className="error-message">{implError || '实现或入口不存在'}</div>
          <Button variant="secondary" onClick={() => navigate('/channels/new')}>← 返回选择</Button>
        </div>
      </MainLayout>
    )
  }

  const inProgress = status.step === 'starting' || status.step === 'pending' || status.step === 'authorized' || status.step === 'creating'

  return (
    <MainLayout>
      <div style={{ padding: '1.5rem 2rem', maxWidth: 720, margin: '0 auto' }}>
        <div style={{ marginBottom: '1.5rem' }}>
          <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.375rem', fontWeight: 700, color: 'var(--text-primary)' }}>
            {impl.name} · {method.name}
          </h1>
          <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
            {method.description}
          </p>
        </div>

        {/* idle: 表单 */}
        {status.step === 'idle' && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '1.25rem' }}>
            <div className="form-group" style={{ marginBottom: '1rem' }}>
              <label className="form-label">实例名称</label>
              <input
                className="input"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={`如：${impl.platform}-bot-1`}
                style={{ width: '100%' }}
              />
              <p style={{ fontSize: '0.7rem', color: 'var(--text-muted)', marginTop: '0.375rem' }}>
                只能小写字母 / 数字 / 连字符，3-32 字符。这就是 module_id，全局唯一。
              </p>
            </div>

            {/* 飞书特有：domain 选择。其他模块如有自定义参数后续按 method 类型扩展 */}
            {impl.id === 'channel-feishu' && (
              <div className="form-group" style={{ marginBottom: '1.25rem' }}>
                <label className="form-label">接入域</label>
                <select
                  className="select"
                  value={paramValues.domain ?? 'feishu'}
                  onChange={(e) => setParamValues((p) => ({ ...p, domain: e.target.value }))}
                >
                  <option value="feishu">国内（飞书 open.feishu.cn）</option>
                  <option value="lark">国际版（Lark open.larksuite.com）</option>
                </select>
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.625rem' }}>
              <Button variant="primary" onClick={handleStart}>开始 {method.type === 'device_code' ? '扫码' : '授权'}</Button>
              <Button variant="secondary" onClick={() => navigate('/channels/new')}>← 返回</Button>
            </div>
          </div>
        )}

        {/* in-progress / expired */}
        {(status.step === 'starting' || status.step === 'pending' || status.step === 'authorized' || status.step === 'creating' || status.step === 'expired') && (
          <div style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, padding: '1.25rem' }}>
            {/* qrcode mode */}
            {status.begin?.ui_mode === 'qrcode' && (
              <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: '1.5rem' }}>
                <div style={{ background: 'white', padding: 12, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {status.qrSvg ? (
                    <div dangerouslySetInnerHTML={{ __html: status.qrSvg }} style={{ width: 240, height: 240 }} />
                  ) : (
                    <Loading />
                  )}
                </div>
                <OnboardingStatusPanel
                  display={status.begin?.display}
                  message={status.message}
                  step={status.step}
                  remainingSec={remainingSec}
                  expiresAt={status.begin?.expires_at}
                  onRestart={handleRestart}
                  inProgress={inProgress}
                />
              </div>
            )}

            {/* redirect mode */}
            {status.begin?.ui_mode === 'redirect' && (
              <div>
                <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
                  已在新标签页打开授权页面。完成后此页面会自动跳转。
                </p>
                {status.begin.verification_uri && (
                  <a href={status.begin.verification_uri} target="_blank" rel="noopener noreferrer" style={{ fontSize: '0.8125rem' }}>
                    若未自动打开，请点这里 →
                  </a>
                )}
                <OnboardingStatusPanel
                  display={status.begin?.display}
                  message={status.message}
                  step={status.step}
                  remainingSec={remainingSec}
                  expiresAt={status.begin?.expires_at}
                  onRestart={handleRestart}
                  inProgress={inProgress}
                />
              </div>
            )}

            {/* pending mode */}
            {(!status.begin?.ui_mode || status.begin?.ui_mode === 'pending') && (
              <OnboardingStatusPanel
                display={status.begin?.display}
                message={status.message ?? '处理中…'}
                step={status.step}
                remainingSec={remainingSec}
                expiresAt={status.begin?.expires_at}
                onRestart={handleRestart}
                inProgress={inProgress}
              />
            )}
          </div>
        )}

        {/* error */}
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

interface StatusPanelProps {
  display?: { title?: string; description?: string }
  message?: string
  step: Step
  remainingSec: number
  expiresAt?: number
  onRestart: () => void
  inProgress: boolean
}

const OnboardingStatusPanel: React.FC<StatusPanelProps> = ({ display, message, step, remainingSec, expiresAt, onRestart, inProgress }) => (
  <div>
    {display?.title && (
      <h3 style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '0.5rem' }}>
        {display.title}
      </h3>
    )}
    {display?.description && (
      <p style={{ fontSize: '0.8125rem', color: 'var(--text-secondary)', marginBottom: '0.75rem' }}>
        {display.description}
      </p>
    )}
    <div style={{ marginTop: '0.5rem', padding: '0.625rem 0.875rem', background: 'var(--surface-subtle, rgba(0,0,0,0.03))', borderRadius: 4 }}>
      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>状态</div>
      <div style={{ fontSize: '0.875rem', color: 'var(--text-primary)', marginTop: 4 }}>{message ?? '等待中…'}</div>
      {expiresAt && step !== 'expired' && step !== 'creating' && (
        <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: 4 }}>
          剩余 {remainingSec}s
        </div>
      )}
    </div>
    <div style={{ marginTop: '1rem', display: 'flex', gap: '0.5rem' }}>
      {step === 'expired' && <Button variant="primary" onClick={onRestart}>重新开始</Button>}
      {inProgress && step !== 'creating' && <Button variant="secondary" onClick={onRestart}>取消</Button>}
    </div>
  </div>
)
