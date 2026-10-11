import { useEffect, useState } from 'react'
import type { VoiceInstanceConfig } from 'crabot-shared'
import { Button } from '../../components/Common/Button'
import { voiceService, type AudioServicePublic } from '../../services/voice'
import { AudioServiceEditor } from './AudioServiceEditor'

export function VoiceServices({ channelId, onChange }: { channelId?: string; onChange?: (config: VoiceInstanceConfig) => void }) {
  const [config, setValue] = useState<VoiceInstanceConfig>({ asr: null, tts: null, wake_word: '你好螃蟹' })
  const [savedConfig, setSavedConfig] = useState<VoiceInstanceConfig>()
  const [providers, setProviders] = useState<AudioServicePublic[]>([])
  const [editor, setEditor] = useState<AudioServicePublic | 'new'>()
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  function setConfig(value: VoiceInstanceConfig) { setValue(value); onChange?.(value) }
  async function refresh() {
    const services = await voiceService.list(); setProviders(services.items)
    if (channelId) { const value = await voiceService.config(channelId); setConfig(value); setSavedConfig(value) }
  }
  useEffect(() => { void refresh().catch(e => setError(e.message)) }, [channelId])
  async function run(work: () => Promise<void>) { setBusy(true); setError(''); setNotice(''); try { await work() } catch (e) { setError(e instanceof Error ? e.message : '操作失败') } finally { setBusy(false) } }
  const changed = JSON.stringify(config) !== JSON.stringify(savedConfig)
  return <div>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <h4>语音服务</h4><p>ASR/TTS 均通过外部 API 接入，模型由服务提供方部署和维护。Crabot 只配置服务连接与模型 ID，不下载或运行 ASR/TTS 模型。</p>
    <p>仅此渠道使用 ASR/TTS。保存服务连接或模型引用会结束当前交互，手机需要现场重新开始；云服务可能留存音频，请按所选服务规则核对。</p>
    <div className="voice-fields">{(['asr', 'tts'] as const).map(cap => <label key={cap}>{cap === 'asr' ? '语音转文字 ASR' : '文字转语音 TTS'}<select className="select" value={config[cap] ? JSON.stringify(config[cap]) : ''} onChange={e => setConfig({ ...config, [cap]: e.target.value ? JSON.parse(e.target.value) : null })}><option value="">未配置</option>{providers.flatMap(p => p.models.filter(m => m.capabilities.includes(cap)).map(m => <option key={p.id + m.model_id} value={JSON.stringify({ provider_id: p.id, model_id: m.model_id })}>{p.name} · {m.display_name} · {p.endpoint}</option>))}</select></label>)}
      <label>手机端唤醒词<input className="input" value={config.wake_word} onChange={e => setConfig({ ...config, wake_word: e.target.value })} /></label>
    </div>
    <p>唤醒词下发到手机，由手机本地模型识别；待机音频不上传。需在手机现场开启本地待机，唤醒后才上传本轮录音。</p>
    <div className="voice-actions">{channelId && <Button disabled={busy || !config.wake_word.trim()} onClick={() => void run(async () => { await voiceService.saveConfig(channelId!, config); setSavedConfig(config); setNotice('已保存；手机重连后仍保持关麦') })}>保存语音配置</Button>}{(['asr', 'tts'] as const).map(cap => <Button key={cap} variant="secondary" disabled={busy || !channelId || changed || !config[cap]} onClick={() => void run(async () => { const result = await voiceService.test(channelId!, cap); setNotice(result.ok ? `${cap.toUpperCase()} 连接测试通过${result.text ? '：' + result.text : ''}` : '测试未通过') })}>测试 {cap.toUpperCase()}</Button>)}</div>
    <p>测试使用固定合成音频或文本，不采集手机声音。请先保存模型选择，再运行测试。</p>
    {providers.map(p => <div className="voice-service-row" key={p.id}><span><strong>{p.name}</strong> · {p.format}<br /><small>{p.endpoint} · {p.has_api_key ? 'key 已保存' : '无 key'}</small></span><div className="voice-actions"><Button variant="secondary" disabled={busy} onClick={() => setEditor(p)}>编辑</Button><Button variant="danger" disabled={busy} onClick={() => void run(async () => { await voiceService.remove(p.id); await refresh() })}>删除服务</Button></div></div>)}
    <Button variant="secondary" disabled={busy} onClick={() => setEditor('new')}>新增音频服务</Button>
    {editor && <AudioServiceEditor key={editor === 'new' ? 'new' : editor.id} provider={editor === 'new' ? undefined : editor} onCancel={() => setEditor(undefined)} onSaved={async () => { await refresh(); setEditor(undefined); setNotice('音频服务已保存；原有模型引用继续使用更新后的连接') }} />}
  </div>
}
