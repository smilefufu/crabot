/**
 * 固定官方 package 的用户级 CLI 安装器。
 *
 * 这里不维护 Crabot private runtime：npm 只写当前用户 ~/.local，成功后仍以
 * resolveUserLevelBinary() 作为唯一 binary 真相。
 */

import { execFile, type ExecFileOptions } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildScrubbedChildEnv } from '../connections/secret-env.js'
import { resolveUserLevelBinary, type CliBinaryResolution } from '../cli-binary.js'
import type { CLIWorkerImplId, WorkerInstallProfile } from '../types.js'

export interface UserLevelInstallManifest {
  readonly impl: CLIWorkerImplId
  readonly packageId: string
  readonly binaryName: string
  readonly fallbackVersion: string
}

const MANIFESTS: Record<CLIWorkerImplId, UserLevelInstallManifest> = {
  'claude-code': {
    impl: 'claude-code',
    packageId: '@anthropic-ai/claude-code',
    binaryName: 'claude',
    fallbackVersion: '2.1.227',
  },
  codex: {
    impl: 'codex',
    packageId: '@openai/codex',
    binaryName: 'codex',
    fallbackVersion: '0.146.0',
  },
}

export function userLevelInstallManifestFor(impl: CLIWorkerImplId): UserLevelInstallManifest {
  return MANIFESTS[impl]
}

export function packageForInstallProfile(manifest: UserLevelInstallManifest, profile: WorkerInstallProfile): string {
  if (profile === 'latest') return manifest.packageId
  if (profile === 'fallback') return `${manifest.packageId}@${manifest.fallbackVersion}`
  throw new Error('install profile must be latest or fallback')
}

export function userLevelNpmPrefix(homeDir = os.homedir()): string {
  return path.join(homeDir, '.local')
}

export interface InstallCommandOptions {
  env: NodeJS.ProcessEnv
  signal: AbortSignal
  timeout: number
  maxBuffer: number
}

export type InstallCommandRunner = (
  file: string,
  args: readonly string[],
  options: InstallCommandOptions,
) => Promise<{ stdout: string; stderr: string }>

export interface UserLevelInstallerDeps {
  dataRoot: string
  homeDir?: string
  resolveNpmCli?: (env: NodeJS.ProcessEnv) => Promise<string>
  resolveBinary?: (name: string, dataRoot: string, options: { homeDir: string }) => Promise<CliBinaryResolution>
  runCommand?: InstallCommandRunner
}

export interface UserLevelInstallResult {
  impl: CLIWorkerImplId
  version: string
  binaryPath: string
}

const INSTALL_TIMEOUT_MS = 5 * 60_000
const VERSION_TIMEOUT_MS = 30_000
const NPM_REGISTRY = 'https://registry.npmjs.org/'

export class UserLevelInstaller {
  private readonly homeDir: string
  private readonly resolveNpmCli: (env: NodeJS.ProcessEnv) => Promise<string>
  private readonly resolveBinary: NonNullable<UserLevelInstallerDeps['resolveBinary']>
  private readonly runCommand: InstallCommandRunner
  private readonly inFlight = new Map<CLIWorkerImplId, AbortController>()

  constructor(private readonly deps: UserLevelInstallerDeps) {
    this.homeDir = path.resolve(deps.homeDir ?? os.homedir())
    this.resolveNpmCli = deps.resolveNpmCli ?? resolveNpmCli
    this.resolveBinary = deps.resolveBinary ?? ((name, dataRoot, options) => resolveUserLevelBinary(name, dataRoot, options))
    this.runCommand = deps.runCommand ?? runCommand
  }

  async install(impl: CLIWorkerImplId, profile: WorkerInstallProfile): Promise<UserLevelInstallResult> {
    if (this.inFlight.has(impl)) {
      const error = new Error(`install already in flight for ${impl}`)
      ;(error as Error & { code?: string }).code = 'WORKER_OPERATION_CONFLICT'
      throw error
    }
    const controller = new AbortController()
    this.inFlight.set(impl, controller)
    try {
      return await this.installInternal(impl, profile, controller.signal)
    } finally {
      this.inFlight.delete(impl)
    }
  }

  cancelInFlight(impl: CLIWorkerImplId): void {
    this.inFlight.get(impl)?.abort()
  }

  private async installInternal(impl: CLIWorkerImplId, profile: WorkerInstallProfile, signal: AbortSignal): Promise<UserLevelInstallResult> {
    const manifest = userLevelInstallManifestFor(impl)
    const env = buildScrubbedChildEnv()
    const npmCli = await this.resolveNpmCli(env)
    const prefix = userLevelNpmPrefix(this.homeDir)
    await this.runCommand(process.execPath, [
      npmCli,
      'install',
      '--global',
      '--prefix', prefix,
      '--registry', NPM_REGISTRY,
      packageForInstallProfile(manifest, profile),
    ], { env, signal, timeout: INSTALL_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 })

    const resolved = await this.resolveBinary(manifest.binaryName, this.deps.dataRoot, { homeDir: this.homeDir })
    if (!resolved.binary) {
      throw new Error(`installed ${manifest.impl} but no user-level binary was resolved`)
    }
    const version = await this.runCommand(resolved.binary, ['--version'], {
      env,
      signal,
      timeout: VERSION_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
    })
    const value = version.stdout.trim()
    if (!value) throw new Error(`installed ${manifest.impl} produced no version output`)
    return { impl, version: value, binaryPath: resolved.binary }
  }
}

async function resolveNpmCli(env: NodeJS.ProcessEnv): Promise<string> {
  const pathEnv = env.PATH ?? ''
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, 'npm')
    try {
      const stat = await fs.stat(candidate)
      if (!stat.isFile()) continue
      await fs.access(candidate, fs.constants.X_OK)
      return await fs.realpath(candidate)
    } catch {
      // 继续枚举，避免 `command -v` 只看 PATH 首项。
    }
  }
  throw new Error('npm not found on PATH')
}

const runCommand: InstallCommandRunner = (file, args, options) => new Promise((resolve, reject) => {
  const execOptions: ExecFileOptions = {
    env: options.env,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    killSignal: 'SIGKILL',
  }
  let abort = () => {}
  const child = execFile(file, [...args], execOptions, (error, stdout, stderr) => {
    options.signal.removeEventListener('abort', abort)
    if (error) {
      reject(error)
      return
    }
    resolve({ stdout: String(stdout), stderr: String(stderr) })
  })
  abort = () => child.kill('SIGKILL')
  if (options.signal.aborted) abort()
  else options.signal.addEventListener('abort', abort, { once: true })
})
