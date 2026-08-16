/**
 * 模块安装器
 *
 * 负责模块包的安装、卸载流程
 */

import fs from 'fs/promises'
import path from 'path'
import { spawn } from 'child_process'
import { RuntimeManager } from './runtime-manager.js'
import { ModuleValidator } from './module-validator.js'
import type {
  ModuleSource,
  ModulePackageInfo,
} from './types.js'

export class ModuleInstaller {
  private readonly dataDir: string
  private readonly tempDir: string
  private readonly installedDir: string
  private readonly runtimeManager: RuntimeManager
  private readonly validator: ModuleValidator

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.tempDir = path.join(dataDir, 'temp')
    this.installedDir = path.join(dataDir, 'installed-modules')
    this.runtimeManager = new RuntimeManager(process.cwd())
    this.validator = new ModuleValidator()
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.tempDir, { recursive: true })
    await fs.mkdir(this.installedDir, { recursive: true })
  }

  /**
   * 预览模块包信息（不安装）
   */
  /**
   * 获取 RuntimeManager 实例
   */
  getRuntimeManager(): RuntimeManager {
    return this.runtimeManager
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
