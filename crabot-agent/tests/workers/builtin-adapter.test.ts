import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { BuiltinWorkerAdapter } from '../../src/workers/builtin/adapter.js'
import type { SpawnSpec, IncarnationHandle, WorkerContractState } from '../../src/workers/types.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import * as engineModule from '../../src/engine/query-loop.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

function makeAdapter(
  responses: Array<{
    text?: string
    toolCalls?: Array<{ name: string; id: string; input: Record<string, unknown> }>
    stopReason: 'end_turn' | 'tool_use'
  }>,
): LLMAdapter {
  let i = 0
  return {
    stream: vi.fn(async function* () {
      const r = responses[i++] ?? responses[responses.length - 1]
      const content: unknown[] = []
      if (r.text) content.push({ type: 'text', text: r.text })
      for (const tc of r.toolCalls ?? []) {
        content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input })
      }
      yield* chunksFromContent(content, r.stopReason, { inputTokens: 100, outputTokens: 50 })
    }),
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

function throwingAdapter(): LLMAdapter {
  return {
    stream: vi.fn(async function* () {
      throw new Error('boom')
    }),
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

function spec(opts: { adapter: LLMAdapter; worker_id?: string }): SpawnSpec {
  return {
    worker_id: opts.worker_id ?? randomUUID(),
    prompt: '测试任务',
    workspace: { root: '/tmp/ws' },
    builtin: {
      adapter: opts.adapter,
      model: 'test',
      systemPrompt: '',
      tools: [],
    },
  }
}

async function waitState(
  adapter: BuiltinWorkerAdapter,
  h: IncarnationHandle,
  target: WorkerContractState,
): Promise<void> {
  const deadline = Date.now() + 2000
  let last: WorkerContractState | undefined
  while (Date.now() < deadline) {
    last = await adapter.state(h)
    if (last === target) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`waitState timeout: expected '${target}', last seen '${last}'`)
}

describe('BuiltinWorkerAdapter', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), 'builtin-adapter-'))
  })

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true })
  })

  it('spawn → burst end_turn → idle，输出可增量读', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([{ text: '想了想，先问你：A 还是 B？', stopReason: 'end_turn' }]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    const { chunk } = await adapter.readOutput(h, { offset: 0 })
    expect(chunk).toContain('A 还是 B')
  })

  it('finish_task → exited(completed)', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([
        {
          toolCalls: [{ name: 'finish_task', id: 'call_1', input: { outcome: 'completed', summary: '搞定了' } }],
          stopReason: 'tool_use',
        },
      ]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'exited')

    const metaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta.json'), 'utf-8')
    const meta = JSON.parse(metaRaw)
    expect(meta.state).toBe('exited')
    expect(meta.ended_reason).toBe('completed')
    expect(meta.outcome).toBe('completed')
  })

  it('engine 抛错 → exited(crashed)', async () => {
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({ adapter: throwingAdapter() })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'exited')

    const metaRaw = await fs.readFile(join(tmp, s.worker_id, 'meta.json'), 'utf-8')
    const meta = JSON.parse(metaRaw)
    expect(meta.state).toBe('exited')
    expect(meta.ended_reason).toBe('crashed')
  })

  it('runBurst 传递 disableCompaction: true 到 runEngine', async () => {
    const runEngineSpy = vi.spyOn(engineModule, 'runEngine')
    const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })
    const s = spec({
      adapter: makeAdapter([{ text: '测试输出', stopReason: 'end_turn' }]),
    })

    const h = await adapter.spawn(s)
    await waitState(adapter, h, 'idle')

    expect(runEngineSpy).toHaveBeenCalled()
    const callArgs = runEngineSpy.mock.calls[0]?.[0]
    expect(callArgs?.options?.disableCompaction).toBe(true)
  })
})
