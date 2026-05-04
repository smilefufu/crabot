import React, { useState, useEffect } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { channelService } from '../../services/channel'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import type {
  ChannelInstance,
  ChannelImplementation,
  ChannelConfig as ChannelConfigType,
  JsonSchema,
  JsonSchemaProperty,
} from '../../types'
import { useToast } from '../../contexts/ToastContext'

const CHANNEL_ONBOARDING_STORAGE_KEY = 'crabot:channel-onboarding-dismissed:v1'

const ChannelOnboardingCallout: React.FC<{ visible: boolean; onDismiss: () => void }> = ({
  visible,
  onDismiss,
}) => {
  if (!visible) return null
  return (
    <aside className="channel-onboarding" role="note">
      <span className="channel-onboarding__eyebrow">下一步</span>
      <h3 className="channel-onboarding__title">完成主人认证 (<code>/认主</code>)</h3>
      <p className="channel-onboarding__text">
        新接入的渠道启动后，需要在该平台的<strong>私聊</strong>或<strong>群聊</strong>中向 Crabot 发送 <code>/认主</code>。
        认证通过后你才会被识别为 Master，写命令、记忆与工具权限等才能正常使用。
      </p>
      <p className="channel-onboarding__text">
        待审批的认主请求会出现在 <Link to="/dialog-objects">对话对象 → 申请队列</Link> 中。
      </p>
      <div className="channel-onboarding__actions">
        <Link to="/dialog-objects" className="channel-onboarding__cta">前往申请队列</Link>
        <button type="button" className="channel-onboarding__dismiss" onClick={onDismiss}>
          我已了解
        </button>
      </div>
    </aside>
  )
}

// ============================================================================
// Schema 驱动的表单渲染
// ============================================================================

/** 根据 JSON Schema property 渲染单个表单字段 */
function SchemaField({ propKey, prop, value, required, onChange }: {
  propKey: string
  prop: JsonSchemaProperty
  value: string
  required: boolean
  onChange: (key: string, value: string) => void
}) {
  const inputType = prop.format === 'password' ? 'password' : 'text'

  return (
    <div className="form-group" style={{ marginBottom: 0 }}>
      <label style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.375rem', display: 'block' }}>
        {prop.title ?? propKey}
        {required && <span style={{ color: 'var(--error, #ef4444)', marginLeft: '0.25rem' }}>*</span>}
      </label>
      {prop.description && (
        <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.375rem', lineHeight: 1.4 }}>
          {prop.description}
        </p>
      )}
      {prop.enum ? (
        <select
          className="select"
          value={value}
          onChange={(e) => onChange(propKey, e.target.value)}
        >
          {!required && <option value="">（未设置）</option>}
          {prop.enum.map((v, i) => {
            const label = prop.enum_titles?.[i] ?? String(v)
            return (
              <option key={String(v)} value={String(v)}>{label}</option>
            )
          })}
        </select>
      ) : prop.type === 'boolean' ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={value === 'true'}
              onChange={(e) => onChange(propKey, String(e.target.checked))}
            />
            <span className="toggle-track" />
          </label>
          <span style={{ fontSize: '0.8125rem', color: value === 'true' ? 'var(--success)' : 'var(--text-muted)' }}>
            {value === 'true' ? '已启用' : '已禁用'}
          </span>
        </div>
      ) : (
        <input
          className="input"
          type={inputType}
          value={value}
          onChange={(e) => onChange(propKey, e.target.value)}
          placeholder={prop.default !== undefined ? String(prop.default) : ''}
        />
      )}
    </div>
  )
}

/** 根据 config_schema 渲染一组表单字段 */
function SchemaForm({ schema, values, onChange }: {
  schema: JsonSchema
  values: Record<string, string>
  onChange: (key: string, value: string) => void
}) {
  const properties = schema.properties ?? {}
  const requiredSet = new Set(schema.required ?? [])
  const entries = Object.entries(properties)

  if (entries.length === 0) {
    return <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>该模块无配置项</p>
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem 1.5rem' }}>
      {entries.map(([key, prop]) => (
        <SchemaField
          key={key}
          propKey={key}
          prop={prop}
          value={values[key] ?? ''}
          required={requiredSet.has(key)}
          onChange={onChange}
        />
      ))}
    </div>
  )
}

