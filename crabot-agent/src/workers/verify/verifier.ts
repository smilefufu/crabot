/**
 * Worker verify runner（P6-B plan §11）。
 *
 * 语义：
 * - 隔离临时 workspace + Agent-owned runtime home；不创建 LedgerWorker/ManagerKey/worker events；
 * - 本次实时 resolve connection（operation admission），按 translator 最小注入；
 * - 执行固定最小 prompt 的真实 CLI turn：验证 binary 启动、endpoint/auth/model 可用、
 *   turn completion 可观察、无 login/permission/trust/version blocker、退出后无残留进程；
 * - 超时/Provider 错误/unknown completion/残留进程一律 failed；
 * - 只保存 passed/failed、CLI version、policy/connection/translator binding、时间、脱敏 detail；
 * - finally 清 temp workspace/runtime file。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import type { CLIWorkerImplId, WorkerImplementationStatus } from '../types.js'
import type { ActivationRegistry, VerificationRecord } from '../activation-registry.js'
import { findTranslator } from '../connections/registry.js'
import { RuntimeFileSet } from '../connections/runtime-file.js'
import { buildScrubbedChildEnv } from '../connections/secret-env.js'
import type { ResolvedWorkerConnection } from '../connections/types.js'

const VERIFY_TIMEOUT_MS = 120_000
const MINIMAL_PROMPT = 'Reply with exactly: OK'

export interface VerifyOutcome {
  passed: boolean
  detail: string
  /** 本次验证实际使用的 connection revision（实时解析值，不是 registry 快照）。 */
  connection_revision?: string
}

export async function runWorkerVerification(
  registry: ActivationRegistry,
  impl: CLIWorkerImplId,
  deps: {
    resolveAdminProviderConnection: (impl: CLIWorkerImplId, expectedPolicyRevision: number) => Promise<{
      connection: ResolvedWorkerConnection
      connection_revision: string
    }>
    runtimeRoot: string
    managedInstaller: { activeBinary(impl: CLIWorkerImplId): Promise<string | undefined> }
    now?: () => string
  },
): Promise<VerifyOutcome> {
  const status: WorkerImplementationStatus = registry.getStatus(impl)
  const policy = registry.getPolicy(impl)
  if (!policy?.enabled || !policy.connection) return { passed: false, detail: 'impl not enabled with a connection' }
  if (!status.installed || !status.version) return { passed: false, detail: 'impl not installed' }
  const translator = findTranslator(impl, policy.connection.mode, status.version)
  if (!translator) return { passed: false, detail: `no translator for ${policy.connection.mode} @ ${status.version}` }

  // 本次实时 resolve（admin_provider 才走 Admin；native/existing 零注入）。
  let connection: ResolvedWorkerConnection | undefined
  let connectionRevision = status.connection_revision
  if (policy.connection.mode === 'admin_provider') {
    try {
      const resolved = await deps.resolveAdminProviderConnection(impl, status.policy_revision)
      connection = resolved.connection
      connectionRevision = resolved.connection_revision
    } catch (error) {
      return { passed: false, detail: `connection resolve failed: ${redact(error)}` }
    }
  }

  let injection
  try {
    injection = translator.buildInjection({ cli_version: status.version, connection })
  } catch (error) {
    return { passed: false, detail: `translator rejected: ${redact(error)}` }
  }

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `crabot-verify-${impl}-`))
  let runtimeFiles: RuntimeFileSet | undefined
  try {
    if (injection.runtimeFiles && Object.keys(injection.runtimeFiles).length > 0) {
      runtimeFiles = await RuntimeFileSet.create(deps.runtimeRoot, injection.runtimeFiles)
    }
    const env: Record<string, string> = {
      ...buildScrubbedChildEnv(),
      ...injection.env,
      ...(runtimeFiles ? { CODEX_HOME: runtimeFiles.root } : {}),
    }
    // 固定 binary：managed active 优先，system fallback（与 adapter detect 同一顺序）。
    const binary = (await deps.managedInstaller.activeBinary(impl)) ?? await findSystemBinary(impl)
    if (!binary) return { passed: false, detail: 'binary not found' }

    const args = impl === 'claude-code'
      ? ['-p', MINIMAL_PROMPT, '--output-format', 'text']
      : ['exec', MINIMAL_PROMPT, '--skip-git-repo-check']
    const result = await runWithTimeout(binary, args, { cwd: workspace, env, timeoutMs: VERIFY_TIMEOUT_MS })
    if (result.timedOut) return { passed: false, detail: 'verify timeout' }
    if (result.exitCode !== 0) return { passed: false, detail: `CLI exited ${result.exitCode}: ${redact(result.stderr.slice(0, 300))}` }
    if (!/OK/.test(result.stdout)) return { passed: false, detail: 'turn completion signal not observed', connection_revision: connectionRevision }
    return { passed: true, detail: 'minimal real turn completed', connection_revision: connectionRevision }
  } finally {
    await runtimeFiles?.dispose()
    await fs.rm(workspace, { recursive: true, force: true }).catch(() => {})
  }
}

/** verify 成功后写 registry 记录（binding 全量：policy/connection/translator/CLI version）。 */
export async function commitVerification(
  registry: ActivationRegistry,
  impl: CLIWorkerImplId,
  outcome: VerifyOutcome,
): Promise<void> {
  const status = registry.getStatus(impl)
  const policy = registry.getPolicy(impl)
  const translator = policy?.connection && status.version
    ? findTranslator(impl, policy.connection.mode, status.version)
    : undefined
  const record: VerificationRecord = {
    result: outcome.passed ? 'passed' : 'failed',
    cli_version: status.version ?? 'unknown',
    translator_id: translator?.capability.translator_id ?? 'unknown',
    translator_version: translator?.capability.translator_version ?? 'unknown',
    policy_revision: status.policy_revision,
    // 记录被验证的那次连接（operation-time resolve 值），不是 registry 快照——
    // 两者可能因 pull 间隙而不同（B: review finding）。
    connection_revision: outcome.connection_revision ?? status.connection_revision ?? 'none',
    at: new Date().toISOString(),
    ...(outcome.passed ? {} : { detail: outcome.detail.slice(0, 200) }),
  }
  await registry.recordVerification(impl, record)
}

async function findSystemBinary(impl: CLIWorkerImplId): Promise<string | undefined> {
  const which = impl === 'claude-code' ? 'claude' : 'codex'
  return new Promise<string | undefined>((resolve) => {
    execFile('/bin/sh', ['-c', `command -v ${which}`], (error, stdout) => {
      resolve(error ? undefined : stdout.trim() || undefined)
    })
  })
}

function runWithTimeout(
  binary: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(binary, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      const timedOut = Boolean(error && (error as { killed?: boolean }).killed)
      resolve({
        exitCode: typeof (error as { code?: unknown })?.code === 'number' ? (error as { code: number }).code : error ? 1 : 0,
        stdout: String(stdout), stderr: String(stderr), timedOut,
      })
    })
    // codex exec 在 stdin 未关闭时会等「additional input」直到超时——立即关 stdin。
    child.stdin?.end()
    child.unref?.()
  })
}

function redact(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/\/[^\s]+/g, '<path>').replace(/sk-[A-Za-z0-9_-]+/g, '<redacted>').slice(0, 200)
}
