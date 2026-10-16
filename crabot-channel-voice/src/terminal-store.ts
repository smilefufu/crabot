import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes, randomUUID, timingSafeEqual, X509Certificate, createPrivateKey } from 'node:crypto'

interface TerminalDisk { storage_version: 1; credential_hash?: string }
export class TerminalStore {
  private data!: TerminalDisk
  constructor(private readonly directory: string) {}
  async load(): Promise<void> {
    let raw: Record<string, unknown>
    try { raw = JSON.parse(await fs.readFile(path.join(this.directory, 'terminal.json'), 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.save({ storage_version: 1 }); return
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw.credential_hash !== undefined && (typeof raw.credential_hash !== 'string' || !/^[a-f0-9]{64}$/.test(raw.credential_hash)))) throw new Error('Invalid voice pairing data; original file preserved')
    if (raw.protocol_version === 2 && typeof raw.cert === 'string' && typeof raw.key === 'string') {
      new X509Certificate(raw.cert); createPrivateKey(raw.key)
      await this.save({ storage_version: 1, ...(raw.credential_hash ? { credential_hash: raw.credential_hash as string } : {}) })
    } else if (raw.storage_version === 1 && Object.keys(raw).every(k => ['storage_version', 'credential_hash'].includes(k))) {
      this.data = raw as unknown as TerminalDisk
    } else throw new Error('Incompatible voice pairing data; original file preserved')
  }
  get paired(): boolean { return !!this.data.credential_hash }
  matches(credential: string): boolean {
    const expected = this.data.credential_hash
    if (!expected || !/^[a-f0-9]{64}$/.test(expected)) return false
    return timingSafeEqual(Buffer.from(expected, 'hex'), createHash('sha256').update(credential).digest())
  }
  async pair(): Promise<string> {
    if (this.paired) throw new Error('Terminal is already paired; revoke it first')
    const credential = randomBytes(32).toString('base64url')
    await this.save({ ...this.data, credential_hash: createHash('sha256').update(credential).digest('hex') })
    return credential
  }
  async revoke(): Promise<void> { const { credential_hash, ...remaining } = this.data; await this.save(remaining) }
  private async save(data: TerminalDisk): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 })
    const filename = path.join(this.directory, 'terminal.json'), tmp = filename + '.' + randomUUID() + '.tmp'
    try { await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 }); await fs.rename(tmp, filename); this.data = data }
    finally { await fs.rm(tmp, { force: true }) }
  }
}
