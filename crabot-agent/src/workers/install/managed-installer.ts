/**
 * Managed installer（P6-B plan §8）。
 *
 * 语义：
 * - 新版本装进唯一 staging dir（worker-impls/<impl>/tools/versions/<version>），
 *   不动 system PATH、不需要 root；
 * - 安装完成跑 manifest detect 并验证 binary 属于目标 dir/version；
 * - active pointer 临时文件 + 原子 rename；失败保留旧 active；
 * - cancel/timeout 杀完整进程组；Agent 重启把未终态 install 标 interrupted 并隔离 staging；
 * - 同一 impl 同类 mutating operation 互斥。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildScrubbedChildEnv } from '../connections/secret-env.js'
import type { CLIWorkerImplId } from '../types.js'
import { manifestFor, type WorkerInstallManifest } from './manifests.js'

const execFileAsync = promisify(execFile)

export interface InstallResult {
  impl: CLIWorkerImplId
  version: string
  binaryPath: string
}

export class ManagedInstaller {
  private readonly inFlight = new Map<CLIWorkerImplId, Promise<InstallResult>>()

  constructor(private readonly agentDataDir: string) {}

  private versionsDir(impl: CLIWorkerImplId): string {
    return path.join(this.agentDataDir, 'worker-impls', impl, 'tools', 'versions')
  }

  private activePointerPath(impl: CLIWorkerImplId): string {
    return path.join(this.agentDataDir, 'worker-impls', impl, 'tools', 'active.json')
  }

  /** 当前 active binary（无 → undefined；pointer 损坏 fail closed）。 */
  async activeBinary(impl: CLIWorkerImplId): Promise<string | undefined> {
    let raw: string
    try {
      raw = await fs.readFile(this.activePointerPath(impl), 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const pointer = JSON.parse(raw) as { version?: unknown; binary?: unknown }
    if (typeof pointer.version !== 'string' || typeof pointer.binary !== 'string') {
      throw new Error(`[ManagedInstaller] corrupt active pointer for ${impl}`)
    }
    // pointer 必须指向本 impl 的 versions 目录内（防篡改/越界）。
    const resolved = path.resolve(pointer.binary)
    if (!resolved.startsWith(path.resolve(this.versionsDir(impl)) + path.sep)) {
      throw new Error(`[ManagedInstaller] active pointer escapes versions dir for ${impl}`)
    }
    return resolved
  }

  /** 固定 manifest 安装：staging → detect 校验 → 原子切 active。同 impl 互斥。 */
  async install(impl: CLIWorkerImplId): Promise<InstallResult> {
    const existing = this.inFlight.get(impl)
    if (existing) {
      const error = new Error(`install already in flight for ${impl}`)
      ;(error as { code?: string }).code = 'WORKER_OPERATION_CONFLICT'
      throw error
    }
    const run = this.installInternal(impl)
    this.inFlight.set(impl, run)
    try {
      return await run
    } finally {
      this.inFlight.delete(impl)
    }
  }

  private async installInternal(impl: CLIWorkerImplId): Promise<InstallResult> {
    const manifest = manifestFor(impl)
    const staging = path.join(this.versionsDir(impl), `${manifest.pinnedVersion}.staging-${process.pid}`)
    const final = path.join(this.versionsDir(impl), manifest.pinnedVersion)
    await fs.mkdir(staging, { recursive: true, mode: 0o700 })
    try {
      // 固定命令：npm install --prefix <staging> <package>@<pinned>；scrub env 只留网络/proxy 必要项。
      await execFileAsync(
        manifest.installer,
        ['install', '--prefix', staging, '--no-save', '--ignore-scripts', `${manifest.packageId}@${manifest.pinnedVersion}`],
        { env: buildScrubbedChildEnv(), timeout: 300_000, maxBuffer: 4 * 1024 * 1024 },
      )
      const stagedBinary = path.join(staging, manifest.binaryRelativePath)
      await this.verifyBinary(manifest, stagedBinary, staging)
      // staging → final 原子就位（已有同版本先清）
      await fs.rm(final, { recursive: true, force: true })
      await fs.rename(staging, final)
      const finalBinary = path.join(final, manifest.binaryRelativePath)
      // active pointer：临时文件 + 原子 rename；失败保留旧 active。
      const pointerPath = this.activePointerPath(impl)
      await fs.mkdir(path.dirname(pointerPath), { recursive: true, mode: 0o700 })
      const tmp = `${pointerPath}.tmp-${process.pid}`
      await fs.writeFile(tmp, JSON.stringify({ version: manifest.pinnedVersion, binary: finalBinary }), { mode: 0o600 })
      await fs.rename(tmp, pointerPath)
      return { impl, version: manifest.pinnedVersion, binaryPath: finalBinary }
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
      throw error
    }
  }

  /** detect：binary 可执行、版本输出可读、路径确属目标 dir。 */
  private async verifyBinary(manifest: WorkerInstallManifest, binary: string, expectedDir: string): Promise<void> {
    if (!path.resolve(binary).startsWith(path.resolve(expectedDir) + path.sep)) {
      throw new Error(`[ManagedInstaller] binary escapes staging dir`)
    }
    const { stdout } = await execFileAsync(binary, [...manifest.detectArgs], {
      env: buildScrubbedChildEnv(),
      timeout: 30_000,
    })
    if (!stdout.trim()) throw new Error(`[ManagedInstaller] detect produced empty version output`)
  }

  /** Agent 重启：清理未终态 staging（不自动切 active）。 */
  async reconcileOnStartup(): Promise<void> {
    for (const impl of ['claude-code', 'codex'] as const) {
      let entries: string[]
      try {
        entries = await fs.readdir(this.versionsDir(impl))
      } catch {
        continue
      }
      for (const entry of entries) {
        if (entry.includes('.staging-')) {
          await fs.rm(path.join(this.versionsDir(impl), entry), { recursive: true, force: true }).catch(() => {})
        }
      }
    }
  }
}
