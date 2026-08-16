/**
 * P6-D：LegacyAgentArchiveStore（protocol-admin §3.18 的唯一实现）。
 *
 * 语义：
 * - archive 只读（除用户显式 delete/uninstall）；raw 只进 export/审计，不进普通 summary。
 * - DELETE 必须显式提交 delete_package/delete_config（至少一个 true），confirmation 逐字等于 archive_id。
 * - 删除走 crash-recoverable journal + tombstone；同 archive+selection 重试返回同一 completed result。
 * - core/builtin 记录拒绝；running/runnable 拒绝；路径必须落在 Admin data 允许根内。
 */

import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { canonicalizeJson } from 'crabot-shared'
import { CoreAgentCutoverStore, type LegacyAgentArchiveRecord } from './core-agent-cutover.js'
import { durableAtomicWriteFile } from './durable-file.js'

export interface LegacyAgentArchiveSummary {
  archive_id: string
  source_kind: LegacyAgentArchiveRecord['source_kind']
  module_id?: string
  archived_at: string
  support_status: 'unsupported_legacy'
  uninstallable: boolean
  display_name?: string
  version?: string
}

export interface DeleteLegacyAgentArchiveParams {
  confirmation: string
  delete_package: boolean
  delete_config: boolean
}

export interface DeleteLegacyAgentArchiveResult {
  archive_id: string
  completed: true
  archive_removed: boolean
  deleted_resources: string[]
  retained_resources: string[]
}

export class LegacyAgentArchiveError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus: number) {
    super(message)
  }
}

/** 一个 archive record 关联的可删除物理资源（逻辑名 → 绝对路径，仅内部用）。 */
interface ArchiveResource {
  logical: string
  absPath: string
}

interface Tombstone {
  archive_id: string
  delete_package: boolean
  delete_config: boolean
  result: DeleteLegacyAgentArchiveResult
  completed_at: string
}

interface Journal {
  archive_id: string
  phase: 'prepared' | 'committed'
  delete_package: boolean
  delete_config: boolean
  /** 待删除的绝对路径（prepared 时确定）。 */
  targets: ArchiveResource[]
  deleted: string[]
  updated_at: string
}

const CORE_IDS = new Set(['crabot-agent', 'default'])

/** 普通 read 的脱敏：raw 中只保留安全的展示字段。 */
function summarize(record: LegacyAgentArchiveRecord, uninstallable: boolean): LegacyAgentArchiveSummary {
  const raw = (record.raw && typeof record.raw === 'object' ? record.raw : {}) as Record<string, unknown>
  const summary: LegacyAgentArchiveSummary = {
    archive_id: record.archive_id,
    source_kind: record.source_kind,
    archived_at: record.archived_at,
    support_status: 'unsupported_legacy',
    uninstallable,
  }
  if (record.module_id) summary.module_id = record.module_id
  if (typeof raw.name === 'string' && raw.name) summary.display_name = raw.name
  else if (typeof raw.instance_id === 'string' && raw.instance_id) summary.display_name = raw.instance_id
  else if (typeof raw.id === 'string' && raw.id) summary.display_name = raw.id
  if (typeof raw.version === 'string' && raw.version) summary.version = raw.version
  return summary
}

function isCoreProtected(record: LegacyAgentArchiveRecord): boolean {
  const raw = (record.raw && typeof record.raw === 'object' ? record.raw : {}) as Record<string, unknown>
  const ids = [record.archive_id, record.source_id, record.module_id, raw.id, raw.instance_id, raw.implementation_id]
    .filter((v): v is string => typeof v === 'string')
  return ids.some((id) => CORE_IDS.has(id))
}

