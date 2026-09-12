/// <reference lib="es2022.intl" />
import type { ToolDefinition } from '../../engine/types.js'
import { sha256CanonicalJson } from 'crabot-shared'

export type ManagerToolProfile = 'normal' | 'daily_reflection' | 'memory_graph_rebuild'
export type ManagerToolLoadingMode = 'full' | 'shadow' | 'progressive'

export const MANAGER_TOOL_CATALOG_REVISION = 'manager-tools-v1'

export const NORMAL_MANAGER_CORE_NAMES = [
  'search_tools',
  'send_message',
  'get_worker_state',
  'get_worker_activity',
  'send_to_worker',
  'get_worker_turn',
  'resolve_worker_turn',
  'get_worker_terminal',
  'spawn_worker',
  'inspect_workboard',
  'change_workboard',
  'inspect_project_docs',
  'manage_decision_doc',
] as const

export const DAILY_REFLECTION_CORE_NAMES = [
  'search_tools',
  'send_message',
  'send_daily_reflection_summary',
  'mcp__crab-memory__list_entries',
  'mcp__crab-memory__search_long_term',
  'mcp__crab-memory__promote_inbox_entry',
  'mcp__crab-memory__delete_memory',
  'mcp__crab-memory__promote_to_rule',
] as const

export const MEMORY_GRAPH_REBUILD_CORE_NAMES = [
  'mcp__crab-memory__list_entries',
  'mcp__crab-memory__search_long_term',
  'mcp__crab-memory__set_memory_links',
] as const

export interface ManagerToolFaceState {
  readonly loadedNames: Set<string>
  readonly mode?: ManagerToolLoadingMode
  /** External MCP definitions are frozen at episode admission, including their connector snapshot. */
  externalMcpTools?: ReadonlyArray<ToolDefinition>
  externalMcpToolsCaptured?: boolean
  catalog?: ManagerToolCatalog
  searchTool?: ToolDefinition
  searches?: number
}

export function createManagerToolFaceState(mode: ManagerToolLoadingMode = 'progressive'): ManagerToolFaceState {
  return { loadedNames: new Set(), mode, externalMcpToolsCaptured: false }
}

export interface ToolSearchResult {
  readonly status: 'loaded' | 'already_visible' | 'no_match' | 'degraded'
  readonly catalogRevision: string
  readonly loaded: string[]
  readonly alreadyVisible: string[]
  readonly omittedDueToBudget: number
}

export function managerToolProfileForSchedule(identity?: {
  readonly isBuiltin?: boolean
  readonly scheduleId?: string
  readonly taskType?: string
}): ManagerToolProfile {
  if (identity?.isBuiltin !== true) return 'normal'
  if (identity.scheduleId === 'memory-graph-rebuild') return 'memory_graph_rebuild'
  if (identity.taskType === 'daily_reflection') return 'daily_reflection'
  return 'normal'
}

type SearchFieldName = 'aliases' | 'name' | 'tags' | 'namespace' | 'description' | 'argumentNames' | 'argumentDescriptions'

interface SearchDocument {
  readonly tool: ToolDefinition
  readonly aliases: readonly string[]
  readonly exact: string
  readonly namespaceExact: string
  readonly fields: Readonly<Record<SearchFieldName, readonly string[]>>
  readonly order: number
}

const MAX_QUERY_LENGTH = 500
const MAX_RESULTS = 5
const DEFAULT_RESULTS = 3
const SEARCH_BUDGET_BYTES = 16 * 1024
const MAX_TOOL_DEFINITION_BYTES = 64 * 1024
const BM25_K1 = 1.2

const SEARCH_FIELDS: ReadonlyArray<{ name: SearchFieldName; boost: number; lengthNorm: number }> = [
  { name: 'aliases', boost: 10, lengthNorm: 0 },
  { name: 'name', boost: 8, lengthNorm: 0 },
  { name: 'tags', boost: 6, lengthNorm: 0 },
  { name: 'namespace', boost: 5, lengthNorm: 0 },
  { name: 'description', boost: 3, lengthNorm: 0.75 },
  { name: 'argumentNames', boost: 2, lengthNorm: 0 },
  { name: 'argumentDescriptions', boost: 1, lengthNorm: 0.75 },
]

