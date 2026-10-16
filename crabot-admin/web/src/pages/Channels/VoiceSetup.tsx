import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { VoiceInstanceConfig, VoiceTerminalState } from 'crabot-shared'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Button } from '../../components/Common/Button'
import { channelService } from '../../services/channel'
import { voiceService } from '../../services/voice'
import { VoiceServices } from './VoiceServices'
import { VoiceConfigCard } from './VoiceConfigCard'
import './voice-config.css'

const steps = ['语音服务', '手机扫码', '联系人与群权限', '检查并完成']
export function VoiceSetup() {
  const [params, setParams] = useSearchParams(), navigate = useNavigate()
  const id = params.get('instance_id') ?? ''
  const [name, setName] = useState(id), [step, setStep] = useState(0), [running, setRunning] = useState(false)
  const [config, setConfig] = useState<VoiceInstanceConfig>({ asr: null, tts: null, wake_word: '你好螃蟹' })
  const [permissionDirty, setPermissionDirty] = useState(false)
  const [state, setState] = useState<VoiceTerminalState>(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  useEffect(() => {
    if (!id) return
    let active = true
    void channelService.getInstance(id).then(async ({ instance }) => {
      if (!active) return
      if (instance.implementation_id !== 'channel-voice') throw new Error('请选择语音渠道实例')
      if (instance.voice_setup?.status === 'complete') { navigate(`/channels/config?selected=${encodeURIComponent(id)}`, { replace: true }); return }
      setName(instance.name)
      await voiceService.resume(id)
      if (active) setRunning(true)
    }).catch(e => { if (active) setError(e.message) })
    return () => { active = false }
  }, [id])
  async function run(work: () => Promise<void>) { setBusy(true); setError(''); try { await work() } catch (e) { setError(e instanceof Error ? e.message : '配置失败，草稿已保留') } finally { setBusy(false) } }
  async function next() {
    if (step === 0) {
      let target = id
      if (!target) {
        // Remember the canonical ID before the request: a lost response can continue the same draft.
        target = name.trim().normalize('NFC')
        try { const result = await voiceService.setup(target, config); target = result.instance.id }
        catch (e) { const existing = await channelService.getInstance(target).catch(() => undefined); if (existing?.instance.implementation_id === 'channel-voice' && existing.instance.voice_setup?.status === 'draft') setParams({ instance_id: existing.instance.id }); throw e }
        setParams({ instance_id: target })
      } else await voiceService.saveConfig(target, config)
      await voiceService.resume(target); setRunning(true)
      for (const capability of ['asr', 'tts'] as const) {
        const result = await voiceService.test(target, capability)
        if (!result.ok) throw new Error(`${capability.toUpperCase()} 测试未通过，草稿已保留`)
      }
    }
    if (step === 3) { await voiceService.finish(id); navigate(`/channels/config?selected=${encodeURIComponent(id)}`) }
    else setStep(value => value + 1)
  }
  return <MainLayout><div className="voice-config" style={{ maxWidth: 960, margin: '1.5rem auto', padding: '1.5rem' }}>
    <h1>{id ? `继续配置：${name}` : '新建语音渠道'}</h1>
    <ol>{steps.map((label, index) => <li key={label} aria-current={step === index ? 'step' : undefined}>{index === step ? '→ ' : ''}{label}</li>)}</ol>
    <p>完成前保留为创建草稿，可配对和登记，业务语音尚未启用。无需公网地址，也无需提前购买硬件。</p>
    {error && <p role="alert">{error}</p>}
    {step === 0 ? <><label>渠道名称<input className="input" disabled={!!id || busy} value={name} onChange={e => setName(e.target.value)} placeholder="如：手机语音" /></label><VoiceServices key={id || 'new'} channelId={id || undefined} onChange={setConfig} /></> : <VoiceConfigCard channelId={id} running={running} stage={step === 1 ? 'phone' : step === 2 ? 'contacts' : 'summary'} onState={setState} onDirty={setPermissionDirty} />}
    {step === 3 && <p>ASR：{config.asr?.model_id} · TTS：{config.tts?.model_id} · 手机唤醒词：{config.wake_word}</p>}
    {permissionDirty && <p role="status">群权限有未保存的修改，请先保存群权限再继续。</p>}
    <div className="voice-actions">
      {step > 0 && <Button variant="secondary" disabled={busy || permissionDirty} onClick={() => setStep(value => value - 1)}>上一步</Button>}
      <Button disabled={busy || permissionDirty || (step === 0 && (!name.trim() || !config.asr || !config.tts || !config.wake_word.trim())) || (step === 1 && (!state?.paired || !state.connected || !state.foreground))} onClick={() => void run(next)}>{busy ? '正在检查…' : step === 3 ? '检查并完成创建' : '下一步'}</Button>
      <Button variant="secondary" disabled={busy || permissionDirty} onClick={() => void run(async () => { if (id) { if (step === 0) await voiceService.saveConfig(id, config); await voiceService.pause(id) } navigate('/channels/config') })}>{id ? '保存并退出' : '退出'}</Button>
    </div>
  </div></MainLayout>
}
