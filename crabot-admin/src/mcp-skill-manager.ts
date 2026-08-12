/**
 * MCP Server 和 Skill 注册表管理器
 *
 * 负责全局 MCP Server 和 Skill 的 CRUD、持久化、以及必要工具配置管理
 */

import fs from 'fs/promises'
import path from 'path'
import { createHash, randomBytes } from 'node:crypto'
import AdmZip from 'adm-zip'
import { canonicalizeJson, generateId, generateTimestamp } from 'crabot-shared'
import type { ConfigDomain, CoreAgentConfigMutationContext } from './core-agent-config-revision-store.js'
import type { OnConflict } from './backup/import/import-types.js'

export type RegistryMutationRunner = (
  domains: ConfigDomain[],
  prepareAfterSnapshot: () => Promise<unknown>,
  applySourceMutation: (context: CoreAgentConfigMutationContext) => Promise<void>,
) => Promise<void>

function runtimeMcpEntries(entries: Map<string, MCPServerRegistryEntry>): unknown[] {
  return Array.from(entries.values()).filter((entry) => entry.enabled).map((entry) => JSON.parse(JSON.stringify({
    id: entry.id, name: entry.name, transport: entry.transport, command: entry.command,
    args: entry.args, env: entry.env, url: entry.url, headers: entry.headers, description: entry.description,
  }))).sort((a: any, b: any) => a.id.localeCompare(b.id))
}

const MAX_FILE_SIZE_BYTES = 1 * 1024 * 1024  // 1MB 单文件上限
const MAX_TOTAL_SIZE_BYTES = 5 * 1024 * 1024 // 5MB 总大小上限
const SNAPSHOT_SKIPPED_NAMES = new Set(['SKILL.md', '.skill_dir', '.DS_Store'])

// ============================================================================
// SKILL.md frontmatter 解析
// ============================================================================

export interface ParsedSkillMd {
  name: string
  description: string
  version: string
  tags?: string[]
  body: string
}

export function parseSkillMd(content: string): ParsedSkillMd {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/)
  if (!match) {
    return { name: '', description: '', version: '1.0.0', body: content }
  }
  const meta: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue
    const k = line.slice(0, colonIdx).trim()
    const v = line.slice(colonIdx + 1).trim()
    if (k) meta[k] = v
  }
  let tags: string[] | undefined
  if (meta['tags']) {
    // 支持 "tag1, tag2" 或 "[tag1, tag2]" 格式
    tags = meta['tags'].replace(/[\[\]]/g, '').split(',').map(t => t.trim()).filter(Boolean)
  }
  return {
    name: meta['name'] ?? '',
    description: meta['description'] ?? '',
    version: meta['version'] ?? '1.0.0',
    tags: tags && tags.length > 0 ? tags : undefined,
    body: match[2],
  }
}

// ============================================================================
// 类型定义
// ============================================================================

export interface MCPServerRegistryEntry {
  id: string
  name: string
  description?: string

  /** 传输类型 */
  transport: 'stdio' | 'streamable-http' | 'sse'

  /** stdio 配置（当 transport='stdio' 时使用） */
  command?: string
  args?: string[]
  env?: Record<string, string>

  /** HTTP/SSE 配置（当 transport='streamable-http' 或 'sse' 时使用） */
  url?: string
  headers?: Record<string, string>

  /** 是否为内置（不可删除） */
  is_builtin: boolean
  /** 是否为必要工具（默认提供给 Agent） */
  is_essential: boolean
  /** 是否允许用户禁用 */
  can_disable: boolean
  /** 安装方式 */
  install_method?: 'npm' | 'pip' | 'binary' | 'local'
  /** 来源市场 ID */
  source_market?: string
  /** 来源包名 */
  source_package?: string
  /** 是否启用 */
  enabled: boolean
  created_at: string
  updated_at: string
}

/**
 * 导入时检测到同名 Skill 抛出此错误
 * 调用方可捕获后询问用户是否覆盖，重试时传 overwrite=true
 */
export class DuplicateSkillError extends Error {
  readonly code = 'DUPLICATE_SKILL'
  constructor(
    readonly existing: SkillRegistryEntry,
    readonly incoming: { name: string; description: string; version: string }
  ) {
    super(`Skill "${existing.name}" 已存在（当前 v${existing.version}，上传 v${incoming.version}）`)
    this.name = 'DuplicateSkillError'
  }
}

export interface SkillRegistryEntry {
  id: string
  name: string
  description: string
  version: string
  /** Skill 目录绝对路径（统一用 name 作 basename：builtin 指向 builtins/skills/<name>，imported 指向 <data_dir>/skills/<name>，scanned 指向 ~/.agents/skills/<name>） */
  skill_dir: string
  /** 触发短语（用于 LLM 匹配） */
  trigger_phrases?: string[]
  source_type: 'builtin' | 'imported' | 'scanned'
  is_builtin: boolean
  is_essential: boolean
  can_disable: boolean
  source_market?: string
  source_package?: string
  /** 原始来源 URL（如 GitHub 仓库 URL） */
  source_url?: string
  enabled: boolean
  created_at: string
  updated_at: string
  /**
   * 上一版快照（N=1 覆盖式）。
   * - 缺失/undefined：从未通过 update() 改过 content
   * - 有值：最近一次 update 之前的完整快照
   *
   * 仅 update() 检测到 content 实际变化 + 非 builtin 时写入。
   * 详见 spec 2026-06-07-skill-previous-version-and-diff-design.md §4.1。
   */
  previous_snapshot?: {
    /** 快照目录的相对路径（相对 skillsRoot），形如 .snapshots/<name>-<ts> */
    snapshot_dir: string
    version: string
    updated_at: string
    snapshotted_at: string
  }
}

/** 必要工具配置 */
export interface EssentialToolsConfig {
  /** 内置工具覆盖（仅 can_disable:true 的内置工具） */
  builtin_overrides: Record<string, { enabled: boolean }>
  /** 必要 MCP Server ID 列表（始终提供给 Agent） */
  essential_mcp_server_ids: string[]
  /** 必要 Skill ID 列表（始终注入 Agent system_prompt） */
  essential_skill_ids: string[]
}

// ============================================================================
// MCP Server 管理器
// ============================================================================

