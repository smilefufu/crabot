import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ActivationRegistry } from '../../src/workers/activation-registry.js'
import type { WorkerAdapter, DetectResult, WorkerImplementationRuntimeConfig } from '../../src/workers/types.js'

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-activation-registry-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function runtimeConfig(overrides: Partial<WorkerImplementationRuntimeConfig['config']['implementations']> = {}): WorkerImplementationRuntimeConfig {
  return {
    config: {
      revision: 1,
      default_impl: 'builtin',
      implementations: {
        builtin: { enabled: true },
        'claude-code': { enabled: false },
        codex: { enabled: false },
        ...overrides,
      } as WorkerImplementationRuntimeConfig['config']['implementations'],
    },
    connection_revisions: {},
  }
}

function fakeAdapter(
  implId: 'builtin' | 'claude-code' | 'codex',
  detect: DetectResult,
  connectionCapabilities: import('../../src/workers/types.js').WorkerConnectionCapability[] = [],
): WorkerAdapter {
  return {
    implId,
    detect: async () => detect,
    capabilities: () => ({ fork: false, revive: false, goalMode: false, subagent: false, structuredTrace: false }),
    connectionCapabilities: () => connectionCapabilities,
  } as unknown as WorkerAdapter
}

const EXISTING_HOST_TRANSLATOR: import('../../src/workers/types.js').WorkerConnectionCapability = {
  mode: 'existing_host',
  translator_id: 'claude-code-existing-host-v1',
  translator_version: '1',
  credential_transport: 'native_store',
  model_selection: 'native_default',
  credential_scope: 'runtime_user_home',
}
const ADMIN_PROVIDER_TRANSLATOR: import('../../src/workers/types.js').WorkerConnectionCapability = {
  mode: 'admin_provider',
  translator_id: 'claude-code-anthropic-runtime-v1',
  translator_version: '1',
  provider_formats: ['anthropic'],
  credential_transport: 'process_env',
  model_selection: 'explicit_model',
  credential_scope: 'admin_runtime',
}

