/**
 * MCP Connector - Manages connections to external MCP servers (multi-transport)
 *
 * Supports stdio, streamable-http, and sse transports.
 * Caches tool definitions at connect time to avoid per-task listTools() overhead.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { sha256CanonicalJson } from 'crabot-shared'
import { defineTool } from '../engine/tool-framework.js'
import type { ToolDefinition, ToolCategory } from '../engine/types.js'
import type { MCPServerConfig, ResolvedPermissions } from '../types.js'
import { buildChildEnv } from '../core/runtime-env.js'
import { capWithMarker, truncateUtf8 } from '../engine/byte-cap.js'

/**
 * 根据 MCP server 名称决定工具类别。
 * computer-use（键盘/鼠标/截屏）归属 desktop（高权限，仅 master_private 可用）；
 * 其他 MCP server 归属 mcp_skill。
 */
export function mcpCategoryFor(serverName: string): ToolCategory {
  return serverName === 'computer-use' ? 'desktop' : 'mcp_skill'
}

/**
 * 在跨 CLI 可移植的 server 粒度按**已经收敛好的 worker 权限**过滤。
 * 固定 worker 档位与 principal 快照的交集由调用方计算；本层只负责复用 MCP 分类真相。
 */
export function filterMcpServersForWorker(
  servers: ReadonlyArray<MCPServerConfig>,
  permissions: ResolvedPermissions,
): MCPServerConfig[] {
  return servers.filter((server) => permissions.tool_access[mcpCategoryFor(server.name)])
}

function definitionDigest(value: unknown): string {
  return sha256CanonicalJson(value)
}

const MAX_SERVER_TOOLS = 10_000
const MAX_MCP_NAME_LENGTH = 128
const MAX_TEXT_OUTPUT_BYTES = 100_000
const MAX_IMAGE_OUTPUTS = 2
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
const MCP_CALL_TIMEOUT_MS = 120_000

function assertMcpName(name: string, label: string): void {
  if (
    name.length === 0
    || name.length > MAX_MCP_NAME_LENGTH
    || name.trim() !== name
    || /[\u0000-\u001f\u007f]/u.test(name)
  ) throw new Error(`invalid ${label}: ${name}`)
}

