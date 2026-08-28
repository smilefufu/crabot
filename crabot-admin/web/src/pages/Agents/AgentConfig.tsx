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
  SlotThinkingConfig,
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

const TIMEZONE_GROUPS: ReadonlyArray<{ label: string; options: ReadonlyArray<{ value: string; label: string }> }> = [
  {
    label: '亚洲',
    options: [
      { value: 'Asia/Shanghai', label: 'Asia/Shanghai — 中国（+08:00）' },
      { value: 'Asia/Hong_Kong', label: 'Asia/Hong_Kong — 香港（+08:00）' },
      { value: 'Asia/Taipei', label: 'Asia/Taipei — 台北（+08:00）' },
      { value: 'Asia/Singapore', label: 'Asia/Singapore — 新加坡（+08:00）' },
      { value: 'Asia/Tokyo', label: 'Asia/Tokyo — 日本（+09:00）' },
      { value: 'Asia/Seoul', label: 'Asia/Seoul — 韩国（+09:00）' },
      { value: 'Asia/Bangkok', label: 'Asia/Bangkok — 泰国（+07:00）' },
      { value: 'Asia/Kolkata', label: 'Asia/Kolkata — 印度（+05:30）' },
      { value: 'Asia/Dubai', label: 'Asia/Dubai — 阿联酋（+04:00）' },
    ],
  },
  {
    label: '美洲',
    options: [
      { value: 'America/New_York', label: 'America/New_York — 美东（-05:00 / 夏令时 -04:00）' },
      { value: 'America/Chicago', label: 'America/Chicago — 美中（-06:00 / 夏令时 -05:00）' },
      { value: 'America/Denver', label: 'America/Denver — 美山地（-07:00 / 夏令时 -06:00）' },
      { value: 'America/Los_Angeles', label: 'America/Los_Angeles — 美西（-08:00 / 夏令时 -07:00）' },
      { value: 'America/Toronto', label: 'America/Toronto — 加拿大东（-05:00 / 夏令时 -04:00）' },
      { value: 'America/Sao_Paulo', label: 'America/Sao_Paulo — 巴西（-03:00）' },
    ],
  },
  {
    label: '欧洲',
    options: [
      { value: 'Europe/London', label: 'Europe/London — 英国（+00:00 / 夏令时 +01:00）' },
      { value: 'Europe/Paris', label: 'Europe/Paris — 法国（+01:00 / 夏令时 +02:00）' },
      { value: 'Europe/Berlin', label: 'Europe/Berlin — 德国（+01:00 / 夏令时 +02:00）' },
      { value: 'Europe/Moscow', label: 'Europe/Moscow — 俄罗斯（+03:00）' },
    ],
  },
  {
    label: '大洋洲',
    options: [
      { value: 'Australia/Sydney', label: 'Australia/Sydney — 澳大利亚东（+10:00 / 夏令时 +11:00）' },
      { value: 'Pacific/Auckland', label: 'Pacific/Auckland — 新西兰（+12:00 / 夏令时 +13:00）' },
    ],
  },
  {
    label: '其他',
    options: [
      { value: 'UTC', label: 'UTC — 协调世界时（+00:00）' },
    ],
  },
]

interface AgentUnifiedConfig {
  system_prompt: string
  timezone: string
  model_roles: Record<string, ModelSlotRef>
  /** 槽位思考强度（2026-08）；与 model_roles 独立，key 一致 */
  thinking: Record<string, SlotThinkingConfig>
  extra: Record<string, unknown>
}

/** 思考下拉选项值：'' 跟随默认；off~high 常用档；custom 自定义透传 */
type ThinkingSelectValue = '' | 'off' | 'low' | 'medium' | 'high' | 'custom'

/** 自定义值归一化：纯数字串 → number（数字 budget 仅 anthropic 支持，后端校验为准） */
function normalizeCustomThinking(raw: string): string | number {
  return /^\d+$/.test(raw) ? parseInt(raw, 10) : raw
}