// ============================================================================
// 工具函数
// ============================================================================

function getStatusInfo(status?: string) {
  switch (status) {
    case 'running':  return { label: '已启动', cls: 'badge-success', dotCls: 'status-dot-running' }
    case 'starting': return { label: '启动中', cls: 'badge-warning', dotCls: 'status-dot-pending' }
    case 'stopping': return { label: '停止中', cls: 'badge-warning', dotCls: 'status-dot-pending' }
    case 'failed':   return { label: '失败',   cls: 'badge-error',   dotCls: 'status-dot-error' }
    default:         return { label: '已停止', cls: 'badge-secondary', dotCls: 'status-dot-stopped' }
  }
}

function getConnectionInfo(connected?: boolean) {
  if (connected === undefined) return null
  return connected
    ? { label: '已连接', cls: 'badge-success' }
    : { label: '未连接', cls: 'badge-warning' }
}

function setNestedValue(obj: any, path: string, value: any): any {
  const keys = path.split('.')
  const result = { ...obj }
  let current: any = result
  for (let i = 0; i < keys.length - 1; i++) {
    current[keys[i]] = { ...current[keys[i]] }
    current = current[keys[i]]
  }
  current[keys[keys.length - 1]] = value
  return result
}

// ============================================================================
// 主组件
// ============================================================================

