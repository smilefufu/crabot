import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { canonicalizeJson } from 'crabot-shared'

export type ConfigDomain = 'models' | 'image' | 'mcp' | 'skills' | 'subagents' | 'worker_implementations' | 'behavior'

export interface CoreAgentConfigRevisionRecord {
  schema_version: 1
  revision: number
  semantic_fingerprint_hmac: string
  updated_at: string
}

export interface CoreAgentConfigMutationOutboxRecord {
  schema_version: 1
  mutation_id: string
  target_revision: number
  domains: ConfigDomain[]
  before_fingerprint_hmac: string
  after_fingerprint_hmac: string
  state: 'prepared' | 'data_persisted' | 'committed'
  invalidation_pending: boolean
}

export interface ConfigMutationHooks {
  afterPrepared?: () => Promise<void> | void
  afterSourceMutation?: () => Promise<void> | void
  afterRevisionCommit?: () => Promise<void> | void
  afterPublish?: () => Promise<void> | void
}

export interface CoreAgentConfigMutationCoordinatorOptions {
  /** Must return a nonsecret semantic projection. Its values may derive from secrets. */
  readSemanticSnapshot: () => Promise<unknown> | unknown
  publishInvalidation: (payload: { config_revision: number; domains: ConfigDomain[] }) => Promise<void> | void
  hooks?: ConfigMutationHooks
}

async function atomicWriteText(file: string, value: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'w', 0o600)
  try {
    await handle.writeFile(value)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fs.rename(temporary, file)
  await fs.chmod(file, 0o600)
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
  await atomicWriteText(file, JSON.stringify(value, null, 2))
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`Invalid persisted coordinator data at ${path.basename(file)}`)
  }
}

function assertDomains(domains: ConfigDomain[]): void {
  if (!Array.isArray(domains) || domains.length === 0 || new Set(domains).size !== domains.length) throw new Error('Invalid config mutation domains')
}

/**
 * Serializes the only permitted order for core runtime config mutations.
 * Domain managers are intentionally not integrated here yet; callers later supply their
 * semantic projection and source write callback through mutate().
 */
export class CoreAgentConfigMutationCoordinator {
  private readonly configDir: string
  private readonly keyPath: string
  private readonly recordPath: string
  private readonly outboxPath: string
  private readonly options: CoreAgentConfigMutationCoordinatorOptions
  private key: Buffer | null = null
  private record: CoreAgentConfigRevisionRecord | null = null
  private tail: Promise<void> = Promise.resolve()

  constructor(dataDir: string, options: CoreAgentConfigMutationCoordinatorOptions) {
    this.configDir = path.join(dataDir, 'config')
    this.keyPath = path.join(this.configDir, 'core-agent-config-hmac-key')
    this.recordPath = path.join(this.configDir, 'core-agent-config-revision.json')
    this.outboxPath = path.join(this.configDir, 'core-agent-config-mutation-outbox.json')
    this.options = options
  }

