/**
 * Browser Manager - 管理持久化 Chrome 实例用于 CDP 浏览器自动化
 *
 * 为 Scrapling MCP 集成提供 Chrome DevTools Protocol 连接。
 * Chrome 在任务之间保持运行，通过 `./crabot stop` 清理。
 */

import fs from 'fs/promises'
import { existsSync } from 'fs'
import path from 'path'
import net from 'net'
import os from 'os'
import { spawn, execSync } from 'child_process'
import type { ChildProcess } from 'child_process'

export interface BrowserConfig {
  profile_mode: 'isolated' | 'user'
  cdp_port: number
}

const CDP_BASE_PORT = 9222
const CDP_READY_TIMEOUT_MS = 15_000
const CDP_POLL_INTERVAL_MS = 500
const KILL_TIMEOUT_MS = 5_000

export class BrowserManager {
  private readonly dataDir: string
  private readonly portOffset: number
  private process: ChildProcess | null = null

  constructor(dataDir: string, portOffset: number = 0) {
    this.dataDir = dataDir
    this.portOffset = portOffset
  }

  // ---------------------------------------------------------------------------
  // Getters
  // ---------------------------------------------------------------------------

  get cdpPort(): number {
    return CDP_BASE_PORT + this.portOffset
  }

  get cdpUrl(): string {
    return `http://127.0.0.1:${this.cdpPort}`
  }

  // ---------------------------------------------------------------------------
  // Config persistence
  // ---------------------------------------------------------------------------

  private get configPath(): string {
    return path.join(this.dataDir, 'browser-config.json')
  }

  private get pidPath(): string {
    return path.join(this.dataDir, 'browser', 'chrome.pid')
  }

  private get isolatedProfileDir(): string {
    return path.join(this.dataDir, 'browser', 'profile')
  }

