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

export interface CoreAgentConfigReadEpoch {
  revision: number
  generation: number
}

export interface CoreAgentConfigMutationContext {
  mutation_id: string
  target_revision: number
  bindSourceJournal: (digest: string) => Promise<void>
  markSourceJournalCleanupCompleted: (digest: string) => Promise<void>
  clearSourceJournalBinding: (digest: string) => Promise<void>
}

export interface CoreAgentConfigMutationReceipt {
  schema_version: 1
  mutation_id: string
  target_revision: number
  domains: ConfigDomain[]
  outcome?: 'committed' | 'aborted'
  source_journal_sha256?: string
  source_journal_hmac?: string
  source_cleanup_completed?: boolean
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
  source_journal_sha256?: string
  source_journal_hmac?: string
  source_cleanup_completed?: boolean
}

export interface ConfigMutationHooks {
  afterPrepared?: () => Promise<void> | void
  afterSourceMutation?: () => Promise<void> | void
  afterRevisionCommit?: () => Promise<void> | void
  afterPublish?: () => Promise<void> | void
  afterEpochOutboxRead?: () => Promise<void> | void
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
  private readonly receiptPath: string
  private readonly options: CoreAgentConfigMutationCoordinatorOptions
  private key: Buffer | null = null
  private record: CoreAgentConfigRevisionRecord | null = null
  private tail: Promise<void> = Promise.resolve()
  private mutationGeneration = 0
  private recoveredMutation: CoreAgentConfigMutationOutboxRecord | null = null

