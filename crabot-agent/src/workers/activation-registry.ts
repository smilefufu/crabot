/**
 * Worker implementation activation registry（P6-B plan §6；protocol-agent-v3 §6.5）。
 *
 * 语义边界：
 * - 这是 ready 的唯一计算点：UI status、`list_worker_implementation_status` RPC、
 *   显式 spawn/resume/handoff gate 全部读这里；禁止任何调用方自己拼 ready。
 * - installed/configured ≠ ready。CLI ready 要求：policy enabled + installed +
 *   connection mode 与当前 CLI 版本声明的 translator 匹配 + verification 为当前绑定下
 *   有效的 passed/grandfathered。builtin 独立：enabled + required model slot 可解析。
 * - desired config 只经 authenticated pull 原子替换；stale revision 拒绝；
 *   running incarnation 不杀，新 resume/handoff 重验。
 * - verification binding 全等才有效：policy_revision + connection_revision +
 *   translator_id/translator_version + cli_version。任一变化即降级 not ready。
 *
 * 持久化（plan §3.3）：只保存脱敏 verification binding/状态，不保存 Provider
 * connection、setup transcript 或任何 credential。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHmac, randomBytes } from 'node:crypto'
import type {
  WorkerAdapter,
  WorkerImplId,
  CLIWorkerImplId,
  WorkerImplementationRuntimeConfig,
  WorkerImplementationStatus,
  WorkerVerificationState,
  WorkerConnectionCapability,
} from './types.js'

export interface VerificationRecord {
  result: 'passed' | 'failed' | 'grandfathered'
  cli_version: string
  translator_id: string
  translator_version: string
  policy_revision: number
  connection_revision: string
  at: string
  /** 脱敏 detail（failed 时）。 */
  detail?: string
}

interface RegistryStateFile {
  version: 1
  verifications: Partial<Record<CLIWorkerImplId, VerificationRecord>>
}

export class WorkerImplementationNotReadyError extends Error {
  readonly code = 'WORKER_IMPLEMENTATION_NOT_READY'
  readonly details: { requested_impl?: WorkerImplId; ready_impls: WorkerImplId[]; reasons: Record<string, string> }
  constructor(requested: WorkerImplId | undefined, ready: WorkerImplId[], reasons: Record<string, string>) {
    super(requested
      ? `Worker implementation not ready: ${requested}`
      : 'No ready worker implementation')
    this.details = { ...(requested ? { requested_impl: requested } : {}), ready_impls: ready, reasons }
  }
}

export class ActivationRegistry {
  private readonly statePath: string
  private readonly keyPath: string
  private adapters: Map<WorkerImplId, WorkerAdapter> = new Map()
  private modelSlotResolvable: () => boolean = () => false
  private desired: WorkerImplementationRuntimeConfig | null = null
  private verifications: Partial<Record<CLIWorkerImplId, VerificationRecord>> = {}
  private snapshots: Map<WorkerImplId, WorkerImplementationStatus> = new Map()
  private hmacKey: Buffer | null = null

  constructor(agentDataDir: string) {
    this.statePath = path.join(agentDataDir, 'worker-impls', 'state.json')
    this.keyPath = path.join(agentDataDir, 'worker-impls', 'native-revision.key')
  }

  setAdapters(adapters: Map<WorkerImplId, WorkerAdapter>): void {
    this.adapters = adapters
  }

  setModelSlotResolvable(check: () => boolean): void {
    this.modelSlotResolvable = check
  }

  isInitialized(): boolean {
    return this.desired !== null
  }

