import React, { useState, useEffect } from 'react'
import { Button } from '../../components/Common/Button'
import { Modal } from '../../components/Common/Modal'
import { Tooltip } from '../../components/Common/Tooltip'
import { subagentService } from '../../services/subagent'
import { providerService } from '../../services/provider'
import { mcpService } from '../../services/mcp'
import { skillService } from '../../services/skill'
import type {
  SubAgentRegistryEntry,
  BuiltinCapabilities,
  ModelRole,
  ModelInfo,
} from '../../types'
import { isValidSubagentName, WHEN_TO_USE_EXAMPLE_TEMPLATE, ROLE_BOUNDARY_TEMPLATE } from './utils'
import { useToast } from '../../contexts/ToastContext'

type TabKey = 'basic' | 'when_to_use' | 'workflow' | 'model' | 'capabilities' | 'whitelist'
const TABS: ReadonlyArray<{ key: TabKey; label: string }> = [
  { key: 'basic', label: '基本' },
  { key: 'when_to_use', label: '触发条件' },
  { key: 'workflow', label: '角色与工作流' },
  { key: 'model', label: '模型' },
  { key: 'capabilities', label: '内置能力' },
  { key: 'whitelist', label: 'MCP + Skill 白名单' },
]

type FormState = {
  name: string
  description: string
  enabled: boolean
  when_to_use: string
  role: string
  workflow: string
  deliverables: string
  verification: string
  model_mode: 'role' | 'specific'
  model_role: ModelRole
  provider_id: string
  model_id: string
  builtin_capabilities: BuiltinCapabilities
  allowed_mcp_server_ids: string[]
  allowed_skill_ids: string[]
  max_turns: number
  hook_preset: string
}

const DEFAULT_FORM: FormState = {
  name: '',
  description: '',
  enabled: true,
  when_to_use: '',
  role: '',
  workflow: '',
  deliverables: '',
  verification: '',
  model_mode: 'role',
  model_role: 'cost_effective',
  provider_id: '',
  model_id: '',
  builtin_capabilities: {
    file_system: true,
    shell: true,
    task_intel: true,
    crab_memory: true,
    crab_messaging: false,
  },
  allowed_mcp_server_ids: [],
  allowed_skill_ids: [],
  max_turns: 20,
  hook_preset: '',
}

function entryToForm(entry: SubAgentRegistryEntry): FormState {
  return {
    name: entry.name,
    description: entry.description,
    enabled: entry.enabled,
    when_to_use: entry.when_to_use,
    role: entry.role,
    workflow: entry.workflow,
    deliverables: entry.deliverables,
    verification: entry.verification ?? '',
    model_mode: entry.model_role !== null ? 'role' : 'specific',
    model_role: entry.model_role ?? 'cost_effective',
    provider_id: entry.provider_id ?? '',
    model_id: entry.model_id ?? '',
    builtin_capabilities: entry.builtin_capabilities,
    allowed_mcp_server_ids: entry.allowed_mcp_server_ids,
    allowed_skill_ids: entry.allowed_skill_ids,
    max_turns: entry.max_turns,
    hook_preset: entry.hook_preset ?? '',
  }
}

function formToPayload(form: FormState): Partial<SubAgentRegistryEntry> {
  return {
    name: form.name,
    description: form.description,
    enabled: form.enabled,
    when_to_use: form.when_to_use,
    role: form.role,
    workflow: form.workflow,
    deliverables: form.deliverables,
    verification: form.verification || undefined,
    provider_id: form.model_mode === 'specific' ? (form.provider_id || null) : null,
    model_id: form.model_mode === 'specific' ? (form.model_id || null) : null,
    model_role: form.model_mode === 'role' ? form.model_role : null,
    builtin_capabilities: form.builtin_capabilities,
    allowed_mcp_server_ids: form.allowed_mcp_server_ids,
    allowed_skill_ids: form.allowed_skill_ids,
    max_turns: form.max_turns,
    hook_preset: form.hook_preset || undefined,
  }
}

export interface SubagentEditorProps {
  mode: 'create' | 'edit'
  entry: SubAgentRegistryEntry | null
  onClose: () => void
  onSaved: () => void
}

