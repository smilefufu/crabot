/**
 * admin_provider connection revision（P6-B plan §3.4/§7）。
 *
 * opaque、nonsecret：HMAC(私有 key, policy_revision | provider_id | model_id | endpoint |
 * credential 语义材料 | translator 输入)。私有 key 使离线比较不可行；revision 变化即代表
 * 连接语义变化，Agent 侧只把它当 invalidation signal，永不反推内容。
 */

import { createHmac, randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'

export class WorkerConnectionRevisionSigner {
  private key: Buffer | null = null
  private readonly keyPath: string

  constructor(dataDir: string) {
    this.keyPath = path.join(dataDir, 'secrets', 'worker-connection-revision.key')
  }

  private async loadKey(): Promise<Buffer> {
    if (this.key) return this.key
    try {
      const raw = await fs.readFile(this.keyPath)
      if (raw.length >= 32) {
        this.key = raw
        return raw
      }
      throw new Error('worker connection revision key is too short')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const generated = randomBytes(32)
      await fs.mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 })
      const tmpPath = `${this.keyPath}.tmp-${process.pid}`
      await fs.writeFile(tmpPath, generated, { mode: 0o600 })
      await fs.rename(tmpPath, this.keyPath)
      this.key = generated
      return generated
    }
  }

  /** 计算 opaque revision。输入只含语义材料；endpoint/key 经 HMAC 后不可离线比较。 */
  async compute(input: {
    policy_revision: number
    provider_id: string
    model_id: string
    endpoint: string
    credential_material: string
  }): Promise<string> {
    const key = await this.loadKey()
    const canonical = JSON.stringify({
      policy_revision: input.policy_revision,
      provider_id: input.provider_id,
      model_id: input.model_id,
      endpoint: input.endpoint,
      credential_material: input.credential_material,
    })
    return createHmac('sha256', key).update(canonical).digest('hex')
  }
}