const BUILTIN_ALIASES: Record<string, readonly string[]> = {
  inspect_crabot: ['get_deployment_info', 'get_config_summary', 'list_capabilities', 'system status', '系统状态', '部署信息', '配置摘要', '能力清单'],
  inspect_workspace_git: ['workspace git', '工作区 git', 'git 状态'],
  get_worker_activity: ['worker output', 'worker error', '执行器输出', '执行器错误'],
  get_worker_state: ['worker status', '执行器状态'],
  get_worker_turn: ['worker result', '执行器回合', '执行器结果'],
  send_to_worker: ['continue worker', '续办执行器', '给执行器发消息'],
  inspect_workboard: ['workboard', '任务板', '工作板'],
  change_workboard: ['update workboard', '修改任务板', '更新工作板'],
  inspect_project_docs: ['project docs', '项目文档', '读取项目文档'],
  manage_decision_doc: ['decision doc', '决策文档', '项目决策'],
  list_schedules: ['schedule list', '定时任务', '调度列表'],
  get_friend_permissions: ['friend permissions', '联系人权限', '权限查询'],
  send_private_message: ['private message', '发送私聊消息'],
  send_master_private: ['contact master', '联系主人'],
  get_history: ['chat history', '聊天历史'],
  get_message: ['message detail', '消息详情'],
  lookup_friend: ['find contact', '查找联系人'],
  list_sessions: ['list conversations', '会话列表'],
  list_contacts: ['address book', '通讯录'],
  list_groups: ['list groups', '群列表'],
  list_group_members: ['group members', '群成员'],
  fetch_media: ['download media', '下载媒体'],
  read_feishu_document: ['read feishu document', '读取飞书文档'],
  feishu_raw_get: ['feishu api read', '飞书接口查询'],
  feishu_download_file: ['feishu file download', '飞书文件下载'],
  query_worker: ['ask worker privately', '侧问执行器'],
  resolve_worker_turn: ['settle worker turn', '处置执行器回合'],
  get_worker_terminal: ['worker terminal', '执行器终端'],
  spawn_worker: ['delegate work', '派发执行器'],
  request_worker_interrupt: ['interrupt worker', '中断执行器'],
  request_worker_stop: ['stop worker', '停止执行器'],
  respond_to_worker_ui: ['respond worker dialog', '回应执行器界面'],
  list_workers: ['list workers', '列出执行器'],
  list_all_workers: ['all session workers', '跨会话执行器'],
  get_worker_detail: ['worker details', '执行器详情'],
  list_worker_implementations: ['worker implementations', '执行器实现'],
  create_schedule: ['create schedule', '创建定时任务'],
  get_schedule: ['schedule details', '定时任务详情'],
  update_schedule: ['edit schedule', '修改定时任务'],
  delete_schedule: ['delete schedule', '删除定时任务'],
  trigger_schedule: ['run schedule now', '立即触发定时任务'],
  'mcp__crab-memory__store_memory': ['store memory', '存储记忆'],
  'mcp__crab-memory__search_memory': ['search memory', '搜索记忆'],
  'mcp__crab-memory__get_memory_detail': ['memory details', '记忆详情'],
  'mcp__crab-memory__set_scene_profile': ['set scene profile', '设置场景画像'],
  'mcp__crab-memory__get_scene_profile': ['get scene profile', '读取场景画像'],
  'mcp__crab-memory__delete_scene_profile': ['delete scene profile', '删除场景画像'],
  'mcp__crab-memory__quick_capture': ['capture memory inbox', '记忆快速收集'],
  'mcp__crab-memory__search_long_term': ['search knowledge', '搜索长期记忆'],
  'mcp__crab-memory__update_long_term': ['update knowledge', '更新长期记忆'],
  'mcp__crab-memory__delete_memory': ['delete memory', '删除记忆'],
  'mcp__crab-memory__list_recent': ['recent memories', '最近记忆'],
  'mcp__crab-memory__list_entries': ['list memory entries', '列出记忆条目'],
  'mcp__crab-memory__set_memory_links': ['link memories', '设置记忆关联'],
  'mcp__crab-memory__get_stats': ['memory statistics', '记忆统计'],
  'mcp__crab-memory__get_evolution_mode': ['get evolution mode', '查看演化模式'],
  'mcp__crab-memory__set_evolution_mode': ['set evolution mode', '设置演化模式'],
  'mcp__crab-memory__promote_inbox_entry': ['promote inbox memory', '提升候选记忆'],
  'mcp__crab-memory__promote_to_rule': ['promote memory rule', '提升记忆规则'],
}