export const ChannelConfig: React.FC = () => {
  const toast = useToast()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [instances, setInstances] = useState<ChannelInstance[]>([])
  const [implementations, setImplementations] = useState<ChannelImplementation[]>([])
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null)
  // 运行时配置（模块运行中通过 RPC 读取）
  const [config, setConfig] = useState<ChannelConfigType | null>(null)
  const [editingConfig, setEditingConfig] = useState<ChannelConfigType | null>(null)
  // 本地配置（模块停止时编辑，启动时作为 env 注入）
  const [localConfig, setLocalConfig] = useState<Record<string, string>>({})
  const [editingLocalConfig, setEditingLocalConfig] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [configLoading, setConfigLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // 健康状态（platform_connected，protocol-channel §7.1）
  const [healthMap, setHealthMap] = useState<Record<string, { platform_connected?: boolean }>>({})

  // 创建表单
  const [showCreateForm, setShowCreateForm] = useState(false)
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => {
    if (typeof window === 'undefined') return true
    return window.localStorage.getItem(CHANNEL_ONBOARDING_STORAGE_KEY) === '1'
  })

  const dismissOnboarding = () => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(CHANNEL_ONBOARDING_STORAGE_KEY, '1')
    }
    setOnboardingDismissed(true)
  }
  const [createImplId, setCreateImplId] = useState('')
  const [createName, setCreateName] = useState('')
  const [createPlatform, setCreatePlatform] = useState('')
  const [createEnv, setCreateEnv] = useState<Record<string, string>>({})
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    loadInstances()
    loadImplementations()
  }, [])

  // 来自 /channels/new "手动填写" 入口：?implementation_id=xxx
  useEffect(() => {
    const implId = searchParams.get('implementation_id')
    if (!implId || implementations.length === 0) return
    if (!implementations.some((i) => i.id === implId)) return
    handleImplChange(implId)
    setShowCreateForm(true)
    const next = new URLSearchParams(searchParams)
    next.delete('implementation_id')
    setSearchParams(next, { replace: true })
  }, [implementations, searchParams, setSearchParams])

  // 来自 onboarding finish 跳转：?selected=xxx
  useEffect(() => {
    const selected = searchParams.get('selected')
    if (!selected || instances.length === 0) return
    if (!instances.some((i) => i.id === selected)) return
    handleSelectInstance(selected)
    const next = new URLSearchParams(searchParams)
    next.delete('selected')
    setSearchParams(next, { replace: true })
  }, [instances, searchParams, setSearchParams])

  const loadInstances = async () => {
    try {
      setLoading(true)
      const response = await channelService.listInstances()
      setInstances(response.items)
      // 异步拉取运行中实例的健康状态
      fetchHealthForRunning(response.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  const fetchHealthForRunning = (items: ChannelInstance[]) => {
    const running = items.filter((i) => i.runtime_status === 'running')
    for (const inst of running) {
      channelService.getHealth(inst.id).then((health) => {
        const connected = health.details?.platform_connected ?? health.details?.socket_connected
        setHealthMap((prev) => ({
          ...prev,
          [inst.id]: { platform_connected: typeof connected === 'boolean' ? connected : undefined },
        }))
      }).catch(() => {
        // 健康检查失败，不更新
      })
    }
  }

  const loadImplementations = async () => {
    try {
      const response = await channelService.listImplementations()
      setImplementations(response.items)
      if (response.items.length > 0 && !createImplId) {
        setCreateImplId(response.items[0].id)
      }
    } catch {
      // 非致命错误，静默处理
    }
  }

  // 查找实例对应的 implementation
  const getImplForInstance = (instance: ChannelInstance): ChannelImplementation | undefined =>
    implementations.find((i) => i.id === instance.implementation_id)

  // ---------- 运行时配置（模块运行中） ----------

  const loadConfig = async (instanceId: string) => {
    try {
      setConfigLoading(true)
      const response = await channelService.getInstanceConfig(instanceId)
      setConfig(response.config)
      setEditingConfig(response.config)
    } catch {
      // 模块可能刚停，fallback 到 local config
      setConfig(null)
      setEditingConfig(null)
      await loadLocalConfig(instanceId)
    } finally {
      setConfigLoading(false)
    }
  }

  const handleSaveRuntimeConfig = async () => {
    if (!selectedInstanceId || !editingConfig) return
    try {
      setSaving(true)
      const result = await channelService.updateInstanceConfig(selectedInstanceId, editingConfig)
      setConfig(result.config)
      setEditingConfig(result.config)
      if (result.requires_restart) {
        toast.info('配置已更新，需要重启模块才能生效')
      } else {
        toast.success('配置已更新并立即生效')
      }
    } catch (err) {
      toast.error(`保存失败: ${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setSaving(false)
    }
  }

  // ---------- 本地配置（模块停止时） ----------

  const loadLocalConfig = async (instanceId: string) => {
    try {
      setConfigLoading(true)
      const response = await channelService.getLocalConfig(instanceId)
      setLocalConfig(response.config)
      setEditingLocalConfig(response.config)
    } catch {
      setLocalConfig({})
      setEditingLocalConfig({})
    } finally {
      setConfigLoading(false)
    }
  }

  const handleSaveLocalConfig = async () => {
    if (!selectedInstanceId) return
    try {
      setSaving(true)
      await channelService.saveLocalConfig(selectedInstanceId, editingLocalConfig)
      setLocalConfig(editingLocalConfig)
      toast.success('配置已保存，启动模块后生效')
    } catch (err) {
      toast.error(`保存失败: ${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setSaving(false)
    }
  }

  // ---------- 实例选择 ----------

  const handleSelectInstance = (instanceId: string) => {
    if (selectedInstanceId === instanceId) {
      setSelectedInstanceId(null)
      setConfig(null)
      setEditingConfig(null)
      setLocalConfig({})
      setEditingLocalConfig({})
    } else {
      setSelectedInstanceId(instanceId)
      const inst = instances.find((i) => i.id === instanceId)
      if (inst?.runtime_status === 'running') {
        loadConfig(instanceId)
      } else {
        setConfig(null)
        setEditingConfig(null)
        loadLocalConfig(instanceId)
      }
    }
  }

  // ---------- 生命周期操作 ----------

  const handleStart = async (instanceId: string) => {
    try {
      await channelService.startInstance(instanceId)
      toast.success('Channel 已启动')
      loadInstances()
    } catch (err) {
      toast.error(`启动失败: ${err instanceof Error ? err.message : '未知错误'}`)
    }
  }

  const handleStop = async (instanceId: string) => {
    try {
      await channelService.stopInstance(instanceId)
      toast.success('Channel 已停止')
      setHealthMap((prev) => {
        const next = { ...prev }
        delete next[instanceId]
        return next
      })
      loadInstances()
    } catch (err) {
      toast.error(`停止失败: ${err instanceof Error ? err.message : '未知错误'}`)
    }
  }

  const handleRestart = async (instanceId: string) => {
    try {
      await channelService.restartInstance(instanceId)
      toast.success('Channel 已重启')
      loadInstances()
    } catch (err) {
      toast.error(`重启失败: ${err instanceof Error ? err.message : '未知错误'}`)
    }
  }

  const handleDelete = async (instance: ChannelInstance) => {
    if (!window.confirm(`确认删除 Channel "${instance.name}"？此操作不可恢复。`)) return
    try {
      await channelService.deleteInstance(instance.id)
      toast.success('Channel 已删除')
      if (selectedInstanceId === instance.id) {
        setSelectedInstanceId(null)
        setConfig(null)
        setEditingConfig(null)
      }
      loadInstances()
    } catch (err) {
      toast.error(`删除失败: ${err instanceof Error ? err.message : '未知错误'}`)
    }
  }

  const handleToggleAutoStart = async (instance: ChannelInstance) => {
    try {
      await channelService.updateInstance(instance.id, { auto_start: !instance.auto_start })
      toast.success(instance.auto_start ? '已关闭自动启动' : '已开启自动启动')
      loadInstances()
    } catch (err) {
      toast.error(`更新失败: ${err instanceof Error ? err.message : '未知错误'}`)
    }
  }

  // ---------- 创建表单 ----------

  const handleImplChange = (implId: string) => {
    setCreateImplId(implId)
    setCreateEnv({})
    const impl = implementations.find((i) => i.id === implId)
    if (impl && impl.platform !== '*') {
      setCreatePlatform(impl.platform)
    } else {
      setCreatePlatform('')
    }
  }

  const handleCreate = async () => {
    if (!createName.trim()) {
      toast.error('请填写实例名称')
      return
    }
    // 校验 config_schema 的 required 字段
    const impl = implementations.find((i) => i.id === createImplId)
    const schema = impl?.config_schema
    if (schema?.required) {
      for (const key of schema.required) {
        if (!createEnv[key]?.trim()) {
          const label = schema.properties?.[key]?.title ?? key
          toast.error(`请填写 ${label}`)
          return
        }
      }
    }
    try {
      setCreating(true)
      const envToSave = Object.fromEntries(
        Object.entries(createEnv).filter(([, v]) => v.trim())
      )
      await channelService.createInstance({
        implementation_id: createImplId,
        name: createName.trim(),
        platform: createPlatform || undefined,
        ...(Object.keys(envToSave).length > 0 && { env: envToSave }),
        auto_start: false,
      })
      toast.success('Channel 实例已创建。启动后请在该平台向 Crabot 发送 /认主 完成主人认证')
      setShowCreateForm(false)
      setCreateName('')
      setCreatePlatform('')
      setCreateEnv({})
      // 创建成功重新展示引导：用户可能已忘记或上次操作的是别的实例
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem(CHANNEL_ONBOARDING_STORAGE_KEY)
      }
      setOnboardingDismissed(false)
      loadInstances()
    } catch (err) {
      toast.error(`创建失败: ${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setCreating(false)
    }
  }

  // ---------- 渲染 ----------

  if (loading) return <MainLayout><Loading /></MainLayout>

  const selectedImpl = implementations.find((i) => i.id === createImplId)
  const createSchema = selectedImpl?.config_schema

  return (
    <MainLayout>
      <div style={{ padding: '1.5rem 2rem', maxWidth: '900px', margin: '0 auto' }}>

        {/* Page Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.75rem' }}>
          <div>
            <h1 style={{ fontFamily: 'var(--font-display)', fontSize: '1.375rem', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '0.02em' }}>
              Channel 配置
            </h1>
            <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
              管理消息渠道实例与连接配置
            </p>
          </div>
          <div style={{ display: 'flex', gap: '0.625rem' }}>
            <Button variant="primary" onClick={() => navigate('/channels/new')}>
              + 新建实例
            </Button>
          </div>
        </div>

        {error && <div className="error-message">{error}</div>}

        <ChannelOnboardingCallout
          visible={!onboardingDismissed && instances.length > 0}
          onDismiss={dismissOnboarding}
        />

        {/* Create Form */}
        {showCreateForm && (
          <div className="channel-create-panel">
            <h2 style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', marginBottom: '1.125rem' }}>
              新建 Channel 实例
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">实现（Implementation）</label>
                <select className="select" value={createImplId} onChange={(e) => handleImplChange(e.target.value)}>
                  {implementations.map((impl) => (
                    <option key={impl.id} value={impl.id}>{impl.name} ({impl.id})</option>
                  ))}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">实例名称</label>
                <input className="input" type="text" value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="如：飞书工作群" />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">平台</label>
                <input
                  className="input"
                  type="text"
                  value={createPlatform}
                  onChange={(e) => setCreatePlatform(e.target.value)}
                  placeholder="如：feishu、wechat、telegram"
                  disabled={selectedImpl?.platform !== '*'}
                />
              </div>
            </div>

            {/* 根据 config_schema 动态渲染配置字段 */}
            {createSchema && Object.keys(createSchema.properties ?? {}).length > 0 && (
              <div style={{ marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
                <p style={{ fontSize: '0.72rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
                  模块配置
                </p>
                <SchemaForm
                  schema={createSchema}
                  values={createEnv}
                  onChange={(key, value) => setCreateEnv((prev) => ({ ...prev, [key]: value }))}
                />
              </div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.625rem', marginTop: '1.25rem' }}>
              <Button variant="secondary" onClick={() => setShowCreateForm(false)}>取消</Button>
              <Button variant="primary" onClick={handleCreate} disabled={creating}>
                {creating ? '创建中...' : '创建实例'}
              </Button>
            </div>
          </div>
        )}

        {/* Instance List */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.875rem' }}>
          {instances.length === 0 ? (
            <div className="channel-empty-state">
              <div className="channel-empty-icon">⬡</div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.9375rem', fontWeight: 500 }}>暂无 Channel 实例</p>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.8125rem', marginTop: '0.375rem' }}>
                通过安装向导或手动创建来添加第一个渠道
              </p>
              <p style={{ color: 'var(--text-muted)', fontSize: '0.75rem', marginTop: '0.875rem', maxWidth: '420px', lineHeight: 1.55 }}>
                创建并启动渠道后，记得在该平台向 Crabot 发送 <code>/认主</code> 完成主人认证——这是写命令、记忆与工具权限生效的前提。
              </p>
            </div>
          ) : (
            instances.map((instance) => {
              const statusInfo = getStatusInfo(instance.runtime_status)
              const isSelected = selectedInstanceId === instance.id
              const isRunning = instance.runtime_status === 'running'
              const impl = getImplForInstance(instance)
              const schema = impl?.config_schema
              const connInfo = isRunning ? getConnectionInfo(healthMap[instance.id]?.platform_connected) : null

              return (
                <div key={instance.id} className={`channel-instance-card channel-instance-card--${instance.runtime_status ?? 'stopped'}`}>

                  {/* Card Header Row */}
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>

                    {/* Left: Info */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem', flexWrap: 'wrap' }}>
                        <span className={`status-dot ${statusInfo.dotCls}`} />
                        <span style={{ fontWeight: 600, fontSize: '0.9375rem', color: 'var(--text-primary)' }}>
                          {instance.name}
                        </span>
                        <span className="badge badge-secondary" style={{ fontSize: '0.65rem' }}>
                          {instance.platform}
                        </span>
                        <span className={`badge ${statusInfo.cls}`}>
                          {statusInfo.label}
                        </span>
                        {connInfo && (
                          <span className={`badge ${connInfo.cls}`}>
                            {connInfo.label}
                          </span>
                        )}
                      </div>

                      {instance.state_dir && (
                        <p
                          style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', marginTop: '0.375rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '480px' }}
                          title={instance.state_dir}
                        >
                          {instance.state_dir}
                        </p>
                      )}

                      {/* Auto-start toggle */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem' }}>
                        <label className="toggle-switch">
                          <input type="checkbox" checked={instance.auto_start} onChange={() => handleToggleAutoStart(instance)} />
                          <span className="toggle-track" />
                        </label>
                        <span style={{ fontSize: '0.75rem', color: instance.auto_start ? 'var(--text-secondary)' : 'var(--text-muted)' }}>
                          自动启动
                        </span>
                      </div>
                    </div>

                    {/* Right: Actions */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexShrink: 0, paddingTop: '0.125rem' }}>
                      {isRunning ? (
                        <>
                          <Button variant="secondary" onClick={() => handleRestart(instance.id)}>重启</Button>
                          <Button variant="danger" onClick={() => handleStop(instance.id)}>停止</Button>
                        </>
                      ) : (
                        <>
                          <Button variant="primary" onClick={() => handleStart(instance.id)}>启动</Button>
                          <Button variant="danger" onClick={() => handleDelete(instance)}>删除</Button>
                        </>
                      )}
                      <button
                        className={`btn channel-config-toggle ${isSelected ? 'channel-config-toggle--active' : ''}`}
                        onClick={() => handleSelectInstance(instance.id)}
                      >
                        配置
                        <span className="channel-config-toggle-arrow">{isSelected ? '▲' : '▼'}</span>
                      </button>
                    </div>
                  </div>

                  {/* Config Panel */}
                  {isSelected && (
                    <div className="channel-config-panel">
                      {configLoading ? (
                        <Loading />
                      ) : isRunning && editingConfig ? (
                        <>
                          {/* 运行时配置：通过 RPC 读取的实时配置 */}
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem 1.5rem' }}>
                            {Object.entries(editingConfig).map(([key, value]) => {
                              if (typeof value === 'object' && value !== null) {
                                // 嵌套对象展开
                                return Object.entries(value as Record<string, unknown>).map(([subKey, subVal]) => (
                                  <div key={`${key}.${subKey}`} className="form-group" style={{ marginBottom: 0 }}>
                                    <label style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.375rem', display: 'block' }}>
                                      {key}.{subKey}
                                    </label>
                                    <input
                                      className="input"
                                      type={subKey.includes('secret') || subKey.includes('token') || subKey.includes('password') ? 'password' : 'text'}
                                      value={String(subVal ?? '')}
                                      onChange={(e) => {
                                        if (!editingConfig) return
                                        setEditingConfig(setNestedValue(editingConfig, `${key}.${subKey}`, e.target.value))
                                      }}
                                    />
                                  </div>
                                ))
                              }
                              return (
                                <div key={key} className="form-group" style={{ marginBottom: 0 }}>
                                  <label style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--text-secondary)', marginBottom: '0.375rem', display: 'block' }}>
                                    {key}
                                  </label>
                                  {typeof value === 'boolean' ? (
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                                      <label className="toggle-switch">
                                        <input
                                          type="checkbox"
                                          checked={value}
                                          onChange={(e) => setEditingConfig(setNestedValue(editingConfig!, key, e.target.checked))}
                                        />
                                        <span className="toggle-track" />
                                      </label>
                                    </div>
                                  ) : (
                                    <input
                                      className="input"
                                      type={key.includes('secret') || key.includes('token') || key.includes('password') ? 'password' : 'text'}
                                      value={String(value ?? '')}
                                      onChange={(e) => setEditingConfig(setNestedValue(editingConfig!, key, e.target.value))}
                                    />
                                  )}
                                </div>
                              )
                            })}
                          </div>
                          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.625rem', marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
                            <Button variant="secondary" onClick={() => setEditingConfig(config)}>重置</Button>
                            <Button variant="primary" onClick={handleSaveRuntimeConfig} disabled={saving}>
                              {saving ? '保存中...' : '保存配置'}
                            </Button>
                          </div>
                        </>
                      ) : schema && Object.keys(schema.properties ?? {}).length > 0 ? (
                        <>
                          {/* 模块未运行：根据 config_schema 编辑启动配置 */}
                          <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
                            模块未运行 — 编辑启动配置
                          </p>
                          <SchemaForm
                            schema={schema}
                            values={editingLocalConfig}
                            onChange={(key, value) => setEditingLocalConfig((prev) => ({ ...prev, [key]: value }))}
                          />
                          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.625rem', marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
                            <Button variant="secondary" onClick={() => setEditingLocalConfig(localConfig)}>重置</Button>
                            <Button variant="primary" onClick={handleSaveLocalConfig} disabled={saving}>
                              {saving ? '保存中...' : '保存配置'}
                            </Button>
                          </div>
                        </>
                      ) : (
                        <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                          Channel 模块未运行，无法读取配置。请先启动模块。
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>
      </div>
    </MainLayout>
  )
}
