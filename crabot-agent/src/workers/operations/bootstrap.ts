/**
 * Grandfather bootstrap transaction — Agent 侧（P6-B plan §12）。
 *
 * 语义：
 * - inspect：对 CLI 做只读 detect，observation 持久化在同 transaction ID 下，可重放（幂等）；
 * - commit：核对 observation 未变 + policy revision 匹配 + CLI 确为 existing_host+enabled，
 *   原子写 grandfathered verification binding（与 inspect 同 CLI version/translator/revision）；
 * - 响应丢失重放同 transaction commit——幂等返回首次结果；不先 rollback；
 * - observation 变化 → 拒绝且不部分 grandfather。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { CLIWorkerImplId } from '../types.js'
import type { ActivationRegistry, VerificationRecord } from '../activation-registry.js'

interface BootstrapTransaction {
  transaction_id: string
  state: 'inspected' | 'committed'
  observation: Partial<Record<CLIWorkerImplId, { installed: boolean; activated: boolean; version?: string }>>
  policy_revision?: number
  created_at: string
  updated_at: string
}

export class GrandfatherBootstrapStore {
  private readonly filePath: string
  private current: BootstrapTransaction | null = null
  private loaded = false

  constructor(agentDataDir: string) {
    this.filePath = path.join(agentDataDir, 'worker-impls', 'bootstrap-transactions.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      this.current = JSON.parse(raw) as BootstrapTransaction
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  get currentTransaction(): BootstrapTransaction | null {
    return this.current
  }

  /** inspect：同 transaction 重放返回既有 observation（幂等）——但仍在 inspected 且
   *  宿主 detect 已变（跨启动升级/重登）时允许重采样更新，否则「重放旧 observation →
   *  commit 核对不符 → 永久卡死」（R5）；committed 后不可变。不同 transaction 拒绝。 */
  async recordInspection(
    transactionId: string,
    observation: BootstrapTransaction['observation'],
  ): Promise<BootstrapTransaction> {
    await this.load()
    if (this.current) {
      if (this.current.transaction_id === transactionId) {
        if (this.current.state === 'inspected' && JSON.stringify(this.current.observation) !== JSON.stringify(observation)) {
          this.current.observation = observation
          this.current.updated_at = new Date().toISOString()
          await this.persist()
        }
        return this.current
      }
      throw new Error(`[GrandfatherBootstrap] another transaction is active: ${this.current.transaction_id}`)
    }
    const now = new Date().toISOString()
    this.current = {
      transaction_id: transactionId,
      state: 'inspected',
      observation,
      created_at: now,
      updated_at: now,
    }
    await this.persist()
    return this.current
  }

  /** commit：observation 与当前 detect 逐项核对在调用方完成；这里原子写 grandfathered binding。 */
  async commit(
    transactionId: string,
    registry: ActivationRegistry,
    bindings: Array<{ impl: CLIWorkerImplId; record: VerificationRecord }>,
    policyRevision: number,
  ): Promise<BootstrapTransaction> {
    await this.load()
    if (!this.current || this.current.transaction_id !== transactionId) {
      throw new Error('[GrandfatherBootstrap] unknown transaction')
    }
    if (this.current.state === 'committed') return this.current // 重放幂等
    for (const { impl, record } of bindings) {
      await registry.recordVerification(impl, record)
    }
    this.current.state = 'committed'
    this.current.policy_revision = policyRevision
    this.current.updated_at = new Date().toISOString()
    await this.persist()
    return this.current
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 })
    const tmpPath = `${this.filePath}.tmp-${process.pid}`
    await fs.writeFile(tmpPath, JSON.stringify(this.current), { mode: 0o600 })
    await fs.rename(tmpPath, this.filePath)
  }
}
