import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { agentService } from '../../services/agent'
import { channelService } from '../../services/channel'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import type { AgentImplementation, ChannelImplementation } from '../../types'

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

function toModuleItemFromAgent(impl: AgentImplementation): ModuleItem {
  return {
    id: impl.id,
    name: impl.name,
    module_type: 'agent',
    install_type: impl.type,
    version: impl.version ?? '-',
    detail: {
      type: 'agent',
      engine: impl.engine,
      supported_roles: impl.supported_roles,
      model_format: impl.model_format,
    },
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
          <p>平台: {detail.platform === '*' ? '通用 (OpenClaw Host)' : detail.platform}</p>
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

  useEffect(() => {
    loadAllModules()
  }, [])

  const loadAllModules = async () => {
    try {
      setLoading(true)
      setError('')

      const [agentResponse, channelResponse] = await Promise.all([
        agentService.listImplementations().catch(() => ({ items: [] })),
        channelService.listImplementations().catch(() => ({ items: [] })),
      ])

      const allModules: ModuleItem[] = [
        ...agentResponse.items.map(toModuleItemFromAgent),
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
                        color: '#fff',
                        padding: '2px 8px',
                        borderRadius: '4px',
                        fontSize: '0.75rem',
                        fontWeight: 500,
                      }}
                    >
                      {TYPE_LABELS[item.module_type]}
                    </span>
                    <span className="badge badge-primary">
                      {item.install_type === 'builtin' ? '内置' : '已安装'}
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