  async loadConfig(): Promise<BrowserConfig> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf-8')
      const stored = JSON.parse(raw) as BrowserConfig
      return {
        ...stored,
        cdp_port: stored.cdp_port + this.portOffset,
      }
    } catch {
      // Default config
      return {
        profile_mode: 'isolated',
        cdp_port: this.cdpPort,
      }
    }
  }

  async saveConfig(config: BrowserConfig): Promise<void> {
    await fs.mkdir(path.dirname(this.configPath), { recursive: true })
    // Store base port without offset
    const toStore: BrowserConfig = {
      ...config,
      cdp_port: config.cdp_port - this.portOffset,
    }
    await fs.writeFile(this.configPath, JSON.stringify(toStore, null, 2), 'utf-8')
  }

  // ---------------------------------------------------------------------------
  // Chrome discovery
  // ---------------------------------------------------------------------------

  private findChromePath(): string | null {
    if (process.platform === 'darwin') {
      const candidates = [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ]
      for (const p of candidates) {
        if (existsSync(p)) return p
      }
      return null
    }

    if (process.platform === 'linux') {
      const names = [
        'google-chrome',
        'google-chrome-stable',
        'chromium-browser',
        'chromium',
      ]
      for (const name of names) {
        try {
          const result = execSync(`which ${name}`, { encoding: 'utf-8' }).trim()
          if (result) return result
        } catch {
          // not found, try next
        }
      }
      return null
    }

    return null
  }

  // ---------------------------------------------------------------------------
  // Process health checks
  // ---------------------------------------------------------------------------

  isAlive(): boolean {
    if (!this.process || this.process.pid == null) return false
    try {
      process.kill(this.process.pid, 0)
      return true
    } catch {
      return false
    }
  }

  isCdpReady(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket()
      const timer = setTimeout(() => {
        socket.destroy()
        resolve(false)
      }, 1_000)

      socket.connect(this.cdpPort, '127.0.0.1', () => {
        clearTimeout(timer)
        socket.destroy()
        resolve(true)
      })

      socket.on('error', () => {
        clearTimeout(timer)
        socket.destroy()
        resolve(false)
      })
    })
  }

  // ---------------------------------------------------------------------------
  // Main entry point
  // ---------------------------------------------------------------------------

  async ensureRunning(): Promise<string> {
    if (this.isAlive() && await this.isCdpReady()) {
      return this.cdpUrl
    }

    // Check if port is occupied by an unknown process
    if (!this.isAlive() && await this.isCdpReady()) {
      throw new Error(
        `CDP port ${this.cdpPort} is already in use by an unknown process. ` +
        `Please free the port or change the CDP port in browser config.`
      )
    }

    await this.start()
    return this.cdpUrl
  }

  // ---------------------------------------------------------------------------
  // Start / Stop
  // ---------------------------------------------------------------------------

  private async start(): Promise<void> {
    const chromePath = this.findChromePath()
    if (!chromePath) {
      throw new Error(
        'Chrome/Chromium not found. Please install Google Chrome or Chromium.'
      )
    }

    const config = await this.loadConfig()

    if (config.profile_mode === 'user') {
      await this.killExistingChrome()
    }

    const profileDir =
      config.profile_mode === 'user'
        ? this.getUserProfileDir()
        : this.isolatedProfileDir

    await fs.mkdir(profileDir, { recursive: true })

    const args = [
      `--remote-debugging-port=${this.cdpPort}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
    ]

    const child = spawn(chromePath, args, {
      detached: true,
      stdio: 'ignore',
    })

    child.unref()
    this.process = child

    // Write PID file
    const pidDir = path.dirname(this.pidPath)
    await fs.mkdir(pidDir, { recursive: true })
    await fs.writeFile(this.pidPath, String(child.pid), 'utf-8')

    // Wait for CDP to become ready
    const deadline = Date.now() + CDP_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (await this.isCdpReady()) return
      await sleep(CDP_POLL_INTERVAL_MS)
    }

    throw new Error(
      `Chrome started but CDP port ${this.cdpPort} did not become ready within ${CDP_READY_TIMEOUT_MS / 1000}s`
    )
  }

  private getUserProfileDir(): string {
    if (process.platform === 'darwin') {
      return path.join(os.homedir(), 'Library', 'Application Support', 'Google', 'Chrome')
    }
    return path.join(os.homedir(), '.config', 'google-chrome')
  }

  private async killExistingChrome(): Promise<void> {
    try {
      if (process.platform === 'darwin') {
        execSync('pkill -f "Google Chrome"', { encoding: 'utf-8' })
      } else {
        execSync('pkill -f "google-chrome|chromium-browser|chromium"', { encoding: 'utf-8' })
      }
    } catch {
      // pkill returns non-zero if no processes matched — that's fine
      return
    }

    // Wait for Chrome to actually exit
    const deadline = Date.now() + KILL_TIMEOUT_MS
    while (Date.now() < deadline) {
      try {
        if (process.platform === 'darwin') {
          execSync('pgrep -f "Google Chrome"', { encoding: 'utf-8' })
        } else {
          execSync('pgrep -f "google-chrome|chromium-browser|chromium"', { encoding: 'utf-8' })
        }
        // Still running, wait
        await sleep(500)
      } catch {
        // pgrep found nothing — Chrome is gone
        return
      }
    }

    throw new Error('Failed to kill existing Chrome processes within 5s')
  }

  async stop(): Promise<void> {
    // Try our managed process first
    if (this.process && this.process.pid != null) {
      await this.killProcess(this.process.pid)
      this.process = null
      await this.cleanupPidFile()
      return
    }

    // Fall back to PID file
    try {
      const pidStr = await fs.readFile(this.pidPath, 'utf-8')
      const pid = parseInt(pidStr.trim(), 10)
      if (!isNaN(pid)) {
        await this.killProcess(pid)
      }
    } catch {
      // PID file doesn't exist or can't be read — nothing to stop
    }

    await this.cleanupPidFile()
  }

  private async killProcess(pid: number): Promise<void> {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Process already gone
      return
    }

    // Wait up to 5s for graceful shutdown
    const deadline = Date.now() + KILL_TIMEOUT_MS
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
        await sleep(500)
      } catch {
        // Process exited
        return
      }
    }

    // Force kill
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone
    }
  }

  private async cleanupPidFile(): Promise<void> {
    try {
      await fs.unlink(this.pidPath)
    } catch {
      // File doesn't exist — fine
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
