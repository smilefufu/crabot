import { afterEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as tar from 'tar'
import AdminModule from './index.js'
import { createMemoryV2RestRouter } from './memory-v2-rest.js'

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))) })

function token(sub: string, epoch = 7, expires = Math.floor(Date.now() / 1000) + 60) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(JSON.stringify({ sub, e: epoch, iat: 0, exp: expires })).toString('base64url')
  const signature = crypto.createHmac('sha256', 'fixture-secret').update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

async function subject() {
  const admin = Object.create(AdminModule.prototype) as any
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-auth-'))
  dirs.push(dataDir)
  await fs.writeFile(path.join(dataDir, 'credentials.json'), JSON.stringify({ token_epoch: 7 }))
  admin.adminConfig = { data_dir: dataDir }
  admin.config = { moduleId: 'admin-test' }
  admin.jwtSecret = 'fixture-secret'
  admin.rpcClient = { callModuleManagerSensitive: vi.fn().mockResolvedValue({ verified: true }), callSensitive: vi.fn().mockResolvedValue({}) }
  return admin
}

describe('Memory identity bridge', () => {
  it('requires a bearer and verifies exact current core Agent through MM', async () => {
    const admin = await subject()
    await expect(admin.handleVerifyMemoryAccess({ caller_kind: 'core_agent', source: 'crabot-agent' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(admin.rpcClient.callModuleManagerSensitive).not.toHaveBeenCalled()
    await expect(admin.handleVerifyMemoryAccess({ caller_kind: 'core_agent' }, { authorizationBearer: 'runtime' })).resolves.toEqual({ verified: true })
    expect(admin.rpcClient.callModuleManagerSensitive).toHaveBeenCalledWith('verify_core_agent_runtime', { expected_module_id: 'crabot-agent' }, 'admin-test', { authorizationBearer: 'runtime' })
    admin.rpcClient.callModuleManagerSensitive.mockRejectedValueOnce(Object.assign(new Error('secret remote body'), { code: 'FORBIDDEN' }))
    await expect(admin.handleVerifyMemoryAccess({ caller_kind: 'core_agent' }, { authorizationBearer: 'old-runtime' })).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Invalid core Agent credential' })
    admin.rpcClient.callModuleManagerSensitive.mockRejectedValueOnce(new Error('remote secrets'))
    await expect(admin.handleVerifyMemoryAccess({ caller_kind: 'core_agent' }, { authorizationBearer: 'runtime' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE', details: { retryable: true } })
  })

  it('accepts current human JWT only; rejects internal, agent-cli, expired and rotated tokens', async () => {
    const admin = await subject()
    await expect(admin.handleVerifyMemoryAccess({ caller_kind: 'admin_web' }, { authorizationBearer: token('admin') })).resolves.toEqual({ verified: true })
    for (const bearer of [token('internal'), token('agent-cli'), token('admin', 6), token('admin', 7, 1), 'forged']) {
      await expect(admin.handleVerifyMemoryAccess({ caller_kind: 'admin_web' }, { authorizationBearer: bearer })).rejects.toMatchObject({ code: expect.stringMatching(/UNAUTHORIZED|FORBIDDEN/) })
    }
  })

  it('forwards the current request human credential in header with host-only Admin context', async () => {
    const admin = await subject()
    const bearer = token('admin')
    await admin.callMemoryAsAdmin({ headers: { authorization: `Bearer ${bearer}` } }, 1234, 'get_stats', {})
    expect(admin.rpcClient.callSensitive).toHaveBeenCalledWith(1234, 'get_stats', { access_context: { actor_kind: 'admin', memory_enabled: true } }, 'admin-test', { authorizationBearer: bearer })
    await expect(admin.callMemoryAsAdmin({ headers: { authorization: `Bearer ${token('internal')}` } }, 1234, 'get_stats', {})).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(admin.rpcClient.callSensitive).toHaveBeenCalledTimes(1)
  })

  it('REST fails before any Memory I/O when no human credential is forwarded', async () => {
    const rpcClient = { callSensitive: vi.fn() }
    const getMemoryPort = vi.fn()
    const router = createMemoryV2RestRouter({ rpcClient: rpcClient as never, moduleId: 'admin', getMemoryPort })
    expect((await router.dispatch('GET', '/api/memory/v2/entries')).status).toBe(401)
    expect(getMemoryPort).not.toHaveBeenCalled()
    expect(rpcClient.callSensitive).not.toHaveBeenCalled()
  })
})

async function openClawMemoryImport(admin: any, bearer: string) {
  const root = path.join(admin.adminConfig.data_dir, 'backup')
  const workspace = path.join(root, 'payload', 'posix', 'fixture', 'workspace')
  await fs.mkdir(workspace, { recursive: true })
  await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, createdAt: '2026-10-10T00:00:00.000Z', archiveRoot: 'backup',
    runtimeVersion: '1', platform: 'linux', nodeVersion: 'v22',
    options: { includeWorkspace: true },
    paths: { stateDir: '/fixture', configPath: '/fixture/config.json', workspaceDirs: ['/fixture/workspace'] },
    assets: [], skipped: [],
  }))
  await fs.writeFile(path.join(workspace, 'MEMORY.md'), '# imported memory')
  const archivePath = path.join(admin.adminConfig.data_dir, 'backup.tar.gz')
  await tar.c({ file: archivePath, gzip: true, cwd: admin.adminConfig.data_dir }, ['backup'])
  admin.openclawImportStore = { resolve: vi.fn().mockReturnValue(archivePath), discard: vi.fn() }
  admin.getMemoryPort = vi.fn().mockResolvedValue(1234)
  admin.modelProviderManager = { listProviders: () => [] }
  admin.channelManager = { listInstances: () => ({ items: [] }) }
  admin.mcpServerManager = { list: () => [] }
  admin.skillManager = { list: () => [] }
  admin.readJsonBody = vi.fn().mockResolvedValue({ token: 'upload', selections: {
    providers: [], channels: [], mcp: [], skills: [], memory: true, workspace: false,
  } })
  admin.rpcClient.call = vi.fn().mockRejectedValue(new Error('Missing Memory access context'))
  const response = { writeHead: vi.fn(), end: vi.fn() }
  await admin.handleOpenClawImportExecuteApi({ headers: { authorization: `Bearer ${bearer}` } }, response)
  expect(response.writeHead).toHaveBeenCalledWith(200, { 'Content-Type': 'application/json' })
  expect(admin.openclawImportStore.discard).toHaveBeenCalledWith('upload')
  return JSON.parse(response.end.mock.calls[0][0])
}

describe('OpenClaw Memory import authentication', () => {
  it('imports a real archive through the current human credential and host Admin context', async () => {
    const admin = await subject()
    const bearer = token('admin')
    const summary = await openClawMemoryImport(admin, bearer)
    expect(summary.errors).toEqual([])
    expect(summary.results).toEqual([{ kind: 'memory', name: 'MEMORY.md', status: 'imported' }])
    expect(admin.rpcClient.call).not.toHaveBeenCalled()
    expect(admin.rpcClient.callSensitive).toHaveBeenCalledWith(1234, 'write_long_term', {
      type: 'fact', content: '# imported memory', author: 'user', status: 'confirmed',
      visibility: 'internal', scopes: [], access_context: { actor_kind: 'admin', memory_enabled: true },
    }, 'admin-test', { authorizationBearer: bearer })
  })

  it.each(['internal', 'agent-cli'])('rejects %s credentials without forwarding Memory data', async (sub) => {
    const admin = await subject()
    const summary = await openClawMemoryImport(admin, token(sub))
    expect(summary.results).toEqual([])
    expect(summary.errors).toEqual(['memory: Human Admin credential required'])
    expect(admin.rpcClient.callSensitive).not.toHaveBeenCalled()
    expect(admin.rpcClient.call).not.toHaveBeenCalled()
  })
})
