import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { WechatImageFetcher } from '../../../crabot-channel-wechat/src/image-fetch.js'
import { createImageReader } from '../../src/mcp/fetch-image.js'
import { BuiltinSubagentRunner } from '../../src/workers/builtin/subagent-runner.js'
import { BgEntityRegistry } from '../../src/engine/bg-entities/registry.js'
import { TraceStore } from '../../src/core/trace-store.js'
import { authorizeTool, fileAuthorization } from '../../src/permissions/tool-authorization.js'
import { BUILTIN_WORKER_PERMISSIONS } from '../../src/workers/builtin/runtime.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter.js'
import type { SubAgentConfig } from '../../src/types.js'

const { createAdapter } = vi.hoisted(() => ({ createAdapter: vi.fn() }))
vi.mock('../../src/engine/llm-adapter.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/engine/llm-adapter.js')>(), createAdapter,
}))
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('微信高清文件交付到 builtin 子 Agent 的真实请求', () => {
  it('Manager 只取路径，引用按最新高清获取，异步 child 的 adapter 收到原始 bytes', async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), 'wechat-child-delivery-'))
    vi.stubEnv('DATA_DIR', dir)
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64')
    const download = vi.fn(async () => new Response(bytes))
    vi.stubGlobal('fetch', download)
    const registry = new BgEntityRegistry(join(dir, 'registry.json'))
    const requests: any[] = []
    const adapter: LLMAdapter = { async *stream(params) {
      requests.push(structuredClone(params.messages))
      yield* chunksFromContent([{ type: 'text', text: '收到图片输入' }], 'end_turn')
    }, updateConfig() {} }
    createAdapter.mockReturnValue(adapter)
    try {
      const channel = new WechatImageFetcher({ dataDir: dir, getTalker: () => 'group',
        getMessage: async id => id === 'quote' ? { fieldTalker: 'group', fieldType: 18,
          content: { quoted_svr_id: '514607585156521130', quoted_resource_url: 'https://cdn/old-thumb' } }
          : { fieldTalker: 'group', fieldType: 1, content: { image_origin: 1, resource_url: 'https://cdn/latest-hd' } },
      })
      const reader = createImageReader({ moduleId: 'agent', resolveChannelPort: async () => 123,
        rpcClient: { call: async (_port: number, method: string, args: any) => method === 'get_capabilities'
          ? { supports_image_fetch: true } : channel.fetch(args) } } as never)
      const fetched = await reader({ channel_id: 'wechat', session_id: 's', platform_message_id: 'quote', include_image: false })
      expect(fetched.images).toBeUndefined()
      const file = JSON.parse(fetched.content[0].text)
      expect(file).toMatchObject({ status: 'ready', image_quality: 'hd' })
      const permissions = { ...BUILTIN_WORKER_PERMISSIONS, storage: { workspace_path: dir, access: 'read' as const } }
      const read = authorizeTool({ name: 'Read', description: 'Read', inputSchema: { type: 'object' }, isReadOnly: true,
        call: async () => ({ output: '', isError: false }) }, fileAuthorization('worker', () => permissions, () => dir, 'file_path', false))
      const store = new TraceStore()
      const parent = store.startTrace({ module_id: 'agent', trigger: { type: 'task', summary: '识别微信引用图' } })
      const runner = new BuiltinSubagentRunner(store, undefined as never, undefined, registry)
      const result = await runner.run({ id: 'vision', name: 'research_collector', model: {
        model_id: 'vision', supports_vision: true, endpoint: 'https://example.test', apikey: 'test', format: 'openai',
      }, builtin_capabilities: { file_system: true }, allowed_mcp_server_ids: [], allowed_skill_ids: [] } as SubAgentConfig,
      { task: '识别图片', image_paths: [file.file_path] }, { worker_subagent: { worker_id: 'worker', parent_trace_id: parent.trace_id } }, [read],
      { permissionConfig: { mode: 'bypass' }, resolvedPermissions: permissions, availableSkills: [], getCwd: () => dir })
      expect(result.isError).toBe(false)
      const { agent_id } = JSON.parse(result.output)
      await vi.waitFor(async () => expect((await registry.get(agent_id))?.status).toBe('completed'), { timeout: 2_000 })
      expect(requests).toHaveLength(1)
      expect(requests[0][0].content).toContainEqual({ type: 'image', source: {
        type: 'base64', media_type: 'image/png', data: bytes.toString('base64'),
      } })
      expect(download).toHaveBeenCalledTimes(1)
      expect(download).toHaveBeenCalledWith('https://cdn/latest-hd', expect.anything())
    } finally { await fs.rm(dir, { recursive: true, force: true }) }
  })
})