export class MCPServerManager {
  private servers: Map<string, MCPServerRegistryEntry> = new Map()
  private readonly filePath: string
  private mutationRunner: RegistryMutationRunner | null = null
  private semanticSnapshotProvider: (() => unknown) | null = null

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'mcp-servers.json')
  }

  async initialize(): Promise<void> {
    await this.initializeLoadOnly()
  }

  async initializeLoadOnly(): Promise<void> {
    await this.load()
  }

  setMutationRunner(runner: RegistryMutationRunner): void { this.mutationRunner = runner }
  setSemanticSnapshotProvider(provider: () => unknown): void { this.semanticSnapshotProvider = provider }

  private async commit(next: Map<string, MCPServerRegistryEntry>): Promise<void> {
    const previous = this.servers
    const apply = async () => { this.servers = next; await this.save() }
    if (!this.mutationRunner) return apply()
    await this.mutationRunner(['mcp'], async () => {
      this.servers = next
      try { return this.semanticSnapshotProvider?.() } finally { this.servers = previous }
    }, apply)
  }

  runtimeSemanticEntries(): unknown[] {
    return runtimeMcpEntries(this.servers)
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const entries: MCPServerRegistryEntry[] = JSON.parse(raw)
      // Migrate: default missing transport to 'stdio' for backward compatibility
      for (const entry of entries) {
        if (!entry.transport) {
          entry.transport = 'stdio'
        }
      }
      this.servers = new Map(entries.map((e) => [e.id, e]))
    } catch {
      this.servers = new Map()
    }
  }

  /**
   * 原子写入文件：先写临时文件，再 rename（避免进程被杀时文件损坏）
   */
  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.tmp`
    await fs.writeFile(tempPath, content, 'utf-8')
    await fs.rename(tempPath, filePath)
  }

  private async save(): Promise<void> {
    const entries = Array.from(this.servers.values())
    await this.atomicWriteFile(this.filePath, JSON.stringify(entries, null, 2))
  }

  list(): MCPServerRegistryEntry[] {
    return Array.from(this.servers.values())
  }

  get(id: string): MCPServerRegistryEntry | undefined {
    return this.servers.get(id)
  }

  async create(params: {
    name: string
    transport?: 'stdio' | 'streamable-http' | 'sse'
    // stdio
    command?: string
    args?: string[]
    env?: Record<string, string>
    // http/sse
    url?: string
    headers?: Record<string, string>
    // meta
    description?: string
    install_method?: MCPServerRegistryEntry['install_method']
    source_market?: string
    source_package?: string
  }): Promise<MCPServerRegistryEntry> {
    const now = generateTimestamp()
    const entry: MCPServerRegistryEntry = {
      id: generateId(),
      name: params.name,
      transport: params.transport ?? 'stdio',
      command: params.command,
      args: params.args,
      env: params.env,
      url: params.url,
      headers: params.headers,
      description: params.description,
      is_builtin: false,
      is_essential: false,
      can_disable: true,
      install_method: params.install_method,
      source_market: params.source_market,
      source_package: params.source_package,
      enabled: true,
      created_at: now,
      updated_at: now,
    }
    const next = new Map(this.servers)
    next.set(entry.id, entry)
    await this.commit(next)
    return entry
  }

  async update(
    id: string,
    params: Partial<
      Pick<
        MCPServerRegistryEntry,
        'name' | 'transport' | 'command' | 'args' | 'env' | 'url' | 'headers' | 'description' | 'is_essential' | 'enabled'
      >
    >
  ): Promise<MCPServerRegistryEntry> {
    const entry = this.servers.get(id)
    if (!entry) throw new Error(`MCP Server not found: ${id}`)
    if (!entry.can_disable && params.enabled === false) {
      throw new Error(`MCP Server "${entry.name}" cannot be disabled`)
    }
    const updated: MCPServerRegistryEntry = {
      ...entry,
      ...params,
      updated_at: generateTimestamp(),
    }
    const currentRuntime = canonicalizeJson(runtimeMcpEntries(this.servers))
    const next = new Map(this.servers)
    next.set(id, updated)
    if (currentRuntime === canonicalizeJson(runtimeMcpEntries(next))) {
      this.servers = next
      await this.save()
      return updated
    }
    await this.commit(next)
    return updated
  }

  async delete(id: string): Promise<void> {
    const entry = this.servers.get(id)
    if (!entry) throw new Error(`MCP Server not found: ${id}`)
    if (entry.is_builtin) throw new Error(`Cannot delete built-in MCP Server "${entry.name}"`)
    const next = new Map(this.servers)
    next.delete(id)
    await this.commit(next)
  }

  async upsertById(entry: MCPServerRegistryEntry, onConflict: OnConflict): Promise<'imported' | 'overwritten' | 'skipped'> {
    const exists = this.servers.has(entry.id)
    if (exists && onConflict === 'skip') return 'skipped'
    const next = new Map(this.servers)
    next.set(entry.id, entry)
    if (exists && canonicalizeJson(this.runtimeSemanticEntries()) === canonicalizeJson(runtimeMcpEntries(next))) {
      this.servers = next
      await this.save()
      return 'overwritten'
    }
    await this.commit(next)
    return exists ? 'overwritten' : 'imported'
  }

  /**
   * 从 JSON 批量导入 MCP Server（支持 Claude Desktop 格式和单 server 格式）
   *
   * 单 server 格式: { "command": "...", "args": [...], "env": {...} }
   * mcpServers 格式: { "mcpServers": { "name": { "command": ..., "args": ..., "env": ... } } }
   */
  async importFromJson(json: string): Promise<MCPServerRegistryEntry[]> {
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
    } catch {
      throw new Error('无效的 JSON 格式')
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('JSON 必须是对象')
    }

    const obj = parsed as Record<string, unknown>
    const now = generateTimestamp()
    const newEntries: MCPServerRegistryEntry[] = []

    const buildEntry = (name: string, c: Record<string, unknown>): MCPServerRegistryEntry => ({
      id: generateId(),
      name,
      transport: 'stdio',
      command: c.command as string,
      args: Array.isArray(c.args) ? c.args.map(String) : undefined,
      env: typeof c.env === 'object' && c.env !== null
        ? Object.fromEntries(Object.entries(c.env as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
        : undefined,
      is_builtin: false,
      is_essential: false,
      can_disable: true,
      enabled: true,
      created_at: now,
      updated_at: now,
    })

    if ('mcpServers' in obj && typeof obj.mcpServers === 'object' && obj.mcpServers !== null) {
      for (const [name, cfg] of Object.entries(obj.mcpServers as Record<string, unknown>)) {
        if (typeof cfg !== 'object' || cfg === null) continue
        const c = cfg as Record<string, unknown>
        if (typeof c.command !== 'string') continue
        newEntries.push(buildEntry(name, c))
      }
    } else if (typeof obj.command === 'string') {
      const nameParts = obj.command.split(/[\s/\\]/)
      const name = nameParts[nameParts.length - 1] || 'mcp-server'
      newEntries.push(buildEntry(name, obj))
    } else {
      throw new Error('无法识别的 JSON 格式，请使用 Claude Desktop mcpServers 格式或单 server 格式')
    }

    const next = new Map(this.servers)
    for (const entry of newEntries) next.set(entry.id, entry)
    if (newEntries.length > 0) await this.commit(next)
    return newEntries
  }

  /**
   * 注册内置 MCP Server（幂等：已存在同名的不会重复注册）
   * 在 Admin 初始化时调用，确保内置工具在首次启动时自动可用
   */
  async registerBuiltins(mcpToolsPath: string): Promise<void> {
    const existingNames = new Set(this.list().map(s => s.name))
    const next = new Map(this.servers)

    const builtins: Array<{
      name: string
      description: string
      transport: 'stdio'
      command: string
      args: string[]
      enabled?: boolean
    }> = [
      {
        name: 'computer-use',
        description: 'Computer interaction: screenshot, mouse, keyboard (macOS)',
        transport: 'stdio',
        command: 'node',
        args: [path.join(mcpToolsPath, 'dist/computer-use/main.js')],
      },
      {
        name: 'lsp',
        description: 'Code intelligence: diagnostics, hover, definition, references, symbols',
        transport: 'stdio',
        command: 'node',
        args: [path.join(mcpToolsPath, 'dist/lsp/main.js')],
      },
      {
        name: 'git',
        description: 'Git operations: status, diff, log, commit, branch, stash',
        transport: 'stdio',
        command: 'node',
        args: [path.join(mcpToolsPath, 'dist/git/main.js')],
      },
      {
        name: 'scrapling',
        description: 'Browser Use: web scraping and browser automation via Scrapling',
        transport: 'stdio',
        command: 'scrapling',
        args: ['mcp'],
        enabled: false,
      },
    ]

    let changed = false
    for (const builtin of builtins) {
      if (existingNames.has(builtin.name)) {
        // 已注册：更新路径（项目目录可能变更）
        for (const [id, existing] of next) {
          if (existing.name === builtin.name && existing.is_builtin) {
            const argsChanged = JSON.stringify(existing.args) !== JSON.stringify(builtin.args)
            if (argsChanged) {
              next.set(id, { ...existing, args: builtin.args, updated_at: generateTimestamp() })
              changed = true
            }
            break
          }
        }
        continue
      }
      const now = generateTimestamp()
      const entry: MCPServerRegistryEntry = {
        id: generateId(),
        ...builtin,
        is_builtin: true,
        is_essential: false,
        can_disable: true,
        enabled: builtin.enabled ?? true,
        created_at: now,
        updated_at: now,
      }
      next.set(entry.id, entry)
      changed = true
    }

    if (changed) {
      await this.commit(next)
    }
  }

  /** 将注册表条目转换为 Agent 所需的 MCPServerConfig 格式 */
  toAgentConfig(entry: MCPServerRegistryEntry): {
    id: string
    name: string
    transport: 'stdio' | 'streamable-http' | 'sse'
    // stdio
    command?: string
    args?: string[]
    env?: Record<string, string>
    // http/sse
    url?: string
    headers?: Record<string, string>
    description?: string
  } {
    return {
      id: entry.id,
      name: entry.name,
      transport: entry.transport,
      command: entry.command,
      args: entry.args,
      env: entry.env,
      url: entry.url,
      headers: entry.headers,
      description: entry.description,
    }
  }
}

// ============================================================================
// Skill 管理器
// ============================================================================

interface SkillSourceMove {
  before_rel?: string
  after_rel: string
  stage_rel: string
  before_existed: boolean
  before_tree_hash?: string
  after_tree_hash: string
  cleanup_rel?: string
}

interface SkillSourceJournal {
  schema_version: 1
  domain: 'skills'
  mutation_id: string
  target_revision: number
  before_registry_sha256: string
  after_registry_sha256: string
  staged_registry_rel: string
  staged_registry_sha256: string
  before_registry_rel: string
  before_registry_artifact_sha256: string
  before_runtime_hashes: Record<string, string>
  after_runtime_hashes: Record<string, string>
  before_referenced_paths: string[]
  before_target_rel?: string
  after_target_rel?: string
  before_target_existed?: boolean
  before_target_tree_hash?: string
  after_target_tree_hash?: string
  stage_rel?: string
  backup_rel?: string
  retained_rel?: string
  delete_after_commit?: boolean
  /** Legacy migration uses a batch of staged directory moves. */
  moves?: SkillSourceMove[]
  legacy_backup_rel?: string
  legacy_backup_sha256?: string
  obsolete_snapshot_rel?: string
}

function sha256(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex') }

interface LegacyMigrationPlan {
  next: Map<string, SkillRegistryEntry>
  hashes: Map<string, string>
  moves: SkillSourceMove[]
  backupPath: string
  backupBytes: Buffer
}

export class SkillManager {
  private readonly transactionRoot: string
  private readonly journalPath: string
  private skillTail: Promise<void> = Promise.resolve()
  private skills: Map<string, SkillRegistryEntry> = new Map()
  private readonly filePath: string
  private readonly skillsRoot: string
  private mutationRunner: RegistryMutationRunner | null = null
  private semanticSnapshotProvider: (() => Promise<unknown> | unknown) | null = null
  private contentTreeHashes = new Map<string, string>()
  private legacyMigrationPending = false

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'skills.json')
    this.skillsRoot = path.join(dataDir, 'skills')
    this.transactionRoot = path.join(this.skillsRoot, '.transactions')
    this.journalPath = path.join(this.transactionRoot, 'skill-source-journal.json')
  }

  async initialize(): Promise<void> {
    await this.initializeLoadOnly()
    await this.initializeMigrations()
  }

  async initializeLoadOnly(): Promise<void> {
    await this.load()
    const journal = await this.readJournal()
    if (journal) {
      this.contentTreeHashes = new Map()
      return
    }
    await this.refreshRuntimeContentHashes()
  }

  async verifySourceJournalBinding(coordinator: import('./core-agent-config-revision-store.js').CoreAgentConfigMutationCoordinator): Promise<void> {
    const journal = await this.readJournal()
    const binding = await coordinator.persistedMutationBinding()
    if (!journal) {
      if (binding?.source_journal_sha256) {
        if (!binding.source_cleanup_completed) throw new Error('Bound Skill source journal is missing')
        await this.cleanupCompletedJournalArtifacts()
        await coordinator.clearCompletedSourceJournalBinding(binding.mutation_id, binding.target_revision, binding.source_journal_sha256)
      }
      return
    }
    if (!binding) throw new Error('Skill source journal binding mismatch')
    const journalBytes = await fs.readFile(this.journalPath)
    if (!binding || binding.mutation_id !== journal.mutation_id || binding.target_revision !== journal.target_revision || !binding.domains.includes('skills') || binding.source_journal_sha256 !== sha256(journalBytes)) throw new Error('Skill source journal binding mismatch')
    const registryDigest = await this.registryDigest()
    if (registryDigest === journal.before_registry_sha256) {
      await this.verifyJournalPhysicalState(journal, 'before')
      this.contentTreeHashes = new Map(Object.entries(journal.before_runtime_hashes))
    } else if (registryDigest === journal.after_registry_sha256) {
      await this.verifyJournalPhysicalState(journal, 'after')
      this.contentTreeHashes = new Map(Object.entries(journal.after_runtime_hashes))
    } else throw new Error('Skill source journal registry digest mismatch')
  }

  async recoverSourceJournal(coordinator: import('./core-agent-config-revision-store.js').CoreAgentConfigMutationCoordinator): Promise<void> {
    const journal = await this.readJournal()
    if (!journal) return
    const pending = await coordinator.pendingMutation()
    const recovered = await coordinator.recentRecoveredMutation()
    const receipt = await coordinator.lastCompletedMutation()
    const matches = (record: { mutation_id: string; target_revision: number } | null) => record?.mutation_id === journal.mutation_id && record.target_revision === journal.target_revision
    if (!matches(pending) && !matches(recovered) && !matches(receipt)) throw new Error('Skill source journal mutation identity mismatch')
    const journalBytes = await fs.readFile(this.journalPath)
    const journalDigest = sha256(journalBytes)
    const digest = await this.registryDigest()
    if (digest === journal.before_registry_sha256) await this.rollbackJournal(journal)
    else if (digest === journal.after_registry_sha256) await this.rollForwardJournal(journal)
    else throw new Error('Skill source journal registry digest mismatch')
    await coordinator.markSourceJournalCleanupCompleted(journal.mutation_id, journal.target_revision, journalDigest)
    await fs.rm(this.journalPath, { force: true })
    await fs.rm(this.resolveTransactionPath(journal.before_registry_rel), { force: true })
    await coordinator.clearCompletedSourceJournalBinding(journal.mutation_id, journal.target_revision, journalDigest)
    await this.load()
    await this.refreshRuntimeContentHashes()
  }

  async initializeMigrations(): Promise<void> {
    return this.serial(async () => {
      if (!this.legacyMigrationPending) return
      const plan = await this.planLegacyMigration()
      if (!plan) return
      await this.applyLegacyMigrationPlan(plan)
    })
  }

  setMutationRunner(runner: RegistryMutationRunner): void { this.mutationRunner = runner }
  setSemanticSnapshotProvider(provider: () => Promise<unknown> | unknown): void { this.semanticSnapshotProvider = provider }

  semanticMigrationState(): { legacy_migration_pending: boolean } {
    return { legacy_migration_pending: this.legacyMigrationPending }
  }

  runtimeSemanticEntries(): unknown[] {
    return Array.from(this.skills.values())
      .filter((entry) => entry.enabled && typeof entry.skill_dir === 'string' && entry.skill_dir.length > 0)
      .map((entry) => ({
        id: entry.id, name: entry.name, description: entry.description, skill_dir: entry.skill_dir,
        ...(this.isAdminOwned(entry) ? { content_tree_hash: this.contentTreeHashes.get(entry.id) ?? 'unreadable' } : {}),
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  private async commit(
    next: Map<string, SkillRegistryEntry>,
    applyFiles: () => Promise<void>,
    previewHashes?: Map<string, string>,
    transaction?: Partial<Omit<SkillSourceJournal, 'schema_version' | 'domain' | 'mutation_id' | 'target_revision' | 'before_registry_sha256' | 'after_registry_sha256' | 'staged_registry_rel' | 'staged_registry_sha256' | 'before_runtime_hashes' | 'after_runtime_hashes'>>,
    migrationAfter = false,
  ): Promise<void> {
    {
      const previous = this.skills
      const previousHashes = this.contentTreeHashes
      const beforeRegistry = await this.registryBytes()
      const afterRegistry = this.registryBytesFor(next)
      const beforeHashes = Object.fromEntries(previousHashes)
      const afterHashes = Object.fromEntries(previewHashes ?? previousHashes)
      const stageRegistry = path.join(this.transactionRoot, `registry-${randomBytes(12).toString('hex')}.json`)
      const beforeRegistryStage = path.join(this.transactionRoot, `before-registry-${randomBytes(12).toString('hex')}.json`)
      await fs.mkdir(this.transactionRoot, { recursive: true, mode: 0o700 })
      await this.writePrivate(stageRegistry, afterRegistry)
      if (transaction) await this.writePrivate(beforeRegistryStage, beforeRegistry)
      let sourceContext: CoreAgentConfigMutationContext | undefined
      let journalDigest: string | undefined
      const apply = async (context?: CoreAgentConfigMutationContext) => {
        sourceContext = context
        if (context && transaction) {
          const journal: SkillSourceJournal = {
            schema_version: 1, domain: 'skills', mutation_id: context.mutation_id, target_revision: context.target_revision,
            before_registry_sha256: sha256(beforeRegistry), after_registry_sha256: sha256(afterRegistry),
            staged_registry_rel: this.relativeTransactionPath(stageRegistry), staged_registry_sha256: sha256(afterRegistry),
            before_registry_rel: this.relativeTransactionPath(beforeRegistryStage), before_registry_artifact_sha256: sha256(beforeRegistry),
            before_runtime_hashes: beforeHashes, after_runtime_hashes: afterHashes,
            before_target_tree_hash: transaction?.before_target_tree_hash, after_target_tree_hash: transaction?.after_target_tree_hash,
            before_referenced_paths: this.registryReferencedPaths(beforeRegistry),
            ...transaction,
          }
          const journalBytes = Buffer.from(JSON.stringify(journal))
          await this.writePrivate(this.journalPath, journalBytes)
          if (!context?.bindSourceJournal) throw new Error('Missing source journal binding context')
          journalDigest = sha256(journalBytes)
          await context.bindSourceJournal(journalDigest)
        }
        await applyFiles()
        this.skills = next
        this.contentTreeHashes = new Map(Object.entries(afterHashes))
        await fs.rename(stageRegistry, this.filePath)
      }
      try {
        if (!this.mutationRunner) await apply()
        else await this.mutationRunner(['skills'], async () => {
          this.skills = next
          this.legacyMigrationPending = migrationAfter ? false : this.legacyMigrationPending
          if (previewHashes) this.contentTreeHashes = previewHashes
          else await this.refreshRuntimeContentHashes()
          try { return await this.semanticSnapshotProvider?.() } finally {
            this.skills = previous
            this.contentTreeHashes = previousHashes
            this.legacyMigrationPending = migrationAfter ? true : this.legacyMigrationPending
          }
        }, apply)
        if (transaction?.moves) await this.cleanupBatchSources(transaction.moves)
        if (transaction?.obsolete_snapshot_rel) await fs.rm(this.resolveTransactionPath(transaction.obsolete_snapshot_rel), { recursive: true, force: true })
        if (transaction && this.mutationRunner) {
          if (!sourceContext || !journalDigest) throw new Error('Missing completed source journal context')
          await sourceContext.markSourceJournalCleanupCompleted(journalDigest)
          await fs.rm(this.journalPath, { force: true })
          await fs.rm(beforeRegistryStage, { force: true })
          await sourceContext.clearSourceJournalBinding(journalDigest)
        } else if (transaction) {
          await fs.rm(beforeRegistryStage, { force: true })
        }
      } catch (error) {
        if (!transaction) {
          await fs.rm(stageRegistry, { force: true }).catch(() => {})
          await fs.rm(beforeRegistryStage, { force: true }).catch(() => {})
        }
        throw error
      }
    }
  }

  private async registryBytes(): Promise<Buffer> {
    try { return await fs.readFile(this.filePath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.from('[]')
      throw new Error('Invalid skills registry')
    }
  }

  private registryBytesFor(entries: Map<string, SkillRegistryEntry>): Buffer {
    return Buffer.from(JSON.stringify(Array.from(entries.values()), null, 2))
  }

  private async writePrivate(file: string, content: Buffer): Promise<void> {
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`
    const handle = await fs.open(temp, 'w', 0o600)
    try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
    await fs.rename(temp, file); await fs.chmod(file, 0o600)
  }

  private relativeTransactionPath(file: string): string {
    const relative = path.relative(this.skillsRoot, file)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('Invalid skill transaction path')
    return relative.split(path.sep).join('/')
  }

  private resolveTransactionPath(relative: string): string {
    if (!relative || path.isAbsolute(relative) || relative.includes('\0') || relative.split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid skill transaction path')
    const resolved = path.resolve(this.skillsRoot, relative)
    if (!resolved.startsWith(this.skillsRoot + path.sep)) throw new Error('Invalid skill transaction path')
    return resolved
  }

  private async writeJournal(journal: SkillSourceJournal): Promise<void> {
    await fs.mkdir(this.transactionRoot, { recursive: true, mode: 0o700 })
    await this.writePrivate(this.journalPath, Buffer.from(JSON.stringify(journal)))
  }

  private async readJournal(): Promise<SkillSourceJournal | null> {
    let raw: Buffer
    try { raw = await fs.readFile(this.journalPath) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    let journal: SkillSourceJournal
    try { journal = JSON.parse(raw.toString('utf8')) } catch { throw new Error('Invalid skill source journal') }
    const registryBytes = await this.registryBytes()
    const registryDigest = sha256(registryBytes)
    const stagedRegistry = this.resolveTransactionPath(journal.staged_registry_rel)
    this.assertJournalPath(journal.staged_registry_rel, 'registry')
    const beforeRegistryArtifact = this.resolveTransactionPath(journal.before_registry_rel)
    this.assertJournalPath(journal.before_registry_rel, 'before-registry')
    const beforeRegistryBytes = await fs.readFile(beforeRegistryArtifact).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (!beforeRegistryBytes || !/^[a-f0-9]{64}$/.test(journal.before_registry_artifact_sha256) || sha256(beforeRegistryBytes) !== journal.before_registry_artifact_sha256 || sha256(beforeRegistryBytes) !== journal.before_registry_sha256) throw new Error('Invalid skill source journal')
    const stagedRegistryBytes = await fs.readFile(stagedRegistry).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (stagedRegistryBytes && journal.staged_registry_sha256 !== sha256(stagedRegistryBytes)) throw new Error('Invalid skill source journal')
    if (!stagedRegistryBytes && registryDigest !== journal.after_registry_sha256) throw new Error('Invalid skill source journal')
    if (journal.schema_version !== 1 || journal.domain !== 'skills' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(journal.mutation_id) || !Number.isSafeInteger(journal.target_revision) || !/^[a-f0-9]{64}$/.test(journal.before_registry_sha256) || !/^[a-f0-9]{64}$/.test(journal.after_registry_sha256) || !/^[a-f0-9]{64}$/.test(journal.staged_registry_sha256)) throw new Error('Invalid skill source journal')
    const beforeRegistry = beforeRegistryBytes
    if (registryDigest === journal.before_registry_sha256 && !registryBytes.equals(beforeRegistry)) throw new Error('Invalid skill source journal')
    const afterRegistry = stagedRegistryBytes ?? (registryDigest === journal.after_registry_sha256 ? registryBytes : null)
    if (journal.moves) {
      this.assertJournalPath(journal.staged_registry_rel, 'registry')
      if (!afterRegistry || !Array.isArray(journal.moves) || journal.moves.length === 0) throw new Error('Invalid skill source journal')
      const authoritativeBefore = await this.readLegacyBeforeRegistry(journal, beforeRegistry)
      const expectedReferences = this.registryReferencedPaths(authoritativeBefore)
      if (canonicalizeJson(expectedReferences) !== canonicalizeJson(journal.before_referenced_paths)) throw new Error('Invalid skill source journal')
      for (const move of journal.moves) {
        if (!move || typeof move !== 'object' || typeof move.after_rel !== 'string' || typeof move.stage_rel !== 'string' || typeof move.before_existed !== 'boolean' || !/^[a-f0-9]{64}$/.test(move.after_tree_hash) || (move.before_tree_hash !== undefined && !/^[a-f0-9]{64}$/.test(move.before_tree_hash))) throw new Error('Invalid skill source journal')
        this.assertJournalPath(move.stage_rel, 'stage')
        this.assertJournalPath(move.after_rel, move.after_rel.startsWith('.snapshots/') ? 'snapshot' : 'target')
        if (move.before_rel !== undefined) this.assertJournalPath(move.before_rel, move.before_rel.startsWith('.snapshots/') ? 'snapshot' : 'target')
        this.assertLegacyMoveMapping(authoritativeBefore, afterRegistry, move)
        if (move.cleanup_rel !== undefined) {
          if (!move.before_existed || move.cleanup_rel !== move.before_rel) throw new Error('Invalid skill source journal')
          if (!expectedReferences.includes(move.cleanup_rel)) throw new Error('Invalid skill source journal')
        }
      }
      return journal
    }
    if (journal.before_target_rel === undefined || journal.after_target_rel === undefined || journal.before_target_existed === undefined || journal.stage_rel === undefined) throw new Error('Invalid skill source journal')
    this.assertJournalPath(journal.staged_registry_rel, 'registry')
    this.assertJournalPath(journal.stage_rel, journal.delete_after_commit ? 'quarantine' : 'stage')
    this.assertJournalPath(journal.before_target_rel, 'target')
    this.assertJournalPath(journal.after_target_rel, journal.delete_after_commit ? 'quarantine' : 'target')
    if (journal.backup_rel !== undefined) this.assertJournalPath(journal.backup_rel, 'snapshot')
    if (journal.retained_rel !== undefined) this.assertJournalPath(journal.retained_rel, journal.delete_after_commit ? 'quarantine' : 'snapshot')
    for (const hashes of [journal.before_runtime_hashes, journal.after_runtime_hashes]) {
      if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes) || Object.values(hashes).some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
        throw new Error('Invalid skill source journal')
      }
    }
    const afterRegistryForRuntime = afterRegistry
    if (!journal.before_target_tree_hash || !/^[a-f0-9]{64}$/.test(journal.before_target_tree_hash)) {
      if (journal.before_target_existed) throw new Error('Invalid skill source journal')
    }
    if (!journal.delete_after_commit && (!journal.after_target_tree_hash || !/^[a-f0-9]{64}$/.test(journal.after_target_tree_hash))) throw new Error('Invalid skill source journal')
    if (journal.obsolete_snapshot_rel !== undefined) this.assertRestoreSnapshotTransition(beforeRegistry, afterRegistryForRuntime, journal)
    if (journal.before_target_existed && !this.registryContainsManagedPath(beforeRegistry, journal.before_target_rel)) {
      throw new Error('Invalid skill source journal')
    }
    if (!journal.delete_after_commit && (!afterRegistryForRuntime || !this.registryContainsManagedPath(afterRegistryForRuntime, journal.after_target_rel))) {
      throw new Error('Invalid skill source journal')
    }
    return journal
  }

  private assertJournalPath(relative: string, kind: 'registry' | 'before-registry' | 'stage' | 'target' | 'snapshot' | 'quarantine'): void {
    this.resolveTransactionPath(relative)
    const parts = relative.split('/')
    const valid = kind === 'registry'
      ? parts.length === 2 && parts[0] === '.transactions' && /^registry-[a-f0-9]{24}\.json$/.test(parts[1])
      : kind === 'before-registry'
        ? parts.length === 2 && parts[0] === '.transactions' && /^before-registry-[a-f0-9]{24}\.json$/.test(parts[1])
      : kind === 'stage'
        ? (parts.length === 1 && /^\.stage\.\d+\.\d+\.[a-f0-9]{8}$/.test(parts[0]) || parts.length === 2 && /^\.stage\.\d+\.\d+\.[a-f0-9]{8}$/.test(parts[0]) && /^(target|snapshot)-\d+$/.test(parts[1]))
        : kind === 'snapshot'
          ? parts.length === 2 && parts[0] === '.snapshots' && /^[a-z0-9][a-z0-9-]{0,63}-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(parts[1])
          : kind === 'quarantine'
            ? parts.length === 2 && parts[0] === '.transactions' && /^delete-[a-f0-9]{24}$/.test(parts[1])
            : parts.length === 1 && isValidSkillName(parts[0])
    if (!valid) throw new Error('Invalid skill transaction path')
  }

  private assertRestoreSnapshotTransition(beforeRegistry: Buffer, afterRegistry: Buffer | null, journal: SkillSourceJournal): void {
    if (!afterRegistry || !journal.obsolete_snapshot_rel || !journal.retained_rel) throw new Error('Invalid skill source journal')
    this.assertJournalPath(journal.obsolete_snapshot_rel, 'snapshot')
    this.assertJournalPath(journal.retained_rel, 'snapshot')
    const parse = (registry: Buffer): Map<string, { skill?: string; snapshot?: string }> => {
      let entries: unknown
      try { entries = JSON.parse(registry.toString('utf8')) } catch { throw new Error('Invalid skill source journal') }
      if (!Array.isArray(entries)) throw new Error('Invalid skill source journal')
      const result = new Map<string, { skill?: string; snapshot?: string }>()
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || typeof (entry as { id?: unknown }).id !== 'string') throw new Error('Invalid skill source journal')
        const value = entry as { id: string; skill_dir?: unknown; previous_snapshot?: { snapshot_dir?: unknown } }
        result.set(value.id, {
          skill: typeof value.skill_dir === 'string' ? this.relativeTransactionPath(value.skill_dir) : undefined,
          snapshot: typeof value.previous_snapshot?.snapshot_dir === 'string' ? value.previous_snapshot.snapshot_dir : undefined,
        })
      }
      return result
    }
    const before = parse(beforeRegistry)
    const after = parse(afterRegistry)
    const ids = [...before].filter(([, refs]) => refs.skill === journal.before_target_rel && refs.snapshot === journal.obsolete_snapshot_rel).map(([id]) => id)
    if (ids.length !== 1 || after.get(ids[0])?.skill !== journal.after_target_rel || after.get(ids[0])?.snapshot !== journal.retained_rel || after.get(ids[0])?.snapshot === journal.obsolete_snapshot_rel) {
      throw new Error('Invalid skill source journal')
    }
  }

  private async verifyJournalPhysicalState(journal: SkillSourceJournal, state: 'before' | 'after'): Promise<void> {
    if (journal.moves) {
      for (const move of journal.moves) {
        const before = move.before_rel ? this.resolveTransactionPath(move.before_rel) : undefined
        const after = this.resolveTransactionPath(move.after_rel)
        const beforeExists = before ? await fs.access(before).then(() => true).catch(() => false) : false
        const afterExists = await fs.access(after).then(() => true).catch(() => false)
        if (state === 'before') {
          if (move.before_existed) {
            if (beforeExists) {
              if (!move.before_tree_hash || move.before_tree_hash !== await this.hashContentTree(before!)) throw new Error('Skill source journal before tree mismatch')
            } else if (!afterExists || move.after_tree_hash !== await this.hashContentTree(after)) throw new Error('Skill source journal before state is not recoverable')
          } else if (afterExists && move.after_tree_hash !== await this.hashContentTree(after)) throw new Error('Skill source journal after tree mismatch')
        } else if (!afterExists || move.after_tree_hash !== await this.hashContentTree(after)) throw new Error('Skill source journal after tree mismatch')
      }
      return
    }
    const before = this.resolveTransactionPath(journal.before_target_rel!)
    const after = this.resolveTransactionPath(journal.after_target_rel!)
    const backup = journal.backup_rel ? this.resolveTransactionPath(journal.backup_rel) : undefined
    const retained = journal.retained_rel ? this.resolveTransactionPath(journal.retained_rel) : undefined
    const beforeExists = await fs.access(before).then(() => true).catch(() => false)
    const afterExists = await fs.access(after).then(() => true).catch(() => false)
    const backupExists = backup ? await fs.access(backup).then(() => true).catch(() => false) : false
    const retainedExists = retained ? await fs.access(retained).then(() => true).catch(() => false) : false
    if (state === 'before') {
      if (journal.before_target_existed && beforeExists) {
        const actual = await this.hashContentTree(before)
        if (journal.before_target_tree_hash === actual) return
        const recoverySource = backupExists ? backup! : retainedExists ? retained! : undefined
        if (!recoverySource || journal.before_target_tree_hash !== await this.hashContentTree(recoverySource) || !journal.after_target_tree_hash || journal.after_target_tree_hash !== actual) {
          throw new Error('Skill source journal before target tree mismatch')
        }
      } else if (journal.before_target_existed && (backupExists || retainedExists)) {
        const recoverySource = backupExists ? backup! : retained!
        if (!journal.before_target_tree_hash || journal.before_target_tree_hash !== await this.hashContentTree(recoverySource)) throw new Error('Skill source journal before target tree mismatch')
      } else if (!journal.before_target_existed && afterExists) {
        if (!journal.after_target_tree_hash || journal.after_target_tree_hash !== await this.hashContentTree(after)) throw new Error('Skill source journal after target tree mismatch')
      } else if (journal.before_target_existed) throw new Error('Skill source journal before state is not recoverable')
      return
    }
    if (journal.delete_after_commit) {
      if (beforeExists) throw new Error('Skill source journal deleted target still exists')
      if (retainedExists && (!journal.before_target_tree_hash || journal.before_target_tree_hash !== await this.hashContentTree(retained!))) throw new Error('Skill source journal delete quarantine mismatch')
      return
    }
    if (!afterExists || !journal.after_target_tree_hash || journal.after_target_tree_hash !== await this.hashContentTree(after)) throw new Error('Skill source journal after target tree mismatch')
  }

  private async cleanupCompletedJournalArtifacts(): Promise<void> {
    const entries = await fs.readdir(this.transactionRoot).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error))
    await Promise.all(entries
      .filter((name) => /^(?:before-)?registry-[a-f0-9]{24}\.json$/.test(name))
      .map((name) => fs.rm(path.join(this.transactionRoot, name), { force: true })))
  }

  private async readLegacyBeforeRegistry(journal: SkillSourceJournal, currentBefore: Buffer | null): Promise<Buffer> {
    if (!journal.legacy_backup_rel || !/^skills\.json\.bak-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(journal.legacy_backup_rel) || !journal.legacy_backup_sha256 || !/^[a-f0-9]{64}$/.test(journal.legacy_backup_sha256)) {
      throw new Error('Invalid skill source journal')
    }
    const backupPath = path.join(path.dirname(this.filePath), journal.legacy_backup_rel)
    const backup = await fs.readFile(backupPath).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error))
    if (backup && (sha256(backup) !== journal.legacy_backup_sha256 || sha256(backup) !== journal.before_registry_sha256)) {
      throw new Error('Invalid skill source journal')
    }
    const authoritative = currentBefore ?? backup
    if (!authoritative || sha256(authoritative) !== journal.before_registry_sha256) throw new Error('Invalid skill source journal')
    return authoritative
  }

  private assertLegacyMoveMapping(beforeRegistry: Buffer, afterRegistry: Buffer, move: SkillSourceMove): void {
    const parse = (registry: Buffer): Map<string, Set<string>> => {
      let entries: unknown
      try { entries = JSON.parse(registry.toString('utf8')) } catch { throw new Error('Invalid skill source journal') }
      if (!Array.isArray(entries)) throw new Error('Invalid skill source journal')
      const result = new Map<string, Set<string>>()
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || typeof (entry as { id?: unknown }).id !== 'string' || result.has((entry as { id: string }).id)) {
          throw new Error('Invalid skill source journal')
        }
        const refs = new Set<string>()
        const value = entry as { id: string; skill_dir?: unknown; previous_snapshot?: { snapshot_dir?: unknown } }
        for (const candidate of [value.skill_dir, value.previous_snapshot?.snapshot_dir]) {
          if (typeof candidate !== 'string') continue
          try { refs.add(candidate.startsWith('.snapshots/') ? candidate : this.relativeTransactionPath(candidate)) } catch { /* external paths are not journal move targets */ }
        }
        result.set(value.id, refs)
      }
      return result
    }
    const before = parse(beforeRegistry)
    const after = parse(afterRegistry)
    const matchingIds = [...after].filter(([, refs]) => refs.has(move.after_rel)).map(([id]) => id)
    if (matchingIds.length !== 1) throw new Error('Invalid skill source journal')
    const beforeRefs = before.get(matchingIds[0])
    if (!beforeRefs || (move.before_rel !== undefined && !beforeRefs.has(move.before_rel))) throw new Error('Invalid skill source journal')
  }

  private registryContainsManagedPath(registry: Buffer, relative: string): boolean {
    let parsed: unknown
    try { parsed = JSON.parse(registry.toString('utf8')) } catch { throw new Error('Invalid skill source journal') }
    if (!Array.isArray(parsed)) throw new Error('Invalid skill source journal')
    return parsed.some((entry) => {
      if (!entry || typeof entry !== 'object' || typeof (entry as { skill_dir?: unknown }).skill_dir !== 'string') return false
      try { return this.relativeTransactionPath((entry as { skill_dir: string }).skill_dir) === relative } catch { return false }
    })
  }

  private registryReferencedPaths(registry: Buffer): string[] {
    let parsed: unknown
    try { parsed = JSON.parse(registry.toString('utf8')) } catch { throw new Error('Invalid skill source journal') }
    if (!Array.isArray(parsed)) throw new Error('Invalid skill source journal')
    const references = new Set<string>()
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue
      const value = entry as { skill_dir?: unknown; previous_snapshot?: { snapshot_dir?: unknown } }
      if (typeof value.skill_dir === 'string') {
        try { references.add(this.relativeTransactionPath(value.skill_dir)) } catch { /* invalid storage cannot authorize cleanup */ }
      }
      if (typeof value.previous_snapshot?.snapshot_dir === 'string') {
        const snapshot = value.previous_snapshot.snapshot_dir
        if (snapshot.startsWith('.snapshots/')) references.add(snapshot)
      }
    }
    return [...references].sort()
  }

  private registryReferencesPath(registry: Buffer, relative: string): boolean {
    let parsed: unknown
    try { parsed = JSON.parse(registry.toString('utf8')) } catch { throw new Error('Invalid skill source journal') }
    if (!Array.isArray(parsed)) throw new Error('Invalid skill source journal')
    return parsed.some((entry) => {
      if (!entry || typeof entry !== 'object') return false
      const value = entry as { skill_dir?: unknown; previous_snapshot?: { snapshot_dir?: unknown } }
      for (const candidate of [value.skill_dir, value.previous_snapshot?.snapshot_dir]) {
        if (typeof candidate !== 'string') continue
        try {
          const normalized = candidate.startsWith('.snapshots/') ? candidate : this.relativeTransactionPath(candidate)
          if (normalized === relative) return true
        } catch { /* invalid references do not authorize cleanup */ }
      }
      return false
    })
  }

  private async cleanupBatchSources(moves: SkillSourceMove[]): Promise<void> {
    for (const move of moves) {
      if (!move.cleanup_rel) continue
      if (move.cleanup_rel !== move.before_rel) throw new Error('Invalid skill source journal')
      await fs.rm(this.resolveTransactionPath(move.cleanup_rel), { recursive: true, force: true })
    }
  }

  private async registryDigest(): Promise<string> { return sha256(await this.registryBytes()) }

  private async rollbackJournal(journal: SkillSourceJournal): Promise<void> {
    if (journal.moves) {
      for (const move of [...journal.moves].reverse()) {
        const stage = this.resolveTransactionPath(move.stage_rel)
        const after = this.resolveTransactionPath(move.after_rel)
        const before = move.before_rel ? this.resolveTransactionPath(move.before_rel) : undefined
        if (!move.before_existed) {
          await fs.rm(after, { recursive: true, force: true })
        } else if (before && await fs.access(before).then(() => true).catch(() => false)) {
          if (move.before_tree_hash && move.before_tree_hash !== await this.hashContentTree(before)) throw new Error('Skill source journal before tree mismatch')
          await fs.rm(after, { recursive: true, force: true })
        } else if (before && await fs.access(after).then(() => true).catch(() => false)) {
          if (move.after_tree_hash !== await this.hashContentTree(after)) throw new Error('Skill source journal after tree mismatch')
          await fs.rename(after, before)
          if (move.before_tree_hash && move.before_tree_hash !== await this.hashContentTree(before)) throw new Error('Skill source journal before tree mismatch')
        } else throw new Error('Skill source journal rollback is ambiguous')
        await fs.rm(stage, { recursive: true, force: true })
      }
      return
    }
    const beforeTarget = this.resolveTransactionPath(journal.before_target_rel!)
    const afterTarget = this.resolveTransactionPath(journal.after_target_rel!)
    const stage = this.resolveTransactionPath(journal.stage_rel!)
    const backup = journal.backup_rel ? this.resolveTransactionPath(journal.backup_rel) : undefined
    const retained = journal.retained_rel ? this.resolveTransactionPath(journal.retained_rel) : undefined
    const restore = backup ?? retained
    if (journal.delete_after_commit) {
      if (!retained || !await fs.access(retained).then(() => true).catch(() => false)) throw new Error('Skill source journal rollback is ambiguous')
      await fs.rename(retained, beforeTarget)
    } else if (restore && await fs.access(restore).then(() => true).catch(() => false)) {
      await fs.rm(afterTarget, { recursive: true, force: true })
      await fs.rename(restore, beforeTarget)
    } else if (!journal.before_target_existed) {
      await fs.rm(afterTarget, { recursive: true, force: true })
    } else if (!await fs.access(beforeTarget).then(() => true).catch(() => false)) {
      throw new Error('Skill source journal rollback is ambiguous')
    }
    await fs.rm(stage, { recursive: true, force: true })
  }

  private async rollForwardJournal(journal: SkillSourceJournal): Promise<void> {
    if (journal.moves) {
      for (const move of journal.moves) {
        const stage = this.resolveTransactionPath(move.stage_rel)
        const after = this.resolveTransactionPath(move.after_rel)
        if (await fs.access(stage).then(() => true).catch(() => false)) {
          if (await fs.access(after).then(() => true).catch(() => false)) throw new Error('Skill source journal target collision')
          await fs.mkdir(path.dirname(after), { recursive: true })
          await fs.rename(stage, after)
        }
        if (!await fs.access(after).then(() => true).catch(() => false)) throw new Error('Skill source journal after target missing')
        if (move.after_tree_hash !== await this.hashContentTree(after)) throw new Error('Skill source journal after tree mismatch')
        if (move.cleanup_rel) await fs.rm(this.resolveTransactionPath(move.cleanup_rel), { recursive: true, force: true })
      }
      return
    }
    const beforeTarget = this.resolveTransactionPath(journal.before_target_rel!)
    const afterTarget = this.resolveTransactionPath(journal.after_target_rel!)
    const stage = this.resolveTransactionPath(journal.stage_rel!)
    const backup = journal.backup_rel ? this.resolveTransactionPath(journal.backup_rel) : undefined
    const retained = journal.retained_rel ? this.resolveTransactionPath(journal.retained_rel) : undefined
    if (journal.delete_after_commit) {
      await fs.rm(afterTarget, { recursive: true, force: true })
      await fs.rm(stage, { recursive: true, force: true })
      return
    }
    if (await fs.access(stage).then(() => true).catch(() => false)) {
      if (await fs.access(afterTarget).then(() => true).catch(() => false)) throw new Error('Skill source journal target collision')
      if (beforeTarget !== afterTarget && await fs.access(beforeTarget).then(() => true).catch(() => false)) {
        if (backup) await fs.rename(beforeTarget, backup)
        else if (retained) await fs.rename(beforeTarget, retained)
        else throw new Error('Skill source journal missing retention path')
      }
      await fs.rename(stage, afterTarget)
    }
    if (await fs.access(afterTarget).then(() => true).catch(() => false)) {
      if (journal.after_target_tree_hash && journal.after_target_tree_hash !== await this.hashContentTree(afterTarget)) throw new Error('Skill source journal after target tree mismatch')
    } else if (journal.delete_after_commit) {
      return
    } else throw new Error('Skill source journal after target missing')
    if (journal.obsolete_snapshot_rel) {
      await fs.rm(this.resolveTransactionPath(journal.obsolete_snapshot_rel), { recursive: true, force: true })
    }
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.skillTail
    let release!: () => void
    this.skillTail = new Promise<void>((resolve) => { release = resolve })
    await previous
    try { return await operation() } finally { release() }
  }

  private isAdminOwned(entry: SkillRegistryEntry): boolean {
    return entry.source_type === 'imported' && typeof entry.skill_dir === 'string' && path.resolve(entry.skill_dir).startsWith(this.skillsRoot + path.sep)
  }

  private async refreshRuntimeContentHashes(): Promise<void> {
    const hashes = new Map<string, string>()
    for (const entry of this.skills.values()) {
      if (this.isAdminOwned(entry)) hashes.set(entry.id, await this.hashContentTree(entry.skill_dir))
    }
    this.contentTreeHashes = hashes
  }

  private async hashContentTree(root: string): Promise<string> {
    const rootStat = await fs.lstat(root).catch(() => { throw new Error(`Unreadable imported skill directory: ${root}`) })
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`Invalid imported skill directory: ${root}`)
    const hash = createHash('sha256')
    const frame = (type: string, relative: string, bytes = Buffer.alloc(0)) => {
      const rel = Buffer.from(relative, 'utf8')
      hash.update(Buffer.from(type, 'ascii'))
      hash.update(Buffer.from([0]))
      const sizes = Buffer.alloc(8)
      sizes.writeUInt32BE(rel.length, 0); sizes.writeUInt32BE(bytes.length, 4)
      hash.update(sizes); hash.update(rel); hash.update(bytes)
    }
    const walk = async (dir: string, relative = ''): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => { throw new Error(`Unreadable imported skill directory: ${root}`) })
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const rel = relative ? `${relative}/${entry.name}` : entry.name
        const target = path.join(dir, entry.name)
        if (entry.isSymbolicLink()) throw new Error(`Symlink in imported skill directory: ${rel}`)
        if (entry.isDirectory()) { frame('D', rel); await walk(target, rel); continue }
        if (!entry.isFile()) throw new Error(`Unsupported imported skill entry: ${rel}`)
        frame('F', rel, await fs.readFile(target).catch(() => { throw new Error(`Unreadable imported skill file: ${rel}`) }))
      }
    }
    await walk(root)
    return hash.digest('hex')
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const entries: SkillRegistryEntry[] = JSON.parse(raw)
      for (const entry of entries) {
        if (!entry.source_type) {
          entry.source_type = entry.is_builtin ? 'builtin' : 'imported'
        }
      }
      this.skills = new Map(entries.map((e) => [e.id, e]))
      this.legacyMigrationPending = entries.some((entry) => {
        const rawEntry = entry as SkillRegistryEntry & { content?: string }
        const previous = rawEntry.previous_snapshot as { content?: string; files?: Record<string, string> } | undefined
        if (rawEntry.content !== undefined || previous?.content !== undefined || (entry.is_builtin && !entry.skill_dir)) return true
        if (!entry.is_builtin && entry.source_type !== 'scanned') {
          const dirName = isValidSkillName(entry.name) ? entry.name : entry.id
          return !entry.skill_dir || path.resolve(entry.skill_dir) !== path.join(this.skillsRoot, dirName)
        }
        return false
      })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.skills = new Map()
        return
      }
      throw new Error('Invalid skills registry')
    }
  }

  /**
   * 启动期一次性把 legacy entry 迁移到 filesystem-native 布局：
   * - 删除 entry.content 字段（content 改成存盘 SKILL.md 文件）
   * - 把 importFromLocalPath 旧语义里 skill_dir 指向用户原目录的复制到 <data_dir>/skills/<id>/
   * - previous_snapshot 由 {content, files, ...} 嵌入式改成 {snapshot_dir, ...} 文件夹引用
   * - builtin / scanned 不动 skill_dir 引用，只清 content 字段
   *
   * 首次进入时写一个 skills.json.bak-<ts> 备份；幂等：无 legacy 字段时直接返回。
   */
  private async planLegacyMigration(): Promise<LegacyMigrationPlan | null> {
    if (!this.legacyMigrationPending) return null
    const next = new Map<string, SkillRegistryEntry>()
    const hashes = new Map<string, string>()
    const moves: SkillSourceMove[] = []
    const plannedDestinations = new Set<string>()
    const stageRoot = path.join(this.skillsRoot, `.stage.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`)
    const backupPath = `${this.filePath}.bak-${isoCompactTs(generateTimestamp())}`
    if (await fs.access(backupPath).then(() => true).catch(() => false)) throw new Error('Legacy skills backup already exists')
    const backupBytes = await this.registryBytes()
    await fs.mkdir(stageRoot, { recursive: true, mode: 0o700 })
    try {
      for (const [id, original] of this.skills) {
        const raw = JSON.parse(JSON.stringify(original)) as SkillRegistryEntry & { content?: string; previous_snapshot?: SkillRegistryEntry['previous_snapshot'] & { content?: string; files?: Record<string, string> } }
        if (raw.is_builtin && !raw.skill_dir) continue
        const dirName = isValidSkillName(raw.name) ? raw.name : (isValidSkillName(id) ? id : (() => { throw new Error(`Invalid legacy skill id: ${id}`) })())
        if (raw.is_builtin || raw.source_type === 'scanned') { delete raw.content; next.set(id, raw); continue }
        const target = path.join(this.skillsRoot, dirName)
        const stage = path.join(stageRoot, `target-${moves.length}`)
        const source = raw.skill_dir
        const sourceExists = source ? await fs.access(source).then(() => true).catch(() => false) : false
        if (raw.content === undefined && !sourceExists) throw new Error(`Legacy skill "${raw.name}" has no recoverable source`)
        if (sourceExists) await copyDir(source, stage, ['.skill_dir', '.DS_Store']); else await fs.mkdir(stage, { recursive: true })
        if (raw.content !== undefined) await atomicWriteFileBuf(path.join(stage, 'SKILL.md'), Buffer.from(raw.content, 'utf8'))
        if (!await fs.access(path.join(stage, 'SKILL.md')).then(() => true).catch(() => false)) throw new Error(`Legacy skill "${raw.name}" has no SKILL.md`)
        const targetExists = await fs.access(target).then(() => true).catch(() => false)
        const targetRel = this.relativeTransactionPath(target)
        if (targetExists || plannedDestinations.has(targetRel)) throw new Error(`Legacy skill target collision: ${dirName}`)
        plannedDestinations.add(targetRel)
        moves.push({
          before_rel: source && this.isPathUnderSkillsRoot(source) ? this.relativeTransactionPath(source) : undefined,
          after_rel: targetRel,
          stage_rel: this.relativeTransactionPath(stage),
          before_existed: sourceExists,
          ...(sourceExists && this.isPathUnderSkillsRoot(source) ? { before_tree_hash: await this.hashContentTree(source) } : {}),
          after_tree_hash: await this.hashContentTree(stage),
          ...(sourceExists && this.isPathUnderSkillsRoot(source) && this.relativeTransactionPath(source) !== this.relativeTransactionPath(target) ? { cleanup_rel: this.relativeTransactionPath(source) } : {}),
        })
        raw.skill_dir = target; delete raw.content
        const previous = raw.previous_snapshot
        if (previous?.snapshot_dir && source && this.isPathUnderSkillsRoot(source) && path.basename(source) !== dirName) {
          const oldSnapshotRel = previous.snapshot_dir
          const oldSnapshot = this.resolveTransactionPath(oldSnapshotRel)
          const oldSnapshotName = path.basename(oldSnapshotRel)
          const oldBase = path.basename(source)
          const snapshotPrefix = `${oldBase}-`
          if (!oldSnapshotName.startsWith(snapshotPrefix)) throw new Error(`Legacy snapshot does not match source: ${oldSnapshotRel}`)
          const newSnapshotRel = path.posix.join('.snapshots', `${dirName}-${oldSnapshotName.slice(snapshotPrefix.length)}`)
          const newSnapshot = this.resolveTransactionPath(newSnapshotRel)
          if (await fs.access(newSnapshot).then(() => true).catch(() => false) || plannedDestinations.has(newSnapshotRel)) throw new Error(`Legacy snapshot collision: ${newSnapshotRel}`)
          plannedDestinations.add(newSnapshotRel)
          if (!await fs.access(oldSnapshot).then(() => true).catch(() => false)) throw new Error(`Legacy snapshot missing: ${oldSnapshotRel}`)
          const snapshotStage = path.join(stageRoot, `snapshot-${moves.length}`)
          await copyDir(oldSnapshot, snapshotStage)
          moves.push({
            before_rel: oldSnapshotRel, after_rel: newSnapshotRel, stage_rel: this.relativeTransactionPath(snapshotStage),
            before_existed: true, before_tree_hash: await this.hashContentTree(oldSnapshot), after_tree_hash: await this.hashContentTree(snapshotStage), cleanup_rel: oldSnapshotRel,
          })
          raw.previous_snapshot = { ...previous, snapshot_dir: newSnapshotRel }
        }
        if (previous?.content !== undefined && !previous.snapshot_dir) {
          const snapshotRel = path.posix.join('.snapshots', `${dirName}-${isoCompactTs(previous.snapshotted_at)}`)
          const snapshot = this.resolveTransactionPath(snapshotRel)
          if (await fs.access(snapshot).then(() => true).catch(() => false) || plannedDestinations.has(snapshotRel)) throw new Error(`Legacy snapshot collision: ${snapshotRel}`)
          plannedDestinations.add(snapshotRel)
          const snapshotStage = path.join(stageRoot, `snapshot-${moves.length}`)
          await fs.mkdir(snapshotStage, { recursive: true }); await atomicWriteFileBuf(path.join(snapshotStage, 'SKILL.md'), Buffer.from(previous.content, 'utf8'))
          for (const [rel, value] of Object.entries(previous.files ?? {})) {
            this.assertLegacyRelativePath(rel); const destination = path.resolve(snapshotStage, rel)
            if (!destination.startsWith(snapshotStage + path.sep)) throw new Error('Invalid legacy snapshot file path')
            await fs.mkdir(path.dirname(destination), { recursive: true }); await atomicWriteFileBuf(destination, Buffer.from(value.startsWith('base64:') ? value.slice(7) : value, value.startsWith('base64:') ? 'base64' : 'utf8'))
          }
          moves.push({ after_rel: snapshotRel, stage_rel: this.relativeTransactionPath(snapshotStage), before_existed: false, after_tree_hash: await this.hashContentTree(snapshotStage) })
          raw.previous_snapshot = { snapshot_dir: snapshotRel, version: previous.version, updated_at: previous.updated_at, snapshotted_at: previous.snapshotted_at }
        }
        next.set(id, raw)
        const stagedTarget = moves.find((move) => move.after_rel === this.relativeTransactionPath(target))
        hashes.set(id, stagedTarget ? stagedTarget.after_tree_hash : await this.hashContentTree(target))
      }
      return { next, hashes, moves, backupPath, backupBytes }
    } catch (error) { await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {}); throw error }
  }

  private async applyLegacyMigrationPlan(plan: LegacyMigrationPlan): Promise<void> {
    await this.commit(plan.next, async () => {
      await fs.writeFile(plan.backupPath, plan.backupBytes, { flag: 'wx', mode: 0o600 })
      for (const move of plan.moves) {
        const stage = this.resolveTransactionPath(move.stage_rel); const after = this.resolveTransactionPath(move.after_rel)
        if (await fs.access(after).then(() => true).catch(() => false)) throw new Error('Legacy skill target collision')
        await fs.mkdir(path.dirname(after), { recursive: true }); await fs.rename(stage, after)
      }
      this.legacyMigrationPending = false
    }, plan.hashes, { moves: plan.moves, legacy_backup_rel: path.basename(plan.backupPath), legacy_backup_sha256: sha256(plan.backupBytes) }, true)
    this.legacyMigrationPending = false
  }

  private isPathUnderSkillsRoot(value: string): boolean { return path.resolve(value).startsWith(this.skillsRoot + path.sep) }
  private assertLegacyRelativePath(relative: string): void {
    if (!relative || relative.includes('\0') || path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) throw new Error('Invalid legacy snapshot file path')
  }

  /**
   * 原子写入文件：先写临时文件，再 rename（避免进程被杀时文件损坏）
   */
  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.tmp`
    await fs.writeFile(tempPath, content, 'utf-8')
    await fs.rename(tempPath, filePath)
  }

  private async save(): Promise<void> {
    const entries = Array.from(this.skills.values())
    await this.atomicWriteFile(this.filePath, JSON.stringify(entries, null, 2))
  }

  list(): SkillRegistryEntry[] {
    return Array.from(this.skills.values())
  }

  get(id: string): SkillRegistryEntry | undefined {
    return this.skills.get(id)
  }

  /**
   * 按 name 查找 Skill。用于导入前的重名检测
   */
  findByName(name: string): SkillRegistryEntry | undefined {
    for (const entry of this.skills.values()) {
      if (entry.name === name) return entry
    }
    return undefined
  }

  async create(params: {
    name: string
    description: string
    content: string
    version?: string
    trigger_phrases?: string[]
    source_market?: string
    source_package?: string
    source_type?: 'builtin' | 'imported' | 'scanned'
  }): Promise<SkillRegistryEntry> {
    return this.serial(() => this.createUnlocked(params))
  }

  private async createUnlocked(params: {
    name: string
    description: string
    content: string
    version?: string
    trigger_phrases?: string[]
    source_market?: string
    source_package?: string
    source_type?: 'builtin' | 'imported' | 'scanned'
  }): Promise<SkillRegistryEntry> {
    if (!isValidSkillName(params.name)) {
      throw new Error(`Skill name "${params.name}" 含非法字符（仅允许小写字母/数字/连字符，最长 64 字符）`)
    }
    const id = generateId()
    const skillDir = path.join(this.skillsRoot, params.name)
    await fs.mkdir(this.skillsRoot, { recursive: true })
    const orphanCheck = await fs.access(skillDir).then(() => true).catch(() => false)
    if (orphanCheck) {
      throw new Error(`目录 ${skillDir} 已存在但 registry 中找不到对应 entry，可能是孤儿数据，请手工清理`)
    }
    const stagedDir = path.join(this.skillsRoot, `.stage.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`)
    await fs.mkdir(stagedDir, { recursive: true })
    await atomicWriteFileBuf(path.join(stagedDir, 'SKILL.md'), Buffer.from(params.content, 'utf-8'))

    const now = generateTimestamp()
    const entry: SkillRegistryEntry = {
      id,
      name: params.name,
      description: params.description,
      version: params.version ?? '1.0.0',
      skill_dir: skillDir,
      trigger_phrases: params.trigger_phrases,
      source_type: params.source_type ?? 'imported',
      is_builtin: false,
      is_essential: false,
      can_disable: true,
      source_market: params.source_market,
      source_package: params.source_package,
      enabled: true,
      created_at: now,
      updated_at: now,
    }
    const next = new Map(this.skills)
    next.set(entry.id, entry)
    try {
      const hashes = new Map(this.contentTreeHashes)
      hashes.set(entry.id, await this.hashContentTree(stagedDir))
      await this.commit(next, async () => { await fs.rename(stagedDir, skillDir) }, hashes, {
        before_target_rel: this.relativeTransactionPath(skillDir), after_target_rel: this.relativeTransactionPath(skillDir), before_target_existed: false,
        after_target_tree_hash: hashes.get(entry.id), stage_rel: this.relativeTransactionPath(stagedDir),
      })
    } catch (error) {
      await fs.rm(stagedDir, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    return entry
  }

  async update(id: string, params: Partial<Pick<SkillRegistryEntry, 'name' | 'description' | 'version' | 'trigger_phrases' | 'is_essential' | 'enabled'>> & { content?: string }): Promise<SkillRegistryEntry> { return this.serial(() => this.updateUnlocked(id, params)) }
  async restore(id: string): Promise<SkillRegistryEntry> { return this.serial(() => this.restoreUnlocked(id)) }
  async delete(id: string): Promise<void> { return this.serial(() => this.deleteUnlocked(id)) }
  async seedBuiltinSkills(entries: SkillRegistryEntry[]): Promise<void> { return this.serial(() => this.seedBuiltinSkillsUnlocked(entries)) }
  async registerBuiltins(builtinsDir: string): Promise<number> { return this.serial(() => this.registerBuiltinsUnlocked(builtinsDir)) }
  async scanWorkspaceSkills(workspaceDir: string): Promise<number> { return this.serial(() => this.scanWorkspaceSkillsUnlocked(workspaceDir)) }
  async importFromGit(skillMdUrl: string, sourceGitUrl?: string, overwrite?: boolean): Promise<{ entry: SkillRegistryEntry; was_overwrite: boolean }> { return this.serial(() => this.importFromGitUnlocked(skillMdUrl, sourceGitUrl, overwrite)) }
  async importFromLocalPath(dirPath: string, overwrite?: boolean): Promise<{ entry: SkillRegistryEntry; was_overwrite: boolean }> { return this.serial(() => this.importFromLocalPathUnlocked(dirPath, overwrite)) }
  async importFromZip(base64Content: string, filename: string, overwrite?: boolean): Promise<{ entry: SkillRegistryEntry; was_overwrite: boolean }> { return this.serial(() => this.importFromZipUnlocked(base64Content, filename, overwrite)) }

  private async updateUnlocked(
    id: string,
    params: Partial<Pick<SkillRegistryEntry, 'name' | 'description' | 'version' | 'trigger_phrases' | 'is_essential' | 'enabled'>> & { content?: string },
  ): Promise<SkillRegistryEntry> {
    const entry = this.skills.get(id)
    if (!entry) throw new Error(`Skill not found: ${id}`)
    if (!entry.can_disable && params.enabled === false) throw new Error(`Skill "${entry.name}" cannot be disabled`)
    if (params.content !== undefined && entry.is_builtin) throw new Error(`Skill "${entry.name}" 是内置的，不能修改 content`)
    const name = params.name ?? entry.name
    if (name !== entry.name && !entry.is_builtin && !isValidSkillName(name)) throw new Error(`Skill name "${name}" 含非法字符（仅允许小写字母/数字/连字符，最长 64 字符）`)
    const existingName = this.findByName(name)
    if (name !== entry.name && existingName && existingName.id !== id) throw new Error(`Skill name "${name}" 已被其他 entry 使用`)
    const managed = this.isAdminOwned(entry)
    const skillDir = managed ? path.join(this.skillsRoot, name) : entry.skill_dir
    const changedContent = params.content !== undefined && managed && await fs.readFile(path.join(entry.skill_dir, 'SKILL.md'), 'utf8').then((text) => text !== params.content).catch(() => true)
    const changedPath = managed && skillDir !== entry.skill_dir
    const createsSnapshot = managed && (changedContent || changedPath)
    const snapshotAt = generateTimestamp()
    const snapRel = path.posix.join('.snapshots', `${name}-${isoCompactTs(snapshotAt)}`)
    const updated: SkillRegistryEntry = {
      ...entry, name, skill_dir: skillDir, description: params.description ?? entry.description,
      version: params.version ?? entry.version, trigger_phrases: params.trigger_phrases ?? entry.trigger_phrases,
      is_essential: params.is_essential ?? entry.is_essential, enabled: params.enabled ?? entry.enabled,
      ...(createsSnapshot ? { previous_snapshot: { snapshot_dir: snapRel, version: entry.version, updated_at: entry.updated_at, snapshotted_at: snapshotAt } } : {}),
      updated_at: generateTimestamp(),
    }
    const next = new Map(this.skills); next.set(id, updated)
    if (!createsSnapshot && canonicalizeJson(this.runtimeSemanticEntries()) === canonicalizeJson(await this.runtimeEntriesFor(next))) {
      this.skills = next; await this.save(); return updated
    }
    const staged = path.join(this.skillsRoot, `.stage.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`)
    const snapPath = path.join(this.skillsRoot, snapRel)
    try {
      if (createsSnapshot) {
        await copyDir(entry.skill_dir, staged)
        if (params.content !== undefined) await atomicWriteFileBuf(path.join(staged, 'SKILL.md'), Buffer.from(params.content, 'utf8'))
      }
      const hashes = new Map(this.contentTreeHashes)
      if (createsSnapshot) hashes.set(id, await this.hashContentTree(staged))
      await this.commit(next, async () => {
        if (!createsSnapshot) return
        await fs.mkdir(path.dirname(snapPath), { recursive: true })
        await fs.rename(entry.skill_dir, snapPath)
        try { await fs.rename(staged, skillDir) } catch (error) { await fs.rename(snapPath, entry.skill_dir).catch(() => {}); throw error }
      }, hashes, createsSnapshot ? {
        before_target_rel: this.relativeTransactionPath(entry.skill_dir), after_target_rel: this.relativeTransactionPath(skillDir), before_target_existed: true,
        before_target_tree_hash: this.contentTreeHashes.get(id), after_target_tree_hash: hashes.get(id), stage_rel: this.relativeTransactionPath(staged),
        backup_rel: this.relativeTransactionPath(snapPath),
      } : undefined)
      if (createsSnapshot && entry.previous_snapshot?.snapshot_dir && entry.previous_snapshot.snapshot_dir !== snapRel) {
        await fs.rm(this.resolveTransactionPath(entry.previous_snapshot.snapshot_dir), { recursive: true, force: true })
      }
    } catch (error) { await fs.rm(staged, { recursive: true, force: true }).catch(() => {}); throw error }
    return updated
  }

  private async runtimeEntriesFor(entries: Map<string, SkillRegistryEntry>): Promise<unknown[]> {
    const previous = this.skills; const previousHashes = this.contentTreeHashes
    this.skills = entries
    try { await this.refreshRuntimeContentHashes(); return this.runtimeSemanticEntries() }
    finally { this.skills = previous; this.contentTreeHashes = previousHashes }
  }

  private async restoreUnlocked(id: string): Promise<SkillRegistryEntry> {
    const entry = this.skills.get(id)
    if (!entry) throw new Error(`Skill not found: ${id}`)
    if (entry.is_builtin) throw new Error(`Skill "${entry.name}" 是内置的，不能 restore`)
    if (!this.isAdminOwned(entry)) throw new Error(`Skill "${entry.name}" cannot be restored`)
    if (!entry.previous_snapshot) throw new Error(`Skill "${entry.name}" 没有上一版可恢复`)
    const source = this.resolveTransactionPath(entry.previous_snapshot.snapshot_dir)
    const now = generateTimestamp()
    const retainedRel = path.posix.join('.snapshots', `${entry.name}-${isoCompactTs(now)}`)
    const retained = this.resolveTransactionPath(retainedRel)
    const stage = path.join(this.skillsRoot, `.stage.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`)
    await copyDir(source, stage)
    const parsed = parseSkillMd(await fs.readFile(path.join(stage, 'SKILL.md'), 'utf8'))
    const updated: SkillRegistryEntry = {
      ...entry, description: parsed.description, version: parsed.version,
      previous_snapshot: { snapshot_dir: retainedRel, version: entry.version, updated_at: entry.updated_at, snapshotted_at: now },
      updated_at: now,
    }
    const next = new Map(this.skills); next.set(id, updated)
    const hashes = new Map(this.contentTreeHashes); hashes.set(id, await this.hashContentTree(stage))
    try {
      await this.commit(next, async () => {
        await fs.mkdir(path.dirname(retained), { recursive: true })
        await fs.rename(entry.skill_dir, retained)
        try { await fs.rename(stage, entry.skill_dir) } catch (error) { await fs.rename(retained, entry.skill_dir).catch(() => {}); throw error }
      }, hashes, {
        before_target_rel: this.relativeTransactionPath(entry.skill_dir), after_target_rel: this.relativeTransactionPath(entry.skill_dir), before_target_existed: true,
        before_target_tree_hash: this.contentTreeHashes.get(id), stage_rel: this.relativeTransactionPath(stage), retained_rel: retainedRel,
        obsolete_snapshot_rel: entry.previous_snapshot.snapshot_dir, after_target_tree_hash: hashes.get(id),
      })
    } catch (error) { await fs.rm(stage, { recursive: true, force: true }).catch(() => {}); throw error }
    return updated
  }

  private async deleteUnlocked(id: string): Promise<void> {
    const entry = this.skills.get(id)
    if (!entry) throw new Error(`Skill not found: ${id}`)
    if (entry.is_builtin) throw new Error(`Cannot delete built-in Skill "${entry.name}"`)
    if (!this.isAdminOwned(entry)) {
      const next = new Map(this.skills)
      next.delete(id)
      await this.commit(next, async () => {})
      return
    }
    const quarantine = path.join(this.transactionRoot, `delete-${randomBytes(12).toString('hex')}`)
    const next = new Map(this.skills)
    next.delete(id)
    const hashes = new Map(this.contentTreeHashes)
    hashes.delete(id)
    await this.commit(next, async () => {
      await fs.mkdir(this.transactionRoot, { recursive: true, mode: 0o700 })
      await fs.rename(entry.skill_dir, quarantine)
    }, hashes, {
      before_target_rel: this.relativeTransactionPath(entry.skill_dir), after_target_rel: this.relativeTransactionPath(quarantine), before_target_existed: true,
      before_target_tree_hash: this.contentTreeHashes.get(id),
      stage_rel: this.relativeTransactionPath(quarantine), retained_rel: this.relativeTransactionPath(quarantine), delete_after_commit: true,
    })
    await fs.rm(quarantine, { recursive: true, force: true })
    if (entry.previous_snapshot?.snapshot_dir) await fs.rm(this.resolveTransactionPath(entry.previous_snapshot.snapshot_dir), { recursive: true, force: true })
  }

  /**
   * 注入内置 Skill：仅当 id 不存在时插入，已存在则跳过。
   * 与 SubAgentManager.seedBuiltin 相同语义。
   */
  private async seedBuiltinSkillsUnlocked(entries: SkillRegistryEntry[]): Promise<void> {
    let changed = false
    const next = new Map(this.skills)
    for (const e of entries) {
      const existing = next.get(e.id)
      if (!existing) {
        next.set(e.id, e)
        changed = true
        continue
      }
      if (!existing.skill_dir && e.skill_dir) {
        next.set(e.id, { ...existing, skill_dir: e.skill_dir, updated_at: new Date().toISOString() })
        console.warn(`[SkillManager] Repaired builtin skill "${e.name}" (${e.id}): missing skill_dir → ${e.skill_dir}`)
        changed = true
      }
    }
    if (changed) await this.commit(next, async () => {})
  }

  /**
   * 注册内置 Skill（幂等：已存在同名的不会重复注册）
   * 在 Admin 初始化时调用，扫描 builtinsDir 下的子目录，每个子目录应包含 SKILL.md
   *
   * 返回本次扫到的可用 builtin skill 数量。扫不到任何一个是异常状态（历史上
   * release 包漏打 SKILL.md 导致 memory-curate 等全部缺失且无声无息），必须报错。
   */
  private async registerBuiltinsUnlocked(builtinsDir: string): Promise<number> {
    let dirEntries: import('fs').Dirent[]
    try {
      dirEntries = await fs.readdir(builtinsDir, { withFileTypes: true })
    } catch {
      console.error(`[SkillManager] builtin skills 目录不可读，内置 skill 全部缺失: ${builtinsDir}`)
      return 0
    }

    const previous = this.skills
    const next = new Map(this.skills)
    this.skills = next
    const existingNames = new Set(this.list().map(s => s.name))
    let changed = false
    let found = 0

    for (const dirent of dirEntries) {
      if (!dirent.isDirectory()) continue
      const skillDir = path.join(builtinsDir, dirent.name)
      const skillMdPath = path.join(skillDir, 'SKILL.md')

      let content: string
      try {
        content = await fs.readFile(skillMdPath, 'utf-8')
      } catch {
        console.error(`[SkillManager] builtin skill "${dirent.name}" 缺 SKILL.md，已跳过: ${skillMdPath}`)
        continue
      }

      const parsed = parseSkillMd(content)
      if (!parsed.name) {
        console.error(`[SkillManager] builtin skill "${dirent.name}" 的 SKILL.md 缺 frontmatter name，已跳过`)
        continue
      }
      found++

      if (existingNames.has(parsed.name)) {
        // 已注册：用 SKILL.md 当前 frontmatter 同步条目
        // （项目目录、frontmatter 里的 description / version 都可能变更）
        for (const [id, existing] of this.skills) {
          if (existing.name === parsed.name && existing.is_builtin) {
            if (
              existing.skill_dir !== skillDir ||
              existing.description !== parsed.description ||
              existing.version !== parsed.version
            ) {
              this.skills.set(id, {
                ...existing,
                skill_dir: skillDir,
                description: parsed.description,
                version: parsed.version,
                updated_at: generateTimestamp(),
              })
              changed = true
            }
            break
          }
        }
        continue
      }

      const now = generateTimestamp()
      const entry: SkillRegistryEntry = {
        id: generateId(),
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        skill_dir: skillDir,
        source_type: 'builtin',
        is_builtin: true,
        is_essential: false,
        can_disable: true,
        enabled: true,
        created_at: now,
        updated_at: now,
      }
      this.skills.set(entry.id, entry)
      existingNames.add(parsed.name)
      changed = true
    }

    if (found === 0) {
      console.error(`[SkillManager] builtin skills 目录下没扫到任何 SKILL.md，内置 skill 全部缺失: ${builtinsDir}`)
    }

    this.skills = previous
    if (changed) await this.commit(next, async () => {})
    return found
  }

  /**
   * 扫描 workspaceDir/.agents/skills/ 目录，将新发现的 skill 注入注册表。
   * Additive-only：已在注册表中（按 name 匹配）的跳过。
   * 返回本次新增数量。
   */
  private async scanWorkspaceSkillsUnlocked(workspaceDir: string): Promise<number> {
    const agentSkillsDir = path.join(workspaceDir, '.agents', 'skills')
    let dirEntries: import('fs').Dirent[]
    try {
      dirEntries = await fs.readdir(agentSkillsDir, { withFileTypes: true })
    } catch {
      return 0
    }

    const subdirs = dirEntries.filter(d => d.isDirectory())
    const reads = await Promise.all(
      subdirs.map(async (dirent) => {
        const skillDir = path.join(agentSkillsDir, dirent.name)
        try {
          const content = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf-8')
          return { skillDir, content }
        } catch {
          return null
        }
      })
    )

    const previous = this.skills
    const next = new Map(this.skills)
    this.skills = next
    let added = 0
    const now = generateTimestamp()
    for (const result of reads) {
      if (!result) continue
      const parsed = parseSkillMd(result.content)
      if (!parsed.name) continue
      if (this.findByName(parsed.name)) continue

      const entry: SkillRegistryEntry = {
        id: generateId(),
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        skill_dir: result.skillDir,
        source_type: 'scanned',
        is_builtin: false,
        is_essential: false,
        can_disable: true,
        enabled: true,
        created_at: now,
        updated_at: now,
      }
      this.skills.set(entry.id, entry)
      added++
    }

    this.skills = previous
    if (added > 0) await this.commit(next, async () => {})
    return added
  }

  /** 将注册表条目转换为 Agent 所需的 SkillConfig 格式 */
  toAgentConfig(entry: SkillRegistryEntry): {
    id: string
    name: string
    description: string
    skill_dir: string
  } {
    return {
      id: entry.id,
      name: entry.name,
      description: entry.description,
      skill_dir: entry.skill_dir,
    }
  }

  /** REST 兼容序列化：附加 content 字段（即时读 SKILL.md），让前端无需改动 */
  async toRestEntry(entry: SkillRegistryEntry): Promise<SkillRegistryEntry & { content: string }> {
    if (!entry.skill_dir) return { ...entry, content: '' }
    const content = await fs.readFile(path.join(entry.skill_dir, 'SKILL.md'), 'utf-8').catch(() => '')
    return { ...entry, content }
  }

  async toRestEntries(entries: SkillRegistryEntry[]): Promise<Array<SkillRegistryEntry & { content: string }>> {
    return Promise.all(entries.map(e => this.toRestEntry(e)))
  }

  /** 读取上一版 snapshot 的内容（diff modal 用） */
  async readPreviousContent(id: string): Promise<{ content: string; files: Record<string, string> } | null> {
    const entry = this.skills.get(id)
    if (!entry?.previous_snapshot) return null
    const dir = path.join(this.skillsRoot, entry.previous_snapshot.snapshot_dir)
    const content = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf-8').catch(() => '')
    const files = (await readSkillDirFiles(dir)) ?? {}
    return { content, files }
  }

  // --------------------------------------------------------------------------
  // 导入方法
  // --------------------------------------------------------------------------

  /**
   * 从 GitHub URL 扫描 skill 列表（不立即安装）
   *
   * 支持：
   * - 单 skill 仓库（根目录有 SKILL.md）→ 直接返回 [{path:'', name, ...}]
   * - 多 skill 仓库（根目录无 SKILL.md）→ 扫描子目录返回列表
   *
   * 支持的 URL 格式：
   * - https://github.com/user/repo
   * - https://github.com/user/repo/tree/branch/subpath
   */
  async scanGitRepo(gitUrl: string): Promise<Array<{ path: string; name: string; description: string; skill_md_url: string }>> {
    const parsed = this.parseGitHubUrl(gitUrl)
    if (!parsed) throw new Error('不支持的 Git URL 格式，目前仅支持 GitHub')

    const { owner, repo, branch, subPath } = parsed
    return this.scanGitHubDir(owner, repo, branch || 'HEAD', subPath || '')
  }

  /**
   * 从 GitHub 安装指定 skill（通过 skill_md_url 获取内容）
   * 仅允许 raw.githubusercontent.com 的 HTTPS URL，防止 SSRF
   */
  private async importFromGitUnlocked(
    skillMdUrl: string,
    sourceGitUrl?: string,
    overwrite?: boolean,
  ): Promise<{ entry: SkillRegistryEntry; was_overwrite: boolean }> {
    let parsedUrl: URL
    try { parsedUrl = new URL(skillMdUrl) } catch { throw new Error('无效的 URL 格式') }
    if (parsedUrl.hostname !== 'raw.githubusercontent.com' || parsedUrl.protocol !== 'https:') {
      throw new Error('只允许 raw.githubusercontent.com 的 HTTPS URL')
    }
    // path: /<owner>/<repo>/<branch>/<sub...>/SKILL.md
    const parts = parsedUrl.pathname.replace(/^\//, '').split('/')
    if (parts.length < 4 || parts[parts.length - 1] !== 'SKILL.md') {
      throw new Error(`URL 格式不符：${skillMdUrl}`)
    }
    const owner = parts[0]
    const repo = parts[1]
    const branch = parts[2]
    const subPath = parts.slice(3, -1).join('/') // 去掉末尾 SKILL.md

    // 下载 archive zip
    const archiveUrl = `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/${branch}`
    const res = await fetch(archiveUrl, { headers: { 'User-Agent': 'Crabot/1.0' }, signal: AbortSignal.timeout(60_000) })
    if (!res.ok) throw new Error(`无法下载 archive: ${res.statusText}`)
    const buf = Buffer.from(await res.arrayBuffer())
    const zip = new AdmZip(buf)

    // GitHub archive zip 顶层目录是 <repo>-<branch>/，提取 <repo>-<branch>/<subPath>/ 整个子目录到 tmp
    await fs.mkdir(this.skillsRoot, { recursive: true })
    const tmpExtract = path.join(this.skillsRoot, `.extract.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`)
    await fs.mkdir(tmpExtract, { recursive: true })
    try {
      const innerPrefix = `${repo}-${branch}/${subPath ? subPath + '/' : ''}`
      const tmpExtractResolved = path.resolve(tmpExtract)
      const tmpExtractPrefix = tmpExtractResolved + path.sep
      let foundSkillMd = false
      for (const e of zip.getEntries()) {
        if (e.isDirectory) continue
        if (e.entryName.includes('..')) throw new Error(`archive 包含非法路径 ${e.entryName}（path traversal）`)
        if (!e.entryName.startsWith(innerPrefix)) continue
        const rel = e.entryName.slice(innerPrefix.length)
        if (!rel || rel.startsWith('.snapshots/')) continue
        if (rel === 'SKILL.md') foundSkillMd = true
        const dst = path.join(tmpExtract, rel)
        const resolved = path.resolve(dst)
        if (!resolved.startsWith(tmpExtractPrefix)) {
          throw new Error(`archive 包含非法路径 ${e.entryName}（path traversal）`)
        }
        await fs.mkdir(path.dirname(dst), { recursive: true })
        await fs.writeFile(dst, e.getData())
      }
      if (!foundSkillMd) throw new Error(`archive 中 ${innerPrefix}SKILL.md 不存在`)

      return await this.installSkillFromDirectory(
        tmpExtract,
        { source_type: 'imported', source_package: sourceGitUrl, source_url: skillMdUrl },
        overwrite,
      )
    } finally {
      await fs.rm(tmpExtract, { recursive: true, force: true }).catch(() => {})
    }
  }

  /**
   * 从本地目录路径导入（读取 <dirPath>/SKILL.md）
   * 禁止访问系统敏感目录，防止路径穿越
   */
  private async importFromLocalPathUnlocked(
    dirPath: string,
    overwrite?: boolean,
  ): Promise<{ entry: SkillRegistryEntry; was_overwrite: boolean }> {
    const resolved = path.resolve(dirPath)
    const FORBIDDEN_PREFIXES = ['/etc', '/proc', '/sys', '/dev', '/var/run', '/root', '/boot']
    if (FORBIDDEN_PREFIXES.some(p => resolved === p || resolved.startsWith(p + '/'))) {
      throw new Error('禁止访问此目录')
    }
    return await this.installSkillFromDirectory(
      resolved,
      { source_type: 'imported', source_package: resolved, source_url: `file://${resolved}` },
      overwrite,
    )
  }

  /**
   * 把一个完整的 skill 目录安装到 <data_dir>/skills/<id>/ 下。
   *
   * 行为：
   * - 读 srcDir/SKILL.md 解析 name/description/version
   * - 重名检测：is_builtin 拒绝；否则未 overwrite 抛 DuplicateSkillError；overwrite 走 swap
   * - 覆盖前把旧目录 rename 成 .snapshots/<id>-<ts> 当 previous_snapshot
   * - 用 tmp 目录复制 srcDir，最后 rename 到 targetDir，失败清理 tmp（原子写）
   */
  private async installSkillFromDirectory(
    srcDir: string,
    sourceMeta: { source_type?: 'imported' | 'scanned'; source_package?: string; source_url?: string },
    overwrite?: boolean,
  ): Promise<{ entry: SkillRegistryEntry; was_overwrite: boolean }> {
    const content = await fs.readFile(path.join(srcDir, 'SKILL.md'), 'utf8').catch(() => { throw new Error(`${srcDir} 中未找到 SKILL.md 文件`) })
    const parsed = parseSkillMd(content)
    if (!parsed.name || !isValidSkillName(parsed.name)) throw new Error('SKILL.md name is invalid')
    const existing = this.findByName(parsed.name)
    if (existing && (!overwrite || existing.is_builtin)) throw new DuplicateSkillError(existing, { name: parsed.name, description: parsed.description, version: parsed.version })
    const target = path.join(this.skillsRoot, parsed.name)
    const targetExisted = await fs.access(target).then(() => true).catch(() => false)
    if (!existing && targetExisted) throw new Error(`目录 ${target} 已存在但 registry 中找不到对应 entry，可能是孤儿数据，请手工清理`)
    const stage = path.join(this.skillsRoot, `.stage.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`)
    try {
      await copyDir(srcDir, stage, ['.skill_dir', '.DS_Store'])
      const now = generateTimestamp()
      const snapshotRel = path.posix.join('.snapshots', `${parsed.name}-${isoCompactTs(now)}`)
      const snapshot = this.resolveTransactionPath(snapshotRel)
      const entry: SkillRegistryEntry = {
        id: existing?.id ?? generateId(), name: parsed.name, description: parsed.description, version: parsed.version, skill_dir: target,
        trigger_phrases: existing?.trigger_phrases, source_type: sourceMeta.source_type ?? 'imported', is_builtin: false,
        is_essential: existing?.is_essential ?? false, can_disable: true, source_market: existing?.source_market,
        source_package: sourceMeta.source_package ?? existing?.source_package, source_url: sourceMeta.source_url ?? existing?.source_url,
        enabled: existing?.enabled ?? true, created_at: existing?.created_at ?? now, updated_at: now,
        previous_snapshot: existing && targetExisted ? { snapshot_dir: snapshotRel, version: existing.version, updated_at: existing.updated_at, snapshotted_at: now } : undefined,
      }
      const next = new Map(this.skills); next.set(entry.id, entry)
      const hashes = new Map(this.contentTreeHashes); hashes.set(entry.id, await this.hashContentTree(stage))
      await this.commit(next, async () => {
        if (targetExisted) { await fs.mkdir(path.dirname(snapshot), { recursive: true }); await fs.rename(target, snapshot) }
        try { await fs.rename(stage, target) } catch (error) { if (targetExisted) await fs.rename(snapshot, target).catch(() => {}); throw error }
      }, hashes, {
        before_target_rel: this.relativeTransactionPath(existing?.skill_dir ?? target), after_target_rel: this.relativeTransactionPath(target), before_target_existed: targetExisted,
        before_target_tree_hash: existing ? this.contentTreeHashes.get(existing.id) : undefined, after_target_tree_hash: hashes.get(entry.id), stage_rel: this.relativeTransactionPath(stage),
        ...(targetExisted ? { backup_rel: snapshotRel } : {}),
      })
      return { entry, was_overwrite: !!existing }
    } catch (error) { await fs.rm(stage, { recursive: true, force: true }).catch(() => {}); throw error }
  }

  /**
   * 从 zip/skills 文件的 base64 内容导入
   */
  private async importFromZipUnlocked(
    base64Content: string,
    filename: string,
    overwrite?: boolean,
  ): Promise<{ entry: SkillRegistryEntry; was_overwrite: boolean }> {
    const buffer = Buffer.from(base64Content, 'base64')
    const zip = new AdmZip(buffer)
    const entries = zip.getEntries()

    // 1. zip slip 防御：entry 名不能包含 ..
    for (const e of entries) {
      if (e.entryName.includes('..')) {
        throw new Error(`zip 包含非法路径 ${e.entryName}（path traversal）`)
      }
    }

    // 2. 找到 SKILL.md 决定是否需要 strip 一层 wrapper
    const rootSkillMd = entries.find(e => e.entryName === 'SKILL.md')
    let wrapperPrefix: string | null = null
    if (!rootSkillMd) {
      const wrappedSkillMd = entries.find(e => /^[^/]+\/SKILL\.md$/.test(e.entryName))
      if (!wrappedSkillMd) {
        throw new Error(`${filename} 中未找到 SKILL.md 文件`)
      }
      wrapperPrefix = wrappedSkillMd.entryName.replace(/SKILL\.md$/, '')
    }

    // 3. 解压到 tmp 目录
    await fs.mkdir(this.skillsRoot, { recursive: true })
    const tmpExtract = path.join(this.skillsRoot, `.extract.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`)
    const tmpExtractPrefix = path.resolve(tmpExtract) + path.sep
    try {
      await fs.mkdir(tmpExtract, { recursive: true })
      for (const e of entries) {
        if (e.isDirectory) continue
        let rel = e.entryName
        if (wrapperPrefix) {
          if (!rel.startsWith(wrapperPrefix)) continue
          rel = rel.slice(wrapperPrefix.length)
        }
        if (rel === '' || rel.startsWith('.snapshots/')) continue
        const dst = path.join(tmpExtract, rel)
        // 双重防御：resolve 后必须在 tmpExtract 内（rel 为空已被上面 continue 过滤）
        const resolved = path.resolve(dst)
        if (!resolved.startsWith(tmpExtractPrefix)) {
          throw new Error(`zip 包含非法路径 ${e.entryName}（path traversal）`)
        }
        await fs.mkdir(path.dirname(dst), { recursive: true })
        await fs.writeFile(dst, e.getData())
      }

      return await this.installSkillFromDirectory(
        tmpExtract,
        { source_type: 'imported', source_package: filename },
        overwrite,
      )
    } finally {
      await fs.rm(tmpExtract, { recursive: true, force: true }).catch(() => {})
    }
  }

  // --------------------------------------------------------------------------
  // 内部辅助方法
  // --------------------------------------------------------------------------

  private parseGitHubUrl(url: string): { owner: string; repo: string; branch?: string; subPath?: string } | null {
    // https://github.com/user/repo
    let m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/?$/)
    if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, '') }

    // https://github.com/user/repo/tree/branch/path/to/dir
    m = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/tree\/([^/]+)\/?(.*)$/)
    if (m) return { owner: m[1], repo: m[2].replace(/\.git$/, ''), branch: m[3], subPath: m[4] }

    return null
  }

  private async scanGitHubDir(
    owner: string,
    repo: string,
    branch: string,
    dirPath: string
  ): Promise<Array<{ path: string; name: string; description: string; skill_md_url: string }>> {
    // 优先使用 Git Trees API：一次请求拿到完整文件树，避免 N+1 请求和多层递归限制
    try {
      return await this.scanWithTreesAPI(owner, repo, branch, dirPath)
    } catch {
      // 降级：使用 Contents API（仅扫描两层）
      return await this.scanWithContentsAPI(owner, repo, branch, dirPath)
    }
  }

  /**
   * 使用 Git Trees API 一次性扫描完整文件树（推荐，仅 1 次 API 请求）
   *
   * 找出所有 SKILL.md 文件，然后过滤"叶子节点"：
   * 若 A/SKILL.md 存在且 A/B/SKILL.md 也存在，则 A/SKILL.md 是类别描述，忽略；
   * 只返回没有更深层 SKILL.md 的那些。
   */
  private async scanWithTreesAPI(
    owner: string,
    repo: string,
    branch: string,
    dirPath: string
  ): Promise<Array<{ path: string; name: string; description: string; skill_md_url: string }>> {
    const headers = {
      'User-Agent': 'Crabot/1.0',
      Accept: 'application/vnd.github.v3+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    }
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`
    const response = await fetch(treeUrl, { headers, signal: AbortSignal.timeout(20000) })
    if (!response.ok) {
      throw new Error(`Trees API 失败: ${response.status}`)
    }
    const data = await response.json() as { truncated?: boolean; tree: Array<{ path: string; type: string }> }
    if (data.truncated) {
      throw new Error('Tree truncated') // 降级到 Contents API
    }

    // 找出所有 SKILL.md 的路径（区分大小写，仅文件）
    let skillMdPaths = data.tree
      .filter(item => item.type === 'blob' && (item.path === 'SKILL.md' || item.path.endsWith('/SKILL.md')))
      .map(item => item.path)

    // 如果指定了子目录，只保留该目录下的
    if (dirPath) {
      skillMdPaths = skillMdPaths.filter(p => p.startsWith(dirPath + '/'))
    }

    if (skillMdPaths.length === 0) return []

    // 提取每个 SKILL.md 的父目录路径（如 "engineering/agent-designer/SKILL.md" → "engineering/agent-designer"）
    const skillDirs = skillMdPaths.map(p => p.slice(0, -'/SKILL.md'.length).replace(/^\//, '') || '')

    // 叶子节点过滤：若 dir 是另一个 dir 的前缀，则 dir 是类别描述，跳过
    const leafDirs = skillDirs.filter(dir => {
      const prefix = dir === '' ? '' : dir + '/'
      return !skillDirs.some(other => other !== dir && (prefix === '' ? other !== '' : other.startsWith(prefix)))
    })

    // 构造结果：并发拉取 SKILL.md 内容，获取真实 name/description
    // 分批并发（每批 8 个），避免同时发起几百个请求
    const CONCURRENCY = 8
    const results: Array<{ path: string; name: string; description: string; skill_md_url: string }> = []

    for (let i = 0; i < leafDirs.length; i += CONCURRENCY) {
      const batch = leafDirs.slice(i, i + CONCURRENCY)
      const batchResults = await Promise.all(batch.map(async (leafDir) => {
        const skillMdPath = leafDir ? `${leafDir}/SKILL.md` : 'SKILL.md'
        const skillMdUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${skillMdPath}`
        try {
          const res = await fetch(skillMdUrl, {
            headers: { 'User-Agent': 'Crabot/1.0' },
            signal: AbortSignal.timeout(8000),
          })
          const content = res.ok ? await res.text() : ''
          const parsed = parseSkillMd(content)
          // 过滤掉没有 name 的（可能是类别描述或格式错误的文件）
          if (!parsed.name) return null
          return { path: leafDir, name: parsed.name, description: parsed.description, skill_md_url: skillMdUrl }
        } catch {
          return null
        }
      }))
      for (const r of batchResults) {
        if (r) results.push(r)
      }
    }

    return results
  }

  /**
   * 降级方案：使用 Contents API 逐层扫描（最多两层，处理简单仓库）
   * 注意：无法处理三层深的 skill 仓库（如 alirezarezvani/claude-skills）
   */
  private async scanWithContentsAPI(
    owner: string,
    repo: string,
    branch: string,
    dirPath: string
  ): Promise<Array<{ path: string; name: string; description: string; skill_md_url: string }>> {
    const headers = {
      'User-Agent': 'Crabot/1.0',
      Accept: 'application/vnd.github.v3+json',
      ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
    }
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${dirPath}?ref=${branch}`
    const response = await fetch(apiUrl, { headers, signal: AbortSignal.timeout(15000) })
    if (!response.ok) {
      throw new Error(`GitHub API 请求失败: ${response.status} ${response.statusText}`)
    }
    const items = await response.json() as Array<{ name: string; type: string; path: string; download_url: string | null }>

    // 当前目录有 SKILL.md → 单 skill 仓库
    const skillMdItem = items.find(i => i.type === 'file' && i.name === 'SKILL.md')
    if (skillMdItem && skillMdItem.download_url) {
      const mdRes = await fetch(skillMdItem.download_url, { signal: AbortSignal.timeout(10000) })
      const content = mdRes.ok ? await mdRes.text() : ''
      const parsed = parseSkillMd(content)
      const skillName = parsed.name || dirPath.split('/').pop() || repo
      return [{ path: dirPath, name: skillName, description: parsed.description, skill_md_url: skillMdItem.download_url }]
    }

    // 无 SKILL.md → 扫描一层子目录
    const results: Array<{ path: string; name: string; description: string; skill_md_url: string }> = []
    for (const item of items) {
      if (item.type !== 'dir') continue
      try {
        const subRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/contents/${item.path}?ref=${branch}`,
          { headers, signal: AbortSignal.timeout(10000) }
        )
        if (!subRes.ok) continue
        const subItems = await subRes.json() as Array<{ name: string; type: string; download_url: string | null }>
        const subSkillMd = subItems.find(i => i.type === 'file' && i.name === 'SKILL.md')
        if (subSkillMd && subSkillMd.download_url) {
          const mdRes = await fetch(subSkillMd.download_url, { signal: AbortSignal.timeout(10000) })
          const content = mdRes.ok ? await mdRes.text() : ''
          const parsed = parseSkillMd(content)
          results.push({
            path: item.path,
            name: parsed.name || item.name,
            description: parsed.description,
            skill_md_url: subSkillMd.download_url,
          })
        }
      } catch {
        // 忽略单个子目录失败
      }
    }
    return results
  }
}

