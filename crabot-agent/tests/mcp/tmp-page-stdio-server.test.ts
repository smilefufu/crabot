import { afterEach, describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { promises as fs } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  TMP_PAGE_OPERATION_NAMES,
  tmpPageBridgeDepsFromEnv,
} from '../../src/mcp/tmp-page-stdio-server.js'
import { TMP_PAGE_BRIDGE_ENV } from '../../src/workers/capability-policy.js'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.allSettled(cleanup.splice(0).map((fn) => fn()))
})

function stringEnv(extra: Record<string, string>): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return { ...inherited, ...extra }
}

async function listenOnRandomPort(): Promise<{ port: number; close(): Promise<void> }> {
  const server = net.createServer((socket) => socket.end())
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('test listener did not expose a TCP port')
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  }
}

describe('tmp-page task-scoped stdio MCP bridge', () => {
  it('真实 stdio client 只能发现五个 operation，create owner 固定为绑定 Worker', async () => {
    const dataDir = await fs.mkdtemp(path.join(tmpdir(), 'tmp-page-stdio-'))
    cleanup.push(() => fs.rm(dataDir, { recursive: true, force: true }))
    const listener = await listenOnRandomPort()
    cleanup.push(() => listener.close())

    const sourceEntry = path.resolve(__dirname, '../../src/mcp/tmp-page-stdio-server.ts')
    const tsconfigPath = path.resolve(__dirname, '../../tsconfig.json')
    const bootstrap = `require(${JSON.stringify(require.resolve('ts-node'))}).register({transpileOnly:true,experimentalResolver:true,project:${JSON.stringify(tsconfigPath)}});require(${JSON.stringify(sourceEntry)}).startTmpPageStdioServer().catch((error)=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1})`
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['-e', bootstrap],
      env: stringEnv({
        [TMP_PAGE_BRIDGE_ENV.dataDir]: dataDir,
        [TMP_PAGE_BRIDGE_ENV.baseUrl]: 'https://pages.example.test',
        [TMP_PAGE_BRIDGE_ENV.workerId]: 'worker-bound',
        [TMP_PAGE_BRIDGE_ENV.port]: String(listener.port),
      }),
    })
    const client = new Client({ name: 'tmp-page-test', version: '1.0.0' }, { capabilities: {} })
    cleanup.push(async () => { await client.close() })
    await client.connect(transport)

    const listed = await client.listTools()
    expect(listed.tools.map((tool) => tool.name)).toEqual(TMP_PAGE_OPERATION_NAMES)
    const createSchema = listed.tools.find((tool) => tool.name === 'tmp_page_create')?.inputSchema as {
      properties?: Record<string, unknown>
    }
    expect(createSchema.properties).not.toHaveProperty('owner_task_id')

    const created = await client.callTool({
      name: 'tmp_page_create',
      arguments: {
        title: 'Bridge page',
        html: '<h1>ok</h1>',
        owner_task_id: 'forged-worker',
      },
    })
    expect(created.isError).toBe(false)
    const text = created.content.find((block) => block.type === 'text')
    if (!text || text.type !== 'text') throw new Error('tmp_page_create returned no text result')
    const payload = JSON.parse(text.text) as { page_id: string; url: string }
    expect(payload.url).toBe(`https://pages.example.test/tmp-pages/${payload.page_id}`)

    const meta = JSON.parse(await fs.readFile(
      path.join(dataDir, 'tmp-pages', payload.page_id, 'meta.json'),
      'utf8',
    )) as { owner_task_id: string }
    expect(meta.owner_task_id).toBe('worker-bound')
    expect(text.text).not.toContain(dataDir)
    expect(text.text).not.toContain(String(listener.port))
    expect(text.text).not.toContain('tmp-page-stdio-server')
  })

  it('启动参数缺失、相对 data dir 或非法 URL/端口均 fail-loud', () => {
    const valid = {
      [TMP_PAGE_BRIDGE_ENV.dataDir]: '/tmp/crabot-data',
      [TMP_PAGE_BRIDGE_ENV.baseUrl]: 'https://pages.example.test',
      [TMP_PAGE_BRIDGE_ENV.workerId]: 'worker-1',
      [TMP_PAGE_BRIDGE_ENV.port]: '19099',
    }
    expect(() => tmpPageBridgeDepsFromEnv({ ...valid, [TMP_PAGE_BRIDGE_ENV.workerId]: '' })).toThrow(
      TMP_PAGE_BRIDGE_ENV.workerId,
    )
    expect(() => tmpPageBridgeDepsFromEnv({ ...valid, [TMP_PAGE_BRIDGE_ENV.dataDir]: './data' })).toThrow(
      'must be absolute',
    )
    expect(() => tmpPageBridgeDepsFromEnv({ ...valid, [TMP_PAGE_BRIDGE_ENV.baseUrl]: 'file:///tmp' })).toThrow(
      'must use http or https',
    )
    expect(() => tmpPageBridgeDepsFromEnv({ ...valid, [TMP_PAGE_BRIDGE_ENV.port]: '0' })).toThrow(
      'port is invalid',
    )
  })
})