function schemaValidatorFor(schema: unknown, label: string): (input: unknown) => { valid: boolean; errorMessage?: string } {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`invalid ${label}`)
  try {
    // A schema $id is server-owned, not a cross-server or cross-generation cache key.
    return new AjvJsonSchemaValidator().getValidator(schema as Record<string, unknown>)
  } catch (error) {
    throw new Error(`invalid ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function decodeImageData(data: string): Buffer | undefined {
  if (data.length === 0 || data.length > MAX_IMAGE_BASE64_LENGTH || data.length % 4 !== 0 || /[^A-Za-z0-9+/=]/u.test(data)) {
    return undefined
  }
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  if (data.length / 4 * 3 - padding > MAX_IMAGE_BYTES || data.slice(0, data.length - padding).includes('=')) return undefined
  const decoded = Buffer.from(data, 'base64')
  return data === decoded.toString('base64') ? decoded : undefined
}

export class McpConnector {
  private readonly clients: Map<string, Client> = new Map()
  /** Cached tool definitions — populated at connect time, avoids per-task listTools() */
  private cachedTools: ToolDefinition[] = []
  private catalogGeneration = 0
  private readonly toolDigests = new Map<string, string>()
  private readonly staleServers = new Set<string>()
  private readonly serverDescriptions = new Map<string, string>()
  private refreshInFlight?: Promise<void>
  private refreshRequested = false
  /** Candidate connectors redirect list-changed callbacks to the live owner after adoption. */
  private refreshTarget?: McpConnector
  /** Per-server per-tool default params — built from MCPServerConfig.tool_defaults */
  private readonly toolDefaultsMap: Map<string, Record<string, Record<string, unknown>>> = new Map()

  /** Connect a detached candidate without touching the live connector. */
  static async prepare(configs: ReadonlyArray<MCPServerConfig>): Promise<McpConnector> {
    const candidate = new McpConnector()
    const seen = new Set<string>()
    const unique = configs.filter((config) => !seen.has(config.name) && (seen.add(config.name), true))
    // 与 connectAll 保持一致：先记 tool_defaults，否则 replaceWith 会用空 map 覆盖，
    // 热更后 tool_defaults 静默丢失。
    for (const config of unique) {
      if (config.tool_defaults) candidate.toolDefaultsMap.set(config.name, config.tool_defaults)
      if (config.description) candidate.serverDescriptions.set(config.name, config.description)
    }
    // 与启动路径 connectAll 同样的容错语义：单台第三方 MCP server 不可用只降级该
    // server，不得升级成「配置不可信」把整个 Agent 打下线（configStale + 全入口
    // fail closed + 断开所有连接）。
    const results = await Promise.allSettled(unique.map((config) => candidate.connectOne(config)))
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const reason = (results[i] as PromiseRejectedResult).reason
        const msg = reason instanceof Error ? reason.message : String(reason)
        console.error(`[McpConnector] Failed to connect MCP server "${unique[i].name}": ${msg}`)
      }
    }
    try {
      await candidate.refreshToolCache()
      return candidate
    } catch (error) {
      await candidate.disconnectAll()
      throw error
    }
  }

  /** Atomically adopt a fully connected candidate, then retire old clients. */
  async replaceWith(candidate: McpConnector): Promise<void> {
    const oldClients = new Map(this.clients)
    candidate.refreshTarget = this
    this.clients.clear()
    for (const [name, client] of candidate.clients) this.clients.set(name, client)
    this.catalogGeneration += 1
    const generation = this.catalogGeneration
    this.staleServers.clear()
    for (const name of candidate.staleServers) this.staleServers.add(name)
    this.toolDigests.clear()
    for (const [name, digest] of candidate.toolDigests) this.toolDigests.set(name, digest)
    this.cachedTools = candidate.cachedTools.map((tool) => {
      const digest = this.toolDigests.get(tool.name)
      return {
        ...tool,
        traceMetadata: { ...tool.traceMetadata, connector_generation: generation },
        call: async (input, context) => {
          const serverName = tool.traceMetadata?.mcp_server
          if (this.catalogGeneration !== generation || !digest || this.toolDigests.get(tool.name) !== digest
            || typeof serverName !== 'string' || this.staleServers.has(serverName)) {
            return { output: 'TOOL_CATALOG_CHANGED', isError: true, traceMetadata: { mcp_status: 'catalog_changed' } }
          }
          return tool.call(input, context)
        },
      }
    })
    this.toolDefaultsMap.clear()
    for (const [name, defaults] of candidate.toolDefaultsMap) this.toolDefaultsMap.set(name, defaults)
    this.serverDescriptions.clear()
    for (const [name, description] of candidate.serverDescriptions) this.serverDescriptions.set(name, description)
    candidate.clients.clear()
    await Promise.allSettled(Array.from(oldClients.values()).map((client) => client.close()))
  }

  async connectAll(configs: ReadonlyArray<MCPServerConfig>): Promise<void> {
    // Deduplicate by name
    const seen = new Set<string>()
    const unique = configs.filter((c) => {
      if (seen.has(c.name)) return false
      seen.add(c.name)
      return true
    })

    // Store tool_defaults for connected servers
    for (const config of unique) {
      if (config.description) this.serverDescriptions.set(config.name, config.description)
      if (config.tool_defaults) {
        this.toolDefaultsMap.set(config.name, config.tool_defaults)
      }
    }

    const results = await Promise.allSettled(
      unique.map((config) => this.connectOne(config))
    )

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'rejected') {
        const reason = (results[i] as PromiseRejectedResult).reason
        const msg = reason instanceof Error ? reason.message : String(reason)
        console.error(`[McpConnector] Failed to connect MCP server "${unique[i].name}": ${msg}`)
      }
    }

    // Cache tools from all connected servers
    await this.refreshToolCache()
  }

  private async connectOne(config: MCPServerConfig): Promise<void> {
    if (this.clients.has(config.name)) return
    assertMcpName(config.name, 'MCP server name')

    const transport = this.resolveTransport(config)
    const client = new Client(
      { name: `crabot-${config.name}`, version: '1.0.0' },
      {
        capabilities: {},
        listChanged: {
          tools: {
            autoRefresh: false,
            onChanged: (error) => {
              const owner = this.refreshTarget ?? this
              if (owner.clients.get(config.name) !== client) return
              owner.markServerStale(config.name)
              if (error) {
                console.error(`[McpConnector] Failed to refresh tools from "${config.name}": ${error.message}`)
                return
              }
              void owner.refreshToolCache().catch((refreshError) => {
                console.error(`[McpConnector] Tool catalog refresh failed for "${config.name}":`, refreshError)
              })
            },
          },
        },
      },
    )
    client.onclose = () => {
      const owner = this.refreshTarget ?? this
      if (owner.clients.get(config.name) !== client) return
      owner.clients.delete(config.name)
      owner.markServerStale(config.name)
    }

    try {
      await client.connect(transport)
      this.clients.set(config.name, client)
      console.log(`[McpConnector] Connected to "${config.name}" (${config.transport ?? 'auto'})`)
    } catch (error) {
      // Clean up on partial failure
      try { await client.close() } catch { /* ignore */ }
      throw error
    }
  }

  private resolveTransport(config: MCPServerConfig) {
    const type = config.transport
      ?? (config.command ? 'stdio' : config.url ? 'streamable-http' : undefined)

    if (!type) {
      throw new Error(`"${config.name}": no transport (need command or url)`)
    }

    switch (type) {
      case 'stdio': {
        if (!config.command) throw new Error(`"${config.name}": stdio needs command`)
        return new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          // 未配置 env 时保持 SDK 默认白名单（getDefaultEnvironment），不向用户可配的
          // MCP 命令下发整个 Agent 环境；配置了 env 时叠加并剔除 runtime bearer。
          env: config.env ? buildChildEnv(config.env) : undefined,
        })
      }
      case 'streamable-http': {
        if (!config.url) throw new Error(`"${config.name}": streamable-http needs url`)
        return new StreamableHTTPClientTransport(
          new URL(config.url),
          config.headers ? { requestInit: { headers: config.headers } } : undefined,
        )
      }
      case 'sse': {
        if (!config.url) throw new Error(`"${config.name}": sse needs url`)
        return new SSEClientTransport(
          new URL(config.url),
          config.headers ? { requestInit: { headers: config.headers } } : undefined,
        )
      }
      default:
        throw new Error(`"${config.name}": unsupported transport "${type}"`)
    }
  }

  /** Serialize list-changed refreshes so a burst cannot publish an intermediate snapshot. */
  private async refreshToolCache(): Promise<void> {
    if (this.refreshInFlight) {
      this.refreshRequested = true
      return this.refreshInFlight
    }
    const run = (async () => {
      do {
        this.refreshRequested = false
        await this.rebuildToolCache()
      } while (this.refreshRequested)
    })()
    this.refreshInFlight = run.finally(() => {
      this.refreshInFlight = undefined
    })
    return this.refreshInFlight
  }

  /** Rebuild tool cache from all connected servers. */
  private async rebuildToolCache(): Promise<void> {
    const tools: ToolDefinition[] = []
    const digests = new Map<string, string>()
    const nextGeneration = this.catalogGeneration + 1
    const qualifiedNames = new Set<string>()
    const failedServers = new Set<string>()
    const clients = new Map(this.clients)
    let nameCollision = false

    for (const [serverName, client] of clients) {
      const serverStart = tools.length
      try {
        const mcpTools: Array<{
          name: string
          description?: string
          inputSchema?: unknown
          outputSchema?: unknown
        }> = []
        const serverToolNames = new Set<string>()
        const cursors = new Set<string>()
        let cursor: string | undefined
        do {
          const page = await client.listTools(cursor ? { cursor } : undefined)
          for (const mcpTool of page.tools) {
            assertMcpName(mcpTool.name, `MCP tool name from ${serverName}`)
            if (serverToolNames.has(mcpTool.name)) {
              throw new Error(`duplicate tool name from server: ${mcpTool.name}`)
            }
            serverToolNames.add(mcpTool.name)
            mcpTools.push(structuredClone(mcpTool))
            if (mcpTools.length > MAX_SERVER_TOOLS) throw new Error(`MCP server exceeds ${MAX_SERVER_TOOLS} tools`)
          }
          const nextCursor = page.nextCursor
          if (!nextCursor) break
          if (cursors.has(nextCursor)) throw new Error(`tools/list cursor loop from server: ${nextCursor}`)
          cursors.add(nextCursor)
          cursor = nextCursor
        } while (true)

        for (const mcpTool of mcpTools) {
          const inputValidator = schemaValidatorFor(mcpTool.inputSchema, `input schema for ${mcpTool.name}`)
          const outputValidator = mcpTool.outputSchema
            ? schemaValidatorFor(mcpTool.outputSchema, `output schema for ${mcpTool.name}`)
            : undefined
          const toolDefaults = structuredClone(this.toolDefaultsMap.get(serverName)?.[mcpTool.name])
          const qualifiedName = `mcp__${serverName}__${mcpTool.name}`
          if (qualifiedNames.has(qualifiedName)) {
            nameCollision = true
            throw new Error(`duplicate qualified tool name: ${qualifiedName}`)
          }
          qualifiedNames.add(qualifiedName)
          const digest = definitionDigest({
            name: qualifiedName,
            description: mcpTool.description ?? '',
            inputSchema: mcpTool.inputSchema,
            ...(mcpTool.outputSchema !== undefined ? { outputSchema: mcpTool.outputSchema } : {}),
          })
          digests.set(qualifiedName, digest)
          tools.push(defineTool({
            name: qualifiedName,
            category: mcpCategoryFor(serverName),
            description: mcpTool.description ?? '',
            inputSchema: mcpTool.inputSchema as Record<string, unknown>,
            isReadOnly: false,
            searchMetadata: { namespace: `mcp__${serverName}`, namespaceDescription: this.serverDescriptions.get(serverName) },
            traceMetadata: {
              mcp_server: serverName,
              mcp_tool: mcpTool.name,
              permission_category: mcpCategoryFor(serverName),
              connector_generation: nextGeneration,
              definition_digest: digest,
            },
            call: async (input, context = {}) => {
              try {
                if (this.staleServers.has(serverName)
                  || this.catalogGeneration !== nextGeneration
                  || this.toolDigests.get(qualifiedName) !== digest) {
                  return {
                    output: 'TOOL_CATALOG_CHANGED',
                    isError: true,
                    traceMetadata: { mcp_status: 'catalog_changed' },
                  }
                }
                // Merge tool_defaults (fill missing keys only, never overwrite LLM input)
                const merged = toolDefaults
                  ? { ...toolDefaults, ...input }
                  : input
                const validatedInput = inputValidator(merged)
                if (!validatedInput.valid) return {
                  output: `MCP_INPUT_INVALID: ${validatedInput.errorMessage ?? 'schema mismatch'}`,
                  isError: true,
                  traceMetadata: { mcp_status: 'input_invalid' },
                }
                const controller = new AbortController()
                if (context.abortSignal?.aborted) return { output: 'MCP_CANCELLED', isError: true, traceMetadata: { mcp_status: 'cancelled' } }
                let timedOut = false
                const timeout = setTimeout(() => {
                  timedOut = true
                  controller.abort()
                }, MCP_CALL_TIMEOUT_MS)
                const abort = (): void => controller.abort(context.abortSignal?.reason)
                context.abortSignal?.addEventListener('abort', abort, { once: true })
                let result
                try {
                  result = await client.callTool({ name: mcpTool.name, arguments: merged }, undefined, {
                    signal: controller.signal, timeout: MCP_CALL_TIMEOUT_MS,
                  })
                } catch (error) {
                  if (timedOut) return {
                    output: 'MCP_TIMEOUT',
                    isError: true,
                    traceMetadata: { mcp_status: 'timeout', mcp_timed_out: true },
                  }
                  throw error
                } finally {
                  clearTimeout(timeout)
                  context.abortSignal?.removeEventListener('abort', abort)
                }
                if (timedOut) return {
                  output: 'MCP_TIMEOUT',
                  isError: true,
                  traceMetadata: { mcp_status: 'timeout', mcp_timed_out: true },
                }
                if (mcpTool.outputSchema && !result.isError) {
                  const structured = (result as { structuredContent?: unknown }).structuredContent
                  const validatedOutput = outputValidator?.(structured)
                  if (!validatedOutput?.valid) return {
                    output: 'MCP_OUTPUT_INVALID',
                    isError: true,
                    traceMetadata: { mcp_status: 'output_invalid' },
                  }
                }
                const contentArray = Array.isArray(result.content)
                  ? result.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
                  : []
                let textBytes = 0
                let textTruncated = false
                const texts: string[] = []
                const images: Array<{ media_type: string; data: string }> = []
                const markers: string[] = []
                for (const content of contentArray) {
                  if (content.type === 'text' && typeof content.text === 'string' && content.text.length > 0) {
                    const remaining = MAX_TEXT_OUTPUT_BYTES - textBytes
                    if (remaining <= 0) {
                      textTruncated = true
                      continue
                    }
                    const bytes = Buffer.byteLength(content.text, 'utf8')
                    if (bytes <= remaining) {
                      texts.push(content.text)
                      textBytes += bytes
                    } else {
                      texts.push(truncateUtf8(content.text, remaining))
                      textBytes = MAX_TEXT_OUTPUT_BYTES
                      textTruncated = true
                    }
                  } else if (content.type === 'image' && typeof content.data === 'string') {
                    if (images.length >= MAX_IMAGE_OUTPUTS) {
                      markers.push(`[image omitted: maximum ${MAX_IMAGE_OUTPUTS} images]`)
                    } else if (decodeImageData(content.data)) {
                      images.push({ media_type: content.mimeType ?? 'image/png', data: content.data })
                    } else {
                      markers.push('[image omitted: invalid or over limit]')
                    }
                  } else if (content.type === 'resource_link') {
                    markers.push('[resource link omitted: fetch is not automatic]')
                  } else if (content.type === 'audio') {
                    markers.push('[audio omitted: unsupported for Manager tool output]')
                  } else if (content.type !== 'text') {
                    markers.push(`[unsupported MCP content block: ${content.type || 'unknown'}]`)
                  }
                }

                const output = capWithMarker([
                    texts.join('\n') || (images.length > 0 ? '[Image captured]' : '(empty)'),
                    ...(textTruncated ? ['[output truncated]'] : []),
                    ...markers,
                  ].join('\n'), MAX_TEXT_OUTPUT_BYTES, () => '\n[output truncated]')
                return {
                  output: output.content,
                  images: images.length > 0 ? images : undefined,
                  isError: !!result.isError,
                  traceMetadata: {
                    mcp_status: result.isError ? 'error' : 'completed',
                    mcp_output_truncated: textTruncated || output.truncated,
                    mcp_content_blocks_omitted: markers.length > 0,
                  },
                }
              } catch (error) {
                const msg = error instanceof Error ? error.message : String(error)
                return { output: msg, isError: true, traceMetadata: { mcp_status: 'error' } }
              }
            },
          }))
        }
      } catch (error) {
        if (this.clients.get(serverName) !== client || this.catalogGeneration !== nextGeneration - 1) return
        for (const tool of tools.splice(serverStart)) {
          digests.delete(tool.name)
          qualifiedNames.delete(tool.name)
        }
        const msg = error instanceof Error ? error.message : String(error)
        console.error(`[McpConnector] Failed to list tools from "${serverName}": ${msg}`)
        this.staleServers.add(serverName)
        failedServers.add(serverName)
      }
    }

    // A connection replacement/disconnect may have completed while tools/list was in flight.
    if (this.refreshRequested || this.refreshTarget || this.catalogGeneration !== nextGeneration - 1
      || [...clients].some(([name, client]) => this.clients.get(name) !== client)) return
    // Existing snapshots remain atomic on refresh failure. At first connection,
    // a bad server must not suppress other servers' complete validated catalogs.
    if (nameCollision || (failedServers.size > 0 && (this.cachedTools.length > 0 || tools.length === 0))) return

    tools.sort((a, b) => a.name.localeCompare(b.name))
    this.cachedTools = tools
    this.toolDigests.clear()
    for (const [name, digest] of digests) this.toolDigests.set(name, digest)
    this.catalogGeneration = nextGeneration
    this.staleServers.clear()
    for (const serverName of failedServers) this.staleServers.add(serverName)
  }

  /** Get all tools (cached — no network calls) */
  getAllTools(): ToolDefinition[] {
    return this.cachedTools.filter((tool) => {
      const serverName = tool.traceMetadata?.mcp_server
      return typeof serverName === 'string' && !this.staleServers.has(serverName)
    })
  }

  get generation(): number {
    return this.catalogGeneration
  }

  getToolDefinitionDigest(name: string): string | undefined {
    return this.toolDigests.get(name)
  }

  getClient(name: string): Client | undefined {
    return this.clients.get(name)
  }

  get count(): number {
    return this.clients.size
  }

  private markServerStale(serverName: string): void {
    this.staleServers.add(serverName)
  }

  /** Prepare the new connection set before replacing the live clients. */
  async reconnect(newConfigs: ReadonlyArray<MCPServerConfig>): Promise<void> {
    const candidate = await McpConnector.prepare(newConfigs)
    try {
      await this.replaceWith(candidate)
    } catch (error) {
      await candidate.disconnectAll().catch(() => undefined)
      throw error
    }
  }

  async disconnectAll(): Promise<void> {
    const entries = Array.from(this.clients.entries())
    this.clients.clear()
    this.cachedTools = []
    this.catalogGeneration += 1
    this.toolDigests.clear()
    this.staleServers.clear()

    await Promise.allSettled(
      entries.map(async ([name, client]) => {
        try { await client.close() } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          console.error(`[McpConnector] Error disconnecting "${name}": ${msg}`)
        }
      })
    )
  }
}