describe('ActivationRegistry（P6-B §6）', () => {
  it('未 initialized（无 desired config）时 status 明确 unavailable，不假装 ready', async () => {
    const registry = new ActivationRegistry(dir)
    await registry.load()
    expect(registry.isInitialized()).toBe(false)
    expect(() => registry.listStatus()).toThrow(/not initialized/i)
  })

  it('builtin ready 要求 enabled + model slot 可解析；CLI disabled → not ready 且 installed 不算 ready', async () => {
    const registry = new ActivationRegistry(dir)
    registry.setAdapters(new Map([
      ['builtin', fakeAdapter('builtin', { installed: true, activated: true })],
      ['claude-code', fakeAdapter('claude-code', { installed: true, activated: true, version: '2.1.227' }, [EXISTING_HOST_TRANSLATOR])],
      ['codex', fakeAdapter('codex', { installed: false, activated: false })],
    ]))
    registry.setModelSlotResolvable(() => true)
    await registry.applyRuntimeConfig(runtimeConfig({
      'claude-code': { enabled: true, connection: { mode: 'existing_host' } },
    }))
    const list = registry.listStatus()
    const builtin = list.find((s) => s.impl === 'builtin')!
    const claude = list.find((s) => s.impl === 'claude-code')!
    expect(builtin.ready).toBe(true)
    // 失败导向（2026-08-16 修订）：never verified 不再阻断——enabled+installed+connection 即 ready
    expect(claude.installed).toBe(true)
    expect(claude.ready).toBe(true)
    expect(claude.verification).toBe('never')
  })

  it('explicit spawn gate：not ready → WORKER_IMPLEMENTATION_NOT_READY + ready list + 脱敏 reason', async () => {
    const registry = new ActivationRegistry(dir)
    registry.setAdapters(new Map([['builtin', fakeAdapter('builtin', { installed: true, activated: true })]]))
    registry.setModelSlotResolvable(() => true)
    await registry.applyRuntimeConfig(runtimeConfig())
    try {
      await registry.assertReady('claude-code')
      expect.unreachable()
    } catch (error) {
      const err = error as Error & { code?: string; details?: { ready_impls?: string[] } }
      expect(err.code).toBe('WORKER_IMPLEMENTATION_NOT_READY')
      expect(err.details?.ready_impls).toEqual(['builtin'])
    }
  })

  it('config 原子替换：revision 旧的 apply 拒绝（stale 防护）', async () => {
    const registry = new ActivationRegistry(dir)
    registry.setAdapters(new Map([['builtin', fakeAdapter('builtin', { installed: true, activated: true })]]))
    registry.setModelSlotResolvable(() => true)
    await registry.applyRuntimeConfig(runtimeConfig())
    const stale = runtimeConfig()
    stale.config.revision = 0
    await expect(registry.applyRuntimeConfig(stale)).rejects.toThrow(/stale/i)
  })

  it('重启后 verification binding 从磁盘恢复（passed 记录参与 ready 计算）', async () => {
    const first = new ActivationRegistry(dir)
    first.setAdapters(new Map([
      ['builtin', fakeAdapter('builtin', { installed: true, activated: true })],
      ['claude-code', fakeAdapter('claude-code', { installed: true, activated: true, version: '2.1.227' }, [EXISTING_HOST_TRANSLATOR])],
    ]))
    first.setModelSlotResolvable(() => true)
    await first.applyRuntimeConfig(runtimeConfig({
      'claude-code': { enabled: true, connection: { mode: 'existing_host' } },
    }))
    // existing_host 的 connection_revision 由 registry 现算——先读 status 拿到当前值。
    const currentRev = first.listStatus().find((s) => s.impl === 'claude-code')!.connection_revision!
    await first.recordVerification('claude-code', {
      result: 'passed',
      cli_version: '2.1.227',
      translator_id: 'claude-code-existing-host-v1',
      translator_version: '1',
      policy_revision: 1,
      connection_revision: currentRev,
      at: new Date().toISOString(),
    })
    const claude = first.listStatus().find((s) => s.impl === 'claude-code')!
    expect(claude.verification).toBe('passed')
    expect(claude.ready).toBe(true)

    // 新实例（模拟重启）：状态从磁盘恢复
    const second = new ActivationRegistry(dir)
    second.setAdapters(new Map([
      ['builtin', fakeAdapter('builtin', { installed: true, activated: true })],
      ['claude-code', fakeAdapter('claude-code', { installed: true, activated: true, version: '2.1.227' }, [EXISTING_HOST_TRANSLATOR])],
    ]))
    second.setModelSlotResolvable(() => true)
    await second.load()
    await second.applyRuntimeConfig(runtimeConfig({
      'claude-code': { enabled: true, connection: { mode: 'existing_host' } },
    }))
    expect(second.listStatus().find((s) => s.impl === 'claude-code')!.ready).toBe(true)
  })

  it('binding 分量变化 → verification_stale 提示但不阻断（失败导向）', async () => {
    const registry = new ActivationRegistry(dir)
    registry.setAdapters(new Map([
      ['builtin', fakeAdapter('builtin', { installed: true, activated: true })],
      ['claude-code', fakeAdapter('claude-code', { installed: true, activated: true, version: '2.1.227' }, [ADMIN_PROVIDER_TRANSLATOR])],
    ]))
    registry.setModelSlotResolvable(() => true)
    const withRev = runtimeConfig({
      'claude-code': { enabled: true, connection: { mode: 'admin_provider', provider_id: 'p1', model_id: 'm1' } },
    })
    withRev.connection_revisions = { 'claude-code': 'rev-A' }
    await registry.applyRuntimeConfig(withRev)
    await registry.recordVerification('claude-code', {
      result: 'passed',
      cli_version: '2.1.227',
      translator_id: 'claude-code-anthropic-runtime-v1',
      translator_version: '1',
      policy_revision: 1,
      connection_revision: 'rev-A',
      at: new Date().toISOString(),
    })
    expect(registry.listStatus().find((s) => s.impl === 'claude-code')!.ready).toBe(true)

    // connection_revision 变化（Admin 侧 provider 轮换）
    const rotated = runtimeConfig({
      'claude-code': { enabled: true, connection: { mode: 'admin_provider', provider_id: 'p1', model_id: 'm1' } },
    })
    rotated.connection_revisions = { 'claude-code': 'rev-B' }
    await registry.applyRuntimeConfig(rotated)
    const stale = registry.listStatus().find((s) => s.impl === 'claude-code')!
    expect(stale.ready).toBe(true) // 不阻断
    expect(stale.verification_stale).toBe(true) // 但提示建议重验
  })

  it('degraded 阻断派活并在成功后清除', async () => {
    const registry = new ActivationRegistry(dir)
    registry.setAdapters(new Map([
      ['builtin', fakeAdapter('builtin', { installed: true, activated: true })],
      ['claude-code', fakeAdapter('claude-code', { installed: true, activated: true, version: '2.1.227' }, [EXISTING_HOST_TRANSLATOR])],
    ]))
    registry.setModelSlotResolvable(() => true)
    await registry.applyRuntimeConfig(runtimeConfig({
      'claude-code': { enabled: true, connection: { mode: 'existing_host' } },
    }))
    expect(registry.getStatus('claude-code').ready).toBe(true)
    await registry.markDegraded('claude-code', 'not logged in')
    const degraded = registry.getStatus('claude-code')
    expect(degraded.ready).toBe(false)
    expect(degraded.degraded).toBe('not logged in')
    // 解封闭环（R96-R1）：passed 的 verify 自动清除 degraded——用户侧的解封入口。
    const rev = registry.getStatus('claude-code').connection_revision ?? 'x'
    await registry.recordVerification('claude-code', {
      result: 'passed', cli_version: '2.1.227', translator_id: 'claude-code-existing-host-v1',
      translator_version: '1', policy_revision: 1, connection_revision: rev, at: new Date().toISOString(),
    })
    expect(registry.getStatus('claude-code').ready).toBe(true)
    expect(registry.getStatus('claude-code').degraded).toBeUndefined()
  })
})
