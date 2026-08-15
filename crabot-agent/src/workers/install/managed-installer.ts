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
import { execFile, type ChildProcess } from 'node:child_process'
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
  private readonly inFlightKillers = new Map<CLIWorkerImplId, () => void>()

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
      // npm 是 node 脚本（nvm 形态 execFile 直跑会 ENOEXEC）——解析真实 cli.js 用当前
      // node 直跑。env scrub 只留网络/proxy 必要项。cancel 可杀当前子进程。
      const npmCli = await this.resolveNpmCli()
      await this.execCancellable(impl, process.execPath,
        [npmCli, 'install', '--prefix', staging, '--no-save', '--ignore-scripts', `${manifest.packageId}@${manifest.pinnedVersion}`],
        { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 })
      if (manifest.postinstall) {
        // 固定 manifest 声明的官方 postinstall（如 claude-code native binary 下载）。
        await this.execCancellable(impl, process.execPath, [path.join(staging, manifest.postinstall)], { timeout: 300_000, cwd: staging })
      }
      const stagedBinary = path.join(staging, manifest.binaryRelativePath)
      await this.verifyBinary(manifest, stagedBinary, staging)
      // staging → final 三段式：旧 final 先 rename 到 backup，新目录就位后再删 backup——
      // 任何一步失败都 rename 回去，不存在「旧 active 已删、新目录没就位」的窗口
      //（同版本重装时旧 active 可能正在服务 running incarnation）。
      const backup = `${final}.backup-${process.pid}`
      const hadFinal = await fs.access(final).then(() => true).catch(() => false)
      if (hadFinal) await fs.rename(final, backup)
      try {
        await fs.rename(staging, final)
      } catch (error) {
        if (hadFinal) await fs.rename(backup, final).catch(() => {})
        throw error
      }
      if (hadFinal) await fs.rm(backup, { recursive: true, force: true }).catch(() => {})
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

  /** 可被 cancelInFlight 终止的 execFile（cancel 时 SIGKILL 当前子进程，Promise 以错收口）。 */
  private execCancellable(
    impl: CLIWorkerImplId,
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer?: number; cwd?: string },
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child: ChildProcess = execFile(file, args, {
        ...options,
        env: buildScrubbedChildEnv(),
        killSignal: 'SIGKILL',
      }, (error, stdout, stderr) => {
        this.inFlightKillers.delete(impl)
        if (error) reject(error)
        else resolve({ stdout: String(stdout), stderr: String(stderr) })
      })
      this.inFlightKillers.set(impl, () => child.kill('SIGKILL'))
    })
  }

  /** npm cli.js 真实路径（command -v npm → realpath）。找不到 fail loud。 */
  private async resolveNpmCli(): Promise<string> {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', 'command -v npm'], { env: buildScrubbedChildEnv() })
    const bin = stdout.trim()
    if (!bin) throw new Error('[ManagedInstaller] npm not found on PATH')
    const real = await fs.realpath(bin)
    return real
  }

  /** cancel：杀在途 install 的当前子进程（install 流程随后 catch 落 failed/cancelled）。 */
  cancelInFlight(impl: CLIWorkerImplId): void {
    this.inFlightKillers.get(impl)?.()
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
        if (entry.includes('.backup-')) {
          // 崩在 backup→final 换位窗口：final 缺失则把 backup rename 回去（保旧 active），
          // final 在则 backup 是换位成功的残留，删除。
          const backupPath = path.join(this.versionsDir(impl), entry)
          const finalPath = path.join(this.versionsDir(impl), entry.replace(/\.backup-.*$/, ''))
          const finalExists = await fs.access(finalPath).then(() => true).catch(() => false)
          if (finalExists) {
            await fs.rm(backupPath, { recursive: true, force: true }).catch(() => {})
          } else {
            await fs.rename(backupPath, finalPath).catch(() => {})
          }
        }
      }
    }
  }
}
