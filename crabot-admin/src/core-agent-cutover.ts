import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { canonicalizeJson } from 'crabot-shared'
import { durableAtomicWriteFile } from './durable-file.js'

export type LegacyAgentArchiveKind = 'agent_implementation' | 'agent_instance' | 'agent_config' | 'installed_package'

export interface LegacyAgentArchiveRecord {
  archive_id: string
  source_kind: LegacyAgentArchiveKind
  source_id: string
  archived_at: string
  support_status: 'unsupported_legacy'
  raw: unknown
}

export interface AdminCoreAgentCutoverRecord {
  schema_version: 1
  completed: true
  completed_at: string
  archive_fingerprint: string
  archive_record_count: number
  mm_result: unknown
}

async function atomicWrite(file: string, value: unknown): Promise<void> {
  await durableAtomicWriteFile(file, JSON.stringify(value, null, 2))
}

export class CoreAgentCutoverStore {
  private readonly archivePath: string
  private readonly markerPath: string

  constructor(dataDir: string) {
    this.archivePath = path.join(dataDir, 'legacy-agent-archive.json')
    this.markerPath = path.join(dataDir, 'migrations', 'core-agent-singleton-v1.json')
  }

  async archive(sources: Array<{ source_kind: LegacyAgentArchiveKind; source_id: string; raw: unknown }>): Promise<{
    fingerprint: string
    record_count: number
    records: LegacyAgentArchiveRecord[]
  }> {
    const existing = await this.readArchive()
    const byId = new Map(existing.map((record) => [record.archive_id, record]))
    for (const source of sources) {
      const archive_id = `${source.source_kind}:${source.source_id}`
      const archived = byId.get(archive_id)
      if (archived) {
        const same = canonicalizeJson({
          source_kind: archived.source_kind,
          source_id: archived.source_id,
          raw: archived.raw,
        }) === canonicalizeJson({
          source_kind: source.source_kind,
          source_id: source.source_id,
          raw: source.raw,
        })
        if (!same) throw new Error(`Legacy Agent archive conflict: ${archive_id}`)
        continue
      }
      byId.set(archive_id, {
        archive_id,
        source_kind: source.source_kind,
        source_id: source.source_id,
        archived_at: new Date().toISOString(),
        support_status: 'unsupported_legacy',
        raw: source.raw,
      })
    }
    const records = Array.from(byId.values()).sort((left, right) => left.archive_id.localeCompare(right.archive_id))
    await atomicWrite(this.archivePath, records)
    const fingerprint = crypto.createHash('sha256').update(canonicalizeJson(records.map((record) => ({
      archive_id: record.archive_id,
      source_kind: record.source_kind,
      source_id: record.source_id,
      support_status: record.support_status,
      raw: record.raw,
    }))), 'utf8').digest('hex')
    return { fingerprint, record_count: records.length, records }
  }

  async loadMarker(): Promise<AdminCoreAgentCutoverRecord | null> {
    try {
      const value = JSON.parse(await fs.readFile(this.markerPath, 'utf8')) as AdminCoreAgentCutoverRecord
      if (value.schema_version !== 1 || value.completed !== true || typeof value.archive_fingerprint !== 'string' || !Number.isSafeInteger(value.archive_record_count)) {
        throw new Error('Invalid core Agent cutover marker')
      }
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async saveMarker(record: AdminCoreAgentCutoverRecord): Promise<void> {
    await atomicWrite(this.markerPath, record)
  }

  private async readArchive(): Promise<LegacyAgentArchiveRecord[]> {
    try {
      const value = JSON.parse(await fs.readFile(this.archivePath, 'utf8')) as LegacyAgentArchiveRecord[]
      if (!Array.isArray(value)) throw new Error('Invalid legacy Agent archive')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }
}
