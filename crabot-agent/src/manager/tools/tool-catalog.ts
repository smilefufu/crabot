/// <reference lib="es2022.intl" />
import type { ToolDefinition } from '../../engine/types.js'
import { sha256CanonicalJson } from 'crabot-shared'

export type ManagerToolProfile = 'normal' | 'daily_reflection' | 'memory_graph_rebuild'
export type ManagerToolLoadingMode = 'full' | 'shadow' | 'progressive'

export const MANAGER_TOOL_CATALOG_REVISION = 'manager-tools-v3-families'

export const NORMAL_MANAGER_CORE_NAMES = [
  'search_tools',
  'load_tool_family',
  'load_guidance',
  'get_execution_capabilities',
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
] as const

export const DAILY_REFLECTION_CORE_NAMES = [
  'load_tool_family',
  'list_reflection_records',
  'read_reflection_record',
  'finish_daily_reflection',
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
  familyTool?: ToolDefinition
  familyLoads?: number
  searches?: number
}

export function createManagerToolFaceState(mode: ManagerToolLoadingMode = 'progressive'): ManagerToolFaceState {
  return { loadedNames: new Set(), mode, externalMcpToolsCaptured: false }
}

export interface LoadToolFamilyInput {
  family: string
}

export interface LoadToolFamilyOutput {
  status: 'loaded' | 'already_visible' | 'unavailable' | 'listed'
  scope: 'current_episode'
  catalog_revision: string
  family: string
  complete: boolean
  loaded: string[]
  already_visible: string[]
  families?: Array<{ family: string; tool_count: number }>
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
  private readonly families = new Map<string, readonly ToolDefinition[]>()
  private readonly availableTools: readonly ToolDefinition[]
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
    aliasMap: Readonly<Record<string, readonly string[]>> = {},
    catalogRevision = MANAGER_TOOL_CATALOG_REVISION,
    canSearch: (tool: ToolDefinition) => boolean = () => true,
    builtinFamilies: Readonly<Record<string, readonly string[]>> = {},
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
    this.availableTools = tools.filter(tool => this.isAllowed(tool.name) && canSearch(tool)
      && serializedToolBytes(tool) <= MAX_TOOL_DEFINITION_BYTES)
    for (const [family, names] of Object.entries(builtinFamilies)) {
      if (profile === 'memory_graph_rebuild' || (profile === 'daily_reflection' && family !== 'memory' && family !== 'worker')) continue
      const members = this.availableTools.filter(tool => !isExternalMcpTool(tool) && names.includes(tool.name))
      if (members.length) this.families.set(family, members)
    }
    for (const tool of this.availableTools.filter(isExternalMcpTool)) {
      const server = tool.traceMetadata?.mcp_server
      const family = typeof server === 'string' ? `mcp__${server}` : tool.name.split('__').slice(0, 2).join('__')
      this.families.set(family, [...(this.families.get(family) ?? []), tool])
    }
    this.documents = this.availableTools
      .filter(tool => isExternalMcpTool(tool) && !core.has(tool.name))
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
    this.authorizedCatalogDigest = sha256CanonicalJson(this.availableTools.map(tool => ({
      name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
      family: [...this.families].find(([, members]) => members.includes(tool))?.[0] ?? null,
      searchMetadata: { aliases: tool.searchMetadata?.aliases ?? [], tags: tool.searchMetadata?.tags ?? [],
        namespace: tool.searchMetadata?.namespace ?? '', namespaceDescription: tool.searchMetadata?.namespaceDescription ?? '' },
      ...(tool.traceMetadata?.definition_digest ? { definition_digest: tool.traceMetadata.definition_digest } : {}),
    })))
    this.catalogRevision = `${catalogRevision}:${this.authorizedCatalogDigest.slice(0, 16)}`
  }

  get tools(): readonly ToolDefinition[] {
    return [...this.byName.values()]
  }

  get candidateCount(): number {
    return this.documents.length
  }

  get(name: string): ToolDefinition | undefined {
    return this.isAllowed(name) ? this.byName.get(name) : undefined
  }

  missingToolOutput(name: string): string {
    if (!this.availableTools.some(tool => tool.name === name)) return 'TOOL_UNAVAILABLE'
    const family = [...this.families].find(([, members]) => members.some(tool => tool.name === name))?.[0]
    const loader = family ? `load_tool_family({family:"${family}"})` : 'search_tools'
    return `TOOL_NOT_LOADED: use ${loader}; loaded tools are available on the next turn.`
  }

  loadFamily(state: ManagerToolFaceState, rawFamily: unknown): LoadToolFamilyOutput {
    if (typeof rawFamily !== 'string' || !rawFamily.trim() || [...rawFamily.trim()].length > 128) {
      throw new Error('load_tool_family.family 必须是 1..128 个字符')
    }
    const family = rawFamily.trim()
    const base = { scope: 'current_episode' as const, catalog_revision: this.catalogRevision, family }
    if (family === 'mcp' && this.profile === 'normal') {
      return { ...base, status: 'listed', complete: true, loaded: [], already_visible: [],
        families: [...this.families].filter(([name]) => name.startsWith('mcp__'))
          .map(([name, tools]) => ({ family: name, tool_count: tools.length })) }
    }
    const members = this.families.get(family)
    if (!members) return { ...base, status: 'unavailable', complete: false, loaded: [], already_visible: [] }
    const loaded: string[] = []
    const already_visible: string[] = []
    for (const tool of members) {
      if (this.coreNames.includes(tool.name) || state.loadedNames.has(tool.name) || state.mode === 'full' || state.mode === 'shadow') {
        already_visible.push(tool.name)
      } else loaded.push(tool.name)
    }
    // Prepare the entire result before committing: no search top-k or byte truncation.
    const result: LoadToolFamilyOutput = { ...base, status: loaded.length ? 'loaded' : 'already_visible',
      complete: true, loaded, already_visible }
    for (const name of loaded) state.loadedNames.add(name)
    return result
  }

  isAllowed(name: string): boolean {
    if (this.profile === 'normal') return true
    if (this.profile === 'memory_graph_rebuild') return MEMORY_GRAPH_REBUILD_CORE_NAMES.includes(name as never)
    return DAILY_REFLECTION_CORE_NAMES.includes(name as never)
      || name === 'get_execution_capabilities'
      || name === 'send_message'
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
    const names = this.coreNames.filter((name) => name !== 'search_tools' && name !== 'load_tool_family')
    const missing = names.filter((name) => !this.byName.has(name))
    if (missing.length > 0) {
      throw new Error(`Manager 固定核心缺失: ${missing.join(',')}`)
    }
    const visible = this.coreNames.map((name) => {
      if (name === 'search_tools') {
        if (!searchTool) throw new Error('Manager 固定核心缺失: search_tools')
        return searchTool
      }
      if (name === 'load_tool_family' && state.familyTool) return state.familyTool
      const tool = this.byName.get(name)
      if (!tool) throw new Error(`Manager 固定核心缺失: ${name}`)
      return tool
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

    const exactTier = ranked[0]?.tier ?? 0
    const toolIdentifier = /^(?:[a-z][a-z0-9]*(?:_[a-z0-9]+)+|mcp__[a-z0-9_.-]+)$/.test(query)
    const matches = exactTier >= 2
      ? ranked.filter((item) => item.tier === exactTier)
      : toolIdentifier
        ? ranked.filter((item) => normalize(item.document.namespaceExact) === query)
        : ranked
    // Visibility and byte budgets must not move a query's results into the long tail.
    const selected = matches.slice(0, limit)
    const loaded: string[] = []
    const alreadyVisible: string[] = []
    let bytes = 0
    let omittedDueToBudget = 0
    let budgetReached = false
    for (const item of selected) {
      const name = item.document.tool.name
      if (state.mode === 'full' || state.mode === 'shadow' || state.loadedNames.has(name)) {
        alreadyVisible.push(name)
        continue
      }
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
