import React, { useState } from 'react'
import type { AudioServiceModel, AudioServiceFormat } from 'crabot-shared'
import { Button } from '../../components/Common/Button'
import { voiceService, type AudioServiceEdit, type AudioServicePublic } from '../../services/voice'

export function AudioServiceEditor({ provider, onSaved, onCancel }: { provider?: AudioServicePublic; onSaved(): Promise<void>; onCancel(): void }) {
  const [draft, setDraft] = useState<AudioServiceEdit>(() => ({ name: provider?.name ?? '', kind: provider?.kind ?? 'self_hosted', format: provider?.format ?? 'openai-audio', endpoint: provider?.endpoint ?? '',
    api_key: '', models: structuredClone(provider?.models ?? [{ model_id: '', display_name: '', capabilities: ['asr'] }]) }))
  const [saving, setSaving] = useState(false), [error, setError] = useState('')
  const format = (value: AudioServiceFormat) => setDraft(d => ({ ...d, format: value, models: d.models.map(m => ({ ...m, capabilities: value === 'openai-audio' ? m.capabilities : [value === 'mlx-audio-http' ? 'tts' : 'asr'] })) }))
  const model = (index: number, patch: Partial<AudioServiceModel>) => setDraft(d => ({ ...d, models: d.models.map((m, i) => i === index ? { ...m, ...patch } : m) }))
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError('')
    try { await voiceService.save(draft, provider?.id); await onSaved() } catch (e) { setError(e instanceof Error ? e.message : '保存失败') } finally { setSaving(false) }
  }
  return <form onSubmit={submit} className="voice-editor">
    <h4>{provider ? '编辑音频服务' : '新增音频服务'}</h4>
    <div className="voice-fields">
      <label>服务名称<input className="input" required value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label>音频去向<select className="select" value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as AudioServiceEdit['kind'] })}><option value="self_hosted">自行部署的 API 服务</option><option value="cloud">第三方云 API</option></select></label>
      <label>接口格式<select className="select" value={draft.format} onChange={e => format(e.target.value as AudioServiceFormat)}><option value="openai-audio">OpenAI 基本音频接口</option><option value="sherpa-offline-ws">Sherpa 有限文件 ASR WebSocket</option><option value="mlx-audio-http">MLX-Audio TTS HTTP</option></select></label>
      <label>服务地址<input className="input" required value={draft.endpoint} placeholder={draft.format === 'sherpa-offline-ws' ? 'ws://主机:端口' : 'https://服务地址/v1'} onChange={e => setDraft({ ...draft, endpoint: e.target.value })} /></label>
      <label>API key<input className="input" type="password" autoComplete="new-password" value={draft.api_key} placeholder={provider?.has_api_key ? '已保存；留空保留原 key' : '无认证的 API 服务可留空'} onChange={e => setDraft({ ...draft, api_key: e.target.value })} /></label>
      {provider?.has_api_key && <label><input type="checkbox" checked={draft.clear_api_key ?? false} onChange={e => setDraft({ ...draft, clear_api_key: e.target.checked })} /> 清除已保存的 key</label>}
    </div>
    <p>这里接入已运行的 API 服务，可位于本机、局域网设备或远程服务器。模型 ID 使用服务原生名称。TTS 还需要 voice；MLX 中文 language 填 z，OpenAI ASR 可填 zh。</p>
    {draft.models.map((m, index) => <fieldset className="voice-model" key={index}><legend>模型 {index + 1}</legend>
      <div className="voice-fields">
        <label>模型 ID<input className="input" required value={m.model_id} onChange={e => model(index, { model_id: e.target.value })} /></label>
        <label>显示名称<input className="input" required value={m.display_name} onChange={e => model(index, { display_name: e.target.value })} /></label>
        <label>voice<input className="input" required={m.capabilities.includes('tts')} value={m.voice ?? ''} onChange={e => model(index, { voice: e.target.value || undefined })} /></label>
        <label>language<input className="input" value={m.language ?? ''} onChange={e => model(index, { language: e.target.value || undefined })} /></label>
      </div>
      <div className="voice-actions">{(['asr', 'tts'] as const).map(cap => <label key={cap}><input type="checkbox" checked={m.capabilities.includes(cap)} disabled={draft.format === 'sherpa-offline-ws' && cap === 'tts' || draft.format === 'mlx-audio-http' && cap === 'asr'} onChange={e => model(index, { capabilities: e.target.checked ? [...m.capabilities, cap] : m.capabilities.filter(c => c !== cap) })} /> {cap === 'asr' ? '语音转文字' : '文字转语音'}</label>)}
        <Button type="button" variant="secondary" disabled={draft.models.length === 1} onClick={() => setDraft({ ...draft, models: draft.models.filter((_, i) => i !== index) })}>删除模型</Button></div>
    </fieldset>)}
    {error && <p role="alert">{error}</p>}
    <div className="voice-actions"><Button type="button" variant="secondary" onClick={() => setDraft({ ...draft, models: [...draft.models, { model_id: '', display_name: '', capabilities: [draft.format === 'mlx-audio-http' ? 'tts' : 'asr'] }] })}>添加模型</Button><Button type="submit" disabled={saving}>{saving ? '保存中…' : '保存服务'}</Button><Button type="button" variant="secondary" onClick={onCancel} disabled={saving}>取消</Button></div>
  </form>
}
