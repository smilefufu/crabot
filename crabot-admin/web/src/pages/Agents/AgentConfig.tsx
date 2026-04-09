import React, { useState, useEffect } from 'react'
import { agentService } from '../../services/agent'
import { providerService } from '../../services/provider'
import { mcpService } from '../../services/mcp'
import { skillService } from '../../services/skill'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Select } from '../../components/Common/Select'
import { Loading } from '../../components/Common/Loading'
import type {
  ModelProvider,
  LLMRoleRequirement,
  ModelSlotRef,
  MCPServerRegistryEntry,
  SkillRegistryEntry,
  ExtraConfigSchema,
} from '../../types'
import { useToast } from '../../contexts/ToastContext'

interface AgentUnifiedConfig {
  system_prompt: string
  model_roles: Record<string, ModelSlotRef>
  mcp_server_ids: string[]
  skill_ids: string[]
  extra: Record<string, unknown>
}

export const AgentConfig: React.FC = () => {
  const toast = useToast()
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [llmRequirements, setLlmRequirements] = useState<LLMRoleRequirement[]>([])
  const [extraSchema, setExtraSchema] = useState<ExtraConfigSchema[]>([])
  const [allMCPServers, setAllMCPServers] = useState<MCPServerRegistryEntry[]>([])
  const [allSkills, setAllSkills] = useState<SkillRegistryEntry[]>([])
  const [config, setConfig] = useState<AgentUnifiedConfig>({
    system_prompt: '',
    model_roles: {},
    mcp_server_ids: [],
    skill_ids: [],
    extra: {},
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    loadData()
  }, [])

  const loadData = async () => {
    try {
      setLoading(true)
      const [providersData, requirements, mcpServers, skills] = await Promise.all([
        providerService.listProviders(),
        agentService.getLLMRequirements(),
        mcpService.list(),
        skillService.list(),
      ])

      setProviders(providersData.items)
      setLlmRequirements(requirements.requirements)
      setExtraSchema(requirements.extra_schema || [])
      setAllMCPServers(mcpServers.filter(s => s.enabled))
      setAllSkills(skills.filter(s => s.enabled))

      try {
        const existingConfig = await agentService.getConfig()
        setConfig({
          system_prompt: existingConfig.system_prompt || '',
          model_roles: existingConfig.model_config || {},
          mcp_server_ids: existingConfig.mcp_server_ids || [],
          skill_ids: existingConfig.skill_ids || [],
          extra: existingConfig.extra || {},
        })
      } catch {
        // Agent config not available yet, use defaults
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    try {
      setSaving(true)
      await agentService.updateConfig({
        system_prompt: config.system_prompt,
        model_config: config.model_roles,
        mcp_server_ids: config.mcp_server_ids,
        skill_ids: config.skill_ids,
        extra: Object.keys(config.extra).length > 0 ? config.extra : undefined,
      })
      toast.success('Agent 配置保存成功')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const handleProviderChange = (roleKey: string, providerId: string) => {
    const provider = providers.find((p) => p.id === providerId)
    if (provider) {
      const llmModels = provider.models.filter((m) => m.type === 'llm')
      const firstModel = llmModels.length > 0 ? llmModels[0] : provider.models[0]
      if (firstModel) {
        setConfig((prev) => ({
          ...prev,
          model_roles: {
            ...prev.model_roles,
            [roleKey]: {
              provider_id: providerId,
              model_id: firstModel.model_id,
            },
          },
        }))
      }
    }
  }

  const handleModelChange = (roleKey: string, modelId: string) => {
    setConfig((prev) => ({
      ...prev,
      model_roles: {
        ...prev.model_roles,
        [roleKey]: { ...prev.model_roles[roleKey], model_id: modelId },
      },
    }))
  }

  const toggleMCPServer = (id: string) => {
    setConfig(prev => ({
      ...prev,
      mcp_server_ids: prev.mcp_server_ids.includes(id)
        ? prev.mcp_server_ids.filter(x => x !== id)
        : [...prev.mcp_server_ids, id],
    }))
  }

  const toggleSkill = (id: string) => {
    setConfig(prev => ({
      ...prev,
      skill_ids: prev.skill_ids.includes(id)
        ? prev.skill_ids.filter(x => x !== id)
        : [...prev.skill_ids, id],
    }))
  }

  const getSelectedProvider = (roleKey: string): ModelProvider | undefined => {
    const roleConfig = config.model_roles[roleKey]
    if (!roleConfig) return undefined
    return providers.find((p) => p.id === roleConfig.provider_id)
  }

  const configurableRoles = llmRequirements

  const llmProviders = providers.filter((p) => p.models.some((m) => m.type === 'llm'))

  if (loading) return <MainLayout><Loading /></MainLayout>

  return (
    <MainLayout>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
        <div>
          <h1 style={{ fontSize: '1.5rem', fontWeight: 700, letterSpacing: '-0.01em' }}>Agent 配置</h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem', marginTop: '0.25rem' }}>
            模型、工具与系统行为
          </p>
        </div>
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中...' : '保存配置'}
        </Button>
      </div>

      {error && <div className="error-message">{error}</div>}

      {/* System Prompt */}
      <Card>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '0.625rem' }}>
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 600 }}>AI 性格提示词</h3>
          <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>工作流程指令已内置</span>
        </div>
        <textarea
          className="textarea"
          value={config.system_prompt}
          onChange={(e) => setConfig((prev) => ({ ...prev, system_prompt: e.target.value }))}
          rows={4}
          style={{ minHeight: '80px' }}
          placeholder="例如：你是一个专业友善的客服助手，帮助用户解决售后问题。回答时请保持简洁、耐心..."
        />
      </Card>

      {/* Model Roles */}
      <div style={{ marginTop: '1rem' }}>
        <Card>
          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
            <h3 style={{ fontSize: '0.9375rem', fontWeight: 600 }}>模型角色</h3>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>未配置则使用全局默认</span>
          </div>
          {configurableRoles.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>暂无可配置的模型角色</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.625rem' }}>
              {configurableRoles.map((role) => {
                const selectedProvider = getSelectedProvider(role.key)
                const llmModels = selectedProvider?.models.filter((m) => m.type === 'llm') || []
                return (
                  <div key={role.key} style={{
                    padding: '0.75rem',
                    background: 'var(--bg-secondary)',
                    borderRadius: '8px',
                    border: '1px solid var(--border)',
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.375rem' }}>
                      <span style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)' }}>{role.key}</span>
                      {role.required && <span style={{ color: 'var(--error)', fontSize: '0.75rem' }}>*</span>}
                      {!role.required && <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)', background: 'var(--surface-hover)', padding: '0.0625rem 0.375rem', borderRadius: '3px' }}>可选</span>}
                      {role.recommended_capabilities && role.recommended_capabilities.length > 0 && (
                        <span style={{ fontSize: '0.6875rem', color: 'var(--primary)', background: 'var(--primary-subtle)', padding: '0.0625rem 0.375rem', borderRadius: '3px' }}>
                          {role.recommended_capabilities.join(' / ')}
                        </span>
                      )}
                    </div>
                    {role.description && (
                      <p style={{ color: 'var(--text-secondary)', fontSize: '0.75rem', marginBottom: '0.5rem', lineHeight: 1.4 }}>{role.description}</p>
                    )}
                    <div style={{ display: 'grid', gridTemplateColumns: llmModels.length > 0 ? '1fr 1fr' : '1fr', gap: '0.5rem' }}>
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <select
                          className="select"
                          value={config.model_roles[role.key]?.provider_id || ''}
                          onChange={(e) => {
                            if (e.target.value) {
                              handleProviderChange(role.key, e.target.value)
                            } else {
                              setConfig((prev) => {
                                const newRoles = { ...prev.model_roles }
                                delete newRoles[role.key]
                                return { ...prev, model_roles: newRoles }
                              })
                            }
                          }}
                        >
                          <option value="">默认</option>
                          {llmProviders.map((p) => (
                            <option key={p.id} value={p.id}>{p.name} [{p.format}]</option>
                          ))}
                        </select>
                      </div>
                      {llmModels.length > 0 && (
                        <div className="form-group" style={{ marginBottom: 0 }}>
                          <select
                            className="select"
                            value={config.model_roles[role.key]?.model_id || ''}
                            onChange={(e) => handleModelChange(role.key, e.target.value)}
                          >
                            {llmModels.map((m) => (
                              <option key={m.model_id} value={m.model_id}>
                                {m.display_name}{m.supports_vision ? ' (Vision)' : ''}
                              </option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </div>

      {/* MCP Servers + Skills — side by side */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
        <Card>
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.5rem' }}>MCP Servers</h3>
          {allMCPServers.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>暂无可用的 MCP Server</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.125rem' }}>
              {allMCPServers.map(s => {
                const checked = config.mcp_server_ids.includes(s.id)
                return (
                  <label key={s.id} style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    cursor: s.can_disable ? 'pointer' : 'default',
                    padding: '0.375rem 0.5rem', borderRadius: '5px',
                    background: checked ? 'var(--primary-subtle)' : 'transparent',
                    transition: 'background 0.15s',
                  }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleMCPServer(s.id)}
                      disabled={!s.can_disable && s.is_essential}
                    />
                    <span style={{ fontSize: '0.8125rem', fontWeight: 500 }}>{s.name}</span>
                    {s.is_builtin && <span style={{ fontSize: '0.6875rem', color: '#8b5cf6', opacity: 0.8 }}>[内置]</span>}
                    {s.description && <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.description}</span>}
                  </label>
                )
              })}
            </div>
          )}
        </Card>

        <Card>
          <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.5rem' }}>Skills</h3>
          {allSkills.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>暂无可用的 Skill</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.125rem' }}>
              {allSkills.map(s => {
                const checked = config.skill_ids.includes(s.id)
                return (
                  <label key={s.id} style={{
                    display: 'flex', alignItems: 'center', gap: '0.5rem',
                    cursor: 'pointer',
                    padding: '0.375rem 0.5rem', borderRadius: '5px',
                    background: checked ? 'var(--primary-subtle)' : 'transparent',
                    transition: 'background 0.15s',
                  }}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSkill(s.id)}
                    />
                    <span style={{ fontSize: '0.8125rem', fontWeight: 500 }}>{s.name}</span>
                    <span style={{ fontSize: '0.6875rem', color: 'var(--text-muted)' }}>v{s.version}</span>
                    {s.is_builtin && <span style={{ fontSize: '0.6875rem', color: '#8b5cf6', opacity: 0.8 }}>[内置]</span>}
                  </label>
                )
              })}
            </div>
          )}
        </Card>
      </div>

      {/* Extra Config */}
      {extraSchema.length > 0 && (
        <div style={{ marginTop: '1rem' }}>
          <Card>
            <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.625rem' }}>扩展配置</h3>
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              {extraSchema.map((schema) => {
                const currentValue = config.extra[schema.key]
                const displayValue = currentValue ?? schema.default ?? ''
                return (
                  <div key={schema.key}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.25rem' }}>
                      <label style={{ fontWeight: 500, fontSize: '0.8125rem' }}>{schema.title}</label>
                      {schema.default !== undefined && (
                        <span style={{ color: 'var(--text-muted)', fontSize: '0.6875rem' }}>
                          默认: {String(schema.default)}
                        </span>
                      )}
                    </div>
                    {schema.description && (
                      <p style={{ color: 'var(--text-secondary)', fontSize: '0.6875rem', marginBottom: '0.375rem' }}>{schema.description}</p>
                    )}
                    {schema.type === 'boolean' ? (
                      <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={displayValue === true || displayValue === 'true'}
                          onChange={(e) => setConfig((prev) => ({
                            ...prev,
                            extra: { ...prev.extra, [schema.key]: e.target.checked },
                          }))}
                        />
                        <span style={{ fontSize: '0.8125rem' }}>{displayValue ? '启用' : '禁用'}</span>
                      </label>
                    ) : schema.type === 'select' && schema.options ? (
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <select
                          className="select"
                          value={String(displayValue)}
                          onChange={(e) => setConfig((prev) => ({
                            ...prev,
                            extra: { ...prev.extra, [schema.key]: e.target.value },
                          }))}
                        >
                          {schema.options.map((o) => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </div>
                    ) : (
                      <input
                        className="input"
                        type={schema.type === 'number' ? 'number' : 'text'}
                        value={String(displayValue)}
                        onChange={(e) => {
                          const raw = e.target.value
                          const parsed = schema.type === 'number' ? (raw === '' ? '' : Number(raw)) : raw
                          setConfig((prev) => ({
                            ...prev,
                            extra: { ...prev.extra, [schema.key]: parsed },
                          }))
                        }}
                      />
                    )}
                  </div>
                )
              })}
            </div>
          </Card>
        </div>
      )}
    </MainLayout>
  )
}
