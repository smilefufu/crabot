import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ManagerSessionStore } from '../../src/manager/session-store.js'
import { SessionTree } from '../../src/workers/session-tree.js'
import { resumeManagerMessages, type ManagerResumeCheckpoint } from '../../src/manager/resume-checkpoint.js'
import { ContextManager } from '../../src/engine/context-manager.js'
import { createAdapter, callNonStreaming } from '../../src/engine/llm-adapter.js'
import { createAssistantMessage, createUserMessage, createToolResultMessage, type EngineMessage } from '../../src/engine/types.js'
import { normalizeMessagesForGemini } from '../../src/engine/gemini-adapter.js'

let dir: string | undefined
afterEach(async () => { vi.restoreAllMocks(); if (dir) await rm(dir, { recursive: true, force: true }) })

async function history(): Promise<EngineMessage[]> {
  const parts = [{ text: 'working', thoughtSignature: 'text-signature' }, { functionCall: { name: 'probe', args: {}, id: 'id' }, thoughtSignature: 'tool-signature' }]
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }] })}\n\n`))
  const result = await callNonStreaming(createAdapter({ format: 'gemini', endpoint: 'https://example.test', apikey: 'key' }), {
    model: 'gemini-test', systemPrompt: 'test', messages: [], tools: [{ name: 'probe', description: '', inputSchema: {}, isReadOnly: true, call: async () => ({ output: '', isError: false }) }],
  })
  return [createUserMessage('hello'), { ...createAssistantMessage(result.content, 'tool_use'), providerState: result.providerState }, createToolResultMessage('id', 'actual result', false)]
}

describe('Gemini native history persistence', () => {
  it('preserves parts, signatures and matching results through Manager state and episode JSONL', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gemini-manager-'))
    const messages = await history()
    const store = new ManagerSessionStore(dir)
    const state = { key: 'test::gemini', recent: messages, foldedCount: 0 }
    await store.save(state)
    await store.appendEpisodeLog(state.key, 'episode', messages)
    const loaded = await store.load(state.key)
    expect(normalizeMessagesForGemini(loaded.recent)).toEqual(normalizeMessagesForGemini(messages))
    const lines = (await readFile(join(dir, 'test%3A%3Agemini', 'episodes', 'episode.jsonl'), 'utf8')).trim()
    expect(lines).toContain('tool-signature')
    expect(normalizeMessagesForGemini(lines.split('\n').map(line => JSON.parse(line)))).toEqual(normalizeMessagesForGemini(messages))
    expect(loaded.recent[1]).toEqual(messages[1])
  })

  it('preserves signed assistant state and actual tool results through a saved Manager checkpoint', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gemini-checkpoint-'))
    const messages = await history()
    const store = new ManagerSessionStore(dir)
    const checkpoint: ManagerResumeCheckpoint = {
      episodeId: 'ep', state: { key: 'test::checkpoint', recent: messages, foldedCount: 0 },
      envelopes: [], wakeIndex: -1, pending: [], hasEngineMessages: true, turns: [], responses: [], tools: [], pendingToolCallIds: [], adminChatClaims: [], transientMessageIds: [], spawnedWorkerIds: [],
      execution: { needsSpawnRecheck: false, spawnRecheckInjected: false, spawnRecheckOutcomeRecorded: false, postSendRecheckSequence: 0, successfulSendMessageTargets: [], continuedWorkers: [] },
    }
    await store.save(checkpoint.state)
    store.saveCheckpoint(checkpoint)
    const restored = await store.loadCheckpoint(checkpoint.state.key)
    expect(restored).toBeDefined()
    expect(normalizeMessagesForGemini(resumeManagerMessages(restored!))).toEqual(normalizeMessagesForGemini(messages))
  })

  it('roundtrips signed history through builtin append-only SessionTree without calling a tool again', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gemini-builtin-'))
    const messages = await history()
    const path = join(dir, 'tree.jsonl')
    const tree = new SessionTree(path)
    let tip: string | null = null
    for (const message of messages) tip = await tree.append(tip, message)
    const loaded = await SessionTree.load(path)
    expect(normalizeMessagesForGemini(loaded.pathTo(tip!))).toEqual(normalizeMessagesForGemini(messages))
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('counts native signatures in capacity estimates instead of only visible text', async () => {
    const messages = await history()
    const assistant = messages[1]
    expect(assistant.role).toBe('assistant')
    if (assistant.role !== 'assistant') throw new Error('fixture')
    const context = new ContextManager({ maxContextTokens: 200000 })
    const plain = { ...assistant, providerState: undefined }
    expect(context.estimateMessageTokens(assistant)).toBeGreaterThan(context.estimateMessageTokens(plain))
  })
})
