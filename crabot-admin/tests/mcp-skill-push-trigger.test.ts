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
    importLocal: vi.fn().mockResolvedValue([]),
    importUpload: vi.fn().mockResolvedValue([]),
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
    const req = makeReq({ name: 'X', transport: 'stdio', command: 'echo' })
    const res = makeRes()

    await (
      admin as {
        handleCreateMCPServerApi: (
          req: IncomingMessage,
          res: ServerResponse
        ) => Promise<void>
      }
    ).handleCreateMCPServerApi(req, res)

    // push 调用是 fire-and-forget，需要等待 microtask
    await new Promise((resolve) => setImmediate(resolve))
    expect(admin.pushConfigToAgentModules).toHaveBeenCalledTimes(1)
  })

  it('handleUpdateMCPServerApi 触发 push', async () => {
    const admin = buildAdmin()
    const req = makeReq({ enabled: false })
    const res = makeRes()

    await (
      admin as {
        handleUpdateMCPServerApi: (
          req: IncomingMessage,
          res: ServerResponse,
          id: string
        ) => Promise<void>
      }
    ).handleUpdateMCPServerApi(req, res, 'mcp-id')

    await new Promise((resolve) => setImmediate(resolve))
    expect(admin.pushConfigToAgentModules).toHaveBeenCalledTimes(1)
  })

  it('handleDeleteMCPServerApi 触发 push', async () => {
    const admin = buildAdmin()
    const req = makeReq({})
    const res = makeRes()

    await (
      admin as {
        handleDeleteMCPServerApi: (
          req: IncomingMessage,
          res: ServerResponse,
          id: string
        ) => Promise<void>
      }
    ).handleDeleteMCPServerApi(req, res, 'mcp-id')

    await new Promise((resolve) => setImmediate(resolve))
    expect(admin.pushConfigToAgentModules).toHaveBeenCalledTimes(1)
  })

  it('handleImportMCPServersFromJsonApi 触发 push', async () => {
    const admin = buildAdmin()
    const req = makeReq({ json: '{"mcpServers":{}}' })
    const res = makeRes()

    await (
      admin as {
        handleImportMCPServersFromJsonApi: (
          req: IncomingMessage,
          res: ServerResponse
        ) => Promise<void>
      }
    ).handleImportMCPServersFromJsonApi(req, res)

    await new Promise((resolve) => setImmediate(resolve))
    expect(admin.pushConfigToAgentModules).toHaveBeenCalledTimes(1)
  })
})
