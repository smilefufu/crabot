/**
 * MCP Server 和 Skill 注册表管理器
 *
 * 负责全局 MCP Server 和 Skill 的 CRUD、持久化、以及必要工具配置管理
 */

import fs from 'fs/promises'
import path from 'path'
import { randomBytes } from 'node:crypto'
import AdmZip from 'adm-zip'
import { canonicalizeJson, generateId, generateTimestamp } from 'crabot-shared'
import type { ConfigDomain } from './core-agent-config-revision-store.js'
import type { OnConflict } from './backup/import/import-types.js'

export type RegistryMutationRunner = (
  domains: ConfigDomain[],
  prepareAfterSnapshot: () => Promise<unknown>,
  applySourceMutation: () => Promise<void>,
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

export class SkillManager {
  private skills: Map<string, SkillRegistryEntry> = new Map()
  private readonly filePath: string
  private readonly skillsRoot: string

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'skills.json')
    this.skillsRoot = path.join(dataDir, 'skills')
  }

  async initialize(): Promise<void> {
    await this.load()
    await this.migrateLegacyEntries()
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
    } catch {
      this.skills = new Map()
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
  private async migrateLegacyEntries(): Promise<void> {
    let needsMigrate = false
    for (const e of this.skills.values()) {
      const raw = e as SkillRegistryEntry & { content?: string }
      const prev = raw.previous_snapshot as
        | undefined
        | { content?: string; files?: Record<string, string>; snapshot_dir?: string; version: string; updated_at: string; snapshotted_at: string }
      if (raw.content !== undefined || (prev && prev.content !== undefined)) {
        needsMigrate = true
        break
      }
      // 已是新格式但 skill_dir basename 不是 name（UUID 命名 → name 命名）
      if (!e.is_builtin && e.skill_dir && e.skill_dir.startsWith(this.skillsRoot + path.sep)) {
        if (path.basename(e.skill_dir) !== e.name) {
          needsMigrate = true
          break
        }
      }
    }
    if (!needsMigrate) return

    // 备份 skills.json
    const backupPath = `${this.filePath}.bak-${isoCompactTs(generateTimestamp())}`
    try { await fs.copyFile(this.filePath, backupPath) } catch {}

    let migrated = 0
    for (const [id, raw] of this.skills) {
      const entry = raw as SkillRegistryEntry & { content?: string }

      // builtin 不迁移文件（registerBuiltins / seedBuiltinSkills 会用磁盘 builtin 目录同步）
      if (entry.is_builtin) {
        if (entry.content !== undefined) {
          delete (entry as { content?: string }).content
          migrated++
        }
        // 旧 seed 写入的 entry 可能缺 skill_dir（Task 6 之前的形态）→ 删除让下游 seed 重建
        if (!entry.skill_dir) {
          this.skills.delete(id)
          console.warn(`[SkillManager] builtin "${entry.name}" 缺 skill_dir，已删除待重 seed`)
          migrated++
        }
        continue
      }

      // scanned：保留 skill_dir 引用，只清 content 字段
      if (entry.source_type === 'scanned') {
        if (entry.content !== undefined) {
          delete (entry as { content?: string }).content
          migrated++
        }
        continue
      }

      // 用 name 做目录名（对齐 Anthropic 标准）；name 缺失时降级到 id（防御性）
      const dirName = entry.name && isValidSkillName(entry.name) ? entry.name : id
      const newSkillDir = path.join(this.skillsRoot, dirName)
      const newHasSkillMd = await fs.access(path.join(newSkillDir, 'SKILL.md')).then(() => true).catch(() => false)

      if (!newHasSkillMd && entry.content !== undefined) {
        // 1. 在 <skillsRoot>/<name>/ 写 SKILL.md
        await fs.mkdir(newSkillDir, { recursive: true })
        await atomicWriteFileBuf(path.join(newSkillDir, 'SKILL.md'), Buffer.from(entry.content, 'utf-8'))

        // 2. 若旧 skill_dir 指向用户原目录（importFromLocalPath legacy 语义），复制附属文件
        if (entry.skill_dir && entry.skill_dir !== newSkillDir) {
          const oldExists = await fs.access(entry.skill_dir).then(() => true).catch(() => false)
          if (oldExists) {
            await copyDir(entry.skill_dir, newSkillDir, ['SKILL.md', '.skill_dir', '.DS_Store'])
          } else {
            console.warn(`[SkillManager] legacy skill "${entry.name}" 原目录 ${entry.skill_dir} 已不存在，仅迁移 SKILL.md（scripts/references/assets 丢失）`)
          }
        }
        entry.skill_dir = newSkillDir
      } else if (!entry.skill_dir) {
        // 无 content 又无 skill_dir 的 zombie entry
        console.warn(`[SkillManager] legacy entry "${entry.name}" 无 content 无 skill_dir，无法迁移`)
        entry.skill_dir = newSkillDir
      } else if (
        entry.skill_dir.startsWith(this.skillsRoot + path.sep) &&
        path.basename(entry.skill_dir) !== dirName
      ) {
        // 已新格式但目录名是 UUID（或别的旧 basename），rename 到 name 目录
        const targetExists = await fs.access(newSkillDir).then(() => true).catch(() => false)
        if (targetExists) {
          console.warn(`[SkillManager] 无法迁移 "${entry.name}"：目标目录 ${newSkillDir} 已存在`)
        } else {
          const srcExists = await fs.access(entry.skill_dir).then(() => true).catch(() => false)
          if (srcExists) {
            await fs.rename(entry.skill_dir, newSkillDir)
            // 同步 previous_snapshot.snapshot_dir 里的旧 basename 前缀
            const oldBasename = path.basename(entry.skill_dir)
            if (entry.previous_snapshot?.snapshot_dir?.includes(`/${oldBasename}-`)) {
              const oldSnapRel = entry.previous_snapshot.snapshot_dir
              const oldSnapAbs = path.join(this.skillsRoot, oldSnapRel)
              const newSnapRel = oldSnapRel.replace(`/${oldBasename}-`, `/${dirName}-`)
              const newSnapAbs = path.join(this.skillsRoot, newSnapRel)
              const oldSnapExists = await fs.access(oldSnapAbs).then(() => true).catch(() => false)
              if (oldSnapExists) {
                await fs.rename(oldSnapAbs, newSnapAbs)
                entry.previous_snapshot = { ...entry.previous_snapshot, snapshot_dir: newSnapRel }
              }
            }
            entry.skill_dir = newSkillDir
          }
        }
      }

      // 3. 迁移 previous_snapshot 嵌入式 → 文件夹
      const prev = entry.previous_snapshot as
        | undefined
        | { content?: string; files?: Record<string, string>; snapshot_dir?: string; version: string; updated_at: string; snapshotted_at: string }
      if (prev && prev.content !== undefined && !prev.snapshot_dir) {
        const snapTs = isoCompactTs(prev.snapshotted_at)
        const snapRel = path.posix.join('.snapshots', `${dirName}-${snapTs}`)
        const snapAbs = path.join(this.skillsRoot, snapRel)
        await fs.mkdir(snapAbs, { recursive: true })
        await atomicWriteFileBuf(path.join(snapAbs, 'SKILL.md'), Buffer.from(prev.content, 'utf-8'))
        if (prev.files) {
          for (const [rel, val] of Object.entries(prev.files)) {
            const dst = path.join(snapAbs, rel)
            await fs.mkdir(path.dirname(dst), { recursive: true })
            const buf = val.startsWith('base64:') ? Buffer.from(val.slice(7), 'base64') : Buffer.from(val, 'utf-8')
            await atomicWriteFileBuf(dst, buf)
          }
        }
        entry.previous_snapshot = {
          snapshot_dir: snapRel,
          version: prev.version,
          updated_at: prev.updated_at,
          snapshotted_at: prev.snapshotted_at,
        }
      }

      // 4. 清 content 字段
      if (entry.content !== undefined) {
        delete (entry as { content?: string }).content
      }
      migrated++
    }
    if (migrated > 0) {
      await this.save()
      console.log(`[SkillManager] 迁移 ${migrated} 个 legacy skill 到 filesystem-native 布局`)
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
    await fs.mkdir(skillDir, { recursive: true })
    await atomicWriteFileBuf(path.join(skillDir, 'SKILL.md'), Buffer.from(params.content, 'utf-8'))

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
    this.skills.set(entry.id, entry)
    await this.save()
    return entry
  }

  async update(
    id: string,
    params: Partial<Pick<SkillRegistryEntry, 'name' | 'description' | 'version' | 'trigger_phrases' | 'is_essential' | 'enabled'>>
      & { content?: string },
  ): Promise<SkillRegistryEntry> {
    const entry = this.skills.get(id)
    if (!entry) throw new Error(`Skill not found: ${id}`)
    if (!entry.can_disable && params.enabled === false) {
      throw new Error(`Skill "${entry.name}" cannot be disabled`)
    }
    if (params.content !== undefined && entry.is_builtin) {
      throw new Error(`Skill "${entry.name}" 是内置的，不能修改 content`)
    }

    // 处理 name 改名：mv 物理目录（仅在 skillsRoot 下的非 builtin entry）
    let workingSkillDir = entry.skill_dir
    if (params.name !== undefined && params.name !== entry.name && !entry.is_builtin) {
      if (!isValidSkillName(params.name)) {
        throw new Error(`Skill name "${params.name}" 含非法字符（仅允许小写字母/数字/连字符，最长 64 字符）`)
      }
      const newNameConflict = Array.from(this.skills.values()).find(s => s.id !== id && s.name === params.name)
      if (newNameConflict) {
        throw new Error(`Skill name "${params.name}" 已被其他 entry 使用`)
      }
      const isUnderSkillsRoot = entry.skill_dir.startsWith(this.skillsRoot + path.sep)
      if (isUnderSkillsRoot) {
        const newSkillDir = path.join(this.skillsRoot, params.name)
        const newExists = await fs.access(newSkillDir).then(() => true).catch(() => false)
        if (newExists) {
          throw new Error(`目标目录 ${newSkillDir} 已存在`)
        }
        await fs.rename(entry.skill_dir, newSkillDir)
        workingSkillDir = newSkillDir
      }
    }

    let previousSnapshot = entry.previous_snapshot
    if (params.content !== undefined && !entry.is_builtin) {
      const skillMdPath = path.join(workingSkillDir, 'SKILL.md')
      const oldContent = await fs.readFile(skillMdPath, 'utf-8').catch(() => '')
      if (oldContent !== params.content) {
        const snapTs = isoCompactTs(generateTimestamp())
        // snapshot 用当前 name（取改名后的，若改了名）
        const snapBase = params.name ?? entry.name
        const snapRel = path.posix.join('.snapshots', `${snapBase}-${snapTs}`)
        const snapDir = path.join(this.skillsRoot, snapRel)
        await fs.mkdir(path.dirname(snapDir), { recursive: true })
        // 1. 先 copy 到 tmp，成功后 rename 到正式 snapDir；失败仅 tmp 残留被清，旧 snapshot 完好
        const tmpSnapDir = `${snapDir}.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`
        try {
          await copyDir(workingSkillDir, tmpSnapDir)
          await fs.rename(tmpSnapDir, snapDir)
        } catch (err) {
          await fs.rm(tmpSnapDir, { recursive: true, force: true }).catch(() => {})
          throw err
        }
        // 2. 新 snapshot 已就位，再删旧（N=1）
        if (entry.previous_snapshot) {
          await fs.rm(path.join(this.skillsRoot, entry.previous_snapshot.snapshot_dir), { recursive: true, force: true })
        }
        await atomicWriteFileBuf(skillMdPath, Buffer.from(params.content, 'utf-8'))
        previousSnapshot = {
          snapshot_dir: snapRel,
          version: entry.version,
          updated_at: entry.updated_at,
          snapshotted_at: generateTimestamp(),
        }
      }
    }

    const updated: SkillRegistryEntry = {
      ...entry,
      name: params.name ?? entry.name,
      description: params.description ?? entry.description,
      version: params.version ?? entry.version,
      skill_dir: workingSkillDir,
      trigger_phrases: params.trigger_phrases ?? entry.trigger_phrases,
      is_essential: params.is_essential ?? entry.is_essential,
      enabled: params.enabled ?? entry.enabled,
      previous_snapshot: previousSnapshot,
      updated_at: generateTimestamp(),
    }
    this.skills.set(id, updated)
    await this.save()
    return updated
  }

  async restore(id: string): Promise<SkillRegistryEntry> {
    const entry = this.skills.get(id)
    if (!entry) throw new Error(`Skill not found: ${id}`)
    if (entry.is_builtin) throw new Error(`Skill "${entry.name}" 是内置的，不能 restore`)
    if (!entry.previous_snapshot) throw new Error(`Skill "${entry.name}" 没有上一版可恢复`)

    const oldSnapRel = entry.previous_snapshot.snapshot_dir
    const oldSnapDir = path.join(this.skillsRoot, oldSnapRel)
    const now = generateTimestamp()
    const newSnapTs = isoCompactTs(now)
    const newSnapRel = path.posix.join('.snapshots', `${entry.name}-${newSnapTs}`)
    const newSnapDir = path.join(this.skillsRoot, newSnapRel)
    await fs.mkdir(path.dirname(newSnapDir), { recursive: true })

    // 三段 swap：当前→stash，旧→当前，stash→新
    const tempStash = path.join(this.skillsRoot, `.swap.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`)
    await fs.rename(entry.skill_dir, tempStash)
    let stepASucceeded = false
    try {
      await fs.rename(oldSnapDir, entry.skill_dir)
      stepASucceeded = true
      await fs.rename(tempStash, newSnapDir)
    } catch (err) {
      if (!stepASucceeded) {
        // A 失败：tempStash 还在，旧 snapshot 完好，把 stash 还回去
        await fs.rename(tempStash, entry.skill_dir).catch(() => {})
      } else {
        // B 失败：磁盘 swap 已半成功（entry.skill_dir 已是旧版内容），但 registry 尚未更新。
        // tempStash 是被替换下来的"原新版"内容；把它挪到 .orphan-<ts> 便于用户手工捞，
        // 然后抛 error 让 upstream 知道 registry 没同步。
        const orphanRel = path.posix.join('.snapshots', `${entry.name}-orphan-${newSnapTs}`)
        const orphanDir = path.join(this.skillsRoot, orphanRel)
        await fs.rename(tempStash, orphanDir).catch(() => {})
      }
      throw err
    }

    const newContent = await fs.readFile(path.join(entry.skill_dir, 'SKILL.md'), 'utf-8')
    const parsed = parseSkillMd(newContent)

    const updated: SkillRegistryEntry = {
      ...entry,
      description: parsed.description,
      version: parsed.version,
      previous_snapshot: {
        snapshot_dir: newSnapRel,
        version: entry.version,
        updated_at: entry.updated_at,
        snapshotted_at: now,
      },
      updated_at: now,
    }
    this.skills.set(id, updated)
    await this.save()
    return updated
  }

  async delete(id: string): Promise<void> {
    const entry = this.skills.get(id)
    if (!entry) throw new Error(`Skill not found: ${id}`)
    if (entry.is_builtin) throw new Error(`Cannot delete built-in Skill "${entry.name}"`)
    this.skills.delete(id)
    await this.save()
  }

  /**
   * 注入内置 Skill：仅当 id 不存在时插入，已存在则跳过。
   * 与 SubAgentManager.seedBuiltin 相同语义。
   */
  async seedBuiltinSkills(entries: SkillRegistryEntry[]): Promise<void> {
    let changed = false
    for (const e of entries) {
      const existing = this.skills.get(e.id)
      if (!existing) {
        this.skills.set(e.id, e)
        changed = true
        continue
      }
      // 修复历史脏数据：旧版本格式的 builtin entry 没有 skill_dir 字段（content 时代遗留），
      // push 给 agent 时 SkillConfig.skill_dir=undefined → agent computeSkillsHash
      // h.update(undefined) 抛 TypeError → 整个 update_config 失败（连带 subagents 不更新）。
      // 这里用 code default 的 skill_dir 补齐；其余字段尊重磁盘上的用户改动。
      if (!existing.skill_dir && e.skill_dir) {
        this.skills.set(e.id, { ...existing, skill_dir: e.skill_dir, updated_at: new Date().toISOString() })
        console.warn(`[SkillManager] Repaired builtin skill "${e.name}" (${e.id}): missing skill_dir → ${e.skill_dir}`)
        changed = true
      }
    }
    if (changed) await this.save()
  }

  /**
   * 注册内置 Skill（幂等：已存在同名的不会重复注册）
   * 在 Admin 初始化时调用，扫描 builtinsDir 下的子目录，每个子目录应包含 SKILL.md
   *
   * 返回本次扫到的可用 builtin skill 数量。扫不到任何一个是异常状态（历史上
   * release 包漏打 SKILL.md 导致 memory-curate 等全部缺失且无声无息），必须报错。
   */
  async registerBuiltins(builtinsDir: string): Promise<number> {
    let dirEntries: import('fs').Dirent[]
    try {
      dirEntries = await fs.readdir(builtinsDir, { withFileTypes: true })
    } catch {
      console.error(`[SkillManager] builtin skills 目录不可读，内置 skill 全部缺失: ${builtinsDir}`)
      return 0
    }

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

    if (changed) {
      await this.save()
    }

    return found
  }

  /**
   * 扫描 workspaceDir/.agents/skills/ 目录，将新发现的 skill 注入注册表。
   * Additive-only：已在注册表中（按 name 匹配）的跳过。
   * 返回本次新增数量。
   */
  async scanWorkspaceSkills(workspaceDir: string): Promise<number> {
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

    if (added > 0) await this.save()
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
  async importFromGit(
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
  async importFromLocalPath(
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
    sourceMeta: {
      source_type?: 'imported' | 'scanned'
      source_package?: string
      source_url?: string
    },
    overwrite?: boolean,
  ): Promise<{ entry: SkillRegistryEntry; was_overwrite: boolean }> {
    let content: string
    try {
      content = await fs.readFile(path.join(srcDir, 'SKILL.md'), 'utf-8')
    } catch {
      throw new Error(`${srcDir} 中未找到 SKILL.md 文件`)
    }
    const parsed = parseSkillMd(content)
    if (!parsed.name) throw new Error('SKILL.md 缺少 name 字段')
    if (!isValidSkillName(parsed.name)) {
      throw new Error(`Skill name "${parsed.name}" 含非法字符（仅允许小写字母/数字/连字符，最长 64 字符）`)
    }

    const existing = this.findByName(parsed.name)
    if (existing && !overwrite) {
      if (existing.is_builtin) {
        throw new Error(`Skill "${existing.name}" 是内置的，不可通过导入覆盖`)
      }
      throw new DuplicateSkillError(existing, {
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
      })
    }
    if (existing?.is_builtin) {
      throw new Error(`Skill "${existing.name}" 是内置的，不可通过导入覆盖`)
    }

    const id = existing?.id ?? generateId()
    const targetDir = path.join(this.skillsRoot, parsed.name)

    await fs.mkdir(this.skillsRoot, { recursive: true })
    // 防御：targetDir 已存在但 registry 中找不到对应 entry（孤儿目录）
    if (!existing) {
      const orphanCheck = await fs.access(targetDir).then(() => true).catch(() => false)
      if (orphanCheck) {
        throw new Error(`目录 ${targetDir} 已存在但 registry 中找不到对应 entry，可能是孤儿数据，请手工清理`)
      }
    }
    const tmpDir = path.join(this.skillsRoot, `.tmp.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`)
    // 放在 try 外面：如果旧 targetDir 已被 rename 到 snapDir，catch 块需要回滚
    let snapDir: string | undefined
    let oldDirExists = false
    try {
      await copyDir(srcDir, tmpDir, ['.skill_dir', '.DS_Store'])

      let previousSnapshotMeta: SkillRegistryEntry['previous_snapshot']
      if (existing) {
        oldDirExists = await fs.access(targetDir).then(() => true).catch(() => false)
        if (oldDirExists) {
          const snapTs = isoCompactTs(generateTimestamp())
          const snapRel = path.posix.join('.snapshots', `${parsed.name}-${snapTs}`)
          snapDir = path.join(this.skillsRoot, snapRel)
          await fs.mkdir(path.dirname(snapDir), { recursive: true })
          if (existing.previous_snapshot?.snapshot_dir) {
            await fs.rm(path.join(this.skillsRoot, existing.previous_snapshot.snapshot_dir), { recursive: true, force: true })
          }
          await fs.rename(targetDir, snapDir)
          previousSnapshotMeta = {
            snapshot_dir: snapRel,
            version: existing.version,
            updated_at: existing.updated_at,
            snapshotted_at: generateTimestamp(),
          }
        }
      }
      await fs.rename(tmpDir, targetDir)

      const now = generateTimestamp()
      // I2: 如果 entry 在 JSON 里但 on-disk 目录早就不在（drift），不要回退到 existing.previous_snapshot
      // 否则会产生指向 orphan snapshot 的悬挂引用
      const fallbackSnapshot = existing && !oldDirExists ? undefined : existing?.previous_snapshot
      const entry: SkillRegistryEntry = {
        id,
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        skill_dir: targetDir,
        trigger_phrases: existing?.trigger_phrases,
        source_type: sourceMeta.source_type ?? 'imported',
        is_builtin: false,
        is_essential: existing?.is_essential ?? false,
        can_disable: true,
        source_market: existing?.source_market,
        source_package: sourceMeta.source_package ?? existing?.source_package,
        source_url: sourceMeta.source_url ?? existing?.source_url,
        enabled: existing?.enabled ?? true,
        created_at: existing?.created_at ?? now,
        updated_at: now,
        previous_snapshot: previousSnapshotMeta ?? fallbackSnapshot,
      }
      this.skills.set(id, entry)
      await this.save()
      return { entry, was_overwrite: !!existing }
    } catch (err) {
      // I1: 如果 snapshot rename 已经发生但后续步骤失败 → 把 snapshot 搬回原 targetDir
      // 避免出现"旧目录在 snapshot 里、新目录没就位、registry 还指向 targetDir"的中间态
      if (snapDir) {
        await fs.rename(snapDir, targetDir).catch(() => {})
      }
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  /**
   * 从 zip/skills 文件的 base64 内容导入
   */
  async importFromZip(
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
