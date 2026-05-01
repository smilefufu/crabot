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
import type { GlobalModelConfig, ModelProvider, ProviderStatus } from '../../types'

type DrawerMode = 'closed' | 'detail' | 'edit' | 'create'

/** 引导阶段：当前用户处于哪一步 */
type OnboardingStage = 'no_provider' | 'no_global' | 'ready'

const STEPS: ReadonlyArray<{ id: OnboardingStage; label: string; sub: string }> = [
  { id: 'no_provider', label: '接入供应商', sub: '配置 OpenAI / Anthropic / 自托管端点' },
  { id: 'no_global',   label: '设默认模型', sub: '指定全局默认 LLM，未单独配置的模块都会用它' },
  { id: 'ready',       label: '可投入使用',  sub: 'Agent / Memory / 其他模块按需调用' },
]

export const ProviderManagement: React.FC = () => {
  const toast = useToast()

  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [globalConfig, setGlobalConfig] = useState<GlobalModelConfig>({})
  const [loading, setLoading] = useState(true)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | ProviderStatus>('all')
  const [globalExpanded, setGlobalExpanded] = useState(false)

  const [drawerMode, setDrawerMode] = useState<DrawerMode>('closed')
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<ModelProvider | null>(null)
  const [deleteWarning, setDeleteWarning] = useState<{ title: string; items: string[]; note: string } | null>(null)
  const [deleting, setDeleting] = useState(false)

  const [providerTestResults, setProviderTestResults] = useState<
    Record<string, { status: 'pending' | 'success' | 'error'; latency_ms?: number; error?: string }>
  >({})

  const refreshGlobalConfig = useCallback(async () => {
    try {
      const cfg = await providerService.getGlobalConfig()
      setGlobalConfig(cfg)
    } catch {
      // 静默失败：进入页面时即使 global config 拉不到，也不阻塞 provider 列表展示
    }
  }, [])

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
    refreshGlobalConfig()
  }, [loadProviders, refreshGlobalConfig])

  const selectedProvider = providers.find(p => p.id === selectedProviderId) || null

  const filtered = providers.filter(p => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false
    if (searchQuery && !p.name.toLowerCase().includes(searchQuery.toLowerCase())) return false
    return true
  })

  const stage: OnboardingStage =
    providers.length === 0
      ? 'no_provider'
      : !globalConfig.default_llm_provider_id || !globalConfig.default_llm_model_id
        ? 'no_global'
        : 'ready'

  const stageIndex = STEPS.findIndex(s => s.id === stage)

  // 选择全局默认 LLM 时，下拉的 provider 仍然存在（避免悬空引用）
  const selectedGlobalProvider = providers.find(p => p.id === globalConfig.default_llm_provider_id)

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
    const deletedId = deleteTarget.id
    const wasGlobalDefault = deletedId === globalConfig.default_llm_provider_id
    try {
      setDeleting(true)
      await providerService.deleteProvider(deletedId)
      toast.success('已删除')
      if (selectedProviderId === deletedId) {
        setDrawerMode('closed')
        setSelectedProviderId(null)
      }
      // 测试结果按 id 索引，被删 provider 的条目永远查不到了，顺手清掉
      setProviderTestResults(prev => {
        const { [deletedId]: _removed, ...rest } = prev
        return rest
      })
      await loadProviders()
      // 全局默认指向自身已被删，引用悬空，需要重拉看 admin 是否清掉了
      if (wasGlobalDefault) await refreshGlobalConfig()
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

  const handleGlobalConfigChanged = async () => {
    await refreshGlobalConfig()
    setGlobalExpanded(false)
  }

  const openCreateDrawer = () => {
    setSelectedProviderId(null)
    setDrawerMode('create')
  }

  if (loading && providers.length === 0) return <MainLayout><Loading /></MainLayout>

  return (
    <MainLayout>
      <div className="provider-management">
        <div className="provider-list-area">
          <header className="provider-page-header">
            <div className="provider-page-title-row">
              <h1 className="provider-page-title">模型配置</h1>
              <span className="provider-page-eyebrow">model.providers</span>
            </div>
            <p className="provider-page-lede">
              这里集中管理所有 LLM 供应商。Agent / Memory / 其他模块本身不存 API key，
              只引用此处配置；改动会按"模块默认 → 全局默认"顺序解析。
            </p>
          </header>

          {/* 步骤导航：永远渲染，告知用户当前在第几步 */}
          <Stepper currentIndex={stageIndex} />

          {/* 阶段 A：尚无供应商 — 大幅引导，不渲染全局模型卡 */}
          {stage === 'no_provider' && (
            <NoProviderHero onCreate={openCreateDrawer} />
          )}

          {/* 阶段 B：已有供应商但未设全局默认 — 醒目招呼条 */}
          {stage === 'no_global' && (
            <ProviderCallout
              variant="attention"
              mark="[02]"
              title="下一步：选定全局默认 LLM"
              sub="未单独配置的模块（Memory / Agent 等）会自动使用全局默认。点击此条展开设置。"
              collapsedHint="+"
              expanded={globalExpanded}
              onToggle={() => setGlobalExpanded(v => !v)}
              providers={providers}
              onChanged={handleGlobalConfigChanged}
            />
          )}

          {/* 阶段 C：完成态 — 紧凑摘要，可展开编辑 */}
          {stage === 'ready' && (
            <ProviderCallout
              variant="ready"
              mark="[03]"
              title={
                <>
                  全局默认 LLM
                  <span className="provider-callout-value">
                    {selectedGlobalProvider
                      ? `${selectedGlobalProvider.name} · ${globalConfig.default_llm_model_id ?? ''}`
                      : (globalConfig.default_llm_model_id ?? '')}
                  </span>
                </>
              }
              sub="未单独配置的模块都会用此模型。点击展开可以更换。"
              collapsedHint="编辑"
              expanded={globalExpanded}
              onToggle={() => setGlobalExpanded(v => !v)}
              providers={providers}
              onChanged={handleGlobalConfigChanged}
            />
          )}

          {/* providers 列表 — 阶段 A 不显示（用户还没创建过任何 provider） */}
          {stage !== 'no_provider' && (
            <section className="provider-list-section">
              <div className="provider-list-section-header">
                <div>
                  <h2 className="provider-section-title">已接入的供应商</h2>
                  <span className="provider-section-count">{providers.length} 个</span>
                </div>
                <Button variant="primary" onClick={openCreateDrawer}>+ 添加供应商</Button>
              </div>

              <div className="provider-search-bar">
                <Input
                  placeholder="按名称搜索..."
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
              </div>

              <div className="provider-cards">
                {filtered.length === 0 ? (
                  <p className="provider-empty-search">没有匹配的供应商</p>
                ) : (
                  filtered.map(provider => {
                    const testResult = providerTestResults[provider.id]
                    const isDefault = provider.id === globalConfig.default_llm_provider_id
                    return (
                      <div
                        key={provider.id}
                        className={`provider-card ${selectedProviderId === provider.id ? 'selected' : ''}`}
                        onClick={() => handleCardClick(provider)}
                      >
                        <div className="provider-card-header">
                          <div className="provider-card-name">
                            <span>{provider.name}</span>
                            <span className="provider-card-type">{provider.type}</span>
                            <StatusBadge status={provider.status}>
                              {provider.status === 'active' ? '正常' : provider.status === 'inactive' ? '未激活' : '错误'}
                            </StatusBadge>
                            {isDefault && <span className="provider-card-default-tag">默认 LLM</span>}
                          </div>
                          <div className="provider-card-actions">
                            <span className="provider-card-models">
                              {provider.models.length} model{provider.models.length === 1 ? '' : 's'}
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
            </section>
          )}
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

// ============================================================================
// 子组件
// ============================================================================

const Stepper: React.FC<{ currentIndex: number }> = ({ currentIndex }) => {
  return (
    <ol className="provider-stepper" aria-label="配置进度">
      {STEPS.map((step, idx) => {
        const state = idx < currentIndex ? 'done' : idx === currentIndex ? 'active' : 'pending'
        return (
          <li key={step.id} className={`provider-step provider-step-${state}`}>
            <span className="provider-step-num">{`[${String(idx + 1).padStart(2, '0')}]`}</span>
            <div className="provider-step-text">
              <span className="provider-step-label">{step.label}</span>
              <span className="provider-step-sub">{step.sub}</span>
            </div>
            {idx < STEPS.length - 1 && <span className="provider-step-rail" aria-hidden />}
          </li>
        )
      })}
    </ol>
  )
}

const NoProviderHero: React.FC<{ onCreate: () => void }> = ({ onCreate }) => {
  return (
    <section className="provider-hero">
      <div className="provider-hero-mark">[01]</div>
      <h2 className="provider-hero-title">接入第一个模型供应商</h2>
      <p className="provider-hero-lede">
        Crabot 不内置任何 LLM 凭据。你需要把自己的 OpenAI / Anthropic / Gemini API key
        （或自托管端点）配进来，模块才能调用模型。
      </p>
      <ul className="provider-hero-bullets">
        <li>
          <span className="provider-hero-bullet-h">从厂商导入</span>
          <span>—— 选预置厂商 + 填 API key，自动拉模型列表，一分钟完事</span>
        </li>
        <li>
          <span className="provider-hero-bullet-h">手动配置</span>
          <span>—— 适合自托管 / Ollama / LiteLLM 等任何 OpenAI 兼容端点</span>
        </li>
      </ul>
      <div className="provider-hero-cta-row">
        <Button variant="primary" onClick={onCreate}>开始配置</Button>
        <span className="provider-hero-note">支持 OpenAI · Anthropic · Gemini · ChatGPT 订阅</span>
      </div>
    </section>
  )
}

interface ProviderCalloutProps {
  /** 视觉变体：attention=脉冲招呼、ready=完成态摘要 */
  variant: 'attention' | 'ready'
  mark: string
  title: React.ReactNode
  sub: React.ReactNode
  /** 折叠态右侧小标，展开态会被 "−" 替换 */
  collapsedHint: string
  expanded: boolean
  onToggle: () => void
  providers: ModelProvider[]
  onChanged: () => void
}

const ProviderCallout: React.FC<ProviderCalloutProps> = ({
  variant, mark, title, sub, collapsedHint, expanded, onToggle, providers, onChanged,
}) => {
  return (
    <section className={`provider-callout provider-callout-${variant} ${expanded ? 'is-expanded' : ''}`}>
      <button type="button" className="provider-callout-summary" onClick={onToggle}>
        <span className="provider-callout-mark">{mark}</span>
        <div className="provider-callout-text">
          <span className="provider-callout-title">{title}</span>
          <span className="provider-callout-sub">{sub}</span>
        </div>
        <span className="provider-callout-chevron">{expanded ? '−' : collapsedHint}</span>
      </button>
      {expanded && (
        <div className="provider-callout-body">
          <GlobalModelConfigCard providers={providers} onSaved={onChanged} embedded />
        </div>
      )}
    </section>
  )
}