function normalize(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase()
}

function tokenize(value: string): string[] {
  const normalized = normalize(value.replace(/([a-z\d])([A-Z])/g, '$1 $2'))
  const pieces = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean)
  const result: string[] = []
  for (const piece of pieces) {
    if (!/\p{Script=Han}/u.test(piece)) {
      result.push(piece)
      continue
    }
    const tokens = new Set([...segmenter.segment(piece)].filter((part) => part.isWordLike).map((part) => part.segment))
    for (const run of piece.match(/\p{Script=Han}+/gu) ?? []) {
      const cjk = [...run]
      for (let i = 0; i + 1 < cjk.length; i += 1) tokens.add(`${cjk[i]}${cjk[i + 1]}`)
    }
    result.push(...tokens)
  }
  return result
}

const segmenter = new Intl.Segmenter('zh', { granularity: 'word' })

export class ToolSearchInputError extends Error {}

export function toolSearchQueryStats(query: unknown): { query_characters: number; query_tokens: number } {
  const text = typeof query === 'string' ? query.trim() : ''
  return { query_characters: [...text].length, query_tokens: uniqueTokens(text).length }
}

function uniqueTokens(value: string): string[] {
  return [...new Set(tokenize(value))]
}

function cappedTokens(value: string, limit: number): string[] {
  return tokenize(value).slice(0, limit)
}

function aliasesForTool(aliasMap: Readonly<Record<string, readonly string[]>>, name: string): string[] {
  return [...(aliasMap[name] ?? [])]
}

function schemaFields(schema: unknown): { argumentNames: string[]; argumentDescriptions: string[] } {
  const names: string[] = []
  const descriptions: string[] = []
  const visit = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object') return
    if (Array.isArray(value)) {
      for (const item of value) visit(item, path)
      return
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'properties' && item && typeof item === 'object' && !Array.isArray(item)) {
        for (const [property, propertySchema] of Object.entries(item as Record<string, unknown>)) {
          names.push(`${path} ${property}`)
          visit(propertySchema, `${path} ${property}`)
        }
      } else if (key === 'description' && typeof item === 'string') {
        descriptions.push(item)
      } else if (key !== 'required') {
        visit(item, path)
      }
    }
  }
  visit(schema, '')
  return { argumentNames: tokenize(names.join(' ')), argumentDescriptions: cappedTokens(descriptions.join(' '), 1_024) }
}

export function serializedToolBytes(tool: ToolDefinition): number {
  return Buffer.byteLength(JSON.stringify({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }), 'utf8')
}

export function serializedToolSetBytes(tools: readonly ToolDefinition[]): number {
  return 2 + tools.reduce((bytes, tool) => bytes + serializedToolBytes(tool), 0) + Math.max(0, tools.length - 1)
}

function averageFieldLength(documents: readonly SearchDocument[], field: SearchFieldName): number {
  if (documents.length === 0) return 1
  return Math.max(1, documents.reduce((total, document) => total + document.fields[field].length, 0) / documents.length)
}

function bm25fScore(document: SearchDocument, queryTokens: readonly string[], averages: ReadonlyMap<SearchFieldName, number>, idf: ReadonlyMap<string, number>): number {
  let total = 0
  for (const token of queryTokens) {
    let tokenScore = 0
    for (const field of SEARCH_FIELDS) {
      const fieldTokens = document.fields[field.name]
      const termFrequency = fieldTokens.reduce((count, item) => count + (item === token ? 1 : 0), 0)
      if (termFrequency === 0) continue
      const averageLength = averages.get(field.name)!
      const lengthFactor = 1 - field.lengthNorm + field.lengthNorm * fieldTokens.length / averageLength
      tokenScore += field.boost * termFrequency / lengthFactor
    }
    total += (idf.get(token) ?? 0) * tokenScore * (BM25_K1 + 1) / (tokenScore + BM25_K1)
  }
  return total
}

export class ManagerToolCatalog {
  private readonly documents: readonly SearchDocument[]
  private readonly byName: ReadonlyMap<string, ToolDefinition>
  private readonly averageLengths = new Map<SearchFieldName, number>()
  private readonly idf = new Map<string, number>()
  readonly profile: ManagerToolProfile
  readonly coreNames: readonly string[]
  readonly catalogRevision: string
  readonly authorizedCatalogDigest: string

