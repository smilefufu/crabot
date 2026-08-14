/**
 * Worker implementation desired config store（protocol-admin §3.19.12 / P6-B plan §5）。
 *
 * 语义边界：
 * - Admin 持有 desired config（用户 intent），Agent 持有 observed status/activation registry；
 * - 本 store 只负责 load/validate/原子落盘；revision CAS、core config revision、outbox、
 *   invalidation 全部经 Slice 0 `CoreAgentConfigMutationCoordinator`（见 setMutationRunner），
 *   与其它 domain（mcp/subagents/skills/providers）同一纪律；
 * - 文件 shape 固定三 key（builtin/claude-code/codex），缺/多 key fail closed；
 * - 任何 endpoint/key/token/native auth 内容禁止进入本文件。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type {
  WorkerImplId,
  WorkerImplementationConfig,
  WorkerImplementationPolicy,
} from './types.js'

const WORKER_IMPL_IDS: readonly WorkerImplId[] = ['builtin', 'claude-code', 'codex']

/** 其它 domain manager 同款 runner 签名（Slice 0 coordinator 适配层）。 */
type MutationRunner = (
  domains: ['worker_implementations'],
  computeAfterSemanticSnapshot: () => unknown,
  applySourceMutation: () => Promise<void> | void,
) => Promise<unknown>

