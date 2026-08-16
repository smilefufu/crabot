import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { legacyArchiveService, type LegacyAgentArchiveSummary } from '../../services/legacy-archive'
import { channelService } from '../../services/channel'
import { api } from '../../services/api'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import type { ChannelImplementation } from '../../types'

interface RunningModule {
  module_id: string
  module_type: string
  status: string
  pid?: number
  port: number
  last_health_status?: string
}

type ModuleType = 'agent' | 'memory' | 'channel'
type ModuleFilter = 'all' | ModuleType

interface ModuleItem {
  id: string
  name: string
  module_type: ModuleType
  install_type: 'builtin' | 'installed'
  version: string
  detail: AgentDetail | MemoryDetail | ChannelDetail
}

interface AgentDetail {
  type: 'agent'
  engine: string
  supported_roles: string[]
  model_format: string
}

interface MemoryDetail {
  type: 'memory'
  runtime: string
}

interface ChannelDetail {
  type: 'channel'
  platform: string
  module_path?: string
}

/** P6-D：唯一 live agent 是静态 core；legacy 记录以 unsupported archive 摘要呈现。 */
const CORE_AGENT_ITEM: ModuleItem = {
  id: 'crabot-agent',
  name: 'Crabot Core Agent',
  module_type: 'agent',
  install_type: 'builtin',
  version: '-',
  detail: { type: 'agent', engine: 'claude-agent-sdk', supported_roles: ['front', 'worker'], model_format: 'anthropic' },
}

function toModuleItemFromArchive(record: LegacyAgentArchiveSummary): ModuleItem {
  return {
    id: `legacy:${record.archive_id}`,
    name: `[不受支持的 legacy] ${record.display_name ?? record.archive_id}`,
    module_type: 'agent',
    install_type: 'installed',
    version: record.version ?? '-',
    detail: { type: 'agent', engine: 'legacy', supported_roles: [], model_format: '-' },
  }
}

function toModuleItemFromChannel(impl: ChannelImplementation): ModuleItem {
  return {
    id: impl.id,
    name: impl.name,
    module_type: 'channel',
    install_type: impl.type,
    version: impl.version,
    detail: {
      type: 'channel',
      platform: impl.platform,
      module_path: impl.module_path,
    },
  }
}

const BUILTIN_MEMORY: ModuleItem = {
  id: 'memory-default',
  name: 'Crabot Memory',
  module_type: 'memory',
  install_type: 'builtin',
  version: '0.1.0',
  detail: {
    type: 'memory',
    runtime: 'python (uv)',
  },
}

const TYPE_LABELS: Record<ModuleType, string> = {
  agent: 'Agent',
  memory: 'Memory',
  channel: 'Channel',
}

const TYPE_COLORS: Record<ModuleType, string> = {
  agent: 'var(--color-primary, #6366f1)',
  memory: 'var(--color-success, #22c55e)',
  channel: 'var(--color-warning, #f59e0b)',
}

function getNavigationTarget(item: ModuleItem): string {
  // P6-D：legacy archive 行进入 archive 详情页（导出/显式卸载 UI 的唯一入口）。
  if (item.id.startsWith('legacy:')) return `/modules/${item.id}`
  switch (item.module_type) {
    case 'agent':
      return '/agents/config'
    case 'memory':
      return '/memory'
    case 'channel':
      return '/channels/config'
  }
}

function renderDetail(item: ModuleItem): React.ReactNode {
  const detail = item.detail
  switch (detail.type) {
    case 'agent':
      return (
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
          <p>引擎: {detail.engine}</p>
          <p>支持角色: {detail.supported_roles.join(', ')}</p>
          <p>模型格式: {detail.model_format}</p>
        </div>
      )
    case 'memory':
      return (
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
          <p>运行时: {detail.runtime}</p>
        </div>
      )
    case 'channel':
      return (
        <div style={{ color: 'var(--text-secondary)', fontSize: '0.9rem' }}>
          <p>平台: {detail.platform}</p>
          {detail.module_path && <p>模块路径: {detail.module_path}</p>}
        </div>
      )
  }
}

