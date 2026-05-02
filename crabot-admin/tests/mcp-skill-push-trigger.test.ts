import { describe, it, expect, vi } from 'vitest'
import { AdminModule } from '../src/index.js'
import type { IncomingMessage, ServerResponse } from 'http'

// 这些测试验证 admin REST 写 handler 都 trigger pushConfigToAgentModules。
// 用 Object.create 跳过构造，spy on push fn，用最小 req/res mock 调 handler。
//
// 本文件覆盖 mcp + skill 9 个 handler。本 task（Simp Task 3）只跑 mcp 4 个，
// skill 5 个在 Simp Task 4 启用（届时去掉 .skip）。

function makeRes(): ServerResponse & { _written: { code?: number; body?: string } } {
  const written: { code?: number; body?: string } = {}
  return {
    writeHead: vi.fn((code: number) => {
      written.code = code
    }),
    end: vi.fn((body?: string) => {
      written.body = body
    }),
    _written: written,
  } as unknown as ServerResponse & { _written: { code?: number; body?: string } }
}

function makeReq(body: unknown): IncomingMessage {
  const payload = Buffer.from(JSON.stringify(body))
  return {
    method: 'POST',
    on(event: string, handler: (chunk?: Buffer) => void) {
      if (event === 'data') handler(payload)
      else if (event === 'end') handler()
      return this
    },
  } as unknown as IncomingMessage
}

/** 调 admin 上的 handler 方法（绕过类型检查）+ 等 200ms debounce 窗口 + fire-and-forget microtask 完成。 */
async function invoke<A extends unknown[]>(
  admin: unknown,
  method: string,
  ...args: A
): Promise<void> {
  await (admin as Record<string, (...a: A) => Promise<void>>)[method](...args)
  // triggerPushAfter 现在 200ms debounce，等够窗口期 + 微任务清空
  await new Promise((resolve) => setTimeout(resolve, 250))
}

/** 断言 push 触发了恰好一次。 */
function expectPushed(admin: { pushConfigToAgentModules: ReturnType<typeof vi.fn> }): void {
  expect(admin.pushConfigToAgentModules).toHaveBeenCalledTimes(1)
}

function buildAdmin(deps: {
  mcpManagerStubs?: Record<string, ReturnType<typeof vi.fn>>
  skillManagerStubs?: Record<string, ReturnType<typeof vi.fn>>
} = {}) {
  const admin = Object.create(AdminModule.prototype) as Record<string, unknown>
  admin.mcpServerManager = {
    create: vi.fn().mockResolvedValue({ id: 'new-mcp-id', name: 'X' }),
    update: vi.fn().mockResolvedValue({ id: 'mcp-id', name: 'X' }),
    delete: vi.fn().mockResolvedValue(undefined),
    importFromJson: vi.fn().mockResolvedValue([]),
    ...deps.mcpManagerStubs,
  }
  admin.skillManager = {
    create: vi.fn().mockResolvedValue({ id: 'new-skill-id', name: 'foo' }),
    update: vi.fn().mockResolvedValue({ id: 'skill-id', name: 'foo' }),
    delete: vi.fn().mockResolvedValue(undefined),
    importFromLocalPath: vi.fn().mockResolvedValue({ id: 'imported-skill-id', name: 'foo' }),
    importFromZip: vi.fn().mockResolvedValue({ id: 'zipped-skill-id', name: 'foo' }),
    ...deps.skillManagerStubs,
  }
  admin.config = { moduleId: 'test-admin' }
  // Spy on pushConfigToAgentModules（被 handler 触发；fire-and-forget）
  admin.pushConfigToAgentModules = vi.fn().mockResolvedValue(undefined)
  return admin as Record<string, unknown> & {
    pushConfigToAgentModules: ReturnType<typeof vi.fn>
  }
}

describe('MCP REST handler triggers pushConfigToAgentModules', () => {
  it('handleCreateMCPServerApi 触发 push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleCreateMCPServerApi', makeReq({ name: 'X', transport: 'stdio', command: 'echo' }), makeRes())
    expectPushed(admin)
  })

  it('handleUpdateMCPServerApi 触发 push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleUpdateMCPServerApi', makeReq({ enabled: false }), makeRes(), 'mcp-id')
    expectPushed(admin)
  })

  it('handleDeleteMCPServerApi 触发 push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleDeleteMCPServerApi', makeReq({}), makeRes(), 'mcp-id')
    expectPushed(admin)
  })

  it('handleImportMCPServersFromJsonApi 触发 push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleImportMCPServersFromJsonApi', makeReq({ json: '{"mcpServers":{}}' }), makeRes())
    expectPushed(admin)
  })
})

describe('Skill REST handler triggers pushConfigToAgentModules', () => {
  it('handleCreateSkillApi 触发 push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleCreateSkillApi', makeReq({ name: 'foo', content: 'body' }), makeRes())
    expectPushed(admin)
  })

  it('handleUpdateSkillApi 触发 push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleUpdateSkillApi', makeReq({ enabled: false }), makeRes(), 'skill-id')
    expectPushed(admin)
  })

  it('handleDeleteSkillApi 触发 push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleDeleteSkillApi', makeReq({}), makeRes(), 'skill-id')
    expectPushed(admin)
  })

  it('handleImportSkillLocalApi 触发 push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleImportSkillLocalApi', makeReq({ dir_path: '/tmp/skill-foo' }), makeRes())
    expectPushed(admin)
  })

  it('handleImportSkillUploadApi 触发 push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleImportSkillUploadApi', makeReq({ base64_content: '', filename: 'foo.zip' }), makeRes())
    expectPushed(admin)
  })
})
