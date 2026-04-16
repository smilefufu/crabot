import React, { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { agentService } from '../../services/agent'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import type { AgentImplementation } from '../../types'

export const ModuleDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [implementation, setImplementation] = useState<AgentImplementation | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!id) return
    loadImplementation()
  }, [id])

  const loadImplementation = async () => {
    if (!id) return

    try {
      setLoading(true)
      const response = await agentService.listImplementations()
      const impl = response.items.find((item) => item.id === id)
      if (impl) {
        setImplementation(impl)
      } else {
        setError('模块不存在')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  if (loading) return <MainLayout><Loading /></MainLayout>
  if (!implementation) return <MainLayout><div className="error-message">{error || '模块不存在'}</div></MainLayout>

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>{implementation.name}</h1>
          <span className="badge badge-primary">
            {implementation.type === 'builtin' ? '内置' : '已安装'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Button variant="secondary" onClick={() => navigate('/modules')}>返回</Button>
          {implementation.type !== 'builtin' && (
            <Button variant="danger" disabled>删除</Button>
          )}
        </div>
      </div>

      {error && <div className="error-message">{error}</div>}

      <div style={{ display: 'grid', gap: '1.5rem' }}>
        <Card title="基本信息">
          <table className="table">
            <tbody>
              <tr><td style={{ width: '150px', color: 'var(--text-secondary)' }}>ID</td><td>{implementation.id}</td></tr>
              <tr><td style={{ color: 'var(--text-secondary)' }}>名称</td><td>{implementation.name}</td></tr>
              <tr><td style={{ color: 'var(--text-secondary)' }}>类型</td><td>{implementation.type === 'builtin' ? '内置' : '已安装'}</td></tr>
              <tr><td style={{ color: 'var(--text-secondary)' }}>实现类型</td><td>{implementation.implementation_type}</td></tr>
              <tr><td style={{ color: 'var(--text-secondary)' }}>引擎</td><td>{implementation.engine}</td></tr>
              <tr><td style={{ color: 'var(--text-secondary)' }}>模型格式</td><td>{implementation.model_format}</td></tr>
              {implementation.version && <tr><td style={{ color: 'var(--text-secondary)' }}>版本</td><td>{implementation.version}</td></tr>}
            </tbody>
          </table>
        </Card>

        <Card title="模型角色定义">
          <table className="table">
            <thead>
              <tr>
                <th>角色键</th>
                <th>描述</th>
                <th>必需</th>
                <th>推荐能力</th>
              </tr>
            </thead>
            <tbody>
              {implementation.model_roles.map((role) => (
                <tr key={role.key}>
                  <td><code>{role.key}</code></td>
                  <td>{role.description}</td>
                  <td>{role.required ? '是' : '否'}</td>
                  <td>{role.recommended_capabilities?.join(', ') || '-'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        {implementation.source && (
          <Card title="来源信息">
            <table className="table">
              <tbody>
                <tr><td style={{ width: '150px', color: 'var(--text-secondary)' }}>类型</td><td>{implementation.source.type}</td></tr>
                <tr><td style={{ color: 'var(--text-secondary)' }}>路径</td><td>{implementation.source.path}</td></tr>
                {implementation.source.ref && <tr><td style={{ color: 'var(--text-secondary)' }}>引用</td><td>{implementation.source.ref}</td></tr>}
                {implementation.installed_path && <tr><td style={{ color: 'var(--text-secondary)' }}>安装路径</td><td>{implementation.installed_path}</td></tr>}
              </tbody>
            </table>
          </Card>
        )}

        <Card title="时间信息">
          <table className="table">
            <tbody>
              <tr><td style={{ width: '150px', color: 'var(--text-secondary)' }}>创建时间</td><td>{new Date(implementation.created_at).toLocaleString()}</td></tr>
              <tr><td style={{ color: 'var(--text-secondary)' }}>更新时间</td><td>{new Date(implementation.updated_at).toLocaleString()}</td></tr>
              {implementation.installed_at && <tr><td style={{ color: 'var(--text-secondary)' }}>安装时间</td><td>{new Date(implementation.installed_at).toLocaleString()}</td></tr>}
            </tbody>
          </table>
        </Card>
      </div>
    </MainLayout>
  )
}
