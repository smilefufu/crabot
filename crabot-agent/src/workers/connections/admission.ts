/**
 * Worker operation connection admission（P6-B plan §7；protocol-agent-v3 §6.5）。
 *
 * 每次 spawn/resume/handoff 当前调用内实时解析连接：
 * - admin_provider：经调用方注入的 resolver 走 Admin `resolve_worker_connection`
 *   （callSensitive + runtime bearer，无 RpcTraceContext，不缓存给下一操作）；
 * - native_account/existing_host：无 Admin 往返，零注入（credential 走 CLI 原生 store）。
 *
 * 产出的 env/runtime file 只在本操作内存活；runtime 目录 finally 清理。
 */

import type { ActivationRegistry } from '../activation-registry.js'
import type { CLIWorkerImplId, WorkerImplId, WorkerImplementationStatus } from '../types.js'
import { findTranslator } from './registry.js'
import { RuntimeFileSet } from './runtime-file.js'
import type { ResolvedWorkerConnection } from './types.js'

export interface WorkerConnectionAdmission {
  /** 注入 child env 的最小连接字段（codex admin_provider 含 CODEX_HOME 指向 runtime 目录）。 */
  readonly env: Record<string, string>
  /** 本次操作的 connection revision（spawn 前与 registry binding 最终比对用）。 */
  readonly connectionRevision?: string
  dispose(): Promise<void>
}

const NOOP_ADMISSION: WorkerConnectionAdmission = { env: {}, dispose: async () => {} }

export async function admitWorkerConnection(
  registry: ActivationRegistry,
  impl: WorkerImplId,
  deps: {
    resolveAdminProviderConnection: (impl: CLIWorkerImplId, expectedPolicyRevision: number) => Promise<{
      connection: ResolvedWorkerConnection
      connection_revision: string
    }>
    runtimeRoot: string
  },
): Promise<WorkerConnectionAdmission> {
  if (impl === 'builtin') return NOOP_ADMISSION
  const status: WorkerImplementationStatus = registry.getStatus(impl) // not ready 在 spawn gate 已拦
  const policy = registry.getPolicy(impl)
  if (!policy?.connection || !status.version) return NOOP_ADMISSION

  const translator = findTranslator(impl, policy.connection.mode, status.version)
  if (!translator) return NOOP_ADMISSION // 状态面已标 not ready；防御性放行为零注入

  if (policy.connection.mode === 'admin_provider') {
    const resolved = await deps.resolveAdminProviderConnection(impl, status.policy_revision)
    // revision 最终比对：pull 与 resolve 之间 Admin 侧发生变化（provider 轮换等）时，
    // registry 快照 revision ≠ 实时解析 revision → 本次操作拒绝（下轮 pull 收敛）。
    if (status.connection_revision && status.connection_revision !== resolved.connection_revision) {
      throw new Error(`worker connection revision changed for ${impl}; retry after next config pull`)
    }
    const injection = translator.buildInjection({ cli_version: status.version, connection: resolved.connection })
    if (injection.runtimeFiles && Object.keys(injection.runtimeFiles).length > 0) {
      const files = await RuntimeFileSet.create(deps.runtimeRoot, injection.runtimeFiles)
      return {
        env: { ...injection.env, CODEX_HOME: files.root },
        connectionRevision: resolved.connection_revision,
        dispose: () => files.dispose(),
      }
    }
    return { env: injection.env, connectionRevision: resolved.connection_revision, dispose: async () => {} }
  }

  // native_account / existing_host：零注入，revision 由 registry 状态面给出
  const injection = translator.buildInjection({ cli_version: status.version })
  return { env: injection.env, connectionRevision: status.connection_revision, dispose: async () => {} }
}
