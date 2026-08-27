import path from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import { createTmpPageTools, type TmpPageToolsDeps } from '../agent/tmp-page-tools.js'
import type { ToolCallContext } from '../engine/types.js'
import { TMP_PAGE_BRIDGE_ENV } from '../workers/capability-policy.js'

export const TMP_PAGE_OPERATION_NAMES = [
  'tmp_page_create',
  'tmp_page_update',
  'tmp_page_read_events',
  'tmp_page_delete',
  'tmp_page_list',
] as const

export function createTmpPageProtocolServer(deps: TmpPageToolsDeps): Server {
  const tools = createTmpPageTools(deps)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))
  const actualNames = tools.map((tool) => tool.name)
  if (actualNames.join('\n') !== TMP_PAGE_OPERATION_NAMES.join('\n')) {
    throw new Error(`tmp-page bridge tool contract drift: ${actualNames.join(', ')}`)
  }

  const server = new Server(
    { name: 'crabot-tmp-page', version: '1.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { readOnlyHint: tool.isReadOnly },
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name)
    if (!tool) throw new McpError(ErrorCode.MethodNotFound, `unknown tmp-page operation: ${request.params.name}`)
    const input = (request.params.arguments ?? {}) as Record<string, unknown>
    const result = await tool.call(input, {} as ToolCallContext)
    return {
      content: [{ type: 'text' as const, text: result.output }],
      isError: result.isError,
    }
  })
  return server
}

function requiredEnv(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim()
  if (!value) throw new Error(`tmp-page bridge missing ${key}`)
  return value
}

export function tmpPageBridgeDepsFromEnv(env: NodeJS.ProcessEnv): TmpPageToolsDeps {
  const dataDir = requiredEnv(env, TMP_PAGE_BRIDGE_ENV.dataDir)
  if (!path.isAbsolute(dataDir)) throw new Error('tmp-page bridge data directory must be absolute')

  const baseUrl = requiredEnv(env, TMP_PAGE_BRIDGE_ENV.baseUrl)
  let parsedBaseUrl: URL
  try {
    parsedBaseUrl = new URL(baseUrl)
  } catch {
    throw new Error('tmp-page bridge base URL is invalid')
  }
  if (parsedBaseUrl.protocol !== 'http:' && parsedBaseUrl.protocol !== 'https:') {
    throw new Error('tmp-page bridge base URL must use http or https')
  }

  const workerId = requiredEnv(env, TMP_PAGE_BRIDGE_ENV.workerId)
  const port = Number(requiredEnv(env, TMP_PAGE_BRIDGE_ENV.port))
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('tmp-page bridge port is invalid')
  }

  return {
    dataDir,
    getTmpPageBaseUrl: () => baseUrl,
    taskId: workerId,
    tmpPagePort: port,
  }
}

export async function startTmpPageStdioServer(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const server = createTmpPageProtocolServer(tmpPageBridgeDepsFromEnv(env))
  await server.connect(new StdioServerTransport())
}

if (require.main === module) {
  void startTmpPageStdioServer().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
