import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Loading } from '../../components/Common/Loading'
import { Button } from '../../components/Common/Button'
import { channelService } from '../../services/channel'
import type { ChannelImplementation, ChannelPluginCatalogEntry } from '../../types'
import { ExperimentalChannels } from './ExperimentalChannels'
import { collaborationDescription, isExperimentalChannel } from './channel-presentation'
import './collaboration.css'

function configurationActions(impl: ChannelImplementation) {
  const actions = (impl.onboarding_methods ?? []).map(method => ({
    label: impl.id === 'channel-feishu' ? '扫码连接飞书' : method.name,
    to: `/channels/new/${encodeURIComponent(impl.id)}/${encodeURIComponent(method.id)}`,
  }))
  if (impl.id !== 'channel-feishu') actions.push({
    label: impl.id === 'channel-voice' ? '设置语音协作' : '手动填写',
    to: impl.id === 'channel-voice' ? '/channels/new/voice' : `/channels/config?implementation_id=${encodeURIComponent(impl.id)}`,
  })
  return actions
}

export function NewChannel() {
  const navigate = useNavigate()
  const [search] = useSearchParams()
  const requested = search.get('implementation_id')
  const [impls, setImpls] = useState<ChannelImplementation[]>([])
  const [plugins, setPlugins] = useState<ChannelPluginCatalogEntry[]>([])
  const [prepared, setPrepared] = useState<Record<string, ChannelImplementation>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  const pending = useRef(new Set<string>())
  const [installErrors, setInstallErrors] = useState<Record<string, string>>({})
  const [choosing, setChoosing] = useState<string | null>(null)
  const selected = useRef<HTMLElement>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [implementations, catalog] = await Promise.all([channelService.listImplementations(), channelService.listPlugins()])
      setImpls(implementations.items)
      setPlugins(catalog.items.filter(plugin => !plugin.installed && !implementations.items.some(impl => impl.id === plugin.implementation_id)))
      setCatalogOpen(implementations.items.length === 0)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '无法读取协作入口，请重试')
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    if (!loading && requested) {
      selected.current?.scrollIntoView?.({ block: 'center' })
      selected.current?.focus()
    }
  }, [loading, requested])

  const install = async (id: string) => {
    if (pending.current.has(id)) return
    pending.current.add(id)
    setInstalling(new Set(pending.current))
    setInstallErrors(previous => ({ ...previous, [id]: '' }))
    try {
      const { implementation } = await channelService.installPlugin(id)
      setPrepared(previous => ({ ...previous, [id]: implementation }))
    } catch (failure) {
      setInstallErrors(previous => ({ ...previous, [id]: failure instanceof Error ? failure.message : '插件安装失败，请重试' }))
    } finally {
      pending.current.delete(id)
      setInstalling(new Set(pending.current))
    }
  }

  const actions = (impl: ChannelImplementation) => <div className="collaboration-actions" role="group" aria-label={`选择 ${impl.name} 的配置方式`}>
    {configurationActions(impl).map((action, index) => <Button key={action.to} type="button" variant={index === 0 ? 'primary' : 'secondary'} onClick={() => navigate(action.to)}>{action.label}</Button>)}
  </div>

  const readyCard = (impl: ChannelImplementation) => <section key={impl.id} aria-label={`${impl.name} 配置`} ref={impl.id === requested ? selected : undefined} tabIndex={impl.id === requested ? -1 : undefined} className={`collaboration-card${impl.id === requested ? ' collaboration-card--selected' : ''}`}>
    <h3>{impl.name}</h3>
    <p className="collaboration-description">{collaborationDescription(impl.platform)}</p>
    <p className="collaboration-ready">插件已就绪，下一步设置账号</p>
    {actions(impl)}
  </section>

  const pluginCard = (plugin: ChannelPluginCatalogEntry) => {
    const id = plugin.implementation_id
    const impl = prepared[id]
    const busy = installing.has(id)
    const failed = installErrors[id]
    let status = '接入前需要准备插件'
    let label = id === 'channel-voice' ? '设置语音协作' : `接入${/^[A-Za-z]/.test(plugin.name) ? ' ' : ''}${plugin.name}`
    let accessibleLabel = label
    if (busy) {
      status = '正在安装所需插件，完成后继续设置'
      label = '正在准备…'
      accessibleLabel = `正在准备 ${plugin.name}`
    } else if (impl) {
      status = '插件已就绪，下一步设置账号'
    } else if (failed) {
      label = '重试接入'
      accessibleLabel = `重试接入 ${plugin.name}`
    }
    return <article className="collaboration-card" key={id}>
      <h3>{plugin.name}</h3>
      <p className="collaboration-description">{collaborationDescription(plugin.platform)}</p>
      <p className={impl ? 'collaboration-ready' : 'collaboration-muted'} role="status">{status}</p>
      {failed && <p role="alert" className="error-message">{failed}</p>}
      <div className="collaboration-actions">
        {impl ? <Button type="button" aria-label={`继续设置 ${plugin.name}`} onClick={() => {
          const options = configurationActions(impl)
          if (options.length === 1) navigate(options[0].to)
          else setChoosing(id)
        }}>继续设置 →</Button> : <Button type="button" variant="secondary" disabled={busy} aria-label={accessibleLabel} onClick={() => void install(id)}>
          {label}
        </Button>}
      </div>
      {impl && choosing === id && actions(impl)}
    </article>
  }

  const ready = impls.filter(impl => !isExperimentalChannel(impl.id))
  const experimentalReady = impls.filter(impl => isExperimentalChannel(impl.id))
  const available = plugins.filter(plugin => !isExperimentalChannel(plugin.implementation_id))
  const experimentalAvailable = plugins.filter(plugin => isExperimentalChannel(plugin.implementation_id))

  return <MainLayout><div className="collaboration-page">
    <p className="collaboration-breadcrumb">协作入口 / 添加入口</p>
    <header className="collaboration-header">
      <h1>在哪里与 CRABOT 协作？</h1>
      <p className="collaboration-description">连接你日常使用的平台，在熟悉的地方交流、处理任务。</p>
    </header>
    {loading ? <Loading /> : error ? <div><p role="alert" className="error-message">{error}</p><Button variant="secondary" onClick={() => void load()}>重新加载</Button></div> : <>
      {requested && !impls.some(impl => impl.id === requested) && <p role="status" className="collaboration-muted">指定的协作插件尚未就绪，请先选择平台完成接入。</p>}
      {impls.length > 0 && <section aria-label="可直接设置的协作入口">
        <h2>可直接设置</h2>
        <div className="collaboration-grid">{ready.map(readyCard)}</div>
        <ExperimentalChannels count={experimentalReady.length} initiallyOpen={experimentalReady.some(impl => impl.id === requested)}><div className="collaboration-grid">{experimentalReady.map(readyCard)}</div></ExperimentalChannels>
      </section>}
      {impls.length === 0 && <p className="collaboration-muted">选择你常用的平台，准备插件后继续设置账号。</p>}
      {plugins.length > 0 && <>
        <button type="button" className="btn btn-secondary collaboration-discover" aria-expanded={catalogOpen} aria-controls="collaboration-catalog" onClick={() => setCatalogOpen(!catalogOpen)}>
          <span><strong>在其他平台上与 CRABOT 协作</strong><small>{catalogOpen ? '收起平台列表' : '选择平台，在这里完成接入和账号设置'}</small></span><span aria-hidden="true">{catalogOpen ? '⌃' : '⌄'}</span>
        </button>
        {catalogOpen && <section id="collaboration-catalog" className="collaboration-catalog" aria-label="其他协作平台">
          <p className="collaboration-muted">首次接入会安装所需插件，完成后继续设置账号。</p>
          <div className="collaboration-grid">{available.map(pluginCard)}</div>
          <ExperimentalChannels count={experimentalAvailable.length}><div className="collaboration-grid">{experimentalAvailable.map(pluginCard)}</div></ExperimentalChannels>
        </section>}
      </>}
    </>}
    <footer className="collaboration-footer"><p className="collaboration-muted">完成账号设置后，可在“协作入口”中查看连接状态、管理账号。</p><Button type="button" variant="secondary" onClick={() => navigate('/channels/config')}>← 返回协作入口</Button></footer>
  </div></MainLayout>
}