// ============================================================================
// 必要工具配置管理器
// ============================================================================

const DEFAULT_ESSENTIAL_CONFIG: EssentialToolsConfig = {
  builtin_overrides: {},
  essential_mcp_server_ids: [],
  essential_skill_ids: [],
}

export class EssentialToolsManager {
  private config: EssentialToolsConfig = { ...DEFAULT_ESSENTIAL_CONFIG }
  private readonly filePath: string

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'essential-tools.json')
  }

  async initialize(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      this.config = JSON.parse(raw)
    } catch {
      this.config = { ...DEFAULT_ESSENTIAL_CONFIG }
    }
  }

  get(): EssentialToolsConfig {
    return { ...this.config }
  }

  /**
   * 原子写入文件：先写临时文件，再 rename（避免进程被杀时文件损坏）
   */
  private async atomicWriteFile(filePath: string, content: string): Promise<void> {
    const tempPath = `${filePath}.tmp`
    await fs.writeFile(tempPath, content, 'utf-8')
    await fs.rename(tempPath, filePath)
  }

  async update(params: Partial<EssentialToolsConfig>): Promise<EssentialToolsConfig> {
    this.config = { ...this.config, ...params }
    await this.atomicWriteFile(this.filePath, JSON.stringify(this.config, null, 2))
    return this.get()
  }
}