export const SubagentEditor: React.FC<SubagentEditorProps> = ({ mode, entry, onClose, onSaved }) => {
  const toast = useToast()
  const [tab, setTab] = useState<TabKey>('basic')
  const [form, setForm] = useState<FormState>(() => entry ? entryToForm(entry) : DEFAULT_FORM)
  const [saving, setSaving] = useState(false)

  const nameInvalid = form.name !== '' && !isValidSubagentName(form.name)
  const builtinRenameWarning = mode === 'edit' && entry?.is_builtin === true && form.name !== entry.name

  const handleSave = async () => {
    if (nameInvalid || form.name === '') {
      toast.error('请填写有效的 name（snake_case）')
      return
    }
    setSaving(true)
    try {
      const payload = formToPayload(form)
      if (mode === 'create') {
        await subagentService.create(payload as never)
        toast.success(`已创建 ${form.name}`)
      } else if (entry) {
        await subagentService.update(entry.id, payload)
        toast.success(`已更新 ${form.name}`)
      }
      onSaved()
    } catch (err) {
      toast.error('保存失败：' + (err instanceof Error ? err.message : String(err)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onClose={saving ? () => {} : onClose}
      size="lg"
      title={mode === 'create' ? '新建 subagent' : `编辑 subagent ${entry?.name ?? ''}`}
      dismissOnBackdrop={!saving}
      dismissOnEscape={!saving}
      contentClassName="subagent-editor"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={saving}>取消</Button>
          <Button
            variant="primary"
            onClick={() => void handleSave()}
            disabled={saving || nameInvalid || form.name === ''}
          >
            {saving ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <div className="subagent-editor__tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            className={`subagent-editor__tab${tab === t.key ? ' subagent-editor__tab--active' : ''}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="subagent-editor__panel">
        {tab === 'basic' && (
          <BasicTab
            form={form}
            setForm={setForm}
            nameInvalid={nameInvalid}
            builtinRenameWarning={!!builtinRenameWarning}
          />
        )}
        {tab === 'when_to_use' && <WhenToUseTab form={form} setForm={setForm} />}
        {tab === 'workflow' && <WorkflowTab form={form} setForm={setForm} />}
        {tab === 'model' && <ModelTab form={form} setForm={setForm} />}
        {tab === 'capabilities' && <CapabilitiesTab form={form} setForm={setForm} />}
        {tab === 'whitelist' && <WhitelistTab form={form} setForm={setForm} />}
      </div>
    </Modal>
  )
}

// ============ Tab 子组件 ============

const BasicTab: React.FC<{
  form: FormState
  setForm: React.Dispatch<React.SetStateAction<FormState>>
  nameInvalid: boolean
  builtinRenameWarning: boolean
}> = ({ form, setForm, nameInvalid, builtinRenameWarning }) => (
  <div>
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span>名称</span>
      <input
        aria-label="名称"
        type="text"
        value={form.name}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        style={{ width: '100%', padding: '6px 8px', fontFamily: 'var(--font-mono)' }}
      />
      {nameInvalid && (
        <div style={{ color: 'var(--error)', fontSize: 12 }}>
          名称必须 snake_case（小写字母开头，可含数字下划线）
        </div>
      )}
      {builtinRenameWarning && (
        <div style={{ color: 'var(--warning-text)', fontSize: 12, marginTop: 4 }}>
          ⚠ builtin 改名后将被自动 prune 重置；如需改名建议复制成自定义项
        </div>
      )}
      {form.name && !nameInvalid && (
        <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
          {`delegate_task(subagent_type="${form.name}")`}
        </div>
      )}
    </label>
    <label style={{ display: 'block', marginBottom: 12 }}>
      <span>说明</span>
      <input
        type="text"
        value={form.description}
        onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
        style={{ width: '100%', padding: '6px 8px' }}
      />
    </label>
    <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <input
        type="checkbox"
        checked={form.enabled}
        onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
      />
      <span>启用（出现在 main 的 delegate_task 可选列表中）</span>
    </label>
  </div>
)

const WhenToUseTab: React.FC<{
  form: FormState
  setForm: React.Dispatch<React.SetStateAction<FormState>>
}> = ({ form, setForm }) => (
  <div>
    <div
      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}
    >
      <span>when_to_use（让 main 判断何时委派此 subagent）</span>
      <Button
        onClick={() =>
          setForm((f) => ({
            ...f,
            when_to_use: f.when_to_use + (f.when_to_use ? '\n\n' : '') + WHEN_TO_USE_EXAMPLE_TEMPLATE,
          }))
        }
      >
        插入 example 模板
      </Button>
    </div>
    <textarea
      aria-label="when_to_use"
      value={form.when_to_use}
      onChange={(e) => setForm((f) => ({ ...f, when_to_use: e.target.value }))}
      style={{ width: '100%', height: 200, fontFamily: 'var(--font-mono)', padding: 8 }}
    />
  </div>
)

const WorkflowTab: React.FC<{
  form: FormState
  setForm: React.Dispatch<React.SetStateAction<FormState>>
}> = ({ form, setForm }) => (
  <div>
    <div
      style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}
    >
      <span>role（角色与边界）</span>
      <Button
        onClick={() =>
          setForm((f) => ({
            ...f,
            role: f.role + (f.role ? '\n' : '') + ROLE_BOUNDARY_TEMPLATE,
          }))
        }
      >
        插入边界默认条款
      </Button>
    </div>
    <textarea
      aria-label="role"
      value={form.role}
      onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
      style={{ width: '100%', height: 100, fontFamily: 'var(--font-mono)', padding: 8, marginBottom: 12 }}
    />
    <div>workflow（工作流步骤）</div>
    <textarea
      aria-label="workflow"
      value={form.workflow}
      onChange={(e) => setForm((f) => ({ ...f, workflow: e.target.value }))}
      style={{ width: '100%', height: 150, fontFamily: 'var(--font-mono)', padding: 8, marginBottom: 12 }}
    />
    <div>deliverables（交付物格式）</div>
    <textarea
      aria-label="deliverables"
      value={form.deliverables}
      onChange={(e) => setForm((f) => ({ ...f, deliverables: e.target.value }))}
      style={{ width: '100%', height: 100, fontFamily: 'var(--font-mono)', padding: 8, marginBottom: 12 }}
    />
    <div>verification（完成前自检，可选但推荐）</div>
    <textarea
      aria-label="verification"
      value={form.verification}
      onChange={(e) => setForm((f) => ({ ...f, verification: e.target.value }))}
      style={{ width: '100%', height: 100, fontFamily: 'var(--font-mono)', padding: 8 }}
    />
  </div>
)

const ModelTab: React.FC<{
  form: FormState
  setForm: React.Dispatch<React.SetStateAction<FormState>>
}> = ({ form, setForm }) => {
  const [providers, setProviders] = useState<Array<{ id: string; name: string; models: ModelInfo[] }>>([])

  useEffect(() => {
    void providerService.listProviders().then((paginated) => {
      setProviders(paginated.items.map((p) => ({ id: p.id, name: p.name, models: p.models ?? [] })))
    })
  }, [])

  const selectedProvider = providers.find((p) => p.id === form.provider_id)
  const modelsForSelected = selectedProvider?.models ?? []

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <label style={{ display: 'block', marginBottom: 6 }}>
          <input
            type="radio"
            name="model_mode"
            aria-label="使用 role 默认"
            checked={form.model_mode === 'role'}
            onChange={() =>
              setForm((f) => ({ ...f, model_mode: 'role', provider_id: '', model_id: '' }))
            }
          />
          <span style={{ marginLeft: 6 }}>使用 role 默认（按全局配置解析）</span>
        </label>
        {form.model_mode === 'role' && (
          <div style={{ marginLeft: 24 }}>
            <select
              aria-label="model_role"
              value={form.model_role}
              onChange={(e) => setForm((f) => ({ ...f, model_role: e.target.value as ModelRole }))}
              style={{ padding: '4px 8px' }}
            >
              <option value="powerful">powerful（强力）</option>
              <option value="cost_effective">cost_effective（性价比）</option>
              <option value="vision">vision（视觉）</option>
            </select>
            <span style={{ color: 'var(--text-muted)', marginLeft: 12, fontSize: 12 }}>
              实际指向取决于该 agent 实例的 model_config[role]
            </span>
          </div>
        )}
      </div>

      <div>
        <label style={{ display: 'block', marginBottom: 6 }}>
          <input
            type="radio"
            name="model_mode"
            aria-label="指定 Provider+Model"
            checked={form.model_mode === 'specific'}
            onChange={() =>
              setForm((f) => ({ ...f, model_mode: 'specific', model_role: 'cost_effective' }))
            }
          />
          <span style={{ marginLeft: 6 }}>指定 Provider + Model</span>
        </label>
        {form.model_mode === 'specific' && (
          <div style={{ marginLeft: 24 }}>
            <select
              aria-label="provider_id"
              value={form.provider_id}
              onChange={(e) => setForm((f) => ({ ...f, provider_id: e.target.value, model_id: '' }))}
              style={{ padding: '4px 8px', marginRight: 8 }}
            >
              <option value="">— 选 Provider —</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <select
              aria-label="model_id"
              value={form.model_id}
              onChange={(e) => setForm((f) => ({ ...f, model_id: e.target.value }))}
              style={{ padding: '4px 8px' }}
              disabled={!form.provider_id}
            >
              <option value="">— 选 Model —</option>
              {modelsForSelected.map((m) => (
                <option key={m.model_id} value={m.model_id}>
                  {m.model_id}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    </div>
  )
}

const CAPABILITY_TOOLS: Record<keyof BuiltinCapabilities, string> = {
  file_system: 'Read, Write, Edit, Glob, Grep',
  shell: 'Bash + Output, Kill, ListEntities',
  task_intel: 'search_traces, get_task_details, search_short_term',
  crab_memory: 'crab-memory MCP 全部工具',
  crab_messaging: 'crab-messaging MCP 全部工具',
}

const CapabilitiesTab: React.FC<{
  form: FormState
  setForm: React.Dispatch<React.SetStateAction<FormState>>
}> = ({ form, setForm }) => {
  const toggle = (key: keyof BuiltinCapabilities) => {
    setForm((f) => ({
      ...f,
      builtin_capabilities: { ...f.builtin_capabilities, [key]: !f.builtin_capabilities[key] },
    }))
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
      <div>
        <div style={{ color: 'var(--text-muted)', marginBottom: 8, fontSize: 12 }}>常用（默认 on）</div>
        {(['file_system', 'shell', 'task_intel', 'crab_memory'] as const).map((key) => (
          <label
            key={key}
            style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}
          >
            <input
              type="checkbox"
              aria-label={key}
              checked={form.builtin_capabilities[key]}
              onChange={() => toggle(key)}
            />
            <Tooltip content={CAPABILITY_TOOLS[key]}>
              <span style={{ fontFamily: 'var(--font-mono)' }}>{key}</span>
            </Tooltip>
          </label>
        ))}
      </div>
      <div>
        <div style={{ color: 'var(--text-muted)', marginBottom: 8, fontSize: 12 }}>敏感（默认 off）</div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            aria-label="crab_messaging"
            checked={form.builtin_capabilities.crab_messaging}
            onChange={() => toggle('crab_messaging')}
          />
          <Tooltip content={CAPABILITY_TOOLS.crab_messaging}>
            <span style={{ fontFamily: 'var(--font-mono)' }}>crab_messaging</span>
          </Tooltip>
        </label>
      </div>
    </div>
  )
}

const WhitelistTab: React.FC<{
  form: FormState
  setForm: React.Dispatch<React.SetStateAction<FormState>>
}> = ({ form, setForm }) => {
  const [mcpOptions, setMcpOptions] = useState<Array<{ id: string; name: string }>>([])
  const [skillOptions, setSkillOptions] = useState<Array<{ id: string; name: string }>>([])

  useEffect(() => {
    void mcpService.list().then((list) => {
      setMcpOptions(list.filter((m) => m.enabled).map((m) => ({ id: m.id, name: m.name })))
    })
    void skillService.list().then((list) => {
      setSkillOptions(list.filter((s) => s.enabled).map((s) => ({ id: s.id, name: s.name })))
    })
  }, [])

  // 白名单存 MCP server **name**，不是 id：运行时工具名是 mcp__<name>__*，agent 侧 subagent-tool-filter
  // 按 name 过滤；内置 server 的 id 还是每实例随机的（generateId），存 id 永远匹配不上。
  const toggleMcp = (name: string) =>
    setForm((f) => ({
      ...f,
      allowed_mcp_server_ids: f.allowed_mcp_server_ids.includes(name)
        ? f.allowed_mcp_server_ids.filter((x) => x !== name)
        : [...f.allowed_mcp_server_ids, name],
    }))

  const toggleSkill = (id: string) =>
    setForm((f) => ({
      ...f,
      allowed_skill_ids: f.allowed_skill_ids.includes(id)
        ? f.allowed_skill_ids.filter((x) => x !== id)
        : [...f.allowed_skill_ids, id],
    }))

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 4 }}>MCP 服务白名单</div>
        {mcpOptions.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>暂无 enabled 的 MCP server</div>
        )}
        {mcpOptions.map((m) => (
          <label
            key={m.id}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 12 }}
          >
            <input
              type="checkbox"
              checked={form.allowed_mcp_server_ids.includes(m.name)}
              onChange={() => toggleMcp(m.name)}
            />
            <span>{m.name}</span>
          </label>
        ))}
      </div>
      <div style={{ marginBottom: 16 }}>
        <div style={{ marginBottom: 4 }}>Skill 白名单</div>
        {skillOptions.length === 0 && (
          <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>未勾选 skill，Skill 加载工具不可用</div>
        )}
        {skillOptions.map((s) => (
          <label
            key={s.id}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginRight: 12 }}
          >
            <input
              type="checkbox"
              checked={form.allowed_skill_ids.includes(s.id)}
              onChange={() => toggleSkill(s.id)}
            />
            <span>{s.name}</span>
          </label>
        ))}
        {form.allowed_skill_ids.length === 0 && skillOptions.length > 0 && (
          <div style={{ color: 'var(--warning-text)', fontSize: 12, marginTop: 4 }}>
            未勾选 skill，Skill 加载工具不可用
          </div>
        )}
      </div>
      <label style={{ display: 'block' }}>
        <span>max_turns</span>
        <input
          type="number"
          value={form.max_turns}
          onChange={(e) => setForm((f) => ({ ...f, max_turns: Number(e.target.value) || 0 }))}
          style={{ width: 120, padding: '4px 8px', marginLeft: 8 }}
          min={1}
        />
      </label>
    </div>
  )
}