function thinkingSelectValue(t: SlotThinkingConfig | undefined): ThinkingSelectValue {
  if (!t) return ''
  if (t.thinking_level) return t.thinking_level
  return 'custom'
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
    thinking: {},
    extra: {},
  })
  /** 全局默认 LLM provider id：slot 未覆盖模型时，思考下拉的 placeholder 按全局默认 format 提示 */
  const [globalDefaultProviderId, setGlobalDefaultProviderId] = useState<string | undefined>(undefined)
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
      setAllMCPServers(mcpServers)
      setAllSkills(skills)

      // 全局默认仅用于思考下拉的 placeholder 提示：单独容错。它和 agent 配置共用 catch
      // 会让 placeholder 级失败把整个表单打回空初始值，此时点保存会把线上配置抹成空
      // （PR #127 review 意见 2）。
      providerService.getGlobalConfig()
        .then((globalConfig) => setGlobalDefaultProviderId(globalConfig.default_llm_provider_id))
        .catch(() => { /* placeholder 退化为通用提示 */ })
      try {
        const existingConfig = await agentService.getConfig()
        setConfig({
          system_prompt: existingConfig.system_prompt || '',
          timezone: existingConfig.timezone || '',
          model_roles: existingConfig.model_config || {},
          thinking: existingConfig.thinking || {},
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
      // 自定义思考值归一化 + 空值拦截（后端校验为准，这里只挡明显笔误）
      for (const [key, t] of Object.entries(config.thinking)) {
        if (t.thinking_custom !== undefined && typeof t.thinking_custom === 'string' && t.thinking_custom.trim() === '') {
          toast.error(`槽位 "${key}" 的自定义思考强度不能为空`)
          setSaving(false)
          return
        }
      }
      const thinking = Object.fromEntries(
        Object.entries(config.thinking).map(([key, t]) => [
          key,
          t.thinking_custom !== undefined && typeof t.thinking_custom === 'string'
            ? { thinking_custom: normalizeCustomThinking(t.thinking_custom.trim()) }
            : t,
        ])
      )
      await agentService.updateConfig({
        system_prompt: config.system_prompt,
        timezone: config.timezone || undefined,
        model_config: config.model_roles,
        thinking,
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

  // --- 槽位思考强度（2026-08） ---

  /** 该槽位生效 provider 的 format：槽位覆盖优先，回落全局默认；用于 placeholder/弱提示 */
  const effectiveFormat = (roleKey: string): string | undefined => {
    return getSelectedProvider(roleKey)?.format
      ?? providers.find((p) => p.id === globalDefaultProviderId)?.format
  }

  const thinkingPlaceholder = (roleKey: string): string => {
    switch (effectiveFormat(roleKey)) {
      case 'anthropic': return '如 xhigh / max；老模型可填 budget 数字如 8192'
      case 'openai': return '如 minimal / xhigh / max'
      case 'openai-responses': return '如 minimal / xhigh / max'
      case 'gemini': return '如 low / high（兼容层映射 thinking level）'
      default: return '原生枚举值或 budget 数字'
    }
  }

  const handleThinkingChange = (roleKey: string, value: ThinkingSelectValue) => {
    setConfig((prev) => {
      const next = { ...prev.thinking }
      if (value === '') {
        delete next[roleKey]
      } else if (value === 'custom') {
        next[roleKey] = { thinking_custom: prev.thinking[roleKey]?.thinking_custom ?? '' }
      } else {
        next[roleKey] = { thinking_level: value }
      }
      return { ...prev, thinking: next }
    })
  }

  const handleCustomThinkingInput = (roleKey: string, raw: string) => {
    setConfig((prev) => ({
      ...prev,
      thinking: { ...prev.thinking, [roleKey]: { thinking_custom: raw } },
    }))
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
          placeholder={`例如：你是 XX 团队的 AI 助理，专业可靠、语气温暖；该直言时坦诚提出不同看法，但始终带着善意。

表达偏好（按需删改）：
· 默认自然口语，少用要点 / 加粗 / 标题，能一段话讲清就不分点
· 简单问题简短答，几句话即可；内容确实多面才用列表
· 拒绝或坏消息不要用要点罗列，把话说得软一些
· 出错就直接承认并改正，不必反复道歉；做完不邀功、不说"还有什么可以帮您"之类的客套`}
        />
        <div style={{ marginTop: '0.875rem' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.25rem' }}>
            <label style={{ fontWeight: 500, fontSize: '0.8125rem' }}>时区</label>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.6875rem' }}>影响 prompt 中"当前时间"与工具结果时间戳的显示</span>
          </div>
          <select
            className="select"
            value={config.timezone}
            onChange={(e) => setConfig((prev) => ({ ...prev, timezone: e.target.value }))}
          >
            <option value="">使用默认（{DEFAULT_TIMEZONE_HINT}）</option>
            {TIMEZONE_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </optgroup>
            ))}
          </select>
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
                    <div style={{ display: 'grid', gridTemplateColumns: llmModels.length > 0 ? '1fr 1fr 1fr' : '1fr 1fr', gap: '0.5rem' }}>
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
                      {llmModels.length > 0 ? (
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
                      ) : null}
                      <div className="form-group" style={{ marginBottom: 0 }}>
                        <select
                          className="select"
                          value={thinkingSelectValue(config.thinking[role.key])}
                          onChange={(e) => handleThinkingChange(role.key, e.target.value as ThinkingSelectValue)}
                        >
                          <option value="">思考：跟随默认</option>
                          <option value="off">思考：关闭</option>
                          <option value="low">思考：低</option>
                          <option value="medium">思考：中</option>
                          <option value="high">思考：高</option>
                          <option value="custom">思考：自定义…</option>
                        </select>
                      </div>
                    </div>
                    {thinkingSelectValue(config.thinking[role.key]) === 'custom' && (
                      <div style={{ marginTop: '0.5rem' }}>
                        <input
                          className="input"
                          value={typeof config.thinking[role.key]?.thinking_custom === 'string'
                            ? (config.thinking[role.key].thinking_custom as string)
                            : config.thinking[role.key]?.thinking_custom !== undefined
                              ? String(config.thinking[role.key].thinking_custom)
                              : ''}
                          onChange={(e) => handleCustomThinkingInput(role.key, e.target.value)}
                          placeholder={thinkingPlaceholder(role.key)}
                        />
                        {typeof config.thinking[role.key]?.thinking_custom === 'string'
                          && /^\d+$/.test(config.thinking[role.key].thinking_custom as string)
                          && effectiveFormat(role.key) !== 'anthropic' && (
                          <div style={{ color: 'var(--warning)', fontSize: '0.6875rem', marginTop: '0.25rem' }}>
                            数字 budget 仅 anthropic 格式支持，其他格式请填原生枚举值
                          </div>
                        )}
                      </div>
                    )}
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
                      background: 'var(--surface-raised)',
                    }}
                  >
                    <strong style={{ fontSize: '0.875rem' }}>{s.name}</strong>
                    {s.is_builtin && (
                      <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', color: 'var(--primary-light)' }}>
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
              <Link to="/mcp-servers" style={{ color: 'var(--primary-light)', fontSize: '0.8125rem', textDecoration: 'none' }}>
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
                      background: 'var(--surface-raised)',
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
              <Link to="/skills" style={{ color: 'var(--primary-light)', fontSize: '0.8125rem', textDecoration: 'none' }}>
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