/**
 * 递归读 skill_dir 下的所有附属文件（SKILL.md 已单独存 content，不读）。
 *
 * - 跳过 SKILL.md / .skill_dir / .DS_Store / 任何 '.' 开头文件
 * - 文本文件按 utf-8 直存
 * - 二进制（含 NUL byte 或 utf-8 round-trip 不一致）用 'base64:' 前缀编码
 * - 单文件 > 1MB 跳过 + console.warn
 * - 累计 > 5MB 返回 undefined（仅留 SKILL.md content）
 */
export async function readSkillDirFiles(dir: string): Promise<Record<string, string> | undefined> {
  const result: Record<string, string> = {}
  let totalSize = 0
  let tooLarge = false

  async function walk(currentDir: string, relativePrefix: string): Promise<void> {
    if (tooLarge) return
    const entries = await fs.readdir(currentDir, { withFileTypes: true })
    for (const ent of entries) {
      if (tooLarge) return
      const name = ent.name
      if (SNAPSHOT_SKIPPED_NAMES.has(name) || name.startsWith('.')) continue
      const fullPath = path.join(currentDir, name)
      const relPath = relativePrefix ? `${relativePrefix}/${name}` : name
      if (ent.isDirectory()) {
        await walk(fullPath, relPath)
      } else if (ent.isFile()) {
        const stat = await fs.stat(fullPath)
        if (stat.size > MAX_FILE_SIZE_BYTES) {
          console.warn(`[skill snapshot] 跳过大文件 ${fullPath} (${stat.size} bytes > ${MAX_FILE_SIZE_BYTES})`)
          continue
        }
        totalSize += stat.size
        if (totalSize > MAX_TOTAL_SIZE_BYTES) {
          console.warn(`[skill snapshot] 总大小超 ${MAX_TOTAL_SIZE_BYTES}，放弃 files snapshot`)
          tooLarge = true
          return
        }
        const buf = await fs.readFile(fullPath)
        const text = buf.toString('utf-8')
        const isBinary = buf.includes(0) || Buffer.from(text, 'utf-8').compare(buf) !== 0
        result[relPath] = isBinary ? `base64:${buf.toString('base64')}` : text
      }
    }
  }

  await walk(dir, '')
  return tooLarge ? undefined : result
}

