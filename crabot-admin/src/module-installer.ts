/**
 * 模块安装器
 *
 * 负责模块包的安装、卸载流程
 */

import fs from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'
import { generateTimestamp } from './core/base-protocol.js'
import { RuntimeManager } from './runtime-manager.js'
import { ModuleValidator } from './module-validator.js'
import { AgentManager } from './agent-manager.js'
import type {
  ModuleSource,
  ModulePackageInfo,
  AgentImplementation,
  InstallOptions,
} from './types.js'

export class ModuleInstaller {
  private readonly dataDir: string
  private readonly tempDir: string
  private readonly installedDir: string
  private readonly runtimeManager: RuntimeManager
  private readonly validator: ModuleValidator
  private readonly agentManager: AgentManager
  private installing = false

  constructor(dataDir: string, agentManager: AgentManager) {
    this.dataDir = dataDir
    this.tempDir = path.join(dataDir, 'temp')
    this.installedDir = path.join(dataDir, 'installed-modules')
    this.runtimeManager = new RuntimeManager(process.cwd())
    this.validator = new ModuleValidator()
    this.agentManager = agentManager
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.tempDir, { recursive: true })
    await fs.mkdir(this.installedDir, { recursive: true })
  }

  /**
   * 预览模块包信息（不安装）
   */
  async preview(source: ModuleSource): Promise<ModulePackageInfo> {
    // 创建临时目录
    const tempPath = await this.createTempDir()

    try {
      // 准备源代码
      await this.prepareSource(source, tempPath)

      // 解析和验证
      const info = await this.validator.validate(tempPath)

      return info
    } finally {
      // 清理临时目录
      await this.cleanup(tempPath)
    }
  }

  /**
   * 安装模块
   */
  async install(
    source: ModuleSource,
    options: InstallOptions = {}
  ): Promise<AgentImplementation> {
    // 并发控制：同一时间只允许一个安装操作
    if (this.installing) {
      throw new Error('Another installation is in progress')
    }

    this.installing = true

    const tempPath = await this.createTempDir()

    try {
      console.log('[ModuleInstaller] Starting installation...')
      console.log('[ModuleInstaller] Source:', JSON.stringify(source))

      // 1. 准备源代码
      console.log('[ModuleInstaller] Step 1: Preparing source...')
      await this.prepareSource(source, tempPath)

      // 2. 解析和验证
      console.log('[ModuleInstaller] Step 2: Validating module...')
      const info = await this.validator.validate(tempPath)
      console.log('[ModuleInstaller] Module info:', JSON.stringify(info, null, 2))

      // 3. 检查是否已存在
      const existing = this.agentManager.getImplementation(info.module_id)
      if (existing && !options.overwrite) {
        throw new Error(
          `Module ${info.module_id} already exists. Use overwrite option to replace it.`
        )
      }

      // 4. 检查运行时
      console.log('[ModuleInstaller] Step 3: Checking runtime...')
      const runtimeOk = await this.runtimeManager.checkRuntime(
        info.runtime.type,
        info.runtime.version
      )
      if (!runtimeOk) {
        throw new Error(
          `Runtime ${info.runtime.type} ${info.runtime.version || ''} not available`
        )
      }

      // 5. 安装依赖
      if (info.install) {
        console.log('[ModuleInstaller] Step 4: Installing dependencies...')
        await this.runtimeManager.runInstall(
          info.install,
          tempPath,
          info.runtime.type,
          options.timeout
        )
      }

      // 6. 构建
      if (info.build) {
        console.log('[ModuleInstaller] Step 5: Building...')
        await this.runtimeManager.runBuild(
          info.build,
          tempPath,
          info.runtime.type,
          options.timeout
        )
      }

      // 7. 验证 entry 文件存在
      console.log('[ModuleInstaller] Step 6: Validating entry file...')
      const entryExists = await this.validator.validateEntryExists(tempPath, info.entry)
      if (!entryExists) {
        throw new Error(`Entry file not found: ${info.entry}`)
      }

      // 8. 移动到安装目录
      console.log('[ModuleInstaller] Step 7: Moving to installed directory...')
      const installedPath = path.join(this.installedDir, info.module_id)

      // 如果已存在，先删除
      if (existing) {
        await this.removeDirectory(installedPath)
      }

      await fs.rename(tempPath, installedPath)

      // 9. 创建 AgentImplementation
      console.log('[ModuleInstaller] Step 8: Creating implementation record...')
      const implementation: AgentImplementation = {
        id: info.module_id,
        name: info.name,
        type: 'installed',
        implementation_type: 'full_code',
        engine: info.agent!.engine,
        supported_roles: info.agent!.supported_roles,
        model_format: info.agent!.model_format,
        model_roles: info.agent!.model_roles,
        source: source.type === 'local'
          ? { type: 'local', path: source.path }
          : { type: 'git', path: source.url, ref: source.ref },
        installed_path: installedPath,
        version: info.version,
        installed_at: generateTimestamp(),
        created_at: generateTimestamp(),
        updated_at: generateTimestamp(),
      }

      await this.agentManager.addImplementation(implementation)

      console.log('[ModuleInstaller] Installation completed successfully')
      return implementation
    } catch (error) {
      console.error('[ModuleInstaller] Installation failed:', error)
      // 清理临时目录
      await this.cleanup(tempPath)
      throw error
    } finally {
      this.installing = false
    }
  }

  /**
   * 获取 RuntimeManager 实例
   */
  getRuntimeManager(): RuntimeManager {
    return this.runtimeManager
  }

  /**
   * 卸载模块
   */
  async uninstall(implementationId: string): Promise<void> {
    const implementation = this.agentManager.getImplementation(implementationId)
    if (!implementation) {
      throw new Error(`Implementation not found: ${implementationId}`)
    }

    if (implementation.type === 'builtin') {
      throw new Error('Cannot uninstall builtin implementation')
    }

    // 检查是否有实例使用此实现
    const instances = this.agentManager.listInstances({
      implementation_id: implementationId,
      page: 1,
      page_size: 1,
    })
    if (instances.items.length > 0) {
      throw new Error(
        `Cannot uninstall implementation with ${instances.items.length} active instances`
      )
    }

    // 删除安装目录
    if (implementation.installed_path) {
      await this.removeDirectory(implementation.installed_path)
    }

    // 删除实现记录
    await this.agentManager.removeImplementation(implementationId)

    console.log(`[ModuleInstaller] Uninstalled: ${implementationId}`)
  }

  /**
   * 准备源代码
   */
  private async prepareSource(source: ModuleSource, targetPath: string): Promise<void> {
    switch (source.type) {
      case 'local':
        await this.copyLocal(source.path, targetPath)
        break

      case 'git':
        await this.cloneGit(source.url, targetPath, source.ref)
        break

      default:
        throw new Error(`Unsupported source type: ${(source as any).type}`)
    }
  }

  /**
   * 复制本地目录
   */
  private async copyLocal(sourcePath: string, targetPath: string): Promise<void> {
    console.log(`[ModuleInstaller] Copying from local: ${sourcePath}`)

    // 检查源目录是否存在
    try {
      await fs.access(sourcePath)
    } catch {
      throw new Error(`Source path not found: ${sourcePath}`)
    }

    // 递归复制
    await this.copyDirectory(sourcePath, targetPath)
  }

  /**
   * 克隆 Git 仓库
   */
  private async cloneGit(url: string, targetPath: string, ref?: string): Promise<void> {
    console.log(`[ModuleInstaller] Cloning from git: ${url}`)
    if (ref) {
      console.log(`[ModuleInstaller] Ref: ${ref}`)
    }

    const args = ['clone', url, targetPath]
    if (ref) {
      args.push('--branch', ref)
    }

    await this.execCommand('git', args, process.cwd(), 300000)
  }

  /**
   * 创建临时目录
   */
  private async createTempDir(): Promise<string> {
    const timestamp = Date.now()
    const tempPath = path.join(this.tempDir, `install-${timestamp}`)
    await fs.mkdir(tempPath, { recursive: true })
    return tempPath
  }

  /**
   * 清理目录
   */
  private async cleanup(dirPath: string): Promise<void> {
    try {
      await this.removeDirectory(dirPath)
    } catch (error) {
      console.warn(`[ModuleInstaller] Failed to cleanup ${dirPath}:`, error)
    }
  }

  /**
   * 递归复制目录
   */
  private async copyDirectory(source: string, target: string): Promise<void> {
    await fs.mkdir(target, { recursive: true })

    const entries = await fs.readdir(source, { withFileTypes: true })

    for (const entry of entries) {
      const sourcePath = path.join(source, entry.name)
      const targetPath = path.join(target, entry.name)

      if (entry.isDirectory()) {
        await this.copyDirectory(sourcePath, targetPath)
      } else {
        await fs.copyFile(sourcePath, targetPath)
      }
    }
  }

  /**
   * 递归删除目录
   */
  private async removeDirectory(dirPath: string): Promise<void> {
    try {
      await fs.rm(dirPath, { recursive: true, force: true })
    } catch (error) {
      console.warn(`[ModuleInstaller] Failed to remove ${dirPath}:`, error)
    }
  }

  /**
   * 执行命令
   */
  private async execCommand(
    command: string,
    args: string[],
    cwd: string,
    timeout: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`[ModuleInstaller] Executing: ${command} ${args.join(' ')}`)

      const child = spawn(command, args, {
        cwd,
        stdio: 'inherit',
      })

      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`Command timeout after ${timeout}ms: ${command} ${args.join(' ')}`))
      }, timeout)

      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Command failed with code ${code}: ${command} ${args.join(' ')}`))
        }
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }
}