  async initialize(): Promise<CoreAgentConfigRevisionRecord> {
    return this.serial(async () => {
      await fs.mkdir(this.configDir, { recursive: true })
      const [storedKey, storedRecord, outbox] = await Promise.all([
        fs.readFile(this.keyPath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error)),
        readJson<CoreAgentConfigRevisionRecord>(this.recordPath),
        readJson<CoreAgentConfigMutationOutboxRecord>(this.outboxPath),
      ])
      if (storedKey === null) {
        if (storedRecord || outbox) throw new Error('Missing core Agent config HMAC key')
        this.key = crypto.randomBytes(32)
        await atomicWriteText(this.keyPath, this.key.toString('base64url'))
      } else {
        const text = storedKey.toString('utf8').trim()
        const key = Buffer.from(text, 'base64url')
        if (key.length !== 32 || key.toString('base64url') !== text) throw new Error('Invalid core Agent config HMAC key')
        this.key = key
      }
      if (!storedRecord) {
        if (outbox) throw new Error('Outbox exists without core Agent config revision')
        const fingerprint = await this.fingerprint()
        this.record = { schema_version: 1, revision: 1, semantic_fingerprint_hmac: fingerprint, updated_at: new Date().toISOString() }
        await atomicWrite(this.recordPath, this.record)
      } else {
        this.assertRecord(storedRecord)
        this.record = storedRecord
      }
      if (outbox) await this.recoverOutbox(outbox, false)
      const liveFingerprint = await this.fingerprint()
      if (!this.equal(liveFingerprint, this.record!.semantic_fingerprint_hmac)) {
        throw new Error('Core Agent config semantic fingerprint does not match committed revision')
      }
      return this.record!
    })
  }

  async current(): Promise<CoreAgentConfigRevisionRecord> {
    if (!this.record) await this.initialize()
    return this.record!
  }

  /**
   * Nonblocking seqlock read for secret resolution. A non-null epoch means no mutation outbox
   * exists at that instant; callers must re-read after all source/resolver work and require the
   * same revision. This deliberately never waits on the mutation mutex: OAuth resolution may
   * itself enter mutate().
   */
  async readCommittedEpoch(): Promise<number | null> {
    await this.current()
    const outbox = await readJson<CoreAgentConfigMutationOutboxRecord>(this.outboxPath)
    if (outbox) {
      this.assertOutbox(outbox)
      return null
    }
    const record = await readJson<CoreAgentConfigRevisionRecord>(this.recordPath)
    if (!record) throw new Error('Missing core Agent config revision')
    this.assertRecord(record)
    return record.revision
  }

  async mutate(
    domains: ConfigDomain[],
    afterSemanticSnapshot: unknown,
    applySourceMutation: () => Promise<void> | void,
  ): Promise<CoreAgentConfigRevisionRecord> {
    return this.mutateComputed(domains, () => afterSemanticSnapshot, applySourceMutation)
  }
  async mutateComputed(
    domains: ConfigDomain[],
    computeAfterSemanticSnapshot: () => Promise<unknown> | unknown,
    applySourceMutation: () => Promise<void> | void,
  ): Promise<CoreAgentConfigRevisionRecord> {
    await this.initialize()
    return this.serial(async () => {
      const current = await this.current()
      assertDomains(domains)
      const before = await this.fingerprint()
      const after = this.fingerprintSnapshot(await computeAfterSemanticSnapshot())
      if (this.equal(before, after)) throw new Error('Config mutation did not change semantic snapshot')
      if (!this.equal(before, current.semantic_fingerprint_hmac)) throw new Error('Core Agent config semantic fingerprint is stale')
      const outbox: CoreAgentConfigMutationOutboxRecord = {
        schema_version: 1, mutation_id: crypto.randomUUID(), target_revision: current.revision + 1,
        domains: [...domains], before_fingerprint_hmac: before, after_fingerprint_hmac: after, state: 'prepared', invalidation_pending: false,
      }
      await atomicWrite(this.outboxPath, outbox)
      await this.options.hooks?.afterPrepared?.()
      await applySourceMutation()
      const observedAfter = await this.fingerprint()
      if (!this.equal(outbox.after_fingerprint_hmac, observedAfter)) throw new Error('Config mutation source did not produce declared semantic snapshot')
      outbox.state = 'data_persisted'
      await atomicWrite(this.outboxPath, outbox)
      await this.options.hooks?.afterSourceMutation?.()
      await this.commitRevision(outbox)
      await this.options.hooks?.afterRevisionCommit?.()
      await this.drainOutbox(outbox)
      return this.record!
    })
  }

  async drainPendingInvalidation(): Promise<void> {
    await this.serial(async () => {
      await this.current()
      const outbox = await readJson<CoreAgentConfigMutationOutboxRecord>(this.outboxPath)
      if (!outbox) return
      this.assertOutbox(outbox)
      await this.recoverOutbox(outbox, true)
    })
  }

  private async recoverOutbox(outbox: CoreAgentConfigMutationOutboxRecord, publish: boolean): Promise<void> {
    this.assertOutbox(outbox)
    const currentFingerprint = await this.fingerprint()
    const isBefore = this.equal(currentFingerprint, outbox.before_fingerprint_hmac)
    const isAfter = this.equal(currentFingerprint, outbox.after_fingerprint_hmac)
    if (outbox.state === 'prepared') {
      if (isBefore) { await fs.rm(this.outboxPath, { force: true }); return }
      if (!isAfter) throw new Error('Ambiguous prepared config mutation recovery')
      outbox.state = 'data_persisted'
      await atomicWrite(this.outboxPath, outbox)
    }
    if (outbox.state === 'data_persisted') {
      if (!isAfter) throw new Error('Config mutation source state does not match outbox')
      await this.commitRevision(outbox)
    }
    if (outbox.state === 'committed') {
      if (!isAfter || !this.record || this.record.revision !== outbox.target_revision || !this.equal(this.record.semantic_fingerprint_hmac, outbox.after_fingerprint_hmac)) {
        throw new Error('Committed config mutation recovery mismatch')
      }
      if (publish) await this.drainOutbox(outbox)
    }
  }

  private async commitRevision(outbox: CoreAgentConfigMutationOutboxRecord): Promise<void> {
    if (!this.record || outbox.target_revision !== this.record.revision + 1 || outbox.after_fingerprint_hmac === '') {
      if (this.record?.revision === outbox.target_revision && this.equal(this.record.semantic_fingerprint_hmac, outbox.after_fingerprint_hmac)) {
        outbox.state = 'committed'; outbox.invalidation_pending = true; await atomicWrite(this.outboxPath, outbox); return
      }
      throw new Error('Invalid config mutation revision transition')
    }
    this.record = { schema_version: 1, revision: outbox.target_revision, semantic_fingerprint_hmac: outbox.after_fingerprint_hmac, updated_at: new Date().toISOString() }
    await atomicWrite(this.recordPath, this.record)
    outbox.state = 'committed'
    outbox.invalidation_pending = true
    await atomicWrite(this.outboxPath, outbox)
  }

  private async drainOutbox(outbox: CoreAgentConfigMutationOutboxRecord): Promise<void> {
    if (!outbox.invalidation_pending) { await fs.rm(this.outboxPath, { force: true }); return }
    await this.options.publishInvalidation({ config_revision: outbox.target_revision, domains: [...outbox.domains] })
    await this.options.hooks?.afterPublish?.()
    outbox.invalidation_pending = false
    await atomicWrite(this.outboxPath, outbox)
    await fs.rm(this.outboxPath, { force: true })
  }

  private assertRecord(record: CoreAgentConfigRevisionRecord): void {
    if (record.schema_version !== 1 || !Number.isSafeInteger(record.revision) || record.revision < 1 || !/^[a-f0-9]{64}$/.test(record.semantic_fingerprint_hmac)) throw new Error('Invalid core Agent config revision')
  }

  private assertOutbox(outbox: CoreAgentConfigMutationOutboxRecord): void {
    if (outbox.schema_version !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(outbox.mutation_id) || !Number.isSafeInteger(outbox.target_revision) || outbox.target_revision < 2 || !['prepared', 'data_persisted', 'committed'].includes(outbox.state) || !Array.isArray(outbox.domains) || outbox.domains.length === 0 || !/^[a-f0-9]{64}$/.test(outbox.before_fingerprint_hmac) || !/^[a-f0-9]{64}$/.test(outbox.after_fingerprint_hmac) || typeof outbox.invalidation_pending !== 'boolean') throw new Error('Invalid core Agent config mutation outbox')
  }

  private fingerprintSnapshot(snapshot: unknown): string {
    if (!this.key) throw new Error('Core Agent config coordinator not initialized')
    return crypto.createHmac('sha256', this.key).update(canonicalizeJson(snapshot), 'utf8').digest('hex')
  }

  private async fingerprint(): Promise<string> {
    return this.fingerprintSnapshot(await this.options.readSemanticSnapshot())
  }

  private equal(left: string, right: string): boolean {
    const a = Buffer.from(left); const b = Buffer.from(right)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }
}

/** Compatibility alias retained only until domain-manager integration is complete. */
export const CoreAgentConfigRevisionStore = CoreAgentConfigMutationCoordinator