  constructor(
    tools: readonly ToolDefinition[],
    profile: ManagerToolProfile,
    aliasMap: Readonly<Record<string, readonly string[]>> = BUILTIN_ALIASES,
    catalogRevision = MANAGER_TOOL_CATALOG_REVISION,
    canSearch: (tool: ToolDefinition) => boolean = () => true,
  ) {
    this.profile = profile
    this.coreNames = profile === 'normal'
      ? NORMAL_MANAGER_CORE_NAMES
      : profile === 'daily_reflection' ? DAILY_REFLECTION_CORE_NAMES : MEMORY_GRAPH_REBUILD_CORE_NAMES
    const byName = new Map<string, ToolDefinition>()
    for (const tool of tools) {
      if (byName.has(tool.name)) throw new Error(`重复的 Manager 工具名: ${tool.name}`)
      byName.set(tool.name, tool)
    }
    this.byName = byName
    const core = new Set(this.coreNames)
    this.documents = tools
      .filter((tool) => this.isAllowed(tool.name) && !core.has(tool.name) && tool.name !== 'search_tools' && canSearch(tool))
      .filter((tool) => serializedToolBytes(tool) <= MAX_TOOL_DEFINITION_BYTES)
      .map((tool, order) => {
        const toolAliases = [...aliasesForTool(aliasMap, tool.name), ...(tool.searchMetadata?.aliases ?? [])]
        const name = tool.name.replace(/^mcp__/, '').replace(/__/g, ' ')
        const namespaceExact = tool.searchMetadata?.namespace
          ?? (tool.name.startsWith('mcp__') ? tool.name.split('__').slice(0, 2).join('__') : '')
        return {
          tool,
          aliases: toolAliases,
          exact: tool.name,
          namespaceExact,
          fields: {
            aliases: toolAliases.flatMap(tokenize),
            name: tokenize(name),
            tags: tokenize((tool.searchMetadata?.tags ?? []).join(' ')),
            namespace: cappedTokens(`${namespaceExact} ${tool.searchMetadata?.namespaceDescription ?? ''}`, 512),
            description: cappedTokens(tool.description, 512),
            ...schemaFields(tool.inputSchema),
          },
          order,
        }
      })
    for (const field of SEARCH_FIELDS) this.averageLengths.set(field.name, averageFieldLength(this.documents, field.name))
    const frequencies = new Map<string, number>()
    for (const document of this.documents) {
      const terms = new Set(Object.values(document.fields).flat())
      for (const term of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
    }
    for (const [term, count] of frequencies) this.idf.set(term, Math.log(1 + (this.documents.length - count + 0.5) / (count + 0.5)))
    this.authorizedCatalogDigest = sha256CanonicalJson(this.documents.map(({ tool }) => ({
      name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
      ...(tool.traceMetadata?.definition_digest ? { definition_digest: tool.traceMetadata.definition_digest } : {}),
    })))
    this.catalogRevision = `${catalogRevision}:${this.authorizedCatalogDigest.slice(0, 16)}`
  }

  get tools(): readonly ToolDefinition[] {
    return [...this.byName.values()]
  }

  get(name: string): ToolDefinition | undefined {
    return this.isAllowed(name) ? this.byName.get(name) : undefined
  }

  missingToolOutput(name: string): string {
    return this.documents.some((document) => document.tool.name === name)
      ? 'TOOL_NOT_LOADED: use search_tools; loaded tools are available on the next turn.'
      : 'TOOL_UNAVAILABLE'
  }

  isAllowed(name: string): boolean {
    if (this.profile === 'normal') return true
    if (this.profile === 'memory_graph_rebuild') return MEMORY_GRAPH_REBUILD_CORE_NAMES.includes(name as never)
    return name === 'send_message'
      || name === 'send_daily_reflection_summary'
      || name.startsWith('mcp__crab-memory__')
      || name === 'spawn_worker'
      || name === 'send_to_worker'
      || name === 'query_worker'
      || name === 'get_worker_state'
      || name === 'get_worker_activity'
      || name === 'get_worker_turn'
      || name === 'resolve_worker_turn'
      || name === 'get_worker_terminal'
      || name === 'request_worker_interrupt'
      || name === 'request_worker_stop'
      || name === 'respond_to_worker_ui'
      || name === 'list_workers'
      || name === 'get_worker_detail'
      || name === 'inspect_workspace_git'
      || name === 'list_worker_implementations'
  }

  project(state: ManagerToolFaceState, searchTool?: ToolDefinition): ToolDefinition[] {
    const names = this.coreNames.filter((name) => name !== 'search_tools')
    const missing = names.filter((name) => !this.byName.has(name))
    if (missing.length > 0) {
      throw new Error(`Manager 固定核心缺失: ${missing.join(',')}`)
    }
    const visible = this.coreNames.map((name) => {
      if (name === 'search_tools') {
        if (!searchTool) throw new Error('Manager 固定核心缺失: search_tools')
        return searchTool
      }
      return this.byName.get(name)!
    })
    const seen = new Set(visible.map((tool) => tool.name))
    // All modes mark the identical core boundary for adapters with explicit cache support.
    visible[visible.length - 1] = { ...visible[visible.length - 1], cacheBreakpoint: true }
    if (state.mode === 'full' || state.mode === 'shadow') {
      for (const tool of this.byName.values()) {
        if (this.isAllowed(tool.name) && tool.name !== 'search_tools' && !seen.has(tool.name)) {
          visible.push(tool)
          seen.add(tool.name)
        }
      }
      return visible
    }
    for (const name of state.loadedNames) {
      const tool = this.byName.get(name)
      if (tool && this.isAllowed(name) && !seen.has(name)) {
        visible.push(tool)
        seen.add(name)
      }
    }
    return visible
  }

  loadBuiltinFallback(state: ManagerToolFaceState): void {
    if (state.mode === 'full' || state.mode === 'shadow') return
    // Record fallback tools in the same append order as explicit loads.
    for (const tool of this.byName.values()) {
      if (this.isAllowed(tool.name) && !isExternalMcpTool(tool) && !this.coreNames.includes(tool.name)) {
        state.loadedNames.add(tool.name)
      }
    }
  }

  search(state: ManagerToolFaceState, rawQuery: unknown, rawLimit: unknown): ToolSearchResult {
    if (typeof rawQuery !== 'string') throw new ToolSearchInputError('search_tools.query 必须是字符串')
    if (!rawQuery.trim() || [...rawQuery.trim()].length > MAX_QUERY_LENGTH) throw new ToolSearchInputError('search_tools.query 必须是 1..500 个字符')
    const query = normalize(rawQuery)
    if (rawLimit !== undefined && (typeof rawLimit !== 'number' || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_RESULTS)) {
      throw new ToolSearchInputError('search_tools.limit 必须是 1..5 的整数')
    }
    const limit = rawLimit === undefined ? DEFAULT_RESULTS : rawLimit as number
    const queryTokens = uniqueTokens(rawQuery)
    const ranked = this.documents
      .map((document) => {
        const exact = normalize(document.exact)
        const alias = document.aliases.some((item) => normalize(item) === query)
        const prefix = normalize(document.namespaceExact)
        const namespace = prefix !== '' && (query === prefix || query.startsWith(`${prefix}__`))
        return { document, tier: exact === query ? 3 : alias ? 2 : namespace ? 1 : 0,
          score: bm25fScore(document, queryTokens, this.averageLengths, this.idf) }
      })
      .filter((item) => item.tier > 0 || item.score > 0)
      .sort((a, b) => b.tier - a.tier || b.score - a.score || a.document.order - b.document.order)

    const loaded: string[] = []
    const alreadyVisible: string[] = []
    let bytes = 0
    let omittedDueToBudget = 0
    let budgetReached = false
    for (const item of ranked) {
      const name = item.document.tool.name
      if (state.mode === 'full' || state.mode === 'shadow' || state.loadedNames.has(name)) {
        if (alreadyVisible.length < limit) alreadyVisible.push(name)
        continue
      }
      if (loaded.length >= limit) continue
      const size = serializedToolBytes(item.document.tool)
      if (budgetReached || (bytes + size > SEARCH_BUDGET_BYTES && loaded.length > 0)) {
        budgetReached = true
        omittedDueToBudget += 1
        continue
      }
      state.loadedNames.add(name)
      loaded.push(name)
      bytes += size
    }
    const status = loaded.length > 0
      ? 'loaded'
      : alreadyVisible.length > 0 ? 'already_visible' : 'no_match'
    return {
      status,
      catalogRevision: this.catalogRevision,
      loaded,
      alreadyVisible,
      omittedDueToBudget,
    }
  }
}

export function isExternalMcpTool(tool: ToolDefinition): boolean {
  return tool.name.startsWith('mcp__') && !tool.name.startsWith('mcp__crab-memory__')
}