/**
 * 把 SKILL.md content + files 原子性写回 skill_dir。
 *
 * 行为：
 * - SKILL.md 写 content（tmp + rename）
 * - files 中每条按相对路径写（base64: 前缀解码回二进制）
 * - 嵌套路径自动 mkdir -p
 * - 清理：遍历 skill_dir，删除不在 (SKILL.md ∪ files keys ∪ SNAPSHOT_SKIPPED_NAMES ∪ '.' 开头) 的所有文件
 * - 删除空的子目录（post-order）
 * - files = undefined 时只重写 SKILL.md，不动其它（snapshot 时 files 已放弃）
 * - 任一步失败 throw（不留半成品中间状态由调用方决定回滚）
 */
export async function writeSkillDirFiles(
  dir: string,
  content: string,
  files: Record<string, string> | undefined,
): Promise<void> {
  await fs.mkdir(dir, { recursive: true })

  // 1. 写 SKILL.md（atomic）
  await atomicWrite(path.join(dir, 'SKILL.md'), Buffer.from(content, 'utf-8'))

  // 2. 写 files（只在 files 提供时）
  if (files !== undefined) {
    for (const [relPath, value] of Object.entries(files)) {
      const fullPath = path.join(dir, relPath)
      await fs.mkdir(path.dirname(fullPath), { recursive: true })
      const buf = value.startsWith('base64:')
        ? Buffer.from(value.slice('base64:'.length), 'base64')
        : Buffer.from(value, 'utf-8')
      await atomicWrite(fullPath, buf)
    }

    // 3. 清理：遍历现有目录删除不在 keep 集合内的（除 SKILL.md / SNAPSHOT_SKIPPED_NAMES / 隐藏文件）
    const keepSet = new Set(Object.keys(files))
    await cleanupExtraFiles(dir, '', keepSet)
  }
}

