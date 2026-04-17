/**
 * PermissionTemplateManager - 权限模板 CRUD 管理
 */

import type {
  PermissionTemplate,
  ToolAccessConfig,
  StoragePermission,
  CreatePermissionTemplateParams,
  UpdatePermissionTemplateParams,
  ResolvedPermissions,
  SessionPermissionConfig,
} from './types.js'
import { createToolAccessConfig } from './types.js'
import { generateId, generateTimestamp } from 'crabot-shared'

export class PermissionTemplateManager {
  private templates: Map<string, PermissionTemplate> = new Map()

  loadFromArray(data: PermissionTemplate[]): void {
    this.templates.clear()
    for (const t of data) {
      this.templates.set(t.id, this.normalize(t))
    }
  }

  /** 迁移旧数据：补齐缺失的 desktop 字段（默认 false，master_private 除外在 initSystemTemplates 时回填） */
  private normalize(t: PermissionTemplate): PermissionTemplate {
    if (!t.tool_access) return t
    if (typeof t.tool_access.desktop === 'boolean') return t
    return {
      ...t,
      tool_access: { ...t.tool_access, desktop: false },
    }
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
        storage: { workspace_path: '/', access: 'readwrite' },
        memory_scopes: [],
        created_at: now,
        updated_at: now,
      },
      {
        id: 'group_default',
        name: '群聊默认',
        description: '群聊的默认权限配置',
        is_system: true,
        tool_access: { ...createToolAccessConfig(false), memory: true, messaging: true },
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
        storage: null,
        memory_scopes: [],
        created_at: now,
        updated_at: now,
      },
    ]

    for (const template of systemTemplates) {
      const existing = this.templates.get(template.id)
      const shouldReplace =
        !existing ||
        !existing.tool_access ||
        typeof existing.tool_access.desktop !== 'boolean'
      if (shouldReplace) {
        this.templates.set(template.id, template)
        continue
      }
      // 非 master_private 的系统模板：强制关闭 desktop
      if (existing.id !== 'master_private' && existing.tool_access.desktop === true) {
        this.templates.set(existing.id, {
          ...existing,
          tool_access: { ...existing.tool_access, desktop: false },
          updated_at: now,
        })
      }
    }
  }

  list(systemOnly?: boolean): PermissionTemplate[] {
    const all = Array.from(this.templates.values())
    return systemOnly ? all.filter(t => t.is_system) : all
  }

  get(id: string): PermissionTemplate | undefined {
    return this.templates.get(id)
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

  resolvePermissions(templateId: string, sessionConfig?: SessionPermissionConfig | null): ResolvedPermissions {
    const template = this.templates.get(templateId)
    if (!template) {
      throw Object.assign(new Error(`Template '${templateId}' not found`), { code: 'NOT_FOUND' })
    }

    if (!sessionConfig) {
      return {
        tool_access: { ...template.tool_access },
        storage: template.storage ? { ...template.storage } : null,
        memory_scopes: [...template.memory_scopes],
      }
    }

    const toolAccess: ToolAccessConfig = sessionConfig.tool_access
      ? { ...template.tool_access, ...sessionConfig.tool_access }
      : { ...template.tool_access }

    const storage: StoragePermission | null = sessionConfig.storage !== undefined
      ? sessionConfig.storage
      : (template.storage ? { ...template.storage } : null)

    const memoryScopes = sessionConfig.memory_scopes !== undefined
      ? [...sessionConfig.memory_scopes]
      : [...template.memory_scopes]

    return { tool_access: toolAccess, storage, memory_scopes: memoryScopes }
  }
}
