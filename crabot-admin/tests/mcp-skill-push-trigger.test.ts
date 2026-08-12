import { describe, it, expect, vi } from 'vitest'
import { AdminModule } from '../src/index.js'
import type { IncomingMessage, ServerResponse } from 'http'

// REST handlers delegate source mutation to the owning manager. The manager owns the
// coordinator/revision transaction; handlers must never resurrect legacy Agent config push.

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

/** 调 admin 上的 handler 方法（绕过类型检查）。 */
async function invoke<A extends unknown[]>(
  admin: unknown,
  method: string,
  ...args: A
): Promise<void> {
  await (admin as Record<string, (...a: A) => Promise<void>>)[method](...args)
}

/** Owning managers coordinate the mutation; the REST layer emits no legacy Agent push. */
function expectNoLegacyPush(admin: { pushConfigToAgentModules: ReturnType<typeof vi.fn> }): void {
  expect(admin.pushConfigToAgentModules).not.toHaveBeenCalled()
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
    importFromLocalPath: vi.fn().mockResolvedValue({ entry: { id: 'imported-skill-id', name: 'foo' }, was_overwrite: false }),
    importFromZip: vi.fn().mockResolvedValue({ entry: { id: 'zipped-skill-id', name: 'foo' }, was_overwrite: false }),
    toRestEntry: vi.fn(async (entry) => entry),
    ...deps.skillManagerStubs,
  }
  admin.config = { moduleId: 'test-admin' }
  // Legacy push spy: every handler must leave it untouched.
  admin.pushConfigToAgentModules = vi.fn().mockResolvedValue(undefined)
  return admin as Record<string, unknown> & {
    pushConfigToAgentModules: ReturnType<typeof vi.fn>
  }
}

describe('MCP REST handlers delegate without legacy Agent push', () => {
  it('handleCreateMCPServerApi delegates without push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleCreateMCPServerApi', makeReq({ name: 'X', transport: 'stdio', command: 'echo' }), makeRes())
    expectNoLegacyPush(admin)
  })

  it('handleUpdateMCPServerApi delegates without push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleUpdateMCPServerApi', makeReq({ enabled: false }), makeRes(), 'mcp-id')
    expectNoLegacyPush(admin)
  })

  it('handleDeleteMCPServerApi delegates without push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleDeleteMCPServerApi', makeReq({}), makeRes(), 'mcp-id')
    expectNoLegacyPush(admin)
  })

  it('handleImportMCPServersFromJsonApi delegates without push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleImportMCPServersFromJsonApi', makeReq({ json: '{"mcpServers":{}}' }), makeRes())
    expectNoLegacyPush(admin)
  })
})

describe('Skill REST handlers delegate without legacy Agent push', () => {
  it('handleCreateSkillApi delegates without push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleCreateSkillApi', makeReq({ name: 'foo', content: 'body' }), makeRes())
    expectNoLegacyPush(admin)
  })

  it('handleUpdateSkillApi delegates without push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleUpdateSkillApi', makeReq({ enabled: false }), makeRes(), 'skill-id')
    expectNoLegacyPush(admin)
  })

  it('handleDeleteSkillApi delegates without push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleDeleteSkillApi', makeReq({}), makeRes(), 'skill-id')
    expectNoLegacyPush(admin)
  })

  it('handleImportSkillLocalApi delegates without push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleImportSkillLocalApi', makeReq({ dir_path: '/tmp/skill-foo' }), makeRes())
    expectNoLegacyPush(admin)
  })

  it('handleImportSkillUploadApi delegates without push', async () => {
    const admin = buildAdmin()
    await invoke(admin, 'handleImportSkillUploadApi', makeReq({ base64_content: '', filename: 'foo.zip' }), makeRes())
    expectNoLegacyPush(admin)
  })
})