export class WorkerImplementationStore {
  private readonly filePath: string
  private cached: WorkerImplementationConfig | null = null
  private mutationRunner: MutationRunner | null = null
  /** CAS 检查 → 候选构造 → coordinator 提交必须在同一临界区（否则两个并发 PUT 同 revision 双成功）。 */
  private updateTail: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'config', 'worker-implementations.json')
  }

  setMutationRunner(runner: MutationRunner): void {
    this.mutationRunner = runner
  }

  /**
   * 加载；文件不存在时原子写 revision 1 安全初始配置（builtin enabled/default，
   * 两个 CLI disabled 且无 connection）。损坏/shape 不符 fail closed。
   */
  async load(): Promise<WorkerImplementationConfig> {
    if (this.cached) return this.cached
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const initial = this.initialConfig()
      await this.persist(initial)
      this.cached = initial
      return initial
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(`worker-implementations.json is not valid JSON`)
    }
    this.assertShape(parsed)
    this.cached = parsed
    return parsed
  }

  getCached(): WorkerImplementationConfig | null {
    return this.cached
  }

  private initialConfig(): WorkerImplementationConfig {
    return {
      revision: 1,
      default_impl: 'builtin',
      implementations: {
        builtin: { enabled: true },
        'claude-code': { enabled: false },
        codex: { enabled: false },
      },
    }
  }

  /** shape 校验（load 用）：固定三 key + 结构不变量。 */
  private assertShape(value: unknown): asserts value is WorkerImplementationConfig {
    const prefix = 'worker-implementations.json'
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${prefix}: not an object`)
    const config = value as Record<string, unknown>
    if (typeof config.revision !== 'number' || !Number.isInteger(config.revision) || config.revision < 1) {
      throw new Error(`${prefix}: revision must be a positive integer`)
    }
    const impls = config.implementations
    if (!impls || typeof impls !== 'object' || Array.isArray(impls)) throw new Error(`${prefix}: implementations must be an object`)
    const keys = Object.keys(impls).sort()
    if (keys.length !== 3 || keys.join(',') !== 'builtin,claude-code,codex') {
      throw new Error(`${prefix}: implementations must have exactly builtin/claude-code/codex keys`)
    }
    if (config.default_impl !== 'builtin' && config.default_impl !== 'claude-code' && config.default_impl !== 'codex') {
      throw new Error(`${prefix}: default_impl must be a WorkerImplId`)
    }
    for (const id of WORKER_IMPL_IDS) {
      this.assertPolicyShape((impls as Record<string, unknown>)[id], `${prefix}.implementations.${id}`)
    }
    const defaultPolicy = (impls as Record<string, WorkerImplementationPolicy>)[config.default_impl as WorkerImplId]
    if (!defaultPolicy.enabled) throw new Error(`${prefix}: default_impl must be enabled`)
  }

  private assertPolicyShape(value: unknown, prefix: string): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${prefix}: not an object`)
    const policy = value as Record<string, unknown>
    if (typeof policy.enabled !== 'boolean') throw new Error(`${prefix}: enabled must be boolean`)
    if (policy.preference !== undefined && typeof policy.preference !== 'string') {
      throw new Error(`${prefix}: preference must be a string`)
    }
    if (policy.connection !== undefined) this.assertConnectionShape(policy.connection, `${prefix}.connection`)
  }

  private assertConnectionShape(value: unknown, prefix: string): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${prefix}: not an object`)
    const connection = value as Record<string, unknown>
    if (connection.mode === 'native_account' || connection.mode === 'existing_host') {
      if (Object.keys(connection).length !== 1) throw new Error(`${prefix}: ${connection.mode} takes no extra fields`)
      return
    }
    if (connection.mode === 'admin_provider') {
      if (typeof connection.provider_id !== 'string' || connection.provider_id.length === 0) {
        throw new Error(`${prefix}: admin_provider requires provider_id`)
      }
      if (typeof connection.model_id !== 'string' || connection.model_id.length === 0) {
        throw new Error(`${prefix}: admin_provider requires model_id`)
      }
      return
    }
    throw new Error(`${prefix}: unknown connection mode`)
  }

  /**
   * PUT 候选校验（在 load shape 之上叠加迁移期/安全不变量）：
   * - revision 必须由 Admin +1（客户端不能指定跳号）；
   * - default 必须 enabled；builtin 不得带 connection；
   * - P6-C 过渡 gate：default_impl 不得从 builtin 改走（UI 同步隐藏/只读）。
   */
  validateCandidate(candidate: WorkerImplementationConfig): void {
    this.assertShape(candidate)
    if (candidate.implementations.builtin.connection !== undefined) {
      throw new Error('builtin implementation must not have a connection')
    }
    if (candidate.default_impl !== 'builtin') {
      throw new Error('default_impl other than builtin is not activated until P6-C selection semantics land')
    }
  }

  /**
   * CAS 写入：expected_revision 必须等于当前 revision；新 revision 由 Admin +1。
   * 经 coordinator 提交（outbox/revision/invalidation 同一事务纪律）。
   */
  async update(expectedRevision: number, mutate: (current: WorkerImplementationConfig) => WorkerImplementationConfig): Promise<WorkerImplementationConfig> {
    const run = this.updateTail.then(() => this.updateSerialized(expectedRevision, mutate))
    this.updateTail = run.then(() => undefined, () => undefined)
    return run
  }

  private async updateSerialized(expectedRevision: number, mutate: (current: WorkerImplementationConfig) => WorkerImplementationConfig): Promise<WorkerImplementationConfig> {
    if (!this.mutationRunner) throw new Error('WorkerImplementationStore mutation runner not wired')
    const current = await this.load()
    if (current.revision !== expectedRevision) {
      const error = new Error(`worker implementation config revision conflict: expected ${expectedRevision}, current ${current.revision}`)
      ;(error as { code?: string }).code = 'ADMIN_WORKER_IMPL_REVISION_CONFLICT'
      throw error
    }
    const candidate = mutate(current)
    candidate.revision = current.revision + 1
    this.validateCandidate(candidate)
    await this.mutationRunner(
      ['worker_implementations'],
      () => this.computeSemanticSnapshotWith(candidate),
      async () => {
        await this.persist(candidate)
        this.cached = candidate
      },
    )
    return candidate
  }

  /** runtime semantic 投影（进入 core semantic snapshot 的 worker_implementations 分量）。 */
  runtimeSemanticEntries(): unknown {
    return this.cached ?? null
  }

  private computeSemanticSnapshotWith(_candidate: WorkerImplementationConfig): unknown {
    // 由 AdminModule 在 setMutationRunner 闭包内基于全局 snapshot 替换该分量；
    // 默认实现只在未替换语义提供者时兜底（候选本身即全量语义）。
    return this.semanticSnapshotComputer ? this.semanticSnapshotComputer(_candidate) : _candidate
  }

  private semanticSnapshotComputer: ((candidate: WorkerImplementationConfig) => unknown) | null = null
  setSemanticSnapshotComputer(computer: (candidate: WorkerImplementationConfig) => unknown): void {
    this.semanticSnapshotComputer = computer
  }

  private async persist(config: WorkerImplementationConfig): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
    const tmpPath = `${this.filePath}.tmp-${crypto.randomUUID()}`
    await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), { mode: 0o600 })
    await fs.rename(tmpPath, this.filePath)
  }
}
