import React, { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { agentService } from '../../services/agent'
import { providerService } from '../../services/provider'
import { mcpService } from '../../services/mcp'
import { skillService } from '../../services/skill'
import { MainLayout } from '../../components/Layout/MainLayout'
import { Card } from '../../components/Common/Card'
import { Button } from '../../components/Common/Button'
import { Loading } from '../../components/Common/Loading'
import type {
  ModelProvider,
  LLMRoleRequirement,
  ModelSlotRef,
  MCPServerRegistryEntry,
  SkillRegistryEntry,
  ExtraConfigSchema,
  VisibleWhenCondition,
} from '../../types'

function evaluateVisibleWhen(
  condition: VisibleWhenCondition | undefined,
  extra: Record<string, unknown>,
): boolean {
  if (!condition) return true
  if ('any_of' in condition) {
    return condition.any_of.some((k) => extra[k] === condition.equals)
  }
  return extra[condition.key] === condition.equals
}
import { useToast } from '../../contexts/ToastContext'

const DEFAULT_TIMEZONE_HINT = 'Asia/Shanghai'

function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz })
    return true
  } catch {
    return false
  }
}

interface AgentUnifiedConfig {
  system_prompt: string
  timezone: string
  model_roles: Record<string, ModelSlotRef>
  extra: Record<string, unknown>
}

export const AgentConfig: React.FC = () => {
  const toast = useToast()
  const [providers, setProviders] = useState<ModelProvider[]>([])
  const [llmRequirements, setLlmRequirements] = useState<LLMRoleRequirement[]>([])
  const [extraSchema, setExtraSchema] = useState<ExtraConfigSchema[]>([])
  const [allMCPServers, setAllMCPServers] = useState<MCPServerRegistryEntry[]>([])
  const [allSkills, setAllSkills] = useState<SkillRegistryEntry[]>([])
  const enabledMCPServers = useMemo(() => allMCPServers.filter(s => s.enabled), [allMCPServers])
  const enabledSkills = useMemo(() => allSkills.filter(s => s.enabled), [allSkills])
  const [config, setConfig] = useState<AgentUnifiedConfig>({
    system_prompt: '',
    timezone: '',
    model_roles: {},
    extra: {},
  })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [timezoneError, setTimezoneError] = useState('')

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
      setAllMCPServers(mcpServers)
      setAllSkills(skills)

      try {
        const existingConfig = await agentService.getConfig()
        setConfig({
          system_prompt: existingConfig.system_prompt || '',
          timezone: existingConfig.timezone || '',
          model_roles: existingConfig.model_config || {},
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
    const trimmedTimezone = config.timezone.trim()
    if (trimmedTimezone && !isValidTimezone(trimmedTimezone)) {
      toast.error('时区无效，请填 IANA 时区名（如 Asia/Shanghai）或留空使用默认')
      return
    }
    try {
      setSaving(true)
      await agentService.updateConfig({
        system_prompt: config.system_prompt,
        timezone: trimmedTimezone || undefined,
        model_config: config.model_roles,
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
        <div style={{ marginTop: '0.875rem' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <label style={{ fontWeight: 500, fontSize: '0.8125rem' }}>时区</label>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.6875rem' }}>留空使用默认（{DEFAULT_TIMEZONE_HINT}）</span>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.6875rem', marginBottom: '0.375rem' }}>
            影响 Agent prompt 中的"当前时间"和工具结果时间戳显示。填 IANA 时区名（如 {DEFAULT_TIMEZONE_HINT}、Asia/Tokyo、UTC、Europe/London）。
          </p>
          <input
            className="input"
            type="text"
            value={config.timezone}
            onChange={(e) => {
              const value = e.target.value
              setConfig((prev) => ({ ...prev, timezone: value }))
              if (timezoneError) setTimezoneError('')
            }}
            onBlur={(e) => {
              const trimmed = e.target.value.trim()
              setTimezoneError(trimmed && !isValidTimezone(trimmed) ? '无效的 IANA 时区名' : '')
            }}
            placeholder={DEFAULT_TIMEZONE_HINT}
          />
          {timezoneError && (
            <p style={{ color: 'var(--error)', fontSize: '0.6875rem', marginTop: '0.25rem' }}>{timezoneError}</p>
          )}
        </div>
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

      {/* MCP Servers + Skills — read-only summary + link to mgmt */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginTop: '1rem' }}>
        <Card>
          <div style={{ flex: 1 }}>
            <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              已启用的 MCP Servers
            </h3>
            {enabledMCPServers.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>暂无启用的 MCP Server</p>
            ) : (
              <div>
                {enabledMCPServers.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      padding: '0.5rem 0.75rem',
                      marginBottom: '0.25rem',
                      borderRadius: '0.375rem',
                      background: 'var(--bg-tertiary)',
                    }}
                  >
                    <strong style={{ fontSize: '0.875rem' }}>{s.name}</strong>
                    {s.is_builtin && (
                      <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: 'var(--accent)' }}>
                        [内置]
                      </span>
                    )}
                    <span style={{ marginLeft: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                      {s.description}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: '0.75rem' }}>
              <Link to="/mcp-servers" style={{ color: 'var(--accent)', fontSize: '0.8125rem', textDecoration: 'none' }}>
                → 前往 MCP 管理
              </Link>
            </div>
          </div>
        </Card>

        <Card>
          <div style={{ flex: 1 }}>
            <h3 style={{ fontSize: '0.9375rem', fontWeight: 600, marginBottom: '0.5rem' }}>
              已启用的 Skills
            </h3>
            {enabledSkills.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>暂无启用的 Skill</p>
            ) : (
              <div>
                {enabledSkills.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      padding: '0.5rem 0.75rem',
                      marginBottom: '0.25rem',
                      borderRadius: '0.375rem',
                      background: 'var(--bg-tertiary)',
                    }}
                  >
                    <strong style={{ fontSize: '0.875rem' }}>{s.name}</strong>
                    <span style={{ marginLeft: '0.5rem', color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>
                      {s.description}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div style={{ marginTop: '0.75rem' }}>
              <Link to="/skills" style={{ color: 'var(--accent)', fontSize: '0.8125rem', textDecoration: 'none' }}>
                → 前往 Skills 管理
              </Link>
            </div>
          </div>
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

                // Evaluate visible_when — apply defaults for fields not yet touched
                const extraWithDefaults: Record<string, unknown> = { ...config.extra }
                for (const s of extraSchema) {
                  if (extraWithDefaults[s.key] === undefined && s.default !== undefined) {
                    extraWithDefaults[s.key] = s.default
                  }
                }
                if (!evaluateVisibleWhen(schema.visible_when, extraWithDefaults)) {
                  return null
                }

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