export class LegacyAgentArchiveStore {
  private readonly cutover: CoreAgentCutoverStore
  private readonly dataDir: string
  private readonly tombstonePath: string
  private readonly journalPath: string

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.cutover = new CoreAgentCutoverStore(dataDir)
    this.tombstonePath = path.join(dataDir, 'legacy-agent-tombstones.json')
    this.journalPath = path.join(dataDir, 'migrations', 'legacy-agent-uninstall-journal.json')
  }

  private async readRecords(): Promise<LegacyAgentArchiveRecord[]> {
    // 复用 cutover 的 reader（readArchive 是 private——这里直接读同一文件，保持单一磁盘真相）。
    const archivePath = path.join(this.dataDir, 'legacy-agent-archive.json')
    try {
      const value = JSON.parse(await fs.readFile(archivePath, 'utf8')) as LegacyAgentArchiveRecord[]
      if (!Array.isArray(value)) throw new Error('Invalid legacy Agent archive')
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async readTombstones(): Promise<Map<string, Tombstone>> {
    try {
      const value = JSON.parse(await fs.readFile(this.tombstonePath, 'utf8')) as Tombstone[]
      if (!Array.isArray(value)) throw new Error('Invalid tombstones')
      return new Map(value.map((t) => [`${t.archive_id}|pkg=${t.delete_package}|cfg=${t.delete_config}`, t]))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map()
      throw error
    }
  }

  private async saveTombstones(map: Map<string, Tombstone>): Promise<void> {
    await durableAtomicWriteFile(this.tombstonePath, JSON.stringify(Array.from(map.values()), null, 2))
  }

  /** 资源解析：config → agent-configs/<instance>.json；package → installed_path / installed-modules/<id>。 */
  private resolveResources(record: LegacyAgentArchiveRecord): { config?: ArchiveResource; pkg?: ArchiveResource } {
    const raw = (record.raw && typeof record.raw === 'object' ? record.raw : {}) as Record<string, unknown>
    const out: { config?: ArchiveResource; pkg?: ArchiveResource } = {}
    const instanceId = typeof raw.instance_id === 'string' ? raw.instance_id : (typeof raw.id === 'string' ? raw.id : undefined)
    if (instanceId && /^[A-Za-z0-9_-]+$/.test(instanceId)) {
      out.config = {
        logical: `agent-configs/${instanceId}.json`,
        absPath: path.join(this.dataDir, 'agent-configs', `${instanceId}.json`),
      }
    }
    const installedPath = typeof raw.installed_path === 'string' ? raw.installed_path : undefined
    const installedRoot = path.join(this.dataDir, 'installed-modules')
    if (installedPath) {
      const abs = path.resolve(installedPath)
      if (abs.startsWith(installedRoot + path.sep)) {
        out.pkg = { logical: `installed-modules/${path.basename(abs)}`, absPath: abs }
      }
    }
    return out
  }

  /** 内部/审计用途：带 raw 的全量记录（不用于普通 REST 序列化）。 */
  async readRawRecords(): Promise<LegacyAgentArchiveRecord[]> {
    return this.readRecords()
  }

  async listSummaries(): Promise<LegacyAgentArchiveSummary[]> {
    const records = await this.readRecords()
    return records.map((record) => {
      const resources = this.resolveResources(record)
      const uninstallable = !isCoreProtected(record) && Boolean(resources.config || resources.pkg)
      return summarize(record, uninstallable)
    })
  }

  async getDetail(archiveId: string): Promise<LegacyAgentArchiveSummary> {
    const records = await this.readRecords()
    const record = records.find((r) => r.archive_id === archiveId)
    if (!record) throw new LegacyAgentArchiveError('ADMIN_LEGACY_AGENT_ARCHIVE_NOT_FOUND', `Archive not found: ${archiveId}`, 404)
    const resources = this.resolveResources(record)
    return summarize(record, !isCoreProtected(record) && Boolean(resources.config || resources.pkg))
  }

  /** authenticated export：返回脱敏 raw（现有 backup redaction 规则的最小面：不返回运行凭据）。 */
  async exportRecord(archiveId: string): Promise<unknown> {
    const records = await this.readRecords()
    const record = records.find((r) => r.archive_id === archiveId)
    if (!record) throw new LegacyAgentArchiveError('ADMIN_LEGACY_AGENT_ARCHIVE_NOT_FOUND', `Archive not found: ${archiveId}`, 404)
    const clone = JSON.parse(JSON.stringify(record)) as Record<string, unknown>
    // 脱敏：endpoint/api_key/token 类字段打码（archive 是审计数据，不回流运行凭据）。
    const redact = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(redact)
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          out[k] = /api_?key|token|secret|password/i.test(k) && typeof v === 'string' ? '<redacted>' : redact(v)
        }
        return out
      }
      return value
    }
    clone.raw = redact(record.raw)
    return clone
  }

  private async recoverJournal(): Promise<Journal | null> {
    try {
      const journal = JSON.parse(await fs.readFile(this.journalPath, 'utf8')) as Journal
      return journal
    } catch {
      return null
    }
  }

  private async writeJournal(journal: Journal): Promise<void> {
    journal.updated_at = new Date().toISOString()
    await fs.mkdir(path.dirname(this.journalPath), { recursive: true })
    await durableAtomicWriteFile(this.journalPath, JSON.stringify(journal, null, 2))
  }

  async deleteArchive(
    archiveId: string,
    params: Omit<DeleteLegacyAgentArchiveParams, 'confirmation'> & { confirmation?: string },
    hooks: { isModuleActive?: (moduleId: string) => Promise<boolean> } = {},
  ): Promise<DeleteLegacyAgentArchiveResult> {
    if (!params.delete_package && !params.delete_config) {
      throw new LegacyAgentArchiveError('ADMIN_LEGACY_AGENT_DELETE_SELECTION_REQUIRED', 'delete_package / delete_config 至少一个必须为 true', 400)
    }
    if (params.confirmation !== archiveId) {
      throw new LegacyAgentArchiveError('ADMIN_LEGACY_AGENT_CONFIRMATION_MISMATCH', 'confirmation 必须逐字等于 archive_id', 400)
    }
    const records = await this.readRecords()
    const record = records.find((r) => r.archive_id === archiveId)
    if (!record) {
      // archive 已移除后的重试：查 tombstone 幂等返回
      const tombstones = await this.readTombstones()
      const done = Array.from(tombstones.values()).find((t) => t.archive_id === archiveId && t.delete_package === params.delete_package && t.delete_config === params.delete_config)
      if (done) return done.result
      throw new LegacyAgentArchiveError('ADMIN_LEGACY_AGENT_ARCHIVE_NOT_FOUND', `Archive not found: ${archiveId}`, 404)
    }
    if (isCoreProtected(record)) {
      throw new LegacyAgentArchiveError('ADMIN_LEGACY_AGENT_CORE_PROTECTED', `Archive is core-protected: ${record.archive_id}`, 403)
    }

    // tombstone 幂等：同 archive+selection 直接返回同一结果
    const tombstones = await this.readTombstones()
    const tombKey = `${record.archive_id}|pkg=${params.delete_package}|cfg=${params.delete_config}`
    const existing = tombstones.get(tombKey)
    if (existing) return existing.result

    // still-active 检查（installed_package 带 module_id 时）
    if (record.module_id && hooks.isModuleActive && await hooks.isModuleActive(record.module_id)) {
      throw new LegacyAgentArchiveError('ADMIN_LEGACY_AGENT_STILL_ACTIVE', `Module still active: ${record.module_id}`, 409)
    }

    // crash 恢复：未完成 journal 指向同一 archive+selection 则续跑
    let journal = await this.recoverJournal()
    if (journal && (journal.archive_id !== record.archive_id || journal.delete_package !== params.delete_package || journal.delete_config !== params.delete_config)) {
      throw new LegacyAgentArchiveError('ADMIN_LEGACY_AGENT_DELETE_CONFLICT', '存在未完成的其它 archive 删除 journal', 409)
    }
    if (!journal) {
      const resources = this.resolveResources(record)
      const targets: ArchiveResource[] = []
      if (params.delete_config && resources.config) targets.push(resources.config)
      if (params.delete_package && resources.pkg) targets.push(resources.pkg)
      journal = {
        archive_id: record.archive_id,
        phase: 'prepared',
        delete_package: params.delete_package,
        delete_config: params.delete_config,
        targets,
        deleted: [],
        updated_at: new Date().toISOString(),
      }
      await this.writeJournal(journal)
    }

    // 逐项删除（rename-to-trash 语义简化：直接 rm，archive 本为退役数据；幂等）
    for (const target of journal.targets) {
      if (journal.deleted.includes(target.logical)) continue
      await fs.rm(target.absPath, { recursive: true, force: true })
      journal.deleted.push(target.logical)
      await this.writeJournal(journal)
    }
    journal.phase = 'committed'
    await this.writeJournal(journal)

    // retained：未选中的资源仍在 → summary 保留
    const resources = this.resolveResources(record)
    const retained: string[] = []
    if (!params.delete_config && resources.config) {
      if (await exists(resources.config.absPath)) retained.push(resources.config.logical)
    }
    if (!params.delete_package && resources.pkg) {
      if (await exists(resources.pkg.absPath)) retained.push(resources.pkg.logical)
    }
    const archiveRemoved = retained.length === 0

    const result: DeleteLegacyAgentArchiveResult = {
      archive_id: record.archive_id,
      completed: true,
      archive_removed: archiveRemoved,
      deleted_resources: journal.deleted,
      retained_resources: retained,
    }

    // tombstone 落盘；archive_removed 时从 archive 中移除 record
    tombstones.set(tombKey, {
      archive_id: record.archive_id,
      delete_package: params.delete_package,
      delete_config: params.delete_config,
      result,
      completed_at: new Date().toISOString(),
    })
    await this.saveTombstones(tombstones)
    if (archiveRemoved) {
      const next = records.filter((r) => r.archive_id !== record.archive_id)
      await durableAtomicWriteFile(path.join(this.dataDir, 'legacy-agent-archive.json'), JSON.stringify(next, null, 2))
    }
    await fs.rm(this.journalPath, { force: true })
    return result
  }

  /** cutover store 直通（inventory/archive 追加仍由 CoreAgentCutoverStore 负责）。 */
  get cutoverStore(): CoreAgentCutoverStore {
    return this.cutover
  }
}

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true } catch { return false }
}

/** 稳定 fingerprint 校验辅助（Slice 0 marker 一致性检查用）。 */
export function archiveFingerprint(records: LegacyAgentArchiveRecord[]): string {
  return crypto.createHash('sha256').update(canonicalizeJson(records.map((record) => ({
    archive_id: record.archive_id,
    source_kind: record.source_kind,
    source_id: record.source_id,
    support_status: record.support_status,
    raw: record.raw,
  }))), 'utf8').digest('hex')
}
