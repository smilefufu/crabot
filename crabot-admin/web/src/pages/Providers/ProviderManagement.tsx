import React, { useState, useEffect, useCallback } from 'react'
import { providerService } from '../../services/provider'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Drawer } from '../../components/Common/Drawer'
import { ConfirmModal } from '../../components/Common/ConfirmModal'
import { Button } from '../../components/Common/Button'
import { Input } from '../../components/Common/Input'
import { Select } from '../../components/Common/Select'
import { StatusBadge } from '../../components/Common/StatusBadge'
import { Loading } from '../../components/Common/Loading'
import { GlobalModelConfigCard } from './GlobalModelConfigCard'
import { ProviderDrawerDetail } from './ProviderDrawerDetail'
import { ProviderDrawerEdit } from './ProviderDrawerEdit'
import { ProviderDrawerCreate } from './ProviderDrawerCreate'
import { useToast } from '../../contexts/ToastContext'
import type { ModelProvider, ProviderStatus } from '../../types'

type DrawerMode = 'closed' | 'detail' | 'edit' | 'create'

export const ProviderManagement: React.FC = () => {
  const toast = useToast()

  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | ProviderStatus>('all')

  const [drawerMode, setDrawerMode] = useState<DrawerMode>('closed')
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<ModelProvider | null>(null)
  const [deleteWarning, setDeleteWarning] = useState<{ title: string; items: string[]; note: string } | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [providerTestResults, setProviderTestResults] = useState<
    Record<string, { status: 'pending' | 'success' | 'error'; latency_ms?: number; error?: string }>
  >({})

  const loadProviders = useCallback(async () => {
    try {
      setLoading(true)
      const response = await providerService.listProviders()
      setProviders(response.items)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => {
    loadProviders()
  }, [loadProviders])

  const selectedProvider = providers.find(p => p.id === selectedProviderId) || null

  const filtered = providers.filter(p => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false
    if (searchQuery && !p.name.toLowerCase().includes(searchQuery.toLowerCase())) return false
    return true
  })

  const handleCardClick = (provider: ModelProvider) => {
    setSelectedProviderId(provider.id)
    setDrawerMode('detail')
  }

  const handleTestProvider = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation()
    setProviderTestResults(prev => ({ ...prev, [id]: { status: 'pending' } }))
    try {
      const result = await providerService.testProvider(id)
      setProviderTestResults(prev => ({
        ...prev,
        [id]: { status: result.success ? 'success' : 'error', latency_ms: result.latency_ms, error: result.error },
      }))
      await loadProviders()
    } catch (err) {
      setProviderTestResults(prev => ({
        ...prev,
        [id]: { status: 'error', error: err instanceof Error ? err.message : '测试失败' },
      }))
    }
  }

  const handleDeleteRequest = async (provider: ModelProvider) => {
    setDeleteTarget(provider)
    try {
      const { references } = await providerService.getReferences(provider.id)
      if (references.length > 0) {
        setDeleteWarning({
          title: '此供应商正在被使用',
          items: references,
          note: '删除后，上述配置将失效并需要重新设置。',
        })
      } else {
        setDeleteWarning(null)
      }
    } catch {
      setDeleteWarning(null)
    }
  }

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return
    try {
      setDeleting(true)
      await providerService.deleteProvider(deleteTarget.id)
      toast.success('已删除')
      if (selectedProviderId === deleteTarget.id) {
        setDrawerMode('closed')
        setSelectedProviderId(null)
      }
      await loadProviders()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '删除失败')
    } finally {
      setDeleting(false)
      setDeleteTarget(null)
      setDeleteWarning(null)
    }
  }

  const handleDeleteCancel = () => {
    setDeleteTarget(null)
    setDeleteWarning(null)
  }

  const handleDrawerClose = () => {
    setDrawerMode('closed')
    setSelectedProviderId(null)
  }

  const handleEditSave = async () => {
    await loadProviders()
    setDrawerMode('detail')
  }

  const handleCreated = async (providerId: string) => {
    await loadProviders()
    setSelectedProviderId(providerId)
    setDrawerMode('detail')
  }

  if (loading && providers.length === 0) return <MainLayout><Loading /></MainLayout>

  return (
    <MainLayout>
      <div className="provider-management">
        <div className="provider-list-area">
          <h1 style={{ fontSize: '1.75rem', fontWeight: 700, marginBottom: '1.25rem' }}>模型配置</h1>

          <div id="global-model-config" style={{ marginBottom: '1.25rem' }}>
            <GlobalModelConfigCard providers={providers} />
          </div>

          <div className="provider-search-bar">
            <Input
              placeholder="搜索供应商..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            <Select
              options={[
                { value: 'all', label: '全部状态' },
                { value: 'active', label: '正常' },
                { value: 'inactive', label: '未激活' },
                { value: 'error', label: '错误' },
              ]}
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value as 'all' | ProviderStatus)}
            />
            <Button variant="primary" onClick={() => { setDrawerMode('create'); setSelectedProviderId(null) }}>
              + 创建
            </Button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            {filtered.length === 0 ? (
              <p style={{ textAlign: 'center', color: 'var(--text-secondary)', padding: '2rem 0' }}>
                {providers.length === 0 ? '暂无供应商，请创建一个' : '没有匹配的供应商'}
              </p>
            ) : (
              filtered.map(provider => {
                const testResult = providerTestResults[provider.id]
                return (
                  <div
                    key={provider.id}
                    className={`provider-card ${selectedProviderId === provider.id ? 'selected' : ''}`}
                    onClick={() => handleCardClick(provider)}
                  >
                    <div className="provider-card-header">
                      <div className="provider-card-name">
                        <span>{provider.name}</span>
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{provider.type}</span>
                        <StatusBadge status={provider.status}>
                          {provider.status === 'active' ? '正常' : provider.status === 'inactive' ? '未激活' : '错误'}
                        </StatusBadge>
                      </div>
                      <div className="provider-card-actions">
                        <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                          {provider.models.length} models
                        </span>
                        {testResult?.status === 'pending' ? (
                          <span className="provider-test-result pending">测试中...</span>
                        ) : testResult?.status === 'success' ? (
                          <span className="provider-test-result success">✓ {testResult.latency_ms}ms</span>
                        ) : testResult?.status === 'error' ? (
                          <span className="provider-test-result error">✗ {testResult.error}</span>
                        ) : (
                          <Button
                            variant="secondary"
                            style={{ padding: '0.2rem 0.6rem', fontSize: '0.75rem' }}
                            onClick={e => handleTestProvider(e, provider.id)}
                          >
                            测试
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="provider-card-meta">{provider.endpoint}</div>
                  </div>
                )
              })
            )}
          </div>
        </div>

        <Drawer open={drawerMode !== 'closed'} onClose={handleDrawerClose}>
          {drawerMode === 'detail' && selectedProvider && (
            <ProviderDrawerDetail
              key={selectedProvider.id}
              provider={selectedProvider}
              onEdit={() => setDrawerMode('edit')}
              onDelete={() => handleDeleteRequest(selectedProvider)}
              onRefresh={loadProviders}
            />
          )}
          {drawerMode === 'edit' && selectedProvider && (
            <ProviderDrawerEdit
              provider={selectedProvider}
              onSave={handleEditSave}
              onCancel={() => setDrawerMode('detail')}
            />
          )}
          {drawerMode === 'create' && (
            <ProviderDrawerCreate
              onCreated={handleCreated}
              onCancel={handleDrawerClose}
            />
          )}
        </Drawer>
      </div>

      <ConfirmModal
        open={deleteTarget !== null}
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
        title="删除供应商"
        message={`确定要删除 "${deleteTarget?.name}" 吗？此操作不可撤销。`}
        warning={deleteWarning || undefined}
        confirmText="确认删除"
        confirmVariant="danger"
        loading={deleting}
      />
    </MainLayout>
  )
}
