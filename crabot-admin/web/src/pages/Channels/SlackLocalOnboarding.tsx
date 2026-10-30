import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Button } from '../../components/Common/Button'
import { channelService } from '../../services/channel'
import type { OnboardBeginResult, OnboardPollEvent } from '../../types'
const IMPLEMENTATION = 'channel-slack', METHOD = 'local-cli'
type Phase = 'idle' | 'starting' | 'waiting' | 'submitting' | 'configuring' | 'creating' | 'finish_error' | 'created' | 'error'
type Identity = { platform_user_id: string; platform_display_name?: string }
export function SlackLocalOnboarding() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [begin, setBegin] = useState<OnboardBeginResult>()
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const commandField = useRef<HTMLTextAreaElement>(null)
  const [now, setNow] = useState(Date.now())
  const [instanceId, setInstanceId] = useState('')
  const [identity, setIdentity] = useState<Identity>()
  const [master, setMaster] = useState<{ id: string; displayName: string }>()
  const [connected, setConnected] = useState(false)
  const active = useRef(true), generation = useRef(0)
  const session = useRef<string | undefined>(undefined)
  const connection = useRef<{ close(): void } | undefined>(undefined)
  const finishing = useRef(false)
  const remaining = begin?.expires_at ? Math.max(0, Math.ceil((begin.expires_at - now) / 1000)) : undefined
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      generation.current++
      connection.current?.close()
      if (session.current) void channelService.onboardCancel(IMPLEMENTATION, METHOD, session.current).catch(() => {})
    }
  }, [])
  useEffect(() => {
    if (phase !== 'waiting' || !begin?.expires_at) return
    const tick = () => {
      setNow(Date.now())
      if (Date.now() >= begin.expires_at!) {
        connection.current?.close()
        if (session.current) void channelService.onboardCancel(IMPLEMENTATION, METHOD, session.current).catch(() => {})
        setError('授权命令已过期，请重新开始')
        setPhase('error')
      }
    }
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [phase, begin])
  useEffect(() => {
    if (!instanceId) return
    let cancelled = false
    const check = async () => {
      try {
        const health = await channelService.getHealth(instanceId)
        if (!cancelled) setConnected(health.details?.platform_connected === true)
      } catch { if (!cancelled) setConnected(false) }
    }
    void check()
    const timer = setInterval(() => { void check() }, 3000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [instanceId])
  async function finish(sessionId: string, instanceName: string, current: number) {
    if (finishing.current) return
    finishing.current = true
    setPhase('creating')
    setError('')
    try {
      const result = await channelService.onboardFinish(IMPLEMENTATION, METHOD, sessionId, instanceName)
      if (!active.current || generation.current !== current) return
      if (result.master_friend_id) session.current = undefined
      setInstanceId(result.instance.id)
      setIdentity(result.authorized_identity)
      setMaster(result.master_friend_id ? { id: result.master_friend_id, displayName: result.master_display_name ?? '' } : undefined)
      setPhase('created')
    } catch (value) {
      if (!active.current || generation.current !== current) return
      setError(value instanceof Error ? value.message : '实例创建失败')
      setPhase('finish_error')
    } finally { finishing.current = false }
  }
  function event(id: string, instanceName: string, current: number, value: OnboardPollEvent) {
    if (!active.current || current !== generation.current) return
    if (value.type === 'success') {
      connection.current?.close()
      const completedGeneration = ++generation.current
      void finish(id, instanceName, completedGeneration)
    } else if (value.type === 'error') {
      generation.current++
      connection.current?.close()
      setCode('')
      setError(value.message ?? (value.code === 'expired_token' ? '授权已过期，请重新开始' : '本轮授权未完成，请重新开始'))
      setPhase('error')
    }
  }
  async function start() {
    const instanceName = name.normalize('NFC')
    if (!/^[\p{Script=Han}A-Za-z0-9-]{2,50}$/u.test(instanceName)) { setError('名称可用中文、大小写英文字母、数字和连字符，2–50 字符'); return }
    const current = ++generation.current
    setName(instanceName); setError(''); setCopied(false); setCode(''); setPhase('starting')
    try {
      const result = await channelService.onboardBegin(IMPLEMENTATION, METHOD, { instance_name: instanceName })
      if (!active.current || current !== generation.current) {
        void channelService.onboardCancel(IMPLEMENTATION, METHOD, result.session_id).catch(() => {})
        return
      }
      session.current = result.session_id
      setBegin(result); setNow(Date.now()); setPhase('waiting')
      connection.current = channelService.onboardPoll(IMPLEMENTATION, METHOD, result.session_id, value => event(result.session_id, instanceName, current, value))
    } catch (value) {
      if (!active.current || current !== generation.current) return
      setError(value instanceof Error ? value.message : '准备授权失败'); setPhase('error')
    }
  }
  async function copyCommand() {
    const current = generation.current
    setError(''); setCopied(false)
    try {
      await navigator.clipboard.writeText(begin?.authorization_command ?? '')
      if (active.current && current === generation.current) setCopied(true)
    } catch {
      if (!active.current || current !== generation.current) return
      commandField.current?.focus()
      commandField.current?.select()
      setError('自动复制未完成，已选中纯文本命令；请按 ⌘C / Ctrl+C 后粘贴到 Slack。')
    }
  }
  async function submit() {
    if (!session.current || phase !== 'waiting') return
    const current = generation.current
    setError(''); setPhase('submitting')
    try {
      await channelService.onboardSubmit(IMPLEMENTATION, METHOD, session.current, code.trim())
      if (active.current && current === generation.current) { setCode(''); setPhase(value => value === 'submitting' ? 'configuring' : value) }
    } catch (value) {
      if (!active.current || current !== generation.current) return
      setError(value instanceof Error ? value.message : '提交未确认，请等待当前授权结果或取消后重新开始')
      const failure = value as { status?: number; body?: { code?: string } }
      setPhase(previous => {
        if (previous !== 'submitting') return previous
        if (failure.body?.code === 'session_busy') return 'configuring'
        if (failure.status === 400) return 'waiting'
        if ([403, 404, 409].includes(failure.status ?? 0)) return 'error'
        return 'configuring' // Unknown submission outcome: continue SSE, do not reset the old countdown.
      })
    }
  }
  async function cancel() {
    const id = session.current
    const cancelledGeneration = ++generation.current
    connection.current?.close()
    session.current = undefined
    if (id) await channelService.onboardCancel(IMPLEMENTATION, METHOD, id).catch(() => {})
    if (!active.current || generation.current !== cancelledGeneration) return
    setBegin(undefined); setCode(''); setError(''); setCopied(false); setPhase('idle')
  }
  const busy = ['starting', 'submitting', 'configuring', 'creating'].includes(phase)
  return <MainLayout><div style={{ maxWidth: 720, margin: '0 auto', padding: '1.5rem 2rem' }}>
    <h1>Slack · 本地授权</h1>
    {error && <p role="alert" className="error-message">{error}</p>}
    {phase === 'idle' && <>
      <p>Crabot 会在你的 workspace 创建和配置一个自己的 Slack App，保持本地直连。授权包含 App 管理能力，CLI 只在接入时运行。</p>
      <label htmlFor="slack-instance-name">渠道名称</label>
      <input id="slack-instance-name" className="input" value={name} onChange={e => setName(e.target.value)} placeholder="如：slack-bot" />
      <p>App 和 Bot 使用此渠道名称，Slack CLI 会添加 (local) 后缀；渠道名称最多 27 个字符。</p>
      <p>你只需在 Slack 确认一次授权，并填回验证码；完成后将自动认主，无需手工配置 Bot 或填写 Token。</p>
      <Button onClick={start} disabled={!name.trim()}>开始授权</Button>
    </>}
    {phase === 'waiting' && <>
      <ol><li>复制以下一次性命令，建议在目标 Slack 工作区与自己的私聊中发送；任意私聊或群聊也可以。</li><li>在 Slack 弹窗中确认权限。</li><li>将 Slack 给出的验证码填回下方。</li></ol>
      <p>这一步只授权 Slack CLI 管理应用，不会将新 Bot 加入发送命令的群。配置完成后，请在要使用的群中添加此 Bot。</p>
      <label htmlFor="slack-authorization-command">一次性授权命令</label>
      <textarea id="slack-authorization-command" ref={commandField} className="input" rows={3} readOnly spellCheck={false}
        value={begin?.authorization_command ?? ''} onFocus={event => event.currentTarget.select()}
        onCopy={event => { event.clipboardData.setData('text/plain', event.currentTarget.value); event.preventDefault() }} />
      <Button variant="secondary" onClick={() => { void copyCommand() }}>复制授权命令</Button>
      {copied && <p role="status">已复制纯文本命令</p>}
      {remaining !== undefined && <p>本轮等待时间：{remaining} 秒；平台票据也可能提前失效。</p>}
      <label htmlFor="slack-challenge">一次性验证码</label>
      <input id="slack-challenge" className="input" autoComplete="off" spellCheck={false} value={code} onChange={e => setCode(e.target.value)} />
      <Button onClick={submit} disabled={!code.trim()}>确认并配置 App</Button>
    </>}
    {busy && <p role="status">{phase === 'starting' ? '正在准备本地授权工具…' : phase === 'creating' ? 'App 已配置，正在保存并创建渠道…' : '正在确认授权并配置 App，请稍候…'}</p>}
    {phase === 'finish_error' && <><p>App 已配置。重试完成会继续使用本次结果，请勿重复授权。</p><Button onClick={() => { if (session.current) void finish(session.current, name, generation.current) }}>重试完成创建</Button></>}
    {phase === 'error' && <><p>若 Slack App 已创建，请先在 <a href="https://api.slack.com/apps" target="_blank" rel="noreferrer">Slack App 后台</a> 核对。取消不会自动删除 App。</p><Button onClick={cancel}>重新开始授权</Button></>}
    {phase !== 'idle' && phase !== 'created' && phase !== 'error' && <Button variant="secondary" disabled={phase === 'creating'} onClick={cancel}>取消本轮授权</Button>}
    {phase === 'created' && <>
      <p>App 已配置，渠道 <strong>{instanceId}</strong> 已创建。</p>
      <p role="status">{connected ? 'Slack 渠道已连接' : '渠道尚未确认连接，可到渠道设置查看状态'}；真实消息收发尚未验证。</p>
      {master ? <p>已自动认主：{master.displayName || identity?.platform_display_name || identity?.platform_user_id || '主人'}。可以直接开始聊天，无需再次关联。</p> : <>
        <p role="alert">渠道已创建，但自动认主未完成。可重试认主；若已有身份绑定冲突，请在「对话对象」中核对，原关联不会被覆盖。</p>
        <Button onClick={() => { if (session.current) void finish(session.current, name, generation.current) }}>重试认主</Button>
        <p><a href="/friends">管理对话对象</a></p>
      </>}
      <p>可选消息测试：在 Slack 中打开此 Bot 私聊，发送一条消息。群聊请先邀请 Bot 加入，再 @Bot 发起；群聊默认仅响应 @，可在渠道设置修改。</p>
      <Button onClick={() => navigate(`/channels/config?selected=${encodeURIComponent(instanceId)}`)}>完成并查看渠道</Button>
    </>}
    {phase === 'idle' && <p><a href="/channels/config?implementation_id=channel-slack">已有 Token？使用手动配置</a></p>}
  </div></MainLayout>
}
