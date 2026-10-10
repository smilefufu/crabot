import 'reflect-metadata'
import { X509CertificateGenerator, cryptoProvider } from '@peculiar/x509'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes, randomUUID, timingSafeEqual, webcrypto, X509Certificate } from 'node:crypto'

interface TerminalDisk { cert: string; key: string; credential_hash?: string }
export class TerminalStore {
  private data!: TerminalDisk
  constructor(private readonly directory: string) {}
  async load(): Promise<void> {
    try { this.data = JSON.parse(await fs.readFile(path.join(this.directory, 'terminal.json'), 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      cryptoProvider.set(webcrypto as unknown as Crypto)
      const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }
      const keys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
      const certificate = await X509CertificateGenerator.createSelfSigned({ serialNumber: randomBytes(16).toString('hex'), name: 'CN=Crabot Voice', notBefore: new Date(Date.now() - 60000), notAfter: new Date(Date.now() + 5 * 365 * 86400000), signingAlgorithm: algorithm, keys: keys as unknown as CryptoKeyPair })
      const privateKey = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
      this.data = { cert: certificate.toString('pem'), key: '-----BEGIN PRIVATE KEY-----\n' + privateKey.toString('base64').match(/.{1,64}/g)!.join('\n') + '\n-----END PRIVATE KEY-----\n' }
      privateKey.fill(0)
      await this.save(this.data)
    }
    new X509Certificate(this.data.cert)
  }
  tls(): { cert: string; key: string } { return { cert: this.data.cert, key: this.data.key } }
  fingerprint(): string { return createHash('sha256').update(new X509Certificate(this.data.cert).raw).digest('hex') }
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
