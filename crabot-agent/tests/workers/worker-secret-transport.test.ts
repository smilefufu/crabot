import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { admitWorkerConnection } from '../../src/workers/connections/admission.js'
import { ActivationRegistry } from '../../src/workers/activation-registry.js'
import type { WorkerAdapter, WorkerImplementationRuntimeConfig } from '../../src/workers/types.js'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-admission-')) })
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

function fakeAdapter(version: string): WorkerAdapter {
  return {
    implId: 'codex',
    detect: async () => ({ installed: true, activated: false, version }),
    capabilities: () => ({ fork: false, revive: true, goalMode: false, subagent: false, structuredTrace: false }),
    connectionCapabilities: () => [{
      mode: 'admin_provider',
      translator_id: 'codex-openai-responses-runtime-v1',
      translator_version: '1',
      cli_version_range: '0.146.x,0.147.x',
      provider_formats: ['openai-responses'],
      credential_transport: 'agent_runtime_file',
      model_selection: 'explicit_model',
      credential_scope: 'admin_runtime',
    }],
  } as unknown as WorkerAdapter
}

function desiredWithAdminProvider(revision: string): WorkerImplementationRuntimeConfig {
  return {
    config: {
      revision: 1,
      default_impl: 'builtin',
      implementations: {
        builtin: { enabled: true },
        'claude-code': { enabled: false },
        codex: { enabled: true, connection: { mode: 'admin_provider', provider_id: 'p1', model_id: 'm1' } },
      },
    },
    connection_revisions: { codex: revision },
  }
}

describe('admitWorkerConnection（P6-B §6.5 operation-time 解析）', () => {
  it('admin_provider：每次调用实时 resolve，CODEX_HOME runtime 目录生成，dispose 后清空', async () => {
    const registry = new ActivationRegistry(dir)
    registry.setAdapters(new Map([['codex', fakeAdapter('0.146.0')]]))
    registry.setModelSlotResolvable(() => true)
    await registry.applyRuntimeConfig(desiredWithAdminProvider('rev-A'))
    let resolveCalls = 0
    const deps = {
      resolveAdminProviderConnection: async () => {
        resolveCalls++
        return { connection: { endpoint: 'https://e', apikey: 'sk-live', model_id: 'm1', format: 'openai-responses' as const }, connection_revision: 'rev-A' }
      },
      runtimeRoot: path.join(dir, 'runtime'),
    }
    const first = await admitWorkerConnection(registry, 'codex', deps)
    expect(first.env.CRABOT_WORKER_ADMIN_PROVIDER_KEY).toBe('sk-live')
    expect(first.env.CODEX_HOME).toBeTruthy()
    const codexHome = first.env.CODEX_HOME!
    const configToml = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf-8')
    expect(configToml).toContain('wire_api = "responses"')
    expect(configToml).not.toContain('sk-live')
    await first.dispose()
    await expect(fs.stat(codexHome)).rejects.toThrow(/ENOENT/)

    // 第二次操作重新 resolve（不缓存）
    await (await admitWorkerConnection(registry, 'codex', deps)).dispose()
    expect(resolveCalls).toBe(2)
  })

  it('revision 漂移（resolve 值 ≠ registry 快照）→ 拒绝且不产生 runtime 残留', async () => {
    const registry = new ActivationRegistry(dir)
    registry.setAdapters(new Map([['codex', fakeAdapter('0.146.0')]]))
    registry.setModelSlotResolvable(() => true)
    await registry.applyRuntimeConfig(desiredWithAdminProvider('rev-A'))
    const deps = {
      resolveAdminProviderConnection: async () => ({
        connection: { endpoint: 'https://e', apikey: 'sk-x', model_id: 'm1', format: 'openai-responses' as const },
        connection_revision: 'rev-B', // Admin 侧已轮换，本进程还没 pull
      }),
      runtimeRoot: path.join(dir, 'runtime'),
    }
    await expect(admitWorkerConnection(registry, 'codex', deps)).rejects.toThrow(/revision changed/)
    // 无残留
    const runtimeRoot = path.join(dir, 'runtime')
    const exists = await fs.access(runtimeRoot).then(() => true).catch(() => false)
    if (exists) {
      expect((await fs.readdir(runtimeRoot)).filter((e) => e.startsWith('op-'))).toEqual([])
    }
  })

  it('builtin / 无 connection 的 impl：零注入', async () => {
    const registry = new ActivationRegistry(dir)
    registry.setAdapters(new Map([['codex', fakeAdapter('0.146.0')]]))
    registry.setModelSlotResolvable(() => true)
    await registry.applyRuntimeConfig({
      config: { revision: 1, default_impl: 'builtin', implementations: { builtin: { enabled: true }, 'claude-code': { enabled: false }, codex: { enabled: false } } },
      connection_revisions: {},
    })
    const admission = await admitWorkerConnection(registry, 'builtin', { resolveAdminProviderConnection: async () => { throw new Error('must not be called') }, runtimeRoot: dir })
    expect(admission.env).toEqual({})
  })
})
