import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate, createPrivateKey } from 'node:crypto'
import { assertVoiceUuid } from 'crabot-shared'

interface TerminalDisk { storage_version: 2; credential_hash?: string; activation_id?: string; activation_pending?: true }
export class TerminalStore {
  private data!: TerminalDisk
  private serial: Promise<unknown> = Promise.resolve()
  constructor(private readonly directory: string) {}
  async load(): Promise<void> {
    const filename = path.join(this.directory, 'terminal.json')
    let original: string, raw: Record<string, unknown>
    try { original = await fs.readFile(filename, 'utf8'); raw = JSON.parse(original) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.save({ storage_version: 2 }); return
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw.credential_hash !== undefined && (typeof raw.credential_hash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.credential_hash)))) throw new Error('Invalid voice pairing data; original file preserved')
    const legacyTls = raw.protocol_version === 2 && typeof raw.cert === 'string' && typeof raw.key === 'string'
    const legacyHash = raw.storage_version === 1 && Object.keys(raw).every(k => ['storage_version', 'credential_hash'].includes(k))
    if (legacyTls || legacyHash) {
      if (legacyTls) { new X509Certificate(raw.cert as string); createPrivateKey(raw.key as string) }
      const backup = filename + (legacyHash ? '.v1.bak' : '.v2.bak')
      try { await fs.writeFile(backup, original, { mode: 0o600, flag: 'wx' }) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      if (await fs.readFile(backup, 'utf8') !== original) throw new Error('Voice pairing backup differs; original file preserved')
      await this.save({ storage_version: 2, ...(raw.credential_hash ? { credential_hash: raw.credential_hash as string } : {}) })
    } else if (raw.storage_version === 2 && Object.keys(raw).every(k => ['storage_version', 'credential_hash', 'activation_id', 'activation_pending'].includes(k))) {
      if (raw.activation_id !== undefined) { assertVoiceUuid(raw.activation_id); if (!raw.credential_hash) throw new Error('Missing activation credential hash') }
      if (raw.activation_pending !== undefined && (raw.activation_pending !== true || !raw.activation_id)) throw new Error('Invalid pending activation')
      this.data = raw as unknown as TerminalDisk
    } else throw new Error('Incompatible voice pairing data; original file preserved')
  }
  get receiptIdentity(): string | undefined { return this.data.credential_hash }
  get paired(): boolean { return !!this.data.credential_hash && !this.data.activation_pending }
  get pendingActivation(): string | undefined { return this.data.activation_pending ? this.data.activation_id : undefined }
  matches(credential: string): boolean {
    const expected = this.data.credential_hash
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) return false
    return timingSafeEqual(Buffer.from(expected, 'hex'), createHash('sha256').update(credential).digest())
  }
  pair(operationId?: string): Promise<string> {
    return this.change(async () => {
      if (operationId !== undefined) assertVoiceUuid(operationId)
      if (this.paired) throw new Error('Terminal is already paired; revoke it first')
      if (this.pendingActivation && this.pendingActivation !== operationId) throw new Error('Pending owner activation differs')
      const credential = randomBytes(32).toString('base64url')
      await this.save({ storage_version: 2, credential_hash: createHash('sha256').update(credential).digest('hex'), ...(operationId ? { activation_id: operationId, activation_pending: true as const } : {}) })
      return credential
    })
  }
  activate(operationId: string): Promise<void> {
    return this.change(async () => {
      assertVoiceUuid(operationId)
      if (this.data.activation_id !== operationId || !this.data.credential_hash) throw new Error('Owner activation differs')
      if (!this.data.activation_pending) return
      const { activation_pending, ...remaining } = this.data
      await this.save(remaining)
    })
  }
  revoke(): Promise<void> { return this.change(() => this.save({ storage_version: 2 })) }
  private change<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation)
    this.serial = result.catch(() => undefined)
    return result
  }
  private async save(data: TerminalDisk): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const filename = path.join(this.directory, 'terminal.json'), tmp = filename + '.' + randomUUID() + '.tmp'
    try { await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 }); await fs.rename(tmp, filename) }
    catch (error) { await fs.rm(tmp, { force: true }).catch(() => undefined); throw error }
    this.data = data
  }
}