async function atomicWrite(filePath: string, buf: Buffer): Promise<void> {
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`
  await fs.writeFile(tmpPath, buf)
  await fs.rename(tmpPath, filePath)
}

async function atomicWriteFileBuf(filePath: string, buf: Buffer): Promise<void> {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`
  await fs.writeFile(tmp, buf)
  await fs.rename(tmp, filePath)
}

async function cleanupExtraFiles(
  rootDir: string,
  relPrefix: string,
  keepSet: Set<string>,
): Promise<void> {
  const currentDir = path.join(rootDir, relPrefix)
  const entries = await fs.readdir(currentDir, { withFileTypes: true })
  for (const ent of entries) {
    const name = ent.name
    if (SNAPSHOT_SKIPPED_NAMES.has(name) || name.startsWith('.')) continue
    const relPath = relPrefix ? `${relPrefix}/${name}` : name
    const fullPath = path.join(currentDir, name)
    if (ent.isDirectory()) {
      await cleanupExtraFiles(rootDir, relPath, keepSet)
      // post-order：清理后看子目录是否变空，空则删
      const remaining = await fs.readdir(fullPath)
      if (remaining.length === 0) {
        await fs.rmdir(fullPath)
      }
    } else if (ent.isFile()) {
      if (!keepSet.has(relPath)) {
        await fs.unlink(fullPath)
      }
    }
  }
}

