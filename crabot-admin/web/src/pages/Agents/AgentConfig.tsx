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
  ModelConnectionInfo,
  MCPServerRegistryEntry,
  SkillRegistryEntry,
} from '../../types'
import { useToast } from '../../contexts/ToastContext'

interface AgentUnifiedConfig {
  system_prompt: string
  model_roles: Record<string, ModelConnectionInfo>
  mcp_server_ids: string[]
  skill_ids: string[]
}

export const AgentConfig: React.FC = () => {
  const toast = useToast()
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [llmRequirements, setLlmRequirements] = useState<LLMRoleRequirement[]>([])
  const [allMCPServers, setAllMCPServers] = useState<MCPServerRegistryEntry[]>([])
  const [allSkills, setAllSkills] = useState<SkillRegistryEntry[]>([])
  const [config, setConfig] = useState<AgentUnifiedConfig>({
    system_prompt: '',
    model_roles: {},
    mcp_server_ids: [],
    skill_ids: [],
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
      setAllMCPServers(mcpServers.filter(s => s.enabled))
      setAllSkills(skills.filter(s => s.enabled))

      try {
        const existingConfig = await agentService.getConfig()
        setConfig({
          system_prompt: existingConfig.system_prompt || '',
          model_roles: existingConfig.model_config || {},
          mcp_server_ids: existingConfig.mcp_server_ids || [],
          skill_ids: existingConfig.skill_ids || [],
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
      const existingConfig = await agentService.getConfig()
      await agentService.updateConfig({
        system_prompt: config.system_prompt || existingConfig.system_prompt,
        model_config: { ...existingConfig.model_config, ...config.model_roles },
        mcp_server_ids: config.mcp_server_ids,
        skill_ids: config.skill_ids,
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
              endpoint: provider.endpoint,
              apikey: provider.api_key,
              model_id: firstModel.model_id,
              format: provider.format,
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
    if (roleConfig.provider_id) return providers.find((p) => p.id === roleConfig.provider_id)
    if (roleConfig.endpoint) return providers.find((p) => p.endpoint === roleConfig.endpoint)
    return undefined
  }

  const configurableRoles = llmRequirements.filter((role) => role.key !== 'default')

  if (loading) return <MainLayout><Loading /></MainLayout>

  return (
    <MainLayout>
      <div style={{ marginBottom: '2rem' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 700 }}>Agent 配置</h1>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
          配置 AI 助手的模型、工具和系统行为
        </p>
      </div>

      {error && <div className="error-message">{error}</div>}

      <Card title="AI 性格提示词">
        <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: '0.875rem' }}>
          定义 AI 助手的角色、语气和领域专长（可选，留空则不设定特定性格）。<br />
          <span style={{ fontSize: '0.8rem', color: 'var(--text-tertiary, #9ca3af)' }}>
            注：Front/Worker 内部的工作流程指令已内置，无需在此配置。
          </span>
        </p>
        <textarea
          className="textarea"
          value={config.system_prompt}
          onChange={(e) => setConfig((prev) => ({ ...prev, system_prompt: e.target.value }))}
          rows={6}
          placeholder="例如：你是一个专业友善的客服助手，帮助用户解决售后问题。回答时请保持简洁、耐心..."
        />
      </Card>

      <div style={{ marginTop: '1.5rem' }}>
        <Card title="模型角色">
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1.5rem', fontSize: '0.875rem' }}>
            为不同场景配置专用模型。默认模型使用全局设置，无需配置。
          </p>
          {configurableRoles.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>暂无可配置的模型角色</p>
          ) : (
            configurableRoles.map((role) => (
              <div key={role.key} style={{ marginBottom: '1.5rem', padding: '1rem', background: 'var(--bg-tertiary)', borderRadius: '8px' }}>
                <div style={{ marginBottom: '0.5rem' }}>
                  <strong style={{ fontSize: '1rem' }}>{role.key}</strong>
                  {role.required && <span style={{ color: 'var(--error)', marginLeft: '0.25rem' }}>*</span>}
                  {!role.required && <span style={{ color: 'var(--text-secondary)', marginLeft: '0.5rem', fontSize: '0.75rem' }}>(可选)</span>}
                </div>
                <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem', marginBottom: '0.75rem' }}>{role.description}</p>
                {role.recommended_capabilities && role.recommended_capabilities.length > 0 && (
                  <p style={{ color: 'var(--primary)', fontSize: '0.75rem', marginBottom: '0.75rem' }}>
                    推荐能力: {role.recommended_capabilities.join(', ')}
                  </p>
                )}
                <Select
                  label="选择模型供应商"
                  options={[
                    { value: '', label: '使用默认模型' },
                    ...providers.filter((p) => p.models.some((m) => m.type === 'llm')).map((p) => ({ value: p.id, label: p.name })),
                  ]}
                  value={config.model_roles[role.key]?.provider_id || (config.model_roles[role.key]?.endpoint ? providers.find((p) => p.endpoint === config.model_roles[role.key]?.endpoint)?.id || '' : '')}
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
                />
                {(() => {
                  const selectedProvider = getSelectedProvider(role.key)
                  if (!selectedProvider) return null
                  const llmModels = selectedProvider.models.filter((m) => m.type === 'llm')
                  if (llmModels.length === 0) return null
                  return (
                    <Select
                      label="选择模型"
                      options={llmModels.map((m) => ({ value: m.model_id, label: m.display_name }))}
                      value={config.model_roles[role.key]?.model_id || ''}
                      onChange={(e) => handleModelChange(role.key, e.target.value)}
                    />
                  )
                })()}
              </div>
            ))
          )}
        </Card>
      </div>

      {/* MCP Server 关联 */}
      <div style={{ marginTop: '1.5rem' }}>
        <Card title="MCP Servers（工具）">
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: '0.875rem' }}>
            选择要提供给 Agent 的 MCP Server。内置必要工具已自动启用，无需配置。
          </p>
          {allMCPServers.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>暂无可用的 MCP Server，请先在"MCP Servers"页面添加</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {allMCPServers.map(s => (
                <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: s.can_disable ? 'pointer' : 'default', padding: '0.5rem', borderRadius: '6px', background: config.mcp_server_ids.includes(s.id) ? 'rgba(59,130,246,0.08)' : 'transparent' }}>
                  <input
                    type="checkbox"
                    checked={config.mcp_server_ids.includes(s.id)}
                    onChange={() => toggleMCPServer(s.id)}
                    disabled={!s.can_disable && s.is_essential}
                  />
                  <div style={{ flex: 1 }}>
                    <span style={{ fontWeight: 500 }}>{s.name}</span>
                    {s.is_builtin && <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: '#8b5cf6' }}>[内置]</span>}
                    {s.description && <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{s.description}</span>}
                  </div>
                </label>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Skill 关联 */}
      <div style={{ marginTop: '1.5rem' }}>
        <Card title="Skills（技能）">
          <p style={{ color: 'var(--text-secondary)', marginBottom: '1rem', fontSize: '0.875rem' }}>
            选择要注入 Agent 系统提示词的 Skill。
          </p>
          {allSkills.length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>暂无可用的 Skill，请先在"Skills"页面添加</p>
          ) : (
            <div style={{ display: 'grid', gap: '0.5rem' }}>
              {allSkills.map(s => (
                <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer', padding: '0.5rem', borderRadius: '6px', background: config.skill_ids.includes(s.id) ? 'rgba(59,130,246,0.08)' : 'transparent' }}>
                  <input
                    type="checkbox"
                    checked={config.skill_ids.includes(s.id)}
                    onChange={() => toggleSkill(s.id)}
                  />
                  <div style={{ flex: 1 }}>
                    <span style={{ fontWeight: 500 }}>{s.name}</span>
                    <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: 'var(--text-secondary)' }}>v{s.version}</span>
                    {s.is_builtin && <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: '#8b5cf6' }}>[内置]</span>}
                    {s.description && <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{s.description}</span>}
                  </div>
                </label>
              ))}
            </div>
          )}
        </Card>
      </div>

      <div style={{ marginTop: '1.5rem', display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" onClick={handleSave} disabled={saving}>
          {saving ? '保存中...' : '保存配置'}
        </Button>
      </div>
    </MainLayout>
  )
}
