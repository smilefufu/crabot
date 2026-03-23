import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { channelService } from '../../services/channel'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import type {
  ChannelInstance,
  ChannelImplementation,
  ChannelConfig as ChannelConfigType,
} from '../../types'
import { useToast } from '../../contexts/ToastContext'

interface ConfigField {
  key: string
  label: string
  type: 'text' | 'password' | 'boolean'
  description?: string
  hot_reload?: boolean
  requires_restart?: boolean
}

const FEISHU_CONFIG_FIELDS: ConfigField[] = [
  { key: 'credentials.app_id', label: 'App ID', type: 'text', description: '飞书应用 App ID' },
  { key: 'credentials.app_secret', label: 'App Secret', type: 'password', description: '飞书应用 App Secret', requires_restart: true },
  { key: 'connectionMode', label: '连接模式', type: 'text', description: 'websocket 或 webhook' },
  { key: 'requireMention', label: '群聊需要 @提及', type: 'boolean', description: '群聊中只响应 @机器人 的消息', hot_reload: true },
]

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((acc: any, key: string) => acc?.[key], obj)
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

function getStatusInfo(status?: string) {
  switch (status) {
    case 'running':  return { label: '运行中', cls: 'badge-success', dotCls: 'status-dot-running' }
    case 'starting': return { label: '启动中', cls: 'badge-warning', dotCls: 'status-dot-pending' }
    case 'stopping': return { label: '停止中', cls: 'badge-warning', dotCls: 'status-dot-pending' }
    case 'failed':   return { label: '失败',   cls: 'badge-error',   dotCls: 'status-dot-error' }
    default:         return { label: '已停止', cls: 'badge-secondary', dotCls: 'status-dot-stopped' }
  }
}

