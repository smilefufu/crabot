/**
 * builtin 接入可复用契约套件（见 contract-suite.ts 文件头注释）。mock LLM adapter 按
 * script 顺序回放：'idle' → 纯文本 end_turn；'exit_success'/'exit_failure' → 文本 + 调用
 * builtin 内置的 finish_task 工具（outcome 对应 completed/failed）——与
 * builtin-adapter.test.ts 现有的 mock 模式（makeAdapter + chunksFromContent）同构。
 */
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { vi } from 'vitest'
import { BuiltinWorkerAdapter } from '../../src/workers/builtin/adapter.js'
import type { SpawnSpec, IncarnationHandle, IncarnationRef } from '../../src/workers/types.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter-types.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'
import { runContractSuite, type ScriptStep, type ContractFixture } from './contract-suite.js'

/** 每次 stream() 调用消费 script 里的下一个 step；越界后重放最后一个 step。 */
function scriptedLLMAdapter(script: ScriptStep[]): LLMAdapter {
  let i = 0
  return {
    stream: vi.fn(async function* () {
      const step = script[i] ?? script[script.length - 1]
      const callIndex = i
      i++
      const content: unknown[] = [{ type: 'text', text: step.output }]
      let stopReason: 'end_turn' | 'tool_use' = 'end_turn'
      if (step.then !== 'idle') {
        stopReason = 'tool_use'
        content.push({
          type: 'tool_use',
          id: `call_${callIndex}`,
          name: 'finish_task',
          input: {
            outcome: step.then === 'exit_success' ? 'completed' : 'failed',
            summary: step.output,
          },
        })
      }
      yield* chunksFromContent(content, stopReason, { inputTokens: 10, outputTokens: 10 })
    }),
    updateConfig: () => {},
  } as unknown as LLMAdapter
}

async function makeBuiltinFixture(): Promise<ContractFixture> {
  const tmp = await fs.mkdtemp(join(tmpdir(), 'contract-builtin-'))
  const adapter = new BuiltinWorkerAdapter({ dataDir: tmp })

  const makeSpec = (workerId: string, script: ScriptStep[]): SpawnSpec => ({
    worker_id: workerId,
    prompt: '契约测试任务',
    workspace: { root: '/tmp/ws' },
    builtin: {
      adapter: scriptedLLMAdapter(script),
      model: 'test',
      systemPrompt: '',
      tools: [],
    },
  })

  const refFor = async (h: IncarnationHandle): Promise<IncarnationRef> => {
    const metaRaw = await fs.readFile(join(tmp, h.worker_id, `meta-${h.seq}.json`), 'utf-8')
    const meta = JSON.parse(metaRaw) as { tip_node_id: string }
    return { worker_id: h.worker_id, seq: h.seq, session_ref: meta.tip_node_id }
  }

  const cleanup = async (): Promise<void> => {
    await fs.rm(tmp, { recursive: true, force: true })
  }

  return { adapter, makeSpec, refFor, cleanup }
}

runContractSuite('builtin', makeBuiltinFixture)
