import React, { useState } from 'react'
import { Button } from '../../components/Common/Button'
import { useToast } from '../../contexts/ToastContext'
import { permissionTemplateService } from '../../services/permission-template'
import type { PermissionTemplate, ToolCategory, ToolAccessConfig, StoragePermission } from '../../types'
import { TOOL_CATEGORIES, TOOL_CATEGORY_LABELS } from '../../types'

interface PermissionTemplateFormProps {
  template?: PermissionTemplate
  onSave: () => void
  onCancel: () => void
}

const DEFAULT_TOOL_ACCESS: ToolAccessConfig = {
  memory: false,
  messaging: false,
  task: false,
  mcp_skill: false,
  file_io: false,
  browser: false,
  shell: false,
  remote_exec: false,
  desktop: false,
}

interface FormState {
  name: string
  description: string
  tool_access: ToolAccessConfig
  storage_enabled: boolean
  workspace_path: string
  storage_access: 'read' | 'readwrite'
  memory_scopes_text: string
}

function buildInitialState(template?: PermissionTemplate): FormState {
  if (!template) {
    return {
      name: '',
      description: '',
      tool_access: { ...DEFAULT_TOOL_ACCESS },
      storage_enabled: false,
      workspace_path: '',
      storage_access: 'read',
      memory_scopes_text: '',
    }
  }
  return {
    name: template.name,
    description: template.description ?? '',
    tool_access: { ...template.tool_access },
    storage_enabled: template.storage !== null,
    workspace_path: template.storage?.workspace_path ?? '',
    storage_access: template.storage?.access ?? 'read',
    memory_scopes_text: template.memory_scopes.join(', '),
  }
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: '0.25rem',
  fontSize: '0.875rem',
  color: 'var(--text-secondary)',
  fontWeight: 500,
}

const hintStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  color: 'var(--text-tertiary)',
  marginTop: '0.25rem',
}

export const PermissionTemplateForm: React.FC<PermissionTemplateFormProps> = ({
  template,
  onSave,
  onCancel,
}) => {
  const toast = useToast()
  const isEdit = !!template
  const isSystem = template?.is_system ?? false
  const [form, setForm] = useState<FormState>(() => buildInitialState(template))
  const [saving, setSaving] = useState(false)

  const updateField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  const toggleToolAccess = (category: ToolCategory) => {
    setForm(prev => ({
      ...prev,
      tool_access: {
        ...prev.tool_access,
        [category]: !prev.tool_access[category],
      },
    }))
  }

  const handleSave = async () => {
    const name = form.name.trim()
    if (!name) {
      toast.error('模板名称不能为空')
      return
    }

    const storage: StoragePermission | null = form.storage_enabled
      ? { workspace_path: form.workspace_path.trim(), access: form.storage_access }
      : null

    const memory_scopes = form.memory_scopes_text.trim()
      ? form.memory_scopes_text.split(',').map(s => s.trim()).filter(Boolean)
      : []

    setSaving(true)
    try {
      const payload = {
        name,
        description: form.description.trim() || undefined,
        tool_access: form.tool_access,
        storage,
        memory_scopes,
      }

      if (isEdit && template) {
        await permissionTemplateService.update(template.id, payload)
        toast.success('模板已更新')
      } else {
        await permissionTemplateService.create(payload)
        toast.success('模板已创建')
      }
      onSave()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      <h3 style={{ fontWeight: 600, fontSize: '1.125rem', margin: 0 }}>
        {isEdit ? '编辑权限模板' : '创建权限模板'}
      </h3>

      {isSystem && (
        <div style={{
          padding: '0.5rem 0.75rem',
          background: 'rgba(234, 179, 8, 0.1)',
          borderRadius: '6px',
          fontSize: '0.85rem',
          color: '#ca8a04',
        }}>
          系统模板不可编辑
        </div>
      )}

      {/* Name */}
      <div>
        <label style={labelStyle}>模板名称 *</label>
        <input
          className="input"
          value={form.name}
          onChange={e => updateField('name', e.target.value)}
          placeholder="例如：高级用户"
          disabled={isSystem}
        />
      </div>

      {/* Description */}
      <div>
        <label style={labelStyle}>描述</label>
        <input
          className="input"
          value={form.description}
          onChange={e => updateField('description', e.target.value)}
          placeholder="模板用途说明"
          disabled={isSystem}
        />
      </div>

      {/* Tool Access */}
      <div>
        <label style={labelStyle}>工具访问权限</label>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: '0.5rem',
          marginTop: '0.25rem',
        }}>
          {TOOL_CATEGORIES.map(cat => {
            // desktop 仅 master_private 模板可启用，其他模板（系统或自定义）一律禁用
            const isDesktop = cat === 'desktop'
            const isMasterPrivate = template?.id === 'master_private'
            const disabled = isSystem || (isDesktop && !isMasterPrivate)
            const title = isDesktop && !isMasterPrivate
              ? '桌面控制（computer-use）仅 Master 私聊可开启'
              : undefined
            return (
              <label
                key={cat}
                title={title}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5rem',
                  padding: '0.5rem 0.75rem',
                  borderRadius: '6px',
                  background: 'var(--bg-secondary)',
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  fontSize: '0.875rem',
                  opacity: disabled && !isSystem ? 0.6 : 1,
                }}
              >
                <input
                  type="checkbox"
                  checked={form.tool_access[cat]}
                  onChange={() => toggleToolAccess(cat)}
                  disabled={disabled}
                  style={{ accentColor: 'var(--primary)' }}
                />
                {TOOL_CATEGORY_LABELS[cat]}
              </label>
            )
          })}
        </div>
      </div>

      {/* Storage */}
      <div>
        <label style={{
          ...labelStyle,
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
        }}>
          <input
            type="checkbox"
            checked={form.storage_enabled}
            onChange={e => updateField('storage_enabled', e.target.checked)}
            disabled={isSystem}
            style={{ accentColor: 'var(--primary)' }}
          />
          启用文件访问
        </label>
        {form.storage_enabled && (
          <div style={{ display: 'grid', gap: '0.5rem', marginTop: '0.5rem', paddingLeft: '1.5rem' }}>
            <div>
              <label style={labelStyle}>工作目录路径</label>
              <input
                className="input"
                value={form.workspace_path}
                onChange={e => updateField('workspace_path', e.target.value)}
                placeholder="例如：./workspace"
                disabled={isSystem}
              />
            </div>
            <div>
              <label style={labelStyle}>访问级别</label>
              <select
                className="input"
                value={form.storage_access}
                onChange={e => updateField('storage_access', e.target.value as 'read' | 'readwrite')}
                disabled={isSystem}
              >
                <option value="read">只读 (read)</option>
                <option value="readwrite">读写 (readwrite)</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {/* Memory Scopes */}
      <div>
        <label style={labelStyle}>Memory Scopes</label>
        <input
          className="input"
          value={form.memory_scopes_text}
          onChange={e => updateField('memory_scopes_text', e.target.value)}
          placeholder="留空表示无限制"
          disabled={isSystem}
        />
        <div style={hintStyle}>留空表示无限制，多个 scope 用逗号分隔</div>
      </div>

      {/* Actions */}
      {!isSystem && (
        <div style={{ display: 'flex', gap: '0.75rem', marginTop: '0.5rem' }}>
          <Button variant="primary" onClick={handleSave} disabled={saving}>
            {saving ? '保存中...' : '保存'}
          </Button>
          <Button variant="secondary" onClick={onCancel}>取消</Button>
        </div>
      )}

      {isSystem && (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="secondary" onClick={onCancel}>关闭</Button>
        </div>
      )}
    </div>
  )
}