/**
 * 把 ISO 时间戳里的 `:` 和 `.` 替换成 `-`，用于做安全的目录名（Windows 不接受 `:`）
 */
function isoCompactTs(iso: string): string {
  return iso.replace(/[:.]/g, '-')
}

/**
 * 校验 skill name 是否符合 Anthropic 规范且可安全做目录名：
 * - 仅小写字母 / 数字 / 连字符
 * - 长度 1-64
 * 防御 path traversal / Windows 非法字符等。
 */
function isValidSkillName(name: string): boolean {
  return /^[a-z0-9-]{1,64}$/.test(name)
}

/**
 * 递归复制目录到目标位置。skipNames 中列出的文件/目录名直接跳过（如 .skill_dir, .DS_Store）。
 */
async function copyDir(src: string, dst: string, skipNames: string[] = []): Promise<void> {
  await fs.mkdir(dst, { recursive: true })
  const entries = await fs.readdir(src, { withFileTypes: true })
  for (const ent of entries) {
    if (skipNames.includes(ent.name)) continue
    const s = path.join(src, ent.name)
    const d = path.join(dst, ent.name)
    if (ent.isDirectory()) {
      await copyDir(s, d, skipNames)
    } else if (ent.isFile()) {
      await fs.copyFile(s, d)
    }
  }
}
