import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { parseVoiceConnection, voiceTerminalEntry } from 'crabot-shared/dist/voice-connection.js'
import type { VoiceConnectionConfig, VoicePairing, VoiceTerminalState } from 'crabot-shared'
import { Button } from '../../components/Common/Button'
import { providerService } from '../../services/provider'
import { voiceService } from '../../services/voice'

export function defaultVoiceConnection(saved: VoiceConnectionConfig | null, publicUrl: string | undefined, origin: string, hosts: string[]): VoiceConnectionConfig | undefined {
  if (saved) return saved
  for (const candidate of [publicUrl, origin, ...hosts]) {
    if (!candidate) continue
    try {
      const url = new URL(candidate)
      if (['localhost', '0.0.0.0', '[::]', '[::1]'].includes(url.hostname) || /^127\./.test(url.hostname)) continue
      return parseVoiceConnection({ base_url: candidate, transport: url.protocol === 'https:' ? 'wss' : 'ws' })
    } catch { /* try the next reachable-address candidate */ }
  }
  return undefined
}

export function VoicePairing({ channelId, running, state, onChanged }: { channelId: string; running: boolean; state?: VoiceTerminalState; onChanged(): Promise<void> }) {
  const [connection, setConnection] = useState<VoiceConnectionConfig>({ base_url: '', transport: 'ws' })
  const [saved, setSaved] = useState<VoiceConnectionConfig | null>(null)
  const [pairing, setPairing] = useState<VoicePairing>(), [qr, setQr] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const manual = useRef(false), edited = useRef(false), loaded = useRef(false)
  const hosts = JSON.stringify(state?.hosts ?? [])
  useEffect(() => {
    let active = true
    void Promise.all([voiceService.connection(channelId), providerService.getGlobalConfig().catch(() => undefined)]).then(([value, global]) => {
      if (!active) return
      setSaved(value); manual.current = !!value; loaded.current = true
      if (!edited.current) { const initial = defaultVoiceConnection(value, global?.public_base_url, window.location.origin, state?.hosts ?? []); if (initial) setConnection(initial) }
    }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [channelId])
  useEffect(() => {
    if (loaded.current && !edited.current) setConnection(value => value.base_url ? value : defaultVoiceConnection(saved, undefined, window.location.origin, state?.hosts ?? []) ?? value)
  }, [hosts, saved])
  useEffect(() => { let active = true; setQr(''); if (pairing) void QRCode.toDataURL(JSON.stringify(pairing)).then(value => { if (active) setQr(value) }); return () => { active = false } }, [pairing])
  let preview = ''
  try { preview = voiceTerminalEntry(connection, channelId).url } catch { /* incomplete input */ }
  const changed = JSON.stringify(connection) !== JSON.stringify(saved)
  async function run(work: () => Promise<void>) { setBusy(true); setError(''); try { await work(); await onChanged() } catch (e) { setError(e instanceof Error ? e.message : '配对失败') } finally { setBusy(false) } }
  return <div>
    <h4>手机配对</h4>
    <p>{!running ? '请先启动此渠道。' : state ? `${state.paired ? '已配对' : '未配对'} · ${state.connected ? '已连接' : '离线'} · ${state.foreground ? '前台' : '非前台'} · 麦克风 ${state.microphone === 'closed' ? '关闭' : state.microphone === 'wake' ? '本地唤醒' : '录音中'}` : '正在等待终端状态。'}</p>
    {error && <p role="alert">{error}</p>}
    <div className="voice-fields">
      <label>手机可访问的后台地址<input className="input" list="voice-hosts" value={connection.base_url} placeholder="http://192.168.1.10:3000" onChange={e => {
        edited.current = true
        const base_url = e.target.value
        setConnection(value => ({ base_url, transport: manual.current ? value.transport : base_url.trim().startsWith('https://') ? 'wss' : 'ws' }))
      }} /><datalist id="voice-hosts">{state?.hosts.map(address => <option key={address} value={address} />)}</datalist></label>
      <label>连接协议<select className="select" value={connection.transport} onChange={e => { manual.current = true; edited.current = true; setConnection({ ...connection, transport: e.target.value as 'ws' | 'wss' }) }}><option value="ws">WS</option><option value="wss">WSS</option></select></label>
    </div>
    <p>填写手机能访问的 Crabot 管理后台完整地址。同一家庭网络可用局域网地址；跨网络需要可访问的域名或地址。默认使用 tmp-page 的 BASE_URL。路径前缀由反向代理转发到 Admin Web。</p>
    <p>{connection.transport === 'ws' ? 'WS 明文传输，请用于你信任的网络。' : 'WSS 加密传输。直连时 Admin 自动生成证书，手机通过二维码指纹验证；外部代理证书可使用系统信任的 CA。'}</p>
    {preview && <p>手机连接：{preview}</p>}
    <div className="voice-actions">
      <Button disabled={busy || !running || !preview || !changed || !!state?.paired} onClick={() => void run(async () => { const value = await voiceService.saveConnection(channelId, connection); setSaved(value); setConnection(value); setPairing(undefined) })}>保存连接地址</Button>
      <Button disabled={busy || !running || !!state?.paired || changed || !preview} onClick={() => void run(async () => { const result = await voiceService.action(channelId, { action: 'create_pairing' }); if (result.action === 'create_pairing') setPairing(result.pairing) })}>生成一次性配对码</Button>
      <Button variant="danger" disabled={busy || !running || !state?.paired} onClick={() => void run(async () => { await voiceService.action(channelId, { action: 'revoke_terminal' }); setPairing(undefined) })}>撤销终端</Button>
    </div>
    {state?.paired && <p>更换连接地址或升级旧配对时，先撤销终端，再用同一渠道的新二维码扫码。手机保留同渠道的声纹登记。</p>}
    {pairing && <div className="voice-pairing">{qr && <img src={qr} width={220} height={220} alt="手机扫描的一次性语音配对二维码" />}<p>用 Android App 扫码，核对两端均显示 <strong>{pairing.verification_code}</strong> 后确认。有效期至 {new Date(pairing.expires_at).toLocaleTimeString()}。</p><p>地址：{pairing.url}</p><Button disabled={busy || changed || state?.pairing_id !== pairing.pairing_id || state?.verification_code !== pairing.verification_code || Date.parse(pairing.expires_at) <= Date.now()} onClick={() => void run(async () => { await voiceService.action(channelId, { action: 'confirm_pairing', pairing_id: pairing.pairing_id }); setPairing(undefined) })}>核对一致，确认配对</Button></div>}
  </div>
}
