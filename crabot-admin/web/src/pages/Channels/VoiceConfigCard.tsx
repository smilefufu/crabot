import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import QRCode from 'qrcode'
import type { VoiceAdminAction, VoiceInstanceConfig, VoicePairing, VoiceTerminalState } from 'crabot-shared'
import { Button } from '../../components/Common/Button'
import { friendService } from '../../services/friend'
import { sessionService } from '../../services/session'
import { api } from '../../services/api'
import { voiceService, type AudioServicePublic } from '../../services/voice'
import type { Friend, ToolAccessConfig } from '../../types'
import { AudioServiceEditor } from './AudioServiceEditor'
import './voice-config.css'

const toolLabels: Partial<Record<keyof ToolAccessConfig, string>> = { memory: '记忆', messaging: '消息', file_io: '文件', shell: '命令', mcp_skill: 'MCP', desktop: '桌面' }
export function VoiceConfigCard({ channelId, running }: { channelId: string; running: boolean }) {
  const [config, setConfig] = useState<VoiceInstanceConfig>(), [providers, setProviders] = useState<AudioServicePublic[]>([])
  const [savedConfig, setSavedConfig] = useState<VoiceInstanceConfig>()
  const [state, setState] = useState<VoiceTerminalState>(), [friends, setFriends] = useState<Friend[]>([])
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [editor, setEditor] = useState<AudioServicePublic | 'new'>(), [host, setHost] = useState('')
  const [pairing, setPairing] = useState<VoicePairing>(), [qr, setQr] = useState('')
  const [friendId, setFriendId] = useState(''), [name, setName] = useState('')
  const [permission, setPermission] = useState<{ sessionId: string; tools: string[]; storage: string; scopes: string[] }>()
  async function refresh() {
    const [services, saved, contacts] = await Promise.all([voiceService.list(), voiceService.config(channelId), friendService.listFriends({ page_size: 100 })])
    setProviders(services.items); setConfig(saved); setSavedConfig(saved); setFriends(contacts.items)
  }
  async function status() {
    const result = await voiceService.action(channelId, { action: 'status' })
    if (result.action === 'status') setState(result.state)
  }
  useEffect(() => { let active = true; void refresh().catch(e => { if (active) setError(e.message) }); return () => { active = false } }, [channelId])
  useEffect(() => {
    if (!running) { setState(undefined); setPermission(undefined); return }
    let active = true
    const poll = async () => { try { const result = await voiceService.action(channelId, { action: 'status' }); if (active && result.action === 'status') setState(result.state) } catch { if (active) setState(undefined) } }
    void poll(); const timer = setInterval(() => { void poll() }, 3000)
    void sessionService.listSessions(channelId, 'group').then(async sessions => {
      const group = sessions.items.find(s => s.platform_session_id === 'household'); if (!group) throw new Error('家庭群尚未就绪')
      const [resolved, override] = await Promise.all([api.post<{ resolved: { tool_access: ToolAccessConfig; storage: { workspace_path: string; access: string } | null } }>('/permissions/resolve-principal', { channel_id: channelId, session_id: group.id, session_type: 'group' }), sessionService.getGroupConfig(channelId, group.id)])
      if (active) setPermission({ sessionId: group.id, tools: Object.entries(toolLabels).filter(([key]) => resolved.resolved.tool_access[key as keyof ToolAccessConfig]).map(([, label]) => label!), storage: resolved.resolved.storage ? `${resolved.resolved.storage.workspace_path} (${resolved.resolved.storage.access})` : '文件工具无目录授权', scopes: override.config?.memory_scopes ?? [group.id] })
    }).catch(e => { if (active) setError(e.message) })
    return () => { active = false; clearInterval(timer) }
  }, [channelId, running])
  useEffect(() => { let active = true; setQr(''); if (pairing) void QRCode.toDataURL(JSON.stringify(pairing)).then(url => { if (active) setQr(url) }); return () => { active = false } }, [pairing])
  async function run(work: () => Promise<void>) {
    setBusy(true); setError(''); setNotice('')
    try { await work() } catch (e) { setError(e instanceof Error ? e.message : '语音配置操作失败') } finally { setBusy(false) }
  }
  async function action(command: VoiceAdminAction) {
    const result = await voiceService.action(channelId, command)
    if (result.action === 'create_pairing') setPairing(result.pairing)
    else if (result.action === 'confirm_pairing' || result.action === 'revoke_terminal') setPairing(undefined)
    await status()
  }
  if (!config) return <section className="voice-config"><h3>家庭语音</h3>{error ? <p role="alert">{error}</p> : <p>正在读取语音配置…</p>}</section>
  const changed = JSON.stringify(config) !== JSON.stringify(savedConfig)
  return <section className="voice-config" aria-label="家庭语音配置">
    <h3>家庭语音</h3><p>手机只在前台、现场开启后收音。后台维护服务和成员，不会远程打开麦克风。</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <h4>语音服务</h4><p>仅此渠道使用 ASR/TTS。保存服务或去向会结束当前交互，手机需要现场重新开始；云服务可能留存音频，请按所选服务规则核对。</p>
    <div className="voice-fields">{(['asr', 'tts'] as const).map(cap => <label key={cap}>{cap === 'asr' ? '语音转文字 ASR' : '文字转语音 TTS'}<select className="select" value={config[cap] ? JSON.stringify(config[cap]) : ''} onChange={e => setConfig({ ...config, [cap]: e.target.value ? JSON.parse(e.target.value) : null })}><option value="">未配置</option>{providers.flatMap(p => p.models.filter(m => m.capabilities.includes(cap)).map(m => <option key={p.id + m.model_id} value={JSON.stringify({ provider_id: p.id, model_id: m.model_id })}>{p.name} · {m.display_name} ({p.kind === 'cloud' ? '云' : '自建'})</option>))}</select></label>)}
      <label>本地唤醒词<input className="input" value={config.wake_word} onChange={e => setConfig({ ...config, wake_word: e.target.value })} /></label>
    </div>
    <div className="voice-actions"><Button disabled={busy || !config.wake_word.trim()} onClick={() => void run(async () => { await voiceService.saveConfig(channelId, config); setSavedConfig(config); setNotice('已保存；手机重连后仍保持关麦') })}>保存语音配置</Button>{(['asr', 'tts'] as const).map(cap => <Button key={cap} variant="secondary" disabled={busy || changed || !config[cap]} onClick={() => void run(async () => { const result = await voiceService.test(channelId, cap); setNotice(result.ok ? `${cap.toUpperCase()} 连接测试通过${result.text ? '：' + result.text : ''}` : '测试未通过') })}>测试 {cap.toUpperCase()}</Button>)}</div>
    <p>测试使用固定合成音频或文本，不采集手机声音。请先保存模型选择，再运行测试。</p>
    {providers.map(p => <div className="voice-service-row" key={p.id}><span><strong>{p.name}</strong> · {p.kind === 'cloud' ? '云服务' : '自建'} · {p.format}<br /><small>{p.endpoint} · {p.has_api_key ? 'key 已保存' : '无 key'}</small></span><div className="voice-actions"><Button variant="secondary" disabled={busy} onClick={() => setEditor(p)}>编辑</Button><Button variant="danger" disabled={busy} onClick={() => void run(async () => { await voiceService.remove(p.id); await refresh() })}>删除服务</Button></div></div>)}
    <Button variant="secondary" disabled={busy} onClick={() => setEditor('new')}>新增音频服务</Button>
    {editor && <AudioServiceEditor key={editor === 'new' ? 'new' : editor.id} provider={editor === 'new' ? undefined : editor} onCancel={() => setEditor(undefined)} onSaved={async () => { await refresh(); setEditor(undefined); setNotice('音频服务已保存；原有模型引用继续使用更新后的连接') }} />}
    <h4>手机配对</h4><p>{!running ? '请先启动此渠道。' : state ? `${state.paired ? '已配对' : '未配对'} · ${state.connected ? '已连接' : '离线'} · ${state.foreground ? '前台' : '非前台'} · 麦克风 ${state.microphone === 'closed' ? '关闭' : state.microphone === 'wake' ? '本地唤醒' : '录音中'}` : '终端状态暂不可用，连接恢复后会更新。'}</p>
    <div className="voice-fields"><label>手机可访问的主机地址<input className="input" list="voice-hosts" value={host} placeholder={state?.hosts[0] ?? '主机的局域网 IP 或域名'} onChange={e => setHost(e.target.value)} /><datalist id="voice-hosts">{state?.hosts.map(address => <option key={address} value={address} />)}</datalist></label></div>
    <div className="voice-actions"><Button disabled={busy || !running || !!state?.paired || !host.trim()} onClick={() => void run(() => action({ action: 'create_pairing', host: host.trim() }))}>生成一次性配对码</Button><Button variant="danger" disabled={busy || !running || !state?.paired} onClick={() => void run(() => action({ action: 'revoke_terminal' }))}>撤销终端</Button></div>
    {pairing && <div className="voice-pairing">{qr && <img src={qr} width={220} height={220} alt="手机扫描的一次性语音配对二维码" />}<p>在 Android App 扫码，核对两端均显示 <strong>{pairing.verification_code}</strong> 后确认。有效期至 {new Date(pairing.expires_at).toLocaleTimeString()}。</p><p>地址：{pairing.url}</p><Button disabled={busy || state?.pairing_id !== pairing.pairing_id || state?.verification_code !== pairing.verification_code || Date.parse(pairing.expires_at) <= Date.now()} onClick={() => void run(() => action({ action: 'confirm_pairing', pairing_id: pairing.pairing_id }))}>核对一致，确认配对</Button></div>}
    <h4>家庭成员</h4><p>声纹帮助标注发言人；这仍是普通家庭群，Master 的语音不会获得私聊权限。录音和向量留在手机。</p>
    {state?.registrations.map(r => <div className="voice-service-row" key={r.registration_id}><span><strong>{r.display_name}</strong> · {r.status === 'active' ? '已登记并绑定' : r.status === 'pending' ? '等待手机现场登记' : r.terminal_cleared ? '已撤销并清除' : '后端已撤销，终端清除待完成'}</span>{r.status !== 'revoked' && <Button variant="danger" disabled={busy} onClick={() => void run(() => action({ action: 'delete_registration', registration_id: r.registration_id }))}>撤销登记</Button>}</div>)}
    <div className="voice-fields"><label>已有对话对象<select className="select" value={friendId} onChange={e => { setFriendId(e.target.value); setName(friends.find(f => f.id === e.target.value)?.display_name ?? '') }}><option value="">选择成员</option>{friends.map(f => <option key={f.id} value={f.id}>{f.display_name}</option>)}</select></label><label>声纹显示名称<input className="input" value={name} onChange={e => setName(e.target.value)} /></label></div>
    <div className="voice-actions"><Button disabled={busy || !state?.connected || !state.foreground || !friendId || !name.trim()} onClick={() => void run(() => action({ action: 'enroll', friend_id: friendId, display_name: name.trim() }))}>让手机开始登记</Button><Link to="/dialog-objects">管理对话对象与家庭群权限</Link></div>
    {permission && <p>家庭群 {permission.sessionId} · 当前允许：{permission.tools.join('、') || '无'}。{permission.storage}；记忆范围：{permission.scopes.length ? permission.scopes.join('、') : '全部范围'}。以上按当前群配置解析。</p>}
    <p>回声尚未通过真机验收时，播放期间关麦，只能点按打断。识别准确率、唤醒误触发和整体延迟须以真机测试为准。</p>
  </section>
}