export const ModuleList: React.FC = () => {
  const navigate = useNavigate()
  const [modules, setModules] = useState<ModuleItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [filter, setFilter] = useState<ModuleFilter>('all')

  // 运行中模块状态
  const [runningModules, setRunningModules] = useState<RunningModule[]>([])
  const [runningLoading, setRunningLoading] = useState(false)
  const [logModal, setLogModal] = useState<{ id: string; content: string } | null>(null)

  const loadRunningModules = useCallback(async () => {
    setRunningLoading(true)
    try {
      const result = await api.listModules()
      setRunningModules(result.modules)
    } catch {
      // 静默失败，不影响主列表
    } finally {
      setRunningLoading(false)
    }
  }, [])

  useEffect(() => {
    loadRunningModules()
    const timer = setInterval(loadRunningModules, 5000)
    return () => clearInterval(timer)
  }, [loadRunningModules])

  const onViewLog = async (moduleId: string) => {
    try {
      const result = await api.getModuleLog(moduleId, 500)
      setLogModal({ id: moduleId, content: result.content })
    } catch (err) {
      setLogModal({ id: moduleId, content: `加载日志失败: ${err instanceof Error ? err.message : String(err)}` })
    }
  }

  const onRestart = async (moduleId: string) => {
    if (!confirm(`确定重启模块 ${moduleId}？`)) return
    try {
      await api.restartModule(moduleId)
      setTimeout(loadRunningModules, 2000)
    } catch (err) {
      alert(`重启失败: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  useEffect(() => {
    loadAllModules()
  }, [])

  const loadAllModules = async () => {
    try {
      setLoading(true)
      setError('')

      const [archiveItems, channelResponse] = await Promise.all([
        legacyArchiveService.list().catch(() => [] as LegacyAgentArchiveSummary[]),
        channelService.listImplementations().catch(() => ({ items: [] as ChannelImplementation[] })),
      ])

      const allModules: ModuleItem[] = [
        CORE_AGENT_ITEM,
        ...archiveItems.map(toModuleItemFromArchive),
        BUILTIN_MEMORY,
        ...channelResponse.items.map(toModuleItemFromChannel),
      ]

      setModules(allModules)
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  const filteredModules = filter === 'all'
    ? modules
    : modules.filter((m) => m.module_type === filter)

  const countByType = (type: ModuleType) =>
    modules.filter((m) => m.module_type === type).length

  if (loading) return <MainLayout><Loading /></MainLayout>

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700, marginBottom: '1rem' }}>模块管理</h1>
        <p style={{ color: 'var(--text-secondary)' }}>
          管理所有已安装的 Agent、Memory 和 Channel 实现
        </p>
      </div>

      {/* 运行状态面板 */}
      <div style={{ marginBottom: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600 }}>运行状态</h2>
          <Button variant="secondary" onClick={loadRunningModules} disabled={runningLoading}>
            {runningLoading ? '刷新中...' : '刷新'}
          </Button>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="table" style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th>模块 ID</th>
                <th>类型</th>
                <th>状态</th>
                <th>PID</th>
                <th>端口</th>
                <th>健康</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {runningModules.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '1rem' }}>
                    {runningLoading ? '加载中...' : '暂无模块数据'}
                  </td>
                </tr>
              ) : (
                runningModules.map((m) => (
                  <tr key={m.module_id}>
                    <td><code style={{ fontSize: '0.85rem' }}>{m.module_id}</code></td>
                    <td>{m.module_type}</td>
                    <td>
                      <span style={{
                        color: m.status === 'running' ? 'var(--color-success, #22c55e)'
                          : m.status === 'error' ? 'var(--color-danger, #ef4444)'
                          : 'var(--text-secondary)',
                        fontWeight: 500,
                      }}>
                        {m.status}
                      </span>
                    </td>
                    <td>{m.pid ?? '-'}</td>
                    <td>{m.port}</td>
                    <td>{m.last_health_status ?? '-'}</td>
                    <td>
                      <div style={{ display: 'flex', gap: '0.5rem' }}>
                        <Button variant="secondary" onClick={() => onViewLog(m.module_id)}>查看日志</Button>
                        <Button variant="secondary" onClick={() => onRestart(m.module_id)}>重启</Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* 日志弹窗 */}
      {logModal && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={(e) => { if (e.target === e.currentTarget) setLogModal(null) }}
        >
          <div style={{ background: 'var(--bg-primary, #fff)', borderRadius: '8px', padding: '1.5rem', width: '80vw', maxWidth: '900px', maxHeight: '80vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.3)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ fontWeight: 600, fontSize: '1.1rem' }}>日志：{logModal.id}</h3>
              <Button variant="secondary" onClick={() => setLogModal(null)}>关闭</Button>
            </div>
            <pre style={{ flex: 1, overflow: 'auto', background: '#1a1a2e', color: '#e0e0e0', padding: '1rem', borderRadius: '4px', fontSize: '0.8rem', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {logModal.content || '（日志为空）'}
            </pre>
          </div>
        </div>
      )}

      {/* 已安装模块列表 */}
      <div style={{ marginBottom: '1rem' }}>
        <h2 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '0.75rem' }}>已安装模块</h2>
      </div>

      <div style={{ marginBottom: '1.5rem', display: 'flex', gap: '0.5rem' }}>
        <Button
          variant={filter === 'all' ? 'primary' : 'secondary'}
          onClick={() => setFilter('all')}
        >
          全部 ({modules.length})
        </Button>
        <Button
          variant={filter === 'agent' ? 'primary' : 'secondary'}
          onClick={() => setFilter('agent')}
        >
          Agent ({countByType('agent')})
        </Button>
        <Button
          variant={filter === 'memory' ? 'primary' : 'secondary'}
          onClick={() => setFilter('memory')}
        >
          Memory ({countByType('memory')})
        </Button>
        <Button
          variant={filter === 'channel' ? 'primary' : 'secondary'}
          onClick={() => setFilter('channel')}
        >
          Channel ({countByType('channel')})
        </Button>
      </div>

      {error && <div className="error-message">{error}</div>}

      {filteredModules.length === 0 ? (
        <Card>
          <p style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>
            暂无模块
          </p>
        </Card>
      ) : (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {filteredModules.map((item) => (
            <Card key={`${item.module_type}-${item.id}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.5rem' }}>
                    <h3 style={{ fontSize: '1.25rem', fontWeight: 600 }}>{item.name}</h3>
                    <span
                      className="badge"
                      style={{
                        backgroundColor: TYPE_COLORS[item.module_type],
                        color: 'var(--text-on-primary)',
                        padding: '2px 8px',
                        borderRadius: '4px',
                        fontSize: '0.75rem',
                        fontWeight: 500,
                      }}
                    >
                      {TYPE_LABELS[item.module_type]}
                    </span>
                    <span className="badge badge-primary">
                      {item.id.startsWith('legacy:') ? '不受支持' : (item.install_type === 'builtin' ? '内置' : '已安装')}
                    </span>
                    {item.version !== '-' && (
                      <span style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
                        v{item.version}
                      </span>
                    )}
                  </div>
                  {renderDetail(item)}
                </div>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <Button
                    variant="secondary"
                    onClick={() => navigate(getNavigationTarget(item))}
                  >
                    管理实例
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
    </MainLayout>
  )
}