export const ChannelConfig: React.FC = () => {
  const toast = useToast()
  const navigate = useNavigate()
  const [instances, setInstances] = useState<ChannelInstance[]>([])
  const [implementations, setImplementations] = useState<ChannelImplementation[]>([])
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null)
  const [config, setConfig] = useState<ChannelConfigType | null>(null)
  const [editingConfig, setEditingConfig] = useState<ChannelConfigType | null>(null)
  const [loading, setLoading] = useState(true)
  const [configLoading, setConfigLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const [showCreateForm, setShowCreateForm] = useState(false)
  const [createImplId, setCreateImplId] = useState('channel-host')
  const [createName, setCreateName] = useState('')
  const [createPlatform, setCreatePlatform] = useState('')
  const [createStateDir, setCreateStateDir] = useState('')
  const [creating, setCreating] = useState(false)
  const [scanningPlatform, setScanningPlatform] = useState(false)

  useEffect(() => {
    loadInstances()
    loadImplementations()
  }, [])

  const loadInstances = async () => {
    try {
      setLoading(true)
      const response = await channelService.listInstances()
      setInstances(response.items)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  const loadImplementations = async () => {
    try {
      const response = await channelService.listImplementations()
      setImplementations(response.items)
    } catch {
      // 非致命错误，静默处理
    }
  }

  const loadConfig = async (instanceId: string) => {
    try {
      setConfigLoading(true)
      const response = await channelService.getInstanceConfig(instanceId)
      setConfig(response.config)
      setEditingConfig(response.config)
    } catch (err) {
      toast.error(`加载配置失败: ${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setConfigLoading(false)
    }
  }

  const handleSelectInstance = (instanceId: string) => {
    if (selectedInstanceId === instanceId) {
      setSelectedInstanceId(null)
      setConfig(null)
      setEditingConfig(null)
    } else {
      setSelectedInstanceId(instanceId)
      loadConfig(instanceId)
    }
  }

  const handleFieldChange = (fieldKey: string, value: any) => {
    if (!editingConfig) return
    setEditingConfig(setNestedValue(editingConfig, fieldKey, value))
  }

  const handleSave = async () => {
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

  const handleStateDirBlur = async () => {
    if (!createStateDir.trim() || createPlatform) return
    setScanningPlatform(true)
    try {
      const result = await channelService.scanStateDir(createStateDir.trim())
      const firstPlugin = result.plugins[0]
      if (firstPlugin && firstPlugin.platform !== 'unknown') {
        setCreatePlatform(firstPlugin.platform)
      }
    } catch {
      // 扫描失败静默处理
    } finally {
      setScanningPlatform(false)
    }
  }

  const handleCreate = async () => {
    if (!createName.trim()) {
      toast.error('请填写实例名称')
      return
    }
    try {
      setCreating(true)
      await channelService.createInstance({
        implementation_id: createImplId,
        name: createName.trim(),
        platform: createPlatform,
        ...(createStateDir.trim() && { state_dir: createStateDir.trim() }),
        auto_start: false,
      })
      toast.success('Channel 实例已创建')
      setShowCreateForm(false)
      setCreateName('')
      setCreatePlatform('')
      setCreateStateDir('')
      loadInstances()
    } catch (err) {
      toast.error(`创建失败: ${err instanceof Error ? err.message : '未知错误'}`)
    } finally {
      setCreating(false)
    }
  }

  const getConfigFields = (instance: ChannelInstance): ConfigField[] => {
    if (instance.platform === 'feishu') return FEISHU_CONFIG_FIELDS
    return []
  }

  if (loading) return <MainLayout><Loading /></MainLayout>

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
            <Button variant="secondary" onClick={() => navigate('/channels/pty')}>
              安装向导
            </Button>
            <Button variant="primary" onClick={() => setShowCreateForm((v) => !v)}>
              {showCreateForm ? '收起' : '+ 新建实例'}
            </Button>
          </div>
        </div>

        {error && <div className="error-message">{error}</div>}

        {/* Create Form */}
        {showCreateForm && (
          <div className="channel-create-panel">
            <h2 style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-muted)', letterSpacing: '0.1em', textTransform: 'uppercase', fontFamily: 'var(--font-mono)', marginBottom: '1.125rem' }}>
              新建 Channel 实例
            </h2>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">实现（Implementation）</label>
                <select className="select" value={createImplId} onChange={(e) => setCreateImplId(e.target.value)}>
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
                  placeholder={scanningPlatform ? '识别中...' : '如：feishu、slack、telegram'}
                />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">
                  插件目录（state_dir）
                  <span style={{ marginLeft: '0.375rem', fontSize: '0.7rem', color: 'var(--text-muted)', fontWeight: 400 }}>channel-host 必填</span>
                </label>
                <input
                  className="input"
                  type="text"
                  value={createStateDir}
                  onChange={(e) => setCreateStateDir(e.target.value)}
                  onBlur={handleStateDirBlur}
                  placeholder="/path/to/openclaw/state"
                />
              </div>
            </div>
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
            </div>
          ) : (
            instances.map((instance) => {
              const statusInfo = getStatusInfo(instance.runtime_status)
              const isSelected = selectedInstanceId === instance.id
              const isRunning = instance.runtime_status === 'running'
              const configFields = getConfigFields(instance)

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
                      ) : editingConfig ? (
                        <>
                          {configFields.length > 0 ? (
                            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem 1.5rem' }}>
                              {configFields.map((field) => {
                                const value = getNestedValue(editingConfig, field.key)
                                const isFullWidth = field.type === 'boolean'
                                return (
                                  <div key={field.key} style={isFullWidth ? { gridColumn: '1 / -1' } : {}}>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
                                      <label style={{ fontSize: '0.8125rem', fontWeight: 500, color: 'var(--text-secondary)' }}>
                                        {field.label}
                                      </label>
                                      {field.hot_reload && (
                                        <span className="config-field-badge config-field-badge--hot">🔥 热生效</span>
                                      )}
                                      {field.requires_restart && (
                                        <span className="config-field-badge config-field-badge--restart">⚠ 需重启</span>
                                      )}
                                    </div>
                                    {field.description && (
                                      <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '0.5rem', lineHeight: 1.4 }}>
                                        {field.description}
                                      </p>
                                    )}
                                    {field.type === 'boolean' ? (
                                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.625rem' }}>
                                        <label className="toggle-switch">
                                          <input
                                            type="checkbox"
                                            checked={!!value}
                                            onChange={(e) => handleFieldChange(field.key, e.target.checked)}
                                          />
                                          <span className="toggle-track" />
                                        </label>
                                        <span style={{ fontSize: '0.8125rem', color: value ? 'var(--success)' : 'var(--text-muted)' }}>
                                          {value ? '已启用' : '已禁用'}
                                        </span>
                                      </div>
                                    ) : (
                                      <input
                                        className="input"
                                        type={field.type === 'password' ? 'password' : 'text'}
                                        value={value ?? ''}
                                        onChange={(e) => handleFieldChange(field.key, e.target.value)}
                                        placeholder={field.type === 'password' ? '••••••••' : ''}
                                      />
                                    )}
                                  </div>
                                )
                              })}
                            </div>
                          ) : (
                            <p style={{ fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                              该平台暂无可配置字段
                            </p>
                          )}
                          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.625rem', marginTop: '1.25rem', paddingTop: '1rem', borderTop: '1px solid var(--border)' }}>
                            <Button variant="secondary" onClick={() => setEditingConfig(config)}>重置</Button>
                            <Button variant="primary" onClick={handleSave} disabled={saving}>
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
