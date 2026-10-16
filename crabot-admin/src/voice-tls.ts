import 'reflect-metadata'
import { X509CertificateGenerator, cryptoProvider } from '@peculiar/x509'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, createPrivateKey, randomBytes, randomUUID, webcrypto, X509Certificate } from 'node:crypto'

export interface VoiceTls { cert: string; key: string; fingerprint: string }

/** Admin-owned identity: one atomic file, stable across restarts, never a web DTO. */
export async function loadVoiceTls(adminDataDir: string): Promise<VoiceTls> {
  const directory = adminDataDir, filename = path.join(directory, 'voice-tls.json')
  await fs.mkdir(directory, { recursive: true, mode: 0o700 })
  await fs.chmod(directory, 0o700)
  let data: { cert: string; key: string }
  try { data = JSON.parse(await fs.readFile(filename, 'utf8')) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    cryptoProvider.set(webcrypto as unknown as Parameters<typeof cryptoProvider.set>[0])
    const algorithm = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }
    const keys = await webcrypto.subtle.generateKey(algorithm, true, ['sign', 'verify'])
    const certificate = await X509CertificateGenerator.createSelfSigned({ serialNumber: randomBytes(16).toString('hex'), name: 'CN=Crabot Admin Voice', notBefore: new Date(Date.now() - 60000), notAfter: new Date(Date.now() + 5 * 365 * 86400000), signingAlgorithm: algorithm, keys: keys as unknown as Parameters<typeof X509CertificateGenerator.createSelfSigned>[0]['keys'] })
    const privateKey = Buffer.from(await webcrypto.subtle.exportKey('pkcs8', keys.privateKey))
    data = { cert: certificate.toString('pem'), key: '-----BEGIN PRIVATE KEY-----\n' + privateKey.toString('base64').match(/.{1,64}/g)!.join('\n') + '\n-----END PRIVATE KEY-----\n' }
    privateKey.fill(0)
    const temporary = filename + '.' + randomUUID() + '.tmp'
    try { await fs.writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' }); await fs.rename(temporary, filename) }
    finally { await fs.rm(temporary, { force: true }) }
  }
  const certificate = new X509Certificate(data.cert)
  if (Date.parse(certificate.validFrom) > Date.now() || Date.parse(certificate.validTo) <= Date.now() || !certificate.checkPrivateKey(createPrivateKey(data.key))) throw new Error('Admin voice certificate is invalid')
  await fs.chmod(filename, 0o600)
  return { ...data, fingerprint: createHash('sha256').update(certificate.raw).digest('hex') }
}
