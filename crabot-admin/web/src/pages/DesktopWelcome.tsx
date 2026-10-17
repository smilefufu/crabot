import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ModelClient, type ModelChoiceProvider } from 'crabot-client'
import { getWebClient } from '../services/api'
import { useServerScope } from '../services/server-state'
import { ProviderDrawerCreate } from './Providers/ProviderDrawerCreate'
import { Modal } from '../components/Common/Modal'
import { Button } from '../components/Common/Button'
import { Select } from '../components/Common/Select'
import './DesktopWelcome.css'

export function DesktopWelcome() {
  const navigate = useNavigate(), scope = useServerScope()
  const client = useMemo(() => new ModelClient(getWebClient()), [scope])
  const [phase, setPhase] = useState<'checking' | 'setup' | 'error'>('checking')
  const [providers, setProviders] = useState<ModelChoiceProvider[]>([])
  const [providerId, setProviderId] = useState(''), [modelId, setModelId] = useState('')
  const [creating, setCreating] = useState(false), [saving, setSaving] = useState(false)
  const [error, setError] = useState(''), [mustCheck, setMustCheck] = useState(false)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const abort = new AbortController()
    setPhase('checking'); setError('')
    void (async () => {
      if (await client.hasManagerModel({ signal: abort.signal })) { if (!abort.signal.aborted) navigate('/chat', { replace: true }); return }
      const choices = (await client.choices({ signal: abort.signal })).items.filter(provider => provider.status === 'active' && provider.models.some(model => model.type === 'llm'))
      if (abort.signal.aborted) return
      setProviders(choices); setPhase('setup'); setMustCheck(false)
      setProviderId(previous => choices.some(provider => provider.id === previous) ? previous : choices[0]?.id ?? '')
    })().catch(() => { if (!abort.signal.aborted) { setError('未能读取已有模型配置。可以重新检查，设置与诊断仍可访问。'); setPhase('error') } })
    return () => abort.abort()
  }, [client, navigate, refresh])
  const selected = providers.find(provider => provider.id === providerId)
  const models = selected?.models.filter(model => model.type === 'llm') ?? []
  const chosen = models.find(model => model.model_id === modelId)?.model_id ?? models[0]?.model_id ?? ''
  const save = useCallback(async () => {
    if (!providerId || !chosen || saving || mustCheck) return
    setSaving(true); setError('')
    try {
      await client.selectDefault({ provider_id: providerId, model_id: chosen })
      navigate('/chat')
    } catch {
      setMustCheck(true); setError('未能确认保存结果，已保留选择。请先重新检查配置。')
    } finally { setSaving(false) }
  }, [client, providerId, chosen, saving, mustCheck, navigate])
  return <main className="desktop-welcome">
    <section className="desktop-welcome-card">
      <div className="desktop-welcome-brand">Crabot</div>
      <h1>让 Crabot 准备好为你工作</h1>
      <p>运行环境已随应用准备。接入一个模型服务，就可以开始聊天和处理任务。</p>
      <ol className="desktop-welcome-steps"><li>接入模型服务</li><li>选择默认模型</li><li>发送第一条消息</li></ol>
      {phase === 'checking' ? <p role="status">正在检查已有配置…</p> : <>
        {providers.length > 0 && phase === 'setup' && <div className="desktop-welcome-models">
          <Select label="模型服务" value={providerId} options={providers.map(provider => ({ value: provider.id, label: provider.name }))}
            disabled={saving} onChange={event => { setProviderId(event.target.value); setModelId('') }} />
          <Select label="默认模型" value={chosen} options={models.map(model => ({ value: model.model_id, label: model.display_name }))}
            disabled={saving} onChange={event => setModelId(event.target.value)} />
          <Button onClick={() => { void save() }} disabled={saving || mustCheck || !chosen}>{saving ? '正在保存…' : '保存并开始聊天'}</Button>
        </div>}
        <div className="desktop-welcome-actions">
          <Button variant={providers.length ? 'secondary' : 'primary'} disabled={saving} onClick={() => setCreating(true)}>添加模型服务</Button>
          {(phase === 'error' || mustCheck) && <Button variant="secondary" disabled={saving} onClick={() => setRefresh(value => value + 1)}>重新检查配置</Button>}
        </div>
      </>}
      {error && <p role="alert">{error}</p>}
      <p className="desktop-welcome-note">连接检查和实际模型调用都由你发起，可能产生模型服务费用。收到真实回复后，才能确认配置可用。</p>
      <div className="desktop-welcome-links"><Link to="/chat">稍后设置，进入应用</Link><Link to="/providers">完整模型设置</Link></div>
      <p className="desktop-welcome-note">桌面无需 Crabot 密码。截图、麦克风和桌面控制权限会在使用相应功能时再请求。</p>
    </section>
    {creating && <Modal open title="接入模型服务" size="lg" onClose={() => setCreating(false)}>
      <ProviderDrawerCreate onCancel={() => setCreating(false)} onCreated={id => {
        setCreating(false); setProviderId(id); setModelId(''); setRefresh(value => value + 1)
      }} />
    </Modal>}
  </main>
}
