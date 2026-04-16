/**
 * 运行时管理器
 *
 * 负责检查和管理不同运行时环境（Node.js, Python）
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import type { RuntimeType, RuntimeInfo, ModulePackageInfo } from './types.js'

export class RuntimeManager {
  private readonly crabotRoot: string

  constructor(crabotRoot: string) {
    this.crabotRoot = crabotRoot
  }

  /**
   * 检查运行时是否可用
   */
  async checkRuntime(type: RuntimeType, version?: string): Promise<boolean> {
    switch (type) {
      case 'nodejs':
        // Crabot 内置 Node.js，总是可用
        return true

      case 'python':
        // 检查 uv 是否可用
        return this.checkCommand('uv', '--version')

      case 'binary':
        // 二进制无需运行时
        return true

      default:
        return false
    }
  }

  /**
   * 获取运行时信息
   */
  async getRuntimeInfo(type: RuntimeType): Promise<RuntimeInfo> {
    const available = await this.checkRuntime(type)

    switch (type) {
      case 'nodejs':
        return {
          type: 'nodejs',
          version: process.version,
          available: true,
          path: process.execPath,
        }

      case 'python':
        if (!available) {
          return { type: 'python', available: false }
        }

        try {
          const version = await this.getCommandOutput('uv', 'run', 'python', '--version')
          return {
            type: 'python',
            version: version.trim().replace('Python ', ''),
            available: true,
            path: 'uv',
          }
        } catch {
          return { type: 'python', available: false }
        }

      case 'binary':
        return {
          type: 'binary',
          available: true,
        }

      default:
        return { type, available: false }
    }
  }

  /**
   * 创建启动命令
   */
  createStartCommand(
    info: ModulePackageInfo,
    installedPath: string
  ): { command: string; args: string[]; cwd: string; env: Record<string, string> } {
    const env = { ...info.env }

    switch (info.runtime.type) {
      case 'nodejs':
        return {
          command: process.execPath,  // 使用当前 Node.js
          args: [info.entry],
          cwd: installedPath,
          env,
        }

      case 'python':
        return {
          command: 'uv',
          args: ['run', 'python', info.entry],
          cwd: installedPath,
          env,
        }

      case 'binary':
        return {
          command: path.join(installedPath, info.entry),
          args: [],
          cwd: installedPath,
          env,
        }

      default:
        throw new Error(`Unsupported runtime type: ${info.runtime.type}`)
    }
  }

  /**
   * 执行安装命令
   */
  async runInstall(
    command: string,
    cwd: string,
    runtimeType: RuntimeType,
    timeout: number = 300000  // 5 分钟
  ): Promise<void> {
    console.log(`[RuntimeManager] Running install command: ${command}`)
    console.log(`[RuntimeManager] Working directory: ${cwd}`)
    console.log(`[RuntimeManager] Runtime type: ${runtimeType}`)

    await this.execCommand(command, cwd, timeout)
  }

  /**
   * 执行构建命令
   */
  async runBuild(
    command: string,
    cwd: string,
    runtimeType: RuntimeType,
    timeout: number = 600000  // 10 分钟
  ): Promise<void> {
    console.log(`[RuntimeManager] Running build command: ${command}`)
    console.log(`[RuntimeManager] Working directory: ${cwd}`)
    console.log(`[RuntimeManager] Runtime type: ${runtimeType}`)

    await this.execCommand(command, cwd, timeout)
  }

  /**
   * 检查命令是否可用
   */
  private async checkCommand(cmd: string, ...args: string[]): Promise<boolean> {
    try {
      await this.execCommand(`${cmd} ${args.join(' ')}`, process.cwd(), 5000)
      return true
    } catch {
      return false
    }
  }

  /**
   * 获取命令输出
   */
  private async getCommandOutput(cmd: string, ...args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(cmd, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (data) => {
        stdout += data.toString()
      })

      child.stderr?.on('data', (data) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout)
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr}`))
        }
      })

      child.on('error', reject)
    })
  }

  /**
   * 执行命令
   */
  private async execCommand(
    command: string,
    cwd: string,
    timeout: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      // 解析命令和参数
      const parts = command.split(' ')
      const cmd = parts[0]
      const args = parts.slice(1)

      console.log(`[RuntimeManager] Executing: ${cmd} ${args.join(' ')}`)

      const child = spawn(cmd, args, {
        cwd,
        stdio: 'inherit',
        shell: true,
      })

      const timer = setTimeout(() => {
        child.kill()
        reject(new Error(`Command timeout after ${timeout}ms: ${command}`))
      }, timeout)

      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          resolve()
        } else {
          reject(new Error(`Command failed with code ${code}: ${command}`))
        }
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }
}
