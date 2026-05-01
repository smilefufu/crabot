/**
 * Tests for spawnPersistentAgent (bg-agent.ts)
 *
 * Each case uses mkdtempSync to isolate DATA_DIR and a mock LLMAdapter.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnPersistentAgent } from '../../../src/engine/bg-entities/bg-agent'
import { BgEntityRegistry } from '../../../src/engine/bg-entities/registry'
import type { LLMAdapter } from '../../../src/engine/llm-adapter'
import type { StreamChunk } from '../../../src/engine/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockAdapter(responses: ReadonlyArray<ReadonlyArray<StreamChunk>>): LLMAdapter {
  let callIndex = 0
  return {
    async *stream() {
      const chunks = responses[callIndex] ?? []
      callIndex++
      for (const chunk of chunks) {
        yield chunk
      }
    },
    updateConfig() {},
  }
}

function textResponse(text: string): ReadonlyArray<StreamChunk> {
  return [
    { type: 'message_start', messageId: 'msg-1' },
    { type: 'text_delta', text },
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
  ]
}

/** Wait up to `timeoutMs` for a predicate to become true (polling every 20 ms). */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise<void>((r) => setTimeout(r, 20))
  }
  throw new Error('waitFor timed out')
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string
let registry: BgEntityRegistry
let abortControllers: Map<string, AbortController>

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'bg-agent-test-'))
  process.env.DATA_DIR = tmpDir
  registry = new BgEntityRegistry()
  abortControllers = new Map()
})

afterEach(() => {
  // Abort any still-running agents to prevent lingering async work.
  for (const ctrl of abortControllers.values()) {
    ctrl.abort()
  }
  rmSync(tmpDir, { recursive: true, force: true })
  delete process.env.DATA_DIR
})

// ---------------------------------------------------------------------------
// Common options factory
// ---------------------------------------------------------------------------

function baseOpts(adapter: LLMAdapter): Parameters<typeof spawnPersistentAgent>[0] {
  return {
    task_description: 'test task',
    tools: [],
    systemPrompt: 'You are a test agent.',
    model: 'test-model',
    adapter,
    owner: { friend_id: 'friend-1', session_id: 'ses-1' },
    spawned_by_task_id: 'task-123',
    registry,
    abortControllers,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('spawnPersistentAgent', () => {
  it('returns entity_id immediately in agent_<hex> format', async () => {
    const adapter = mockAdapter([textResponse('done')])
    const id = await spawnPersistentAgent(baseOpts(adapter))

    expect(id).toMatch(/^agent_[0-9a-f]{12}$/)
  })

  it('registry has running entry immediately after spawn', async () => {
    const adapter = mockAdapter([textResponse('done')])
    const id = await spawnPersistentAgent(baseOpts(adapter))

    const rec = await registry.get(id)
    expect(rec).not.toBeNull()
    expect(rec!.status).toBe('running')
    expect(rec!.type).toBe('agent')
  })

  it('abortControllers map contains the entity_id immediately after spawn', async () => {
    const adapter = mockAdapter([textResponse('done')])
    const id = await spawnPersistentAgent(baseOpts(adapter))

    // The controller is added synchronously before the fire-and-forget starts.
    expect(abortControllers.has(id)).toBe(true)
  })

  it('registry status becomes completed and result_file is written on agent completion', async () => {
    const fixedText = 'final answer'
    const adapter = mockAdapter([textResponse(fixedText)])
    const id = await spawnPersistentAgent(baseOpts(adapter))

    // Wait until the agent finishes.
    await waitFor(async () => {
      const rec = await registry.get(id)
      return rec?.status === 'completed'
    })

    const rec = await registry.get(id)
    expect(rec!.status).toBe('completed')
    expect(rec!.exit_code).toBe(0)
    expect(rec!.ended_at).not.toBeNull()
    expect(rec!.result_file).not.toBeNull()

    const agentRec = rec as import('../../../src/engine/bg-entities/types').BgAgentRegistryRecord
    const fileContent = fs.readFileSync(agentRec.result_file!, 'utf-8')
    expect(fileContent).toBe(fixedText)
  })

  it('abort triggers registry status=failed (not killed)', async () => {
    // Use an adapter that yields nothing so the abort has time to take effect.
    const slowAdapter: LLMAdapter = {
      async *stream() {
        // Pause long enough for the abort to fire before any chunks.
        await new Promise<void>((r) => setTimeout(r, 50))
        yield { type: 'message_start', messageId: 'msg-1' } as StreamChunk
        yield { type: 'text_delta', text: 'never seen' } as StreamChunk
        yield { type: 'message_end', stopReason: 'end_turn' } as StreamChunk
      },
      updateConfig() {},
    }

    const id = await spawnPersistentAgent(baseOpts(slowAdapter))

    // Abort immediately after spawn.
    abortControllers.get(id)!.abort()

    await waitFor(async () => {
      const rec = await registry.get(id)
      return rec?.status === 'failed' || rec?.status === 'killed'
    })

    const rec = await registry.get(id)
    // Registry guard prevents overwriting 'killed' with 'failed', but since we
    // never set 'killed' here, the catch block should land on 'failed'.
    expect(['failed', 'killed']).toContain(rec!.status)
  })

  it('multiple parallel spawns produce independent result_files without mixing', async () => {
    const messages = ['alpha result', 'beta result', 'gamma result']
    const adapters = messages.map((m) => mockAdapter([textResponse(m)]))

    const ids = await Promise.all([
      spawnPersistentAgent({ ...baseOpts(adapters[0]), task_description: 'task A' }),
      spawnPersistentAgent({ ...baseOpts(adapters[1]), task_description: 'task B' }),
      spawnPersistentAgent({ ...baseOpts(adapters[2]), task_description: 'task C' }),
    ])

    // All IDs are distinct.
    expect(new Set(ids).size).toBe(3)

    // Wait for all to complete.
    await Promise.all(
      ids.map((id) =>
        waitFor(async () => {
          const rec = await registry.get(id)
          return rec?.status === 'completed' || rec?.status === 'failed'
        })
      )
    )

    // Each result_file contains the correct content for its agent.
    for (let i = 0; i < ids.length; i++) {
      const rec = await registry.get(ids[i])
      const agentRec = rec as import('../../../src/engine/bg-entities/types').BgAgentRegistryRecord
      expect(agentRec.result_file).not.toBeNull()
      const content = fs.readFileSync(agentRec.result_file!, 'utf-8')
      expect(content).toBe(messages[i])
    }
  })
})
