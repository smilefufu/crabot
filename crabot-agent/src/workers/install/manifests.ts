/**
 * Managed install manifest（P6-B plan §8）。
 *
 * 每个 CLI 的 manifest 随 Crabot release 写死：package/允许版本/installer/args/
 * binary 相对路径/detect 命令/setup 命令/进程树收口策略。Browser/RPC 不接受
 * package/version/URL/args/executable——只接受 impl + operation 语义。
 */

import type { CLIWorkerImplId } from '../types.js'

export interface WorkerInstallManifest {
  readonly impl: CLIWorkerImplId
  /** npm artifact ID。 */
  readonly packageId: string
  /** 允许安装的版本（exact pin；升级 = 新 release 更新此处）。 */
  readonly pinnedVersion: string
  /** 安装器 executable（固定 npm）。 */
  readonly installer: 'npm'
  /** binary 在包内的相对路径。 */
  readonly binaryRelativePath: string
  /** detect 命令（binary --version）。 */
  readonly detectArgs: readonly string[]
  /** setup 命令（native_account login）。 */
  readonly setupArgs: readonly string[]
  /**
   * 显式 postinstall（相对 staging 根，经 process.execPath 执行）。
   * claude-code ≥2.x 的 npm 包 bin 是无 shebang 占位壳，真实 native binary 由官方
   * install.cjs 下载就位；--ignore-scripts 安装后必须显式跑这一步。
   */
  readonly postinstall?: string
}

const MANIFESTS: Record<CLIWorkerImplId, WorkerInstallManifest> = {
  'claude-code': {
    impl: 'claude-code',
    packageId: '@anthropic-ai/claude-code',
    pinnedVersion: '2.1.232',
    installer: 'npm',
    binaryRelativePath: 'node_modules/.bin/claude',
    detectArgs: ['--version'],
    setupArgs: ['setup-token'],
    postinstall: 'node_modules/@anthropic-ai/claude-code/install.cjs',
  },
  codex: {
    impl: 'codex',
    packageId: '@openai/codex',
    pinnedVersion: '0.147.0',
    installer: 'npm',
    binaryRelativePath: 'node_modules/.bin/codex',
    detectArgs: ['--version'],
    setupArgs: ['login', '--device-auth'],
  },
}

export function manifestFor(impl: CLIWorkerImplId): WorkerInstallManifest {
  return MANIFESTS[impl]
}