  constructor(dataDir: string, options: CoreAgentConfigMutationCoordinatorOptions) {
    this.configDir = path.join(dataDir, 'config')
    this.keyPath = path.join(this.configDir, 'core-agent-config-hmac-key')
    this.recordPath = path.join(this.configDir, 'core-agent-config-revision.json')
    this.outboxPath = path.join(this.configDir, 'core-agent-config-mutation-outbox.json')
    this.receiptPath = path.join(this.configDir, 'core-agent-config-last-completed.json')
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
   * Nonblocking seqlock read for secret resolution. The in-process generation catches a mutation
   * that starts and finishes while callers resolve sources. Reading the outbox on both sides of
   * the revision catches persisted/recovered writers that are not represented by this process's
   * generation. Callers must compare the complete epoch before and after source resolution.
   */
  async readCommittedEpoch(): Promise<CoreAgentConfigReadEpoch | null> {
    await this.current()
    const generationBefore = this.mutationGeneration
    if (generationBefore % 2 !== 0) return null

    const outboxBefore = await readJson<CoreAgentConfigMutationOutboxRecord>(this.outboxPath)
    if (outboxBefore) {
      this.assertOutbox(outboxBefore)
      return null
    }
    await this.options.hooks?.afterEpochOutboxRead?.()
    const record = await readJson<CoreAgentConfigRevisionRecord>(this.recordPath)
    if (!record) throw new Error('Missing core Agent config revision')
    this.assertRecord(record)
    const outboxAfter = await readJson<CoreAgentConfigMutationOutboxRecord>(this.outboxPath)
    if (outboxAfter) {
      this.assertOutbox(outboxAfter)
      return null
    }

    const generationAfter = this.mutationGeneration
    if (generationAfter !== generationBefore || generationAfter % 2 !== 0) return null
    return { revision: record.revision, generation: generationAfter }
  }

  async mutate(
    domains: ConfigDomain[],
    afterSemanticSnapshot: unknown,
    applySourceMutation: (context: CoreAgentConfigMutationContext) => Promise<void> | void,
  ): Promise<CoreAgentConfigRevisionRecord> {
    return this.mutateComputed(domains, () => afterSemanticSnapshot, applySourceMutation)
  }
  async mutateComputed(
    domains: ConfigDomain[],
    computeAfterSemanticSnapshot: () => Promise<unknown> | unknown,
    applySourceMutation: (context: CoreAgentConfigMutationContext) => Promise<void> | void,
  ): Promise<CoreAgentConfigRevisionRecord> {
    const persistedBeforeInitialize = await readJson<CoreAgentConfigMutationOutboxRecord>(this.outboxPath)
    if (persistedBeforeInitialize) throw new Error('Core Agent config mutation already active')
    const receiptBeforeInitialize = await readJson<CoreAgentConfigMutationReceipt>(this.receiptPath)
    if (receiptBeforeInitialize) {
      await this.ensureKeyReadOnly()
      this.assertReceipt(receiptBeforeInitialize)
      if (receiptBeforeInitialize.source_journal_sha256) throw new Error('Core Agent source journal cleanup is still active')
    }
    await this.initialize()
    return this.serial(async () => {
      const persistedOutbox = await readJson<CoreAgentConfigMutationOutboxRecord>(this.outboxPath)
      if (persistedOutbox) { this.assertOutbox(persistedOutbox); throw new Error('Core Agent config mutation already active') }
      this.mutationGeneration += 1
      try {
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
        let bound = false
        const bindSourceJournal = async (digest: string): Promise<void> => {
          if (bound) throw new Error('Source journal binding already set')
          if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid source journal digest')
          const persisted = await readJson<CoreAgentConfigMutationOutboxRecord>(this.outboxPath)
          if (!persisted) throw new Error('Missing config mutation outbox for source journal binding')
          this.assertOutbox(persisted)
          if (persisted.mutation_id !== outbox.mutation_id || persisted.target_revision !== outbox.target_revision || persisted.state !== 'prepared') throw new Error('Config mutation source journal binding is too late')
          const binding = this.sourceJournalBinding(outbox.mutation_id, outbox.target_revision, outbox.domains, digest)
          persisted.source_journal_sha256 = digest
          persisted.source_journal_hmac = binding
          outbox.source_journal_sha256 = digest
          outbox.source_journal_hmac = binding
          await atomicWrite(this.outboxPath, persisted)
          bound = true
        }
        const markSourceJournalCleanupCompleted = async (digest: string): Promise<void> => {
          if (!bound || digest !== outbox.source_journal_sha256) throw new Error('Source journal binding does not match')
          await this.markSourceJournalCleanupCompleted(outbox.mutation_id, outbox.target_revision, digest)
        }
        const clearSourceJournalBinding = async (digest: string): Promise<void> => {
          if (!bound || digest !== outbox.source_journal_sha256) throw new Error('Source journal binding does not match')
          await this.clearCompletedSourceJournalBinding(outbox.mutation_id, outbox.target_revision, digest)
        }
        await applySourceMutation({ mutation_id: outbox.mutation_id, target_revision: outbox.target_revision, bindSourceJournal, markSourceJournalCleanupCompleted, clearSourceJournalBinding })
        const observedAfter = await this.fingerprint()
        if (!this.equal(outbox.after_fingerprint_hmac, observedAfter)) throw new Error('Config mutation source did not produce declared semantic snapshot')
        outbox.state = 'data_persisted'
        await atomicWrite(this.outboxPath, outbox)
        await this.options.hooks?.afterSourceMutation?.()
        await this.commitRevision(outbox)
        await this.options.hooks?.afterRevisionCommit?.()
        await this.drainOutbox(outbox)
        return this.record!
      } finally {
        this.mutationGeneration += 1
      }
    })
  }

  private async ensureKeyReadOnly(): Promise<void> {
    if (this.key) return
    const raw = await fs.readFile(this.keyPath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!raw) throw new Error('Missing core Agent config HMAC key')
    const text = raw.toString('utf8').trim(); const key = Buffer.from(text, 'base64url')
    if (key.length !== 32 || key.toString('base64url') !== text) throw new Error('Invalid core Agent config HMAC key')
    this.key = key
  }

  async markSourceJournalCleanupCompleted(mutationId: string, targetRevision: number, digest: string): Promise<void> {
    await this.updateSourceJournalBinding(mutationId, targetRevision, digest, 'mark')
  }

  async clearCompletedSourceJournalBinding(mutationId: string, targetRevision: number, digest: string): Promise<void> {
    await this.updateSourceJournalBinding(mutationId, targetRevision, digest, 'clear')
  }

  private async updateSourceJournalBinding(mutationId: string, targetRevision: number, digest: string, action: 'mark' | 'clear'): Promise<void> {
    await this.ensureKeyReadOnly()
    let matched = false
    const update = async <T extends CoreAgentConfigMutationOutboxRecord | CoreAgentConfigMutationReceipt>(file: string, record: T | null): Promise<void> => {
      if (!record) return
      if ('state' in record) this.assertOutbox(record); else this.assertReceipt(record)
      if (record.mutation_id !== mutationId || record.target_revision !== targetRevision || record.source_journal_sha256 !== digest) return
      if (action === 'mark') {
        if ('state' in record && record.state !== 'committed') throw new Error('Source journal cleanup is too early')
        record.source_cleanup_completed = true
        record.source_journal_hmac = this.sourceJournalBinding(record.mutation_id, record.target_revision, record.domains, digest, true)
      } else {
        if (!record.source_cleanup_completed) throw new Error('Source journal cleanup is not completed')
        delete record.source_journal_sha256
        delete record.source_journal_hmac
        delete record.source_cleanup_completed
      }
      await atomicWrite(file, record)
      matched = true
    }
    await update(this.outboxPath, await readJson<CoreAgentConfigMutationOutboxRecord>(this.outboxPath))
    await update(this.receiptPath, await readJson<CoreAgentConfigMutationReceipt>(this.receiptPath))
    if (!matched && action === 'mark') throw new Error('Completed source journal binding does not match')
  }

  async persistedMutationBinding(): Promise<CoreAgentConfigMutationOutboxRecord | CoreAgentConfigMutationReceipt | null> {
    const outbox = await readJson<CoreAgentConfigMutationOutboxRecord>(this.outboxPath)
    const receipt = outbox ? null : await readJson<CoreAgentConfigMutationReceipt>(this.receiptPath)
    if (!outbox && !receipt) return null
    await this.ensureKeyReadOnly()
    if (outbox) { this.assertOutbox(outbox); return outbox }
    this.assertReceipt(receipt!)
    return receipt
  }

  async verifyCommittedFingerprint(): Promise<void> {
    await this.current()
    const live = await this.fingerprint()
    if (!this.equal(live, this.record!.semantic_fingerprint_hmac)) throw new Error('Core Agent config semantic fingerprint does not match committed revision')
  }

  async pendingMutation(): Promise<CoreAgentConfigMutationOutboxRecord | null> {
    await this.current()
    const outbox = await readJson<CoreAgentConfigMutationOutboxRecord>(this.outboxPath)
    if (outbox) this.assertOutbox(outbox)
    return outbox
  }

  async recentRecoveredMutation(): Promise<CoreAgentConfigMutationOutboxRecord | null> {
    await this.current()
    return this.recoveredMutation
  }

  async lastCompletedMutation(): Promise<CoreAgentConfigMutationReceipt | null> {
    await this.current()
    const receipt = await readJson<CoreAgentConfigMutationReceipt>(this.receiptPath)
    if (receipt) this.assertReceipt(receipt)
    return receipt
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
    this.recoveredMutation = { ...outbox, domains: [...outbox.domains] }
    const currentFingerprint = await this.fingerprint()
    const isBefore = this.equal(currentFingerprint, outbox.before_fingerprint_hmac)
    const isAfter = this.equal(currentFingerprint, outbox.after_fingerprint_hmac)
    if (outbox.state === 'prepared') {
      if (isBefore) {
        if (outbox.source_journal_sha256) {
          const receipt: CoreAgentConfigMutationReceipt = {
            schema_version: 1, mutation_id: outbox.mutation_id, target_revision: outbox.target_revision,
            domains: [...outbox.domains], outcome: 'aborted', source_journal_sha256: outbox.source_journal_sha256,
            source_journal_hmac: outbox.source_journal_hmac,
          }
          await atomicWrite(this.receiptPath, receipt)
        }
        await fs.rm(this.outboxPath, { force: true })
        return
      }
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
    const receipt: CoreAgentConfigMutationReceipt = {
      schema_version: 1, mutation_id: outbox.mutation_id, target_revision: outbox.target_revision, domains: [...outbox.domains], outcome: 'committed',
      source_journal_sha256: outbox.source_journal_sha256, source_journal_hmac: outbox.source_journal_hmac,
      source_cleanup_completed: outbox.source_cleanup_completed,
    }
    await atomicWrite(this.receiptPath, receipt)
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

  private sourceJournalBinding(mutationId: string, targetRevision: number, domains: ConfigDomain[], digest: string, cleanupCompleted = false): string {
    if (!this.key) throw new Error('Core Agent config coordinator not initialized')
    return crypto.createHmac('sha256', this.key).update(canonicalizeJson({ mutation_id: mutationId, target_revision: targetRevision, domains, source_journal_sha256: digest, source_cleanup_completed: cleanupCompleted }), 'utf8').digest('hex')
  }

  private assertSourceJournalBinding(record: { mutation_id: string; target_revision: number; domains: ConfigDomain[]; source_journal_sha256?: string; source_journal_hmac?: string; source_cleanup_completed?: boolean }): void {
    if (record.source_journal_sha256 === undefined && record.source_journal_hmac === undefined) {
      if (record.source_cleanup_completed !== undefined) throw new Error('Core Agent config source journal binding mismatch')
      return
    }
    if (!record.source_journal_sha256 || !record.source_journal_hmac || !/^[a-f0-9]{64}$/.test(record.source_journal_sha256) || !/^[a-f0-9]{64}$/.test(record.source_journal_hmac) || (record.source_cleanup_completed !== undefined && typeof record.source_cleanup_completed !== 'boolean') || !this.equal(this.sourceJournalBinding(record.mutation_id, record.target_revision, record.domains, record.source_journal_sha256, record.source_cleanup_completed === true), record.source_journal_hmac)) throw new Error('Core Agent config source journal binding mismatch')
  }

  private assertReceipt(receipt: CoreAgentConfigMutationReceipt): void {
    this.assertSourceJournalBinding(receipt)
    if (receipt.schema_version !== 1 || (receipt.outcome !== undefined && !['committed', 'aborted'].includes(receipt.outcome)) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receipt.mutation_id) || !Number.isSafeInteger(receipt.target_revision) || receipt.target_revision < 2 || !Array.isArray(receipt.domains) || receipt.domains.length === 0 || (receipt.source_journal_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(receipt.source_journal_sha256))) throw new Error('Invalid core Agent config mutation receipt')
  }

  private assertOutbox(outbox: CoreAgentConfigMutationOutboxRecord): void {
    this.assertSourceJournalBinding(outbox)
    if (outbox.schema_version !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(outbox.mutation_id) || !Number.isSafeInteger(outbox.target_revision) || outbox.target_revision < 2 || !['prepared', 'data_persisted', 'committed'].includes(outbox.state) || !Array.isArray(outbox.domains) || outbox.domains.length === 0 || !/^[a-f0-9]{64}$/.test(outbox.before_fingerprint_hmac) || !/^[a-f0-9]{64}$/.test(outbox.after_fingerprint_hmac) || typeof outbox.invalidation_pending !== 'boolean' || (outbox.source_journal_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(outbox.source_journal_sha256))) throw new Error('Invalid core Agent config mutation outbox')
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
