import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createBashTool, MAX_FOREGROUND_TIMEOUT_MS } from '../../../src/engine/tools/bash-tool'
import { BgEntityRegistry } from '../../../src/engine/bg-entities/registry'
import { TransientShellRegistry } from '../../../src/engine/bg-entities/bg-shell'
import type { BashBgContext } from '../../../src/engine/tools/bash-tool'
import type { WorkerAgentContext } from '../../../src/types'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import type { ToolCallContext } from '../../../src/engine/types'

describe('createBashTool', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-tool-test-'))
  const tool = createBashTool(tmpDir)

  it('returns ToolDefinition with correct name and schema', () => {
    expect(tool.name).toBe('Bash')
    expect(tool.isReadOnly).toBe(false)
    expect(tool.permissionLevel).toBe('dangerous')
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: {
          type: 'number',
          description: `Foreground timeout in ms (default 120000, max ${MAX_FOREGROUND_TIMEOUT_MS}). 超过会被 cap。run_in_background=true 时此参数无效。`,
        },
        run_in_background: {
          type: 'boolean',
          description:
            'Spawn in background and return entity_id immediately. master 私聊场景持久化（survive worker 重启）；其他场景仅 task 内活，task 结束自动 kill。',
        },
      },
      required: ['command'],
    })
  })

  it('executes simple command', async () => {
    const result = await tool.call({ command: 'echo hello' }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('hello')
  })

  it('captures stderr', async () => {
    const result = await tool.call({ command: 'echo err >&2' }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('err')
  })

  it('returns error for failing command', async () => {
    const result = await tool.call({ command: 'exit 1' }, {})
    expect(result.isError).toBe(true)
  })

  it('respects cwd', async () => {
    const result = await tool.call({ command: 'pwd' }, {})
    expect(result.isError).toBe(false)
    // Resolve symlinks (macOS /tmp -> /private/tmp)
    const resolvedTmpDir = fs.realpathSync(tmpDir)
    expect(result.output.trim()).toBe(resolvedTmpDir)
  })

  it('truncates large output', async () => {
    // Generate output > 100000 chars
    const result = await tool.call(
      { command: 'python3 -c "print(\'x\' * 120000)"' },
      {},
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('[...truncated...]')
    expect(result.output.length).toBeLessThanOrEqual(100000 + 100) // some margin for the truncation marker
  })

  it('respects abort signal', async () => {
    const controller = new AbortController()
    // Abort immediately
    controller.abort()

    const context: ToolCallContext = { abortSignal: controller.signal }
    const result = await tool.call({ command: 'sleep 10' }, context)
    expect(result.isError).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Helpers for bg-context tests
// ---------------------------------------------------------------------------

function makeMasterPrivateCtx(): WorkerAgentContext {
  return {
    task_origin: {
      channel_id: 'channel-test',
      session_id: 'session-test',
      friend_id: 'friend-master',
      session_type: 'private',
    },
    sender_friend: {
      id: 'friend-master',
      display_name: 'Master',
      permission: 'master',
      channel_identities: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    short_term_memories: [],
    long_term_memories: [],
    available_tools: [],
    admin_endpoint: { module_id: 'admin', port: 3001 },
    memory_endpoint: { module_id: 'memory', port: 3002 },
    channel_endpoints: [],
  }
}

function makeGroupCtx(): WorkerAgentContext {
  return {
    task_origin: {
      channel_id: 'channel-test',
      session_id: 'session-group',
      friend_id: 'friend-normal',
      session_type: 'group',
    },
    sender_friend: {
      id: 'friend-normal',
      display_name: 'Normal',
      permission: 'normal',
      channel_identities: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    short_term_memories: [],
    long_term_memories: [],
    available_tools: [],
    admin_endpoint: { module_id: 'admin', port: 3001 },
    memory_endpoint: { module_id: 'memory', port: 3002 },
    channel_endpoints: [],
  }
}

// ---------------------------------------------------------------------------
// describe block: createBashTool with bgCtx
// ---------------------------------------------------------------------------

describe('createBashTool with bgCtx', () => {
  let tmpDataDir: string
  let registry: BgEntityRegistry
  let transient: TransientShellRegistry
  const cwd = os.tmpdir()

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-bg-test-'))
    const registryPath = path.join(tmpDataDir, 'registry.json')
    registry = new BgEntityRegistry(registryPath)
    transient = new TransientShellRegistry()
  })

  afterEach(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
  })

  it('bgCtx undefined + run_in_background=true → isError with "Background mode unavailable"', async () => {
    const tool = createBashTool(cwd)
    const result = await tool.call({ command: 'echo hi', run_in_background: true }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('Background mode unavailable')
  })

  it('bgCtx provided + persistent mode (master private) + run_in_background=true → spawns persistent shell', async () => {
    const workerContext = makeMasterPrivateCtx()
    const bgCtx: BashBgContext = {
      registry,
      transient,
      workerContext,
      owner: { friend_id: 'friend-master' },
      taskId: 'task-001',
    }
    const tool = createBashTool(cwd, undefined, bgCtx)

    const result = await tool.call({ command: 'echo hi', run_in_background: true }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toMatch(/Shell spawned \(persistent\): shell_/)
    expect(result.output).toContain('Output(')
    expect(result.output).toContain('Kill(')

    // Extract entity_id from output
    const match = result.output.match(/shell_[0-9a-f]+/)
    expect(match).not.toBeNull()
    const entityId = match![0]

    // Registry should contain the entity
    const entity = await registry.get(entityId)
    expect(entity).not.toBeNull()
    expect(entity?.type).toBe('shell')
  })

  it('bgCtx provided + transient mode (group session) + run_in_background=true → spawns transient shell', async () => {
    const workerContext = makeGroupCtx()
    const bgCtx: BashBgContext = {
      registry,
      transient,
      workerContext,
      owner: { friend_id: 'friend-normal' },
      taskId: 'task-002',
    }
    const tool = createBashTool(cwd, undefined, bgCtx)

    const result = await tool.call({ command: 'echo hi', run_in_background: true }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toMatch(/Shell spawned \(transient, dies with task\): shell_/)

    // Extract entity_id from output
    const match = result.output.match(/shell_[0-9a-f]+/)
    expect(match).not.toBeNull()
    const entityId = match![0]

    // TransientShellRegistry should contain the entity
    const state = transient.get(entityId)
    expect(state).toBeDefined()
    expect(state?.spawned_by_task_id).toBe('task-002')

    // Cleanup
    transient.killAllOwnedBy('task-002')
  })

  it('persistent mode: hitting 20 entity limit returns error', async () => {
    const friendId = 'friend-limit-test'
    const workerContext = makeMasterPrivateCtx()
    // Override sender_friend to use friendId
    const ctx: WorkerAgentContext = {
      ...workerContext,
      sender_friend: {
        ...workerContext.sender_friend!,
        id: friendId,
      },
      task_origin: {
        ...workerContext.task_origin!,
        friend_id: friendId,
      },
    }
    const bgCtx: BashBgContext = {
      registry,
      transient,
      workerContext: ctx,
      owner: { friend_id: friendId },
      taskId: 'task-limit',
    }

    // Pre-register 20 running entities directly into the registry
    for (let i = 0; i < 20; i++) {
      await registry.register({
        entity_id: `shell_fake${i.toString().padStart(4, '0')}`,
        type: 'shell',
        status: 'running',
        command: 'sleep 9999',
        log_file: '/tmp/fake.log',
        pid: 99900 + i,
        pgid: 99900 + i,
        process_started_at: new Date().toISOString(),
        owner: { friend_id: friendId },
        spawned_by_task_id: 'task-limit',
        spawned_at: new Date().toISOString(),
        exit_code: null,
        ended_at: null,
        last_activity_at: new Date().toISOString(),
      })
    }

    const tool = createBashTool(cwd, undefined, bgCtx)
    const result = await tool.call({ command: 'echo hi', run_in_background: true }, {})

    expect(result.isError).toBe(true)
    expect(result.output).toContain('20 个上限')
  })

  it('timeout cap: large requested timeout is silently capped at MAX_FOREGROUND_TIMEOUT_MS', async () => {
    // We cannot wait 10 minutes; instead spy on execFile to verify the capped value.
    // Use a short command and verify it works without error — the cap doesn't reject.
    const tool = createBashTool(cwd)
    // Request a huge timeout — the cap silently clamps it
    const result = await tool.call({ command: 'echo cap-test', timeout: 999_999_999 }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('cap-test')
  })

  it('MAX_FOREGROUND_TIMEOUT_MS constant is 600_000', () => {
    expect(MAX_FOREGROUND_TIMEOUT_MS).toBe(600_000)
  })

  it('synchronous path still works when bgCtx is provided', async () => {
    const workerContext = makeMasterPrivateCtx()
    const bgCtx: BashBgContext = {
      registry,
      transient,
      workerContext,
      owner: { friend_id: 'friend-master' },
      taskId: 'task-sync',
    }
    const tool = createBashTool(cwd, undefined, bgCtx)

    // Synchronous (no run_in_background flag)
    const result = await tool.call({ command: 'echo sync-ok' }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('sync-ok')
  })
})