  /** 启动加载持久 verification 状态（文件缺失=全新部署；损坏 fail closed）。 */
  async load(): Promise<void> {
    let raw: string
    try {
      raw = await fs.readFile(this.statePath, 'utf-8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const parsed = JSON.parse(raw) as RegistryStateFile
    if (parsed.version !== 1 || typeof parsed.verifications !== 'object' || parsed.verifications === null) {
      throw new Error('[ActivationRegistry] unsupported state.json shape')
    }
    this.verifications = parsed.verifications
  }

  /**
   * 构造期同步播种（无 detect）：让 registry 立刻可判 builtin gate——
   * builtin ready 只依赖 policy enabled + model slot 可解析（同步可判）；
   * CLI impl 在 detect 重算前一律 not ready（fail closed）。
   * 完整事实由 applyRuntimeConfig 的 detect 重算补全。重复播种同 revision 幂等。
   */
  seedDesired(config: WorkerImplementationRuntimeConfig): void {
    if (this.desired && config.config.revision < this.desired.config.revision) return
    this.desired = config
    const snapshots = new Map<WorkerImplId, WorkerImplementationStatus>()
    for (const impl of ['builtin', 'claude-code', 'codex'] as const) {
      const policy = config.config.implementations[impl]
      const adapter = this.adapters.get(impl)
      const base: WorkerImplementationStatus = {
        impl,
        installed: false,
        configured: policy.connection !== undefined || impl === 'builtin',
        policy_revision: config.config.revision,
        verification: 'never',
        ready: false,
        capabilities: adapter ? adapter.capabilities() : { fork: false, revive: false, goalMode: false, subagent: false, structuredTrace: false },
        connection_capabilities: [],
        observed_at: new Date().toISOString(),
      }
      if (impl === 'builtin' && policy.enabled && this.modelSlotResolvable()) {
        base.installed = true
        base.ready = true
      } else if (impl === 'builtin') {
        base.detail = policy.enabled ? 'required model slot not resolvable' : 'disabled by policy'
      } else {
        base.detail = 'pending detect'
      }
      snapshots.set(impl, base)
    }
    this.snapshots = snapshots
  }

  /**
   * authenticated pull 后原子替换 desired/revisions 并重算。stale revision 拒绝
   * （防御乱序 pull；ConfigLoader.acceptRevision 已是主门禁，这里是 registry 双保险）。
   */
  async applyRuntimeConfig(config: WorkerImplementationRuntimeConfig): Promise<void> {
    if (this.desired && config.config.revision < this.desired.config.revision) {
      throw new Error(`[ActivationRegistry] refusing stale worker implementation config revision ${config.config.revision}`)
    }
    this.desired = config
    await this.recompute()
  }

  /** 当前快照（未 initialized 抛错——调用方据此返回 service unavailable，不假装空）。 */
  listStatus(): WorkerImplementationStatus[] {
    if (!this.desired) throw new Error('[ActivationRegistry] not initialized')
    return [...this.snapshots.values()]
  }

  getStatus(impl: WorkerImplId): WorkerImplementationStatus {
    if (!this.desired) throw new Error('[ActivationRegistry] not initialized')
    const status = this.snapshots.get(impl)
    if (!status) throw new Error(`[ActivationRegistry] unknown impl: ${impl}`)
    return status
  }

  /** 显式 spawn/resume/handoff gate：not ready → 结构化 fail loud。 */
  assertReady(impl: WorkerImplId): void {
    const status = this.getStatus(impl)
    if (status.ready) return
    const ready = this.listStatus().filter((s) => s.ready).map((s) => s.impl)
    const reasons: Record<string, string> = {}
    for (const s of this.listStatus()) reasons[s.impl] = s.detail ?? (s.ready ? 'ready' : 'not ready')
    throw new WorkerImplementationNotReadyError(impl, ready, reasons)
  }

  /** verify runner / grandfather 事务写入 verification 记录（原子落盘）。 */
  async recordVerification(impl: CLIWorkerImplId, record: VerificationRecord): Promise<void> {
    this.verifications[impl] = record
    await this.persist()
    await this.recompute()
  }

  /** native_account/existing_host 的 opaque revision：对非敏感 generation 材料 HMAC。 */
  async computeNativeRevision(impl: CLIWorkerImplId, generationMaterial: string): Promise<string> {
    const key = await this.loadKey()
    return createHmac('sha256', key).update(`${impl}\n${generationMaterial}`).digest('hex')
  }

  private async recompute(): Promise<void> {
    if (!this.desired) return
    const next = new Map<WorkerImplId, WorkerImplementationStatus>()
    for (const impl of ['builtin', 'claude-code', 'codex'] as const) {
      next.set(impl, await this.computeStatus(impl))
    }
    this.snapshots = next
  }

  private async computeStatus(impl: WorkerImplId): Promise<WorkerImplementationStatus> {
    const desired = this.desired!
    const policy = desired.config.implementations[impl]
    const adapter = this.adapters.get(impl)
    const observedAt = new Date().toISOString()
    const base = {
      impl,
      installed: false,
      configured: policy.connection !== undefined || impl === 'builtin',
      policy_revision: desired.config.revision,
      verification: 'never' as WorkerVerificationState,
      ready: false,
      capabilities: adapter ? adapter.capabilities() : { fork: false, revive: false, goalMode: false, subagent: false, structuredTrace: false },
      connection_capabilities: [] as WorkerConnectionCapability[],
      observed_at: observedAt,
    }
    if (!adapter) {
      return { ...base, detail: 'adapter not registered' }
    }

    let detect
    try {
      detect = await adapter.detect()
    } catch (error) {
      return { ...base, detail: `detect failed: ${redactDetail(error)}` }
    }

    if (impl === 'builtin') {
      if (!policy.enabled) return { ...base, installed: detect.installed, detail: 'disabled by policy' }
      if (!this.modelSlotResolvable()) {
        return { ...base, installed: detect.installed, detail: 'required model slot not resolvable' }
      }
      return { ...base, installed: detect.installed, ready: true }
    }

    // CLI impl
    const capabilities = adapter.connectionCapabilities?.() ?? []
    const status: WorkerImplementationStatus = {
      ...base,
      installed: detect.installed,
      version: detect.version,
      install_source: detect.install_source,
      connection_mode: policy.connection?.mode,
      connection_capabilities: capabilities,
    }
    if (!policy.enabled) return { ...status, detail: 'disabled by policy' }
    if (!detect.installed) return { ...status, detail: 'not installed' }
    if (!policy.connection) return { ...status, detail: 'no connection configured' }

    const translator = capabilities.find((cap) => cap.mode === policy.connection!.mode)
    if (!translator) {
      return { ...status, detail: `no translator for connection mode ${policy.connection.mode} at CLI ${detect.version ?? 'unknown'}` }
    }
    status.translator = translator
    status.credential_scope = translator.credential_scope

    // connection revision：admin_provider 由 Admin 下发；native/existing 由 Agent 现算。
    const connectionRevision = policy.connection.mode === 'admin_provider'
      ? desired.connection_revisions[impl]
      : await this.computeNativeRevision(impl, nativeGenerationMaterial(detect))
    status.connection_revision = connectionRevision

    const verification = this.verifications[impl]
    if (!verification) return { ...status, detail: 'never verified' }
    status.verification = verification.result
    status.last_verified_at = verification.at

    const bindingMatches =
      verification.result !== 'failed' &&
      verification.policy_revision === desired.config.revision &&
      verification.connection_revision === connectionRevision &&
      verification.translator_id === translator.translator_id &&
      verification.translator_version === translator.translator_version &&
      verification.cli_version === detect.version
    if (!bindingMatches) {
      return { ...status, detail: 'verification binding stale (revision/translator/CLI changed)' }
    }
    return { ...status, ready: true }
  }

  private async persist(): Promise<void> {
    const state: RegistryStateFile = { version: 1, verifications: this.verifications }
    await fs.mkdir(path.dirname(this.statePath), { recursive: true, mode: 0o700 })
    const tmpPath = `${this.statePath}.tmp-${crypto.randomUUID()}`
    await fs.writeFile(tmpPath, JSON.stringify(state, null, 2), { mode: 0o600 })
    await fs.rename(tmpPath, this.statePath)
  }

  private async loadKey(): Promise<Buffer> {
    if (this.hmacKey) return this.hmacKey
    try {
      const raw = await fs.readFile(this.keyPath)
      if (raw.length >= 32) {
        this.hmacKey = raw
        return raw
      }
      throw new Error('native revision key is too short')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const generated = randomBytes(32)
      await fs.mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 })
      const tmpPath = `${this.keyPath}.tmp-${process.pid}`
      await fs.writeFile(tmpPath, generated, { mode: 0o600 })
      await fs.rename(tmpPath, this.keyPath)
      this.hmacKey = generated
      return generated
    }
  }
}

/** native/existing-host revision 的非敏感 generation 材料：credential 文件存在性+代际（mtime），不读正文。 */
function nativeGenerationMaterial(detect: { activated: boolean; version?: string }): string {
  return `activated=${detect.activated};version=${detect.version ?? 'unknown'}`
}

function redactDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  // 路径/home 等本地信息不进入 status detail。
  return message.replace(/\/[^\s]+/g, '<path>').slice(0, 200)
}
