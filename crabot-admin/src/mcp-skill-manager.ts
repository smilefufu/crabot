/**
 * MCP Server 和 Skill 注册表管理器
 *
 * 负责全局 MCP Server 和 Skill 的 CRUD、持久化、以及必要工具配置管理
 */

import fs from 'fs/promises'
import path from 'path'
import AdmZip from 'adm-zip'
import { generateId, generateTimestamp } from './core/base-protocol.js'

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

export interface SkillRegistryEntry {
  id: string
  name: string
  description: string
  version: string
  /** SKILL.md 格式的提示词内容 */
  content: string
  /** skill 所在目录的绝对路径（目录型 skill） */
  skill_dir?: string
  /** 触发短语（用于 LLM 匹配） */
  trigger_phrases?: string[]
  is_builtin: boolean
  is_essential: boolean
  can_disable: boolean
  source_market?: string
  source_package?: string
  enabled: boolean
  created_at: string
  updated_at: string
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

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'mcp-servers.json')
  }

  async initialize(): Promise<void> {
    await this.load()
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
    this.servers.set(entry.id, entry)
    await this.save()
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
    this.servers.set(id, updated)
    await this.save()
    return updated
  }

  async delete(id: string): Promise<void> {
    const entry = this.servers.get(id)
    if (!entry) throw new Error(`MCP Server not found: ${id}`)
    if (entry.is_builtin) throw new Error(`Cannot delete built-in MCP Server "${entry.name}"`)
    this.servers.delete(id)
    await this.save()
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

    // 批量写入，避免 N 次文件 I/O 和竞态
    for (const entry of newEntries) {
      this.servers.set(entry.id, entry)
    }
    await this.save()
    return newEntries
  }

  /**
   * 注册内置 MCP Server（幂等：已存在同名的不会重复注册）
   * 在 Admin 初始化时调用，确保内置工具在首次启动时自动可用
   */
  async registerBuiltins(mcpToolsPath: string): Promise<void> {
    const existingNames = new Set(this.list().map(s => s.name))

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
      if (existingNames.has(builtin.name)) continue
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
      this.servers.set(entry.id, entry)
      changed = true
    }

    if (changed) {
      await this.save()
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

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, 'skills.json')
  }

  async initialize(): Promise<void> {
    await this.load()
  }

  private async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const entries: SkillRegistryEntry[] = JSON.parse(raw)
      this.skills = new Map(entries.map((e) => [e.id, e]))
    } catch {
      this.skills = new Map()
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

  async create(params: {
    name: string
    description: string
    content: string
    version?: string
    trigger_phrases?: string[]
    source_market?: string
    source_package?: string
  }): Promise<SkillRegistryEntry> {
    const now = generateTimestamp()
    const entry: SkillRegistryEntry = {
      id: generateId(),
      name: params.name,
      description: params.description,
      version: params.version ?? '1.0.0',
      content: params.content,
      trigger_phrases: params.trigger_phrases,
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
    params: Partial<
      Pick<
        SkillRegistryEntry,
        'name' | 'description' | 'content' | 'version' | 'trigger_phrases' | 'skill_dir' | 'is_essential' | 'enabled'
      >
    >
  ): Promise<SkillRegistryEntry> {
    const entry = this.skills.get(id)
    if (!entry) throw new Error(`Skill not found: ${id}`)
    if (!entry.can_disable && params.enabled === false) {
      throw new Error(`Skill "${entry.name}" cannot be disabled`)
    }
    const updated: SkillRegistryEntry = {
      ...entry,
      ...params,
      updated_at: generateTimestamp(),
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
   * 注册内置 Skill（幂等：已存在同名的不会重复注册）
   * 在 Admin 初始化时调用，扫描 builtinsDir 下的子目录，每个子目录应包含 SKILL.md
   */
  async registerBuiltins(builtinsDir: string): Promise<void> {
    let dirEntries: import('fs').Dirent[]
    try {
      dirEntries = await fs.readdir(builtinsDir, { withFileTypes: true })
    } catch {
      // builtinsDir 不存在时静默跳过
      return
    }

    const existingNames = new Set(this.list().map(s => s.name))
    let changed = false

    for (const dirent of dirEntries) {
      if (!dirent.isDirectory()) continue
      const skillDir = path.join(builtinsDir, dirent.name)
      const skillMdPath = path.join(skillDir, 'SKILL.md')

      let content: string
      try {
        content = await fs.readFile(skillMdPath, 'utf-8')
      } catch {
        continue // 没有 SKILL.md 的子目录跳过
      }

      const parsed = parseSkillMd(content)
      if (!parsed.name || existingNames.has(parsed.name)) continue

      const now = generateTimestamp()
      const entry: SkillRegistryEntry = {
        id: generateId(),
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        content,
        skill_dir: skillDir,
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

    if (changed) {
      await this.save()
    }
  }

  /** 将注册表条目转换为 Agent 所需的 SkillConfig 格式 */
  toAgentConfig(entry: SkillRegistryEntry): {
    id: string
    name: string
    content: string
    description?: string
    skill_dir?: string
  } {
    return {
      id: entry.id,
      name: entry.name,
      content: entry.content,
      description: entry.description,
      ...(entry.skill_dir ? { skill_dir: entry.skill_dir } : {}),
    }
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
  async importFromGit(skillMdUrl: string, sourceGitUrl?: string): Promise<SkillRegistryEntry> {
    // 严格限制只允许 GitHub raw 内容 URL，防止 SSRF
    let parsedUrl: URL
    try {
      parsedUrl = new URL(skillMdUrl)
    } catch {
      throw new Error('无效的 URL 格式')
    }
    const allowedHosts = ['raw.githubusercontent.com']
    if (!allowedHosts.includes(parsedUrl.hostname) || parsedUrl.protocol !== 'https:') {
      throw new Error('只允许 raw.githubusercontent.com 的 HTTPS URL')
    }

    const response = await fetch(skillMdUrl, {
      headers: { 'User-Agent': 'Crabot/1.0' },
      signal: AbortSignal.timeout(15000),
    })
    if (!response.ok) throw new Error(`无法获取 SKILL.md: ${response.statusText}`)
    const content = await response.text()
    const parsed = parseSkillMd(content)
    if (!parsed.name) throw new Error('SKILL.md 缺少 name 字段')
    return this.create({
      name: parsed.name,
      description: parsed.description,
      version: parsed.version,
      content,
      source_package: sourceGitUrl,
    })
  }

  /**
   * 从本地目录路径导入（读取 <dirPath>/SKILL.md）
   * 禁止访问系统敏感目录，防止路径穿越
   */
  async importFromLocalPath(dirPath: string): Promise<SkillRegistryEntry> {
    const resolved = path.resolve(dirPath)
    // 禁止访问敏感系统路径
    const FORBIDDEN_PREFIXES = ['/etc', '/proc', '/sys', '/dev', '/var/run', '/root', '/boot']
    if (FORBIDDEN_PREFIXES.some(p => resolved === p || resolved.startsWith(p + '/'))) {
      throw new Error('禁止访问此目录')
    }
    const skillMdPath = path.join(resolved, 'SKILL.md')
    let content: string
    try {
      content = await fs.readFile(skillMdPath, 'utf-8')
    } catch {
      throw new Error(`无法读取 ${skillMdPath}，请确认路径正确且包含 SKILL.md 文件`)
    }
    const parsed = parseSkillMd(content)
    if (!parsed.name) throw new Error('SKILL.md 缺少 name 字段')
    const entry = await this.create({
      name: parsed.name,
      description: parsed.description,
      version: parsed.version,
      content,
      source_package: resolved,
    })
    const updated: SkillRegistryEntry = { ...entry, skill_dir: resolved, updated_at: generateTimestamp() }
    this.skills.set(entry.id, updated)
    await this.save()
    return updated
  }

  /**
   * 从 zip/skills 文件的 base64 内容导入
   */
  async importFromZip(base64Content: string, filename: string): Promise<SkillRegistryEntry> {
    const buffer = Buffer.from(base64Content, 'base64')
    const zip = new AdmZip(buffer)
    const entries = zip.getEntries()

    // 找到 SKILL.md（支持根目录或一层子目录）
    let skillMdEntry = entries.find(e => e.entryName === 'SKILL.md' || e.entryName.match(/^[^/]+\/SKILL\.md$/))
    if (!skillMdEntry) {
      throw new Error(`${filename} 中未找到 SKILL.md 文件`)
    }

    const content = skillMdEntry.getData().toString('utf-8')
    const parsed = parseSkillMd(content)
    if (!parsed.name) throw new Error('SKILL.md 缺少 name 字段')
    return this.create({
      name: parsed.name,
      description: parsed.description,
      version: parsed.version,
      content,
      source_package: filename,
    })
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
