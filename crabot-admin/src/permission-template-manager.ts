/**
 * PermissionTemplateManager - 权限模板 CRUD 管理
 */

import type {
  PermissionTemplate,
  ToolAccessConfig,
  CreatePermissionTemplateParams,
  UpdatePermissionTemplateParams,
  ResolvedPermissions,
  SessionPermissionConfig,
  GroupSessionPermissionConfig,
} from './types.js'
import { createToolAccessConfig, createCliAccessConfig, CLI_DOMAINS } from './types.js'
import { generateId, generateTimestamp } from 'crabot-shared'
import type { OnConflict } from './backup/import/import-types.js'

export class PermissionTemplateManager {
  private templates: Map<string, PermissionTemplate> = new Map()

  loadFromArray(data: PermissionTemplate[]): void {
    this.templates.clear()
    for (const t of data) {
      this.templates.set(t.id, this.normalize(t))
    }
  }

  /** 迁移旧数据：补齐缺失的 desktop 字段（默认 false，master_private 除外在 initSystemTemplates 时回填） + cli_access */
  private normalize(t: PermissionTemplate): PermissionTemplate {
    let normalized = t
    // desktop 字段补默认（旧数据）
    if (normalized.tool_access && typeof normalized.tool_access.desktop !== 'boolean') {
      normalized = { ...normalized, tool_access: { ...normalized.tool_access, desktop: false } }
    }
    // cli_access 字段补默认（旧数据）
    if (!normalized.cli_access || !CLI_DOMAINS.every(d => d in normalized.cli_access)) {
      normalized = {
        ...normalized,
        cli_access: { ...createCliAccessConfig('none'), ...(normalized.cli_access ?? {}) },
      }
    }
    return normalized
  }

  /** 非 master_private 模板的 desktop 必须为 false */
  private enforceDesktopPolicy(templateId: string | null, toolAccess: ToolAccessConfig): ToolAccessConfig {
    if (templateId === 'master_private') return toolAccess
    if (toolAccess.desktop !== true) return toolAccess
    return { ...toolAccess, desktop: false }
  }

  toArray(): PermissionTemplate[] {
    return Array.from(this.templates.values())
  }

  get size(): number {
    return this.templates.size
  }

  initSystemTemplates(): void {
    const now = generateTimestamp()
    const systemTemplates: PermissionTemplate[] = [
      {
        id: 'master_private',
        name: 'Master 私聊',
        description: 'Master 用户私聊的权限配置',
        is_system: true,
        tool_access: createToolAccessConfig(true),
        cli_access: createCliAccessConfig('write'),
        storage: { workspace_path: '/', access: 'readwrite' },
        memory_scopes: [],
        created_at: now,
        updated_at: now,
      },
      {
        id: 'group_default',
        name: '群聊默认',
        description: '群聊的默认权限配置（仅开放记忆和消息）',
        is_system: true,
        tool_access: { ...createToolAccessConfig(false), memory: true, messaging: true },
        cli_access: createCliAccessConfig('none'),
        storage: null,
        memory_scopes: [],
        created_at: now,
        updated_at: now,
      },
      {
        id: 'minimal',
        name: '最低权限',
        description: '最低权限配置',
        is_system: true,
        tool_access: { ...createToolAccessConfig(false), messaging: true },
        cli_access: createCliAccessConfig('none'),
        storage: null,
        memory_scopes: [],
        created_at: now,
        updated_at: now,
      },
      {
        id: 'standard',
        name: '普通权限',
        description: '普通用户的权限配置',
        is_system: true,
        tool_access: { ...createToolAccessConfig(false), memory: true, messaging: true, task: true },
        cli_access: createCliAccessConfig('none'),
        storage: null,
        memory_scopes: [],
        created_at: now,
        updated_at: now,
      },
      {
        id: 'group_scheduler',
        name: '群聊排程',
        description: '群聊场景下允许群成员通过 LLM 审核创建简单定时任务（如提醒）',
        is_system: true,
        tool_access: { ...createToolAccessConfig(false), memory: true, messaging: true, task: true },
        cli_access: { ...createCliAccessConfig('none'), schedule: 'write' },
        storage: null,
        memory_scopes: [],
        created_at: now,
        updated_at: now,
      },
    ]

    // 系统模板始终以代码定义为准（is_system 模板不允许用户编辑，磁盘持久化只是缓存）
    for (const template of systemTemplates) {
      this.templates.set(template.id, template)
    }
  }

  list(systemOnly?: boolean): PermissionTemplate[] {
    const all = Array.from(this.templates.values())
    return systemOnly ? all.filter(t => t.is_system) : all
  }

