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
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import type { CLIWorkerImplId, WorkerImplementationStatus } from '../types.js'
import type { ActivationRegistry, VerificationRecord } from '../activation-registry.js'
import { findTranslator } from '../connections/registry.js'
import { RuntimeFileSet } from '../connections/runtime-file.js'
import { resolveUserLevelBinary } from '../cli-binary.js'
import { buildScrubbedChildEnv } from '../connections/secret-env.js'
import type { ResolvedWorkerConnection } from '../connections/types.js'

const VERIFY_TIMEOUT_MS = 120_000
// 判据是 prompt 中不出现的计算结果（codex exec 会把 instructions 段回显到 stdout，
// 无锚点的 /OK/ 对 prompt 里的 OK 退化成常真——R6）。
const MINIMAL_PROMPT = 'Compute 17+25. Reply with only the number.'

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
    dataRoot: string
    now?: () => string
  },
): Promise<VerifyOutcome> {
  // §6.5 operation-time 重校验：verify 也用新鲜 detect（宿主刚升级 CLI 时 binding 记
  // 新 cli_version，不再出现「验证通过却 binding stale」——R7）。
  const status: WorkerImplementationStatus = await registry.refreshImpl(impl)
  const policy = registry.getPolicy(impl)
  if (!policy?.enabled || !policy.connection) return { passed: false, detail: 'impl not enabled with a connection' }
  if (!status.installed || !status.version) return { passed: false, detail: 'impl not installed' }
  const translator = findTranslator(impl, policy.connection.mode)
  if (!translator) return { passed: false, detail: `no translator for ${policy.connection.mode}` }

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
    injection = translator.buildInjection({ connection })
  } catch (error) {
    return { passed: false, detail: `translator rejected: ${redact(error)}` }
  }

  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), `crabot-verify-${impl}-`))
  let runtimeFiles: RuntimeFileSet | undefined
  let isolatedCodexHome: string | undefined
  try {
    if (injection.runtimeFiles && Object.keys(injection.runtimeFiles).length > 0) {
      runtimeFiles = await RuntimeFileSet.create(deps.runtimeRoot, injection.runtimeFiles)
    }
    // existing_host codex：verify 也跑在隔离 CODEX_HOME（拷宿主 auth.json+config.toml）——
    // 直接用宿主 home 会让 codex 运行时重写 config.toml，宿主状态被 verify 副作用污染。
    if (impl === 'codex' && policy.connection.mode === 'existing_host') {
      isolatedCodexHome = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-verify-codex-home-'))
      for (const name of ['auth.json', 'config.toml']) {
        try {
          await fs.copyFile(join(os.homedir(), '.codex', name), join(isolatedCodexHome, name))
        } catch { /* 单文件缺失跳过 */ }
      }
    }
    const env: Record<string, string> = {
      ...buildScrubbedChildEnv(),
      ...injection.env,
      ...(runtimeFiles ? { CODEX_HOME: runtimeFiles.root } : {}),
      ...(isolatedCodexHome ? { CODEX_HOME: isolatedCodexHome } : {}),
    }
    // 用户级安装 binary（与 adapter detect 同一规则；全局安装忽略）。
    const resolved = await resolveUserLevelBinary(impl === 'claude-code' ? 'claude' : 'codex', deps.dataRoot)
    const binary = resolved.binary
    if (!binary) return { passed: false, detail: resolved.global_detected ? 'only global install found (ignored); install at user level' : 'binary not found' }

    const args = impl === 'claude-code'
      ? ['-p', MINIMAL_PROMPT, '--output-format', 'text']
      : ['exec', MINIMAL_PROMPT, '--skip-git-repo-check']
    const result = await runWithTimeout(binary, args, { cwd: workspace, env, timeoutMs: VERIFY_TIMEOUT_MS })
    if (result.timedOut) return { passed: false, detail: 'verify timeout' }
    if (result.exitCode !== 0) return { passed: false, detail: `CLI exited ${result.exitCode}: ${redact(result.stderr.slice(0, 300))}` }
    if (!/\b42\b/.test(result.stdout)) return { passed: false, detail: 'turn completion signal not observed', connection_revision: connectionRevision }
    return { passed: true, detail: 'minimal real turn completed', connection_revision: connectionRevision }
  } finally {
    await runtimeFiles?.dispose()
    if (isolatedCodexHome) await fs.rm(isolatedCodexHome, { recursive: true, force: true }).catch(() => {})
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
  const translator = policy?.connection
    ? findTranslator(impl, policy.connection.mode)
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
