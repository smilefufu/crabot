/**
 * 模块验证器
 *
 * 负责验证模块包的合法性和兼容性
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import yaml from 'js-yaml'
import semver from 'semver'
import type { ModulePackageInfo } from './types.js'

const CURRENT_PROTOCOL_VERSION = '0.1.0'
const HOTPLUG_MODULE_TYPES = ['agent', 'channel']
const MODULE_ID_REGEX = /^[a-z0-9-]{3,50}$/

export class ModuleValidator {
  /**
   * 解析模块包的 crabot-module.yaml
   */
  async parseModuleYaml(modulePath: string): Promise<ModulePackageInfo> {
    const yamlPath = path.join(modulePath, 'crabot-module.yaml')

    // 检查文件是否存在
    try {
      await fs.access(yamlPath)
    } catch {
      throw new Error('crabot-module.yaml not found')
    }

    // 读取并解析 YAML
    const yamlContent = await fs.readFile(yamlPath, 'utf-8')

    // 检查文件大小（最大 10KB）
    if (yamlContent.length > 10 * 1024) {
      throw new Error('crabot-module.yaml too large (max 10KB)')
    }

    let data: any
    try {
      data = yaml.load(yamlContent)
    } catch (error) {
      throw new Error(`Invalid YAML format: ${error}`)
    }

    // 验证必填字段
    this.validateRequiredFields(data)

    // 验证字段格式
    this.validateFieldFormats(data)

    // 构造 ModulePackageInfo
    const info: ModulePackageInfo = {
      module_id: data.module_id,
      module_type: data.module_type,
      protocol_version: data.protocol_version,
      name: data.name,
      version: data.version,
      description: data.description,
      author: data.author,
      license: data.license,
      runtime: {
        type: data.runtime?.type || 'nodejs',
        version: data.runtime?.version,
      },
      entry: data.entry,
      install: data.install,
      build: data.build,
      env: data.env,
      agent: data.agent,
    }

    return info
  }

  /**
   * 验证必填字段
   */
  private validateRequiredFields(data: any): void {
    const requiredFields = [
      'module_id',
      'module_type',
      'protocol_version',
      'name',
      'version',
      'runtime',
      'entry',
    ]

    for (const field of requiredFields) {
      if (!data[field]) {
        throw new Error(`Missing required field: ${field}`)
      }
    }

    // runtime 必须有 type
    if (!data.runtime.type) {
      throw new Error('Missing required field: runtime.type')
    }

    // agent 类型必须有 agent 配置
    if (data.module_type === 'agent') {
      if (!data.agent) {
        throw new Error('Missing required field: agent (for agent module)')
      }

      const agentRequiredFields = [
        'engine',
        'supported_roles',
        'model_format',
        'model_roles',
      ]

      for (const field of agentRequiredFields) {
        if (!data.agent[field]) {
          throw new Error(`Missing required field: agent.${field}`)
        }
      }
    }
  }

  /**
   * 验证字段格式
   */
  private validateFieldFormats(data: any): void {
    // 验证 module_id 格式
    if (!MODULE_ID_REGEX.test(data.module_id)) {
      throw new Error(
        'Invalid module_id format. Must be lowercase letters, numbers, and hyphens, 3-50 characters'
      )
    }

    // 验证 module_type
    if (!HOTPLUG_MODULE_TYPES.includes(data.module_type)) {
      throw new Error(
        `Invalid module_type: ${data.module_type}. Must be one of: ${HOTPLUG_MODULE_TYPES.join(', ')}`
      )
    }

    // 验证 protocol_version
    if (!semver.valid(data.protocol_version)) {
      throw new Error(`Invalid protocol_version format: ${data.protocol_version}`)
    }

    // 验证 version
    if (!semver.valid(data.version)) {
      throw new Error(`Invalid version format: ${data.version}`)
    }

    // 验证 runtime.type
    const validRuntimeTypes = ['nodejs', 'python', 'binary']
    if (!validRuntimeTypes.includes(data.runtime.type)) {
      throw new Error(
        `Invalid runtime.type: ${data.runtime.type}. Must be one of: ${validRuntimeTypes.join(', ')}`
      )
    }

    // 验证 runtime.version（如果提供）
    if (data.runtime.version && !semver.validRange(data.runtime.version)) {
      throw new Error(`Invalid runtime.version format: ${data.runtime.version}`)
    }

    // 验证 agent 配置（如果是 agent 类型）
    if (data.module_type === 'agent') {
      const validEngines = ['claude-agent-sdk', 'pydantic-ai', 'custom']
      if (!validEngines.includes(data.agent.engine)) {
        throw new Error(
          `Invalid agent.engine: ${data.agent.engine}. Must be one of: ${validEngines.join(', ')}`
        )
      }

      const validRoles = ['front', 'worker']
      if (!Array.isArray(data.agent.supported_roles) || data.agent.supported_roles.length === 0) {
        throw new Error('agent.supported_roles must be a non-empty array')
      }
      for (const role of data.agent.supported_roles) {
        if (!validRoles.includes(role)) {
          throw new Error(
            `Invalid agent.supported_roles: ${role}. Must be one of: ${validRoles.join(', ')}`
          )
        }
      }

      const validFormats = ['openai', 'anthropic', 'gemini']
      if (!validFormats.includes(data.agent.model_format)) {
        throw new Error(
          `Invalid agent.model_format: ${data.agent.model_format}. Must be one of: ${validFormats.join(', ')}`
        )
      }

      if (!Array.isArray(data.agent.model_roles) || data.agent.model_roles.length === 0) {
        throw new Error('agent.model_roles must be a non-empty array')
      }
    }
  }

  /**
   * 验证协议版本兼容性
   */
  validateProtocolVersion(version: string): boolean {
    try {
      // 主版本号必须相同
      const current = semver.parse(CURRENT_PROTOCOL_VERSION)
      const target = semver.parse(version)

      if (!current || !target) {
        return false
      }

      return current.major === target.major
    } catch {
      return false
    }
  }

  /**
   * 验证运行时版本兼容性
   */
  validateRuntimeVersion(required: string, actual: string): boolean {
    try {
      return semver.satisfies(actual, required)
    } catch {
      return false
    }
  }

  /**
   * 验证 entry 文件是否存在
   */
  async validateEntryExists(modulePath: string, entry: string): Promise<boolean> {
    const entryPath = path.join(modulePath, entry)
    try {
      await fs.access(entryPath)
      return true
    } catch {
      return false
    }
  }

  /**
   * 完整验证模块包
   */
  async validate(modulePath: string): Promise<ModulePackageInfo> {
    // 1. 解析 YAML
    const info = await this.parseModuleYaml(modulePath)

    // 2. 验证协议版本兼容性
    if (!this.validateProtocolVersion(info.protocol_version)) {
      throw new Error(
        `Incompatible protocol version: ${info.protocol_version}. Current: ${CURRENT_PROTOCOL_VERSION}`
      )
    }

    // 3. 验证 entry 文件存在（构建后才有，安装时可能不存在）
    // 这个检查在安装完成后再做

    return info
  }
}