  get(id: string): PermissionTemplate | undefined {
    return this.templates.get(id)
  }

  upsertById(template: PermissionTemplate, onConflict: OnConflict): 'imported' | 'overwritten' | 'skipped' {
    if (this.templates.get(template.id)?.is_system) return 'skipped'
    const exists = this.templates.has(template.id)
    if (exists && onConflict === 'skip') return 'skipped'
    this.templates.set(template.id, template)
    return exists ? 'overwritten' : 'imported'
  }

  create(params: CreatePermissionTemplateParams): PermissionTemplate {
    const now = generateTimestamp()
    const id = generateId()
    const template: PermissionTemplate = {
      id,
      name: params.name,
      description: params.description,
      is_system: false,
      tool_access: this.enforceDesktopPolicy(id, params.tool_access),
      cli_access: params.cli_access ?? createCliAccessConfig('none'),
      storage: params.storage ?? null,
      memory_scopes: params.memory_scopes ?? [],
      created_at: now,
      updated_at: now,
    }
    this.templates.set(template.id, template)
    return template
  }

  update(id: string, params: Omit<UpdatePermissionTemplateParams, 'template_id'>): PermissionTemplate {
    const existing = this.templates.get(id)
    if (!existing) {
      throw Object.assign(new Error('Template not found'), { code: 'NOT_FOUND' })
    }
    if (existing.is_system) {
      throw Object.assign(new Error('Cannot modify system template'), { code: 'ADMIN_CANNOT_MODIFY_SYSTEM_TEMPLATE' })
    }
    const updated: PermissionTemplate = {
      ...existing,
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.tool_access !== undefined ? { tool_access: this.enforceDesktopPolicy(existing.id, params.tool_access) } : {}),
      ...(params.cli_access !== undefined ? { cli_access: params.cli_access } : {}),
      ...(params.storage !== undefined ? { storage: params.storage } : {}),
      ...(params.memory_scopes !== undefined ? { memory_scopes: params.memory_scopes } : {}),
      updated_at: generateTimestamp(),
    }
    this.templates.set(id, updated)
    return updated
  }

  delete(id: string, isInUse: (templateId: string) => boolean): void {
    const existing = this.templates.get(id)
    if (!existing) {
      throw Object.assign(new Error('Template not found'), { code: 'NOT_FOUND' })
    }
    if (existing.is_system) {
      throw Object.assign(new Error('Cannot delete system template'), { code: 'ADMIN_CANNOT_DELETE_SYSTEM_TEMPLATE' })
    }
    if (isInUse(id)) {
      throw Object.assign(new Error('Template is in use'), { code: 'ADMIN_TEMPLATE_IN_USE' })
    }
    this.templates.delete(id)
  }

  resolveGroupPermissions(templateId: string, config?: GroupSessionPermissionConfig | null): ResolvedPermissions {
    const base = this.resolvePermissions(templateId)
    return {
      tool_access: { ...base.tool_access, ...config?.tool_access, desktop: false },
      cli_access: { ...base.cli_access, ...config?.cli_access },
      storage: config?.storage !== undefined ? structuredClone(config.storage) : base.storage,
      memory_scopes: config?.memory_scopes !== undefined ? [...config.memory_scopes] : base.memory_scopes,
    }
  }

  resolvePermissions(templateId: string, sessionConfig?: SessionPermissionConfig | null): ResolvedPermissions {
    const template = this.templates.get(templateId)
    if (!template) {
      throw Object.assign(new Error(`Template '${templateId}' not found`), { code: 'NOT_FOUND' })
    }

    if (!sessionConfig) {
      return {
        tool_access: { ...template.tool_access },
        cli_access: { ...template.cli_access },
        storage: template.storage ? { ...template.storage } : null,
        memory_scopes: [...template.memory_scopes],
      }
    }

    // 快照式：sessionConfig 存在 = 已经被 admin web 整份保存过 = 完全脱离模板
    // 缺失字段用模板兜底（迁移路径上的旧 sessionConfig；下次保存即落成完整快照）
    return {
      tool_access: sessionConfig.tool_access
        ? { ...createToolAccessConfig(false), ...sessionConfig.tool_access }
        : { ...template.tool_access },
      cli_access: sessionConfig.cli_access
        ? { ...sessionConfig.cli_access }
        : { ...template.cli_access },
      storage: sessionConfig.storage !== undefined
        ? sessionConfig.storage
        : (template.storage ? { ...template.storage } : null),
      memory_scopes: sessionConfig.memory_scopes !== undefined
        ? [...sessionConfig.memory_scopes]
        : [...template.memory_scopes],
    }
  }
}
