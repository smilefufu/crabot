import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

export type ConfigDomain = 'models' | 'image' | 'mcp' | 'skills' | 'subagents' | 'worker_implementations' | 'behavior'
export interface CoreAgentConfigRevisionRecord { schema_version: 1; revision: number; semantic_fingerprint_hmac: string; updated_at: string }
export interface CoreAgentConfigMutationOutboxRecord { mutation_id: string; target_revision: number; domains: ConfigDomain[]; before_fingerprint_hmac: string; after_fingerprint_hmac: string; state: 'prepared'|'data_persisted'|'committed' }

async function atomicWrite(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  const handle = await fs.open(tmp, 'w', 0o600)
  try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync() } finally { await handle.close() }
  await fs.rename(tmp, file)
}

export class CoreAgentConfigRevisionStore {
  private readonly recordPath: string
  private readonly outboxPath: string
  private record: CoreAgentConfigRevisionRecord | null = null
  constructor(dataDir: string) {
    this.recordPath = path.join(dataDir, 'config', 'core-agent-config-revision.json')
    this.outboxPath = path.join(dataDir, 'config', 'core-agent-config-mutation-outbox.json')
  }
  async load(): Promise<CoreAgentConfigRevisionRecord> {
    try { this.record = JSON.parse(await fs.readFile(this.recordPath, 'utf8')) as CoreAgentConfigRevisionRecord }
    catch { this.record = { schema_version: 1, revision: 1, semantic_fingerprint_hmac: '', updated_at: new Date().toISOString() }; await atomicWrite(this.recordPath, this.record) }
    if (!this.record || this.record.schema_version !== 1 || !Number.isSafeInteger(this.record.revision) || this.record.revision < 1) throw new Error('Invalid core Agent config revision')
    return this.record
  }
  async current(): Promise<CoreAgentConfigRevisionRecord> { return this.record ?? this.load() }
  async commit(domains: ConfigDomain[], before: string, after: string): Promise<CoreAgentConfigRevisionRecord> {
    const current = await this.current(); const next = current.revision + 1
    const outbox: CoreAgentConfigMutationOutboxRecord = { mutation_id: crypto.randomUUID(), target_revision: next, domains, before_fingerprint_hmac: before, after_fingerprint_hmac: after, state: 'prepared' }
    await atomicWrite(this.outboxPath, outbox)
    outbox.state = 'data_persisted'; await atomicWrite(this.outboxPath, outbox)
    this.record = { schema_version: 1, revision: next, semantic_fingerprint_hmac: after, updated_at: new Date().toISOString() }
    await atomicWrite(this.recordPath, this.record)
    outbox.state = 'committed'; await atomicWrite(this.outboxPath, outbox)
    await fs.rm(this.outboxPath, { force: true })
    return this.record
  }
}
