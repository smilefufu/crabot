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

import { promises as fs } from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
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
    /** 化身归属标签（workerId）——runtime 目录名携带，供启动 sweep 识别孤儿。 */
    operationLabel?: string
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
  if (!policy?.connection) return NOOP_ADMISSION

  const translator = findTranslator(impl, policy.connection.mode)
  if (!translator) return NOOP_ADMISSION // 状态面已标 not ready；防御性放行为零注入

  if (policy.connection.mode === 'admin_provider') {
    const resolved = await deps.resolveAdminProviderConnection(impl, status.policy_revision)
    // revision 最终比对：pull 与 resolve 之间 Admin 侧发生变化（provider 轮换等）时，
    // registry 快照 revision ≠ 实时解析 revision → 本次操作拒绝（下轮 pull 收敛）。
    if (status.connection_revision && status.connection_revision !== resolved.connection_revision) {
      throw new Error(`worker connection revision changed for ${impl}; retry after next config pull`)
    }
    const injection = translator.buildInjection({ connection: resolved.connection })
    if (injection.runtimeFiles && Object.keys(injection.runtimeFiles).length > 0) {
      // agent_runtime_file 的 CODEX_HOME 按 **worker** 持久（config.toml 只含 env_key 引用，
      // 不含 credential 明文；真正的 key 在进程 env）：rollout/session 跨化身延续，
      // resume 才找得到 session。每次操作原子覆写内容（连接轮换即更新）。
      // 无 operationLabel（verify 等真一次性操作）才用 op 目录 + dispose。
      if (deps.operationLabel) {
        const home = path.join(deps.runtimeRoot, deps.operationLabel)
        await fs.mkdir(home, { recursive: true, mode: 0o700 })
        for (const [relative, content] of Object.entries(injection.runtimeFiles)) {
          const target = path.resolve(home, relative)
          if (!target.startsWith(home + path.sep)) throw new Error(`runtime file escapes dir: ${relative}`)
          const tmp = `${target}.tmp-${crypto.randomUUID()}`
          await fs.writeFile(tmp, content, { mode: 0o600 })
          await fs.rename(tmp, target)
        }
        return {
          env: { ...injection.env, CODEX_HOME: home },
          connectionRevision: resolved.connection_revision,
          dispose: async () => {}, // worker 级持久，终态不清理（resume 依赖）
        }
      }
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
  const injection = translator.buildInjection({})
  return { env: injection.env, connectionRevision: status.connection_revision, dispose: async () => {} }
}
