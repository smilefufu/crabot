import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { UnifiedAgent } from '../../src/unified-agent.js'
import { WorkerOperationStore } from '../../src/workers/operations/store.js'
import type { UnifiedAgentConfig } from '../../src/types.js'

function config(): UnifiedAgentConfig {
  return {
    module_id: 'worker-install-test-agent', module_type: 'agent', version: '0.1.0', protocol_version: '3.6.0', port: 19999,
    orchestration: { front_context_recent_messages_window_hours: 1, front_context_recent_messages_max_cap: 1, front_context_short_term_memory_window_hours: 1, front_context_short_term_memory_max_cap: 1, worker_recent_messages_window_hours: 1, worker_recent_messages_max_cap: 1, worker_short_term_memory_window_hours: 1, worker_short_term_memory_max_cap: 1, worker_long_term_memory_limit: 1, front_agent_timeout: 1, session_state_ttl: 1, worker_config_refresh_interval: 1, front_agent_queue_max_length: 1, front_agent_queue_timeout: 1 },
    agent_config: { instance_id: 'worker-install-test-agent', roles: [], system_prompt: 'test', model_config: {} },
  }
}

function installParams(operationId = 'op-install') {
  return {
    impl: 'codex' as const,
    operation_id: operationId,
    assertion: 'one-time-assertion',
    expected: { action: 'install', operation_id: operationId, impl: 'codex', mode: 'install', policy_revision: 1 },
  }
}

describe('UnifiedAgent install_worker_implementation', () => {
  let dataDir: string
  let agent: any
  let operations: WorkerOperationStore

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-worker-install-operation-'))
    operations = new WorkerOperationStore(dataDir)
    await operations.load()
    agent = new UnifiedAgent(config()) as any
    agent.adminPort = 19998
    agent.workerOperationStore = operations
    agent.activationRegistry = {
      refreshImpl: vi.fn().mockResolvedValue({ installed: false }),
      refresh: vi.fn().mockResolvedValue(undefined),
    }
    agent.userLevelInstaller = {
      install: vi.fn().mockResolvedValue({ impl: 'codex', version: '0.1.2', binaryPath: '/home/test/.local/bin/codex' }),
      cancelInFlight: vi.fn(),
    }
    agent.rpcClient = { callSensitive: vi.fn().mockResolvedValue({ consumed: true }) }
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('核销精确 install assertion 后安装、刷新 activation registry 并收口 operation', async () => {
    await expect(agent.handleInstallWorkerImplementation(installParams())).resolves.toEqual({
      operation_id: 'op-install', state: 'completed', version: '0.1.2',
    })

    expect(agent.rpcClient.callSensitive).toHaveBeenCalledWith(
      19998,
      'consume_worker_operation_assertion',
      { assertion: 'one-time-assertion', expected: installParams().expected },
      'worker-install-test-agent',
      expect.any(Object),
    )
    expect(agent.userLevelInstaller.install).toHaveBeenCalledWith('codex')
    expect(agent.activationRegistry.refresh).toHaveBeenCalledOnce()
    expect(operations.get('op-install')).toMatchObject({ kind: 'install', state: 'completed', impl: 'codex' })
  })

  it('在核销前拒绝 action、mode 或 revision 绑定错误', async () => {
    const params = installParams()
    params.expected.mode = 'existing_host'
    await expect(agent.handleInstallWorkerImplementation(params)).rejects.toThrow(/assertion binding mismatch/)
    expect(agent.rpcClient.callSensitive).not.toHaveBeenCalled()
    expect(operations.get('op-install')).toBeUndefined()
  })

  it('在首次异步探测期间保留同 implementation 的互斥', async () => {
    let releaseProbe!: (value: { installed: boolean }) => void
    const probeStarted = new Promise<void>((resolve) => {
      agent.activationRegistry.refreshImpl.mockImplementationOnce(() => {
        resolve()
        return new Promise((done) => { releaseProbe = done })
      })
    })

    const first = agent.handleInstallWorkerImplementation(installParams('op-first'))
    await probeStarted
    await expect(agent.handleInstallWorkerImplementation(installParams('op-second'))).rejects.toThrow(/another mutating operation/)
    releaseProbe({ installed: false })
    await expect(first).resolves.toMatchObject({ operation_id: 'op-first', state: 'completed' })
  })

  it('取消在途安装后保持 cancelled，不被安装器失败改写', async () => {
    let rejectInstall!: (error: Error) => void
    const installStarted = new Promise<void>((resolve) => {
      agent.userLevelInstaller.install.mockImplementationOnce(() => new Promise((_, reject) => {
        rejectInstall = reject
        resolve()
      }))
    })
    agent.userLevelInstaller.cancelInFlight.mockImplementation(() => rejectInstall(new Error('cancelled')))

    const running = agent.handleInstallWorkerImplementation(installParams())
    await installStarted
    const cancelled = await agent.handleCancelWorkerOperation({
      operation_id: 'op-install',
      assertion: 'cancel-assertion',
      expected: { action: 'cancel', operation_id: 'op-install', impl: 'codex', mode: 'install', policy_revision: 1 },
    })

    expect(cancelled.operation).toMatchObject({ state: 'cancelled' })
    await expect(running).resolves.toMatchObject({ state: 'cancelled' })
    expect(operations.get('op-install')).toMatchObject({ state: 'cancelled' })
  })
})
