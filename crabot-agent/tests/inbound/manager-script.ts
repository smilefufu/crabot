/**
 * 入站测试网 cutover 后的共用脚本件（P7 / PR J Task 5）。
 *
 * cutover 之后入站链路的下游是 **manager episode**：真实 `ManagerRegistry` + 真实
 * `ManagerPrincipalStore` + 真实工具面（crab-messaging / crab-memory / worker 编排）。
 * 唯一需要替身的是 LLM 本身——所以这里只提供那一个替身，其余一律用真件。
 *
 * 注入方式与 PR A 时期 mock `dispatch()` 同理：`adapterFromSdkEnv` 是模块级函数、
 * 没有实例注入口，各测试文件用 `vi.mock('../../src/agent/agent-handler.js')` 把它换成
 * 本文件造出来的脚本 adapter。
 */
import type { LLMAdapter, LLMStreamParams } from '../../src/engine/index.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'

/** 一个 turn 的 content blocks（`{type:'text'|'tool_use', ...}`）。 */
export type ScriptedTurn = ReadonlyArray<Record<string, unknown>>

export interface ManagerScript {
  readonly adapter: LLMAdapter
  /** 每次 `stream()` 收到的入参（systemPrompt / messages / tools）——prompt 装配的断言口。 */
  readonly streams: LLMStreamParams[]
}

/**
 * 按脚本吐 content block 的 manager LLM。
 *
 * 脚本用完之后一律 `end_turn`，所以"沉默"就是空脚本（`makeManagerScript([])`）——
 * 与 v2 的 `stay_silent` 动作等价：manager 一句话都不说。
 */
export function makeManagerScript(turns: ReadonlyArray<ScriptedTurn> = []): ManagerScript {
  const streams: LLMStreamParams[] = []
  let cursor = 0
  const adapter: LLMAdapter = {
    async *stream(params: LLMStreamParams) {
      streams.push(params)
      const content = turns[cursor] ?? [{ type: 'text', text: '(本轮无需动作)' }]
      cursor += 1
      const hasTool = content.some((b) => b.type === 'tool_use')
      yield* chunksFromContent(content, hasTool ? 'tool_use' : 'end_turn', { inputTokens: 10, outputTokens: 5 })
    },
    updateConfig: () => {},
  }
  return { adapter, streams }
}

/**
 * manager「跟人说话」的最小脚本块。
 *
 * 用真的 `tool_use` 而不是在 `stream()` 里直接调 `tool.call()`：
 * `EpisodeResult.repliedToHuman` 是扫 `finalMessages` 里的 tool_use 块推出来的，
 * 绕过这一层就测不到退避反馈那条链。
 */
export function sendMessageBlock(p: {
  channelId: string
  sessionId: string
  text: string
  id?: string
}): Record<string, unknown> {
  return {
    type: 'tool_use',
    id: p.id ?? 'tu-send-1',
    name: 'send_message',
    input: { channel_id: p.channelId, session_id: p.sessionId, content: p.text },
  }
}

/**
 * manager 派一个 worker（权限身份的断言口：`SpawnWorkerParams.principal_permissions` 是
 * "manager 算好的档位随 spawn 下传"这条链的落点，PR #59 review）。
 */
export function spawnWorkerBlock(p: { title?: string; prompt?: string; id?: string } = {}): Record<string, unknown> {
  return {
    type: 'tool_use',
    id: p.id ?? 'tu-spawn-1',
    name: 'spawn_worker',
    input: { title: p.title ?? '干活', prompt: p.prompt ?? '把活干完' },
  }
}

/** manager 读一次短期记忆（记忆可见范围的断言口：落到 memory 模块的 `search_short_term`）。 */
export function searchMemoryBlock(id = 'tu-mem-1'): Record<string, unknown> {
  return {
    type: 'tool_use',
    id,
    name: 'mcp__crab-memory__search_memory',
    input: { query: '上次说的那件事', level: 'short_term', limit: 5 },
  }
}
