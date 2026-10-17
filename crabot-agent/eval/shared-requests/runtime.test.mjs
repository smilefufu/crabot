import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { cases, runCase } from './runtime.mjs'

async function* response(block, text) {
  yield { type: 'message_start', messageId: Math.random().toString() }
  if (text) yield { type: 'text_delta', text }
  if (block) {
    const id = Math.random().toString()
    yield { type: 'tool_use_start', id, name: block.name }
    yield { type: 'tool_use_delta', id, inputJson: JSON.stringify(block.input) }
    yield { type: 'tool_use_end', id }
  }
  yield { type: 'message_end', stopReason: block ? 'tool_use' : 'end_turn' }
}
function originalSource(params) {
  const text = params.messages.flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).map(block => block.text ?? '')).join('\n')
  const source = text.match(/"source_id"\s*:\s*"([^"]+)"/)?.[1]
  assert.ok(source, 'actual trusted input annotation must be present')
  return source
}

test('offline harness uses actual voice parser and local receipt, no external transport', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b7-harness-'))
  const events = []
  const adapter = {
updateConfig() { }, async *stream() {
      yield { type: 'message_start', messageId: 'scripted' }
      yield { type: 'text_delta', text: '<voice_reply>十五。</voice_reply>' }
      yield { type: 'message_end', stopReason: 'end_turn' }
    }
}
  try {
    const result = await runCase({ scenario: cases[0], root: path.join(root, 'data'), liveAdapter: adapter, model: 'scripted', connection: { endpoint: 'https://example.invalid', apikey: 'not-a-real-key', format: 'openai', model_id: 'scripted' }, record: event => events.push(event), budget: { take: () => true }, timeoutMs: 10000 })
    assert.equal(result.status, 'passed', JSON.stringify(result))
    assert.equal(result.requests, 1)
    assert.ok(result.spoken.some(item => item.event.type === 'reply_end'))
    assert.equal(result.sends.length, 0)
    assert.ok(events.some(item => item.type === 'model_input'))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('offline harness reaches real request-bound builtin Write and trace/receipt lifecycle before live testing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b7-worker-harness-'))
  let shared = 0, request = 0, worker = 0; const events = []

  const adapter = {
updateConfig() { }, async *stream(params) {
      if (params.tools.some(tool => tool.name === 'Write')) {
        yield* response(worker++ === 0 ? { name: 'Write', input: { file_path: path.join(root, 'data', 'owner-files', 'result.txt'), content: 'OWNER_OK' } } : undefined); return
      }
      if (params.systemPrompt.includes('已经由系统固定来源的请求')) {
        yield* response(request++ === 0 ? { name: 'spawn_worker', input: { impl: 'builtin', workspace: path.join(root, 'data', 'owner-files'), title: '合成请求写入核验', prompt: '只使用 Write 在当前工作区创建 result.txt，内容为 OWNER_OK。' } } : undefined); return
      }
      if (!params.tools.some(tool => tool.name === 'execute_request')) { yield* response({ name: 'load_tool_family', input: { family: 'crabot' } }); return }
      if (shared++ === 0) {
        const source = originalSource(params)
        yield* response({ name: 'execute_request', input: { source_id: source, delivery: 'origin' } }); return
      }
      yield* response()
    }
}
  try {
    const scenario = { id: 'offline-write', task: 'write' }
    const result = await runCase({ scenario, root: path.join(root, 'data'), liveAdapter: adapter, model: 'scripted', connection: { endpoint: 'https://example.invalid', apikey: 'not-a-real-key', format: 'openai', model_id: 'scripted' }, record: event => events.push(event), budget: { take: () => true }, timeoutMs: 15000 })
    assert.equal(result.values.output, 'OWNER_OK', JSON.stringify(result))
    assert.equal(result.checks.worker_reached, true)
    assert.ok(result.worker_records.every(item => item.bound.author === 'f-owner'))
    assert.ok(events.some(event => event.type === 'worker_tool_lifecycle' && event.event.name === 'Write'))
    assert.ok(result.worker_records.every(item => item.turns.length > 0), 'actual durable Worker completion receipt must exist')
    assert.ok(result.worker_records.every(item => item.turns.every(turn => turn.activity_through !== turn.activity_from)), 'receipt must cover actual activity')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})


test('production runtime verifies the omitted default root and executes file tools there', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b7-default-harness-'))
  let shared = 0, request = 0, worker = 0
  const before = process.env.WORKER_WORKSPACES_DIR
  process.env.WORKER_WORKSPACES_DIR = path.join(root, 'must-not-be-used')
  const adapter = { updateConfig() { }, async *stream(params) {
    if (params.tools.some(tool => tool.name === 'Write')) {
      const [id] = await fs.readdir(path.join(root, 'data', 'workspaces'))
      const file = path.join(root, 'data', 'workspaces', id, 'result.txt')
      yield* response(worker++ === 0 ? { name: 'Write', input: { file_path: file, content: 'DEFAULT_OK' } } : undefined); return
    }
    if (params.systemPrompt.includes('已经由系统固定来源的请求')) {
      yield* response(request++ === 0 ? { name: 'spawn_worker', input: { impl: 'builtin', title: '默认目录实际写入', prompt: '在自己的默认目录写入 result.txt。' } } : undefined); return
    }
    if (!params.tools.some(tool => tool.name === 'execute_request')) { yield* response({ name: 'load_tool_family', input: { family: 'crabot' } }); return }
    yield* response(shared++ === 0 ? { name: 'execute_request', input: { source_id: originalSource(params), delivery: 'origin' } } : undefined)
  } }
  try {
    const result = await runCase({ scenario: { id: 'offline-default', task: 'read' }, root: path.join(root, 'data'), liveAdapter: adapter, model: 'scripted', connection: { endpoint: 'https://example.invalid', apikey: 'not-a-real-key', format: 'openai', model_id: 'scripted' }, record() {}, budget: { take: () => true }, timeoutMs: 15000 })
    assert.equal(result.status, 'passed', JSON.stringify(result))
    assert.equal(result.worker_records.length, 1)
    const workspace = result.worker_records[0].worker.incarnations[0].workspace
    assert.equal(await fs.readFile(path.join(workspace, 'result.txt'), 'utf8'), 'DEFAULT_OK')
    assert.equal(result.worker_records[0].bound.author, 'f-owner')
    assert.equal(process.env.WORKER_WORKSPACES_DIR, path.join(root, 'must-not-be-used'))
    await assert.rejects(fs.stat(path.join(root, 'must-not-be-used')))
  } finally {
    if (before === undefined) delete process.env.WORKER_WORKSPACES_DIR; else process.env.WORKER_WORKSPACES_DIR = before
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('offline harness discovers personal MCP through production search and executes via request scope', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b7-mcp-harness-'))
  let shared = 0, request = 0; const events = []

  const adapter = {
updateConfig() { }, async *stream(params) {
      if (params.systemPrompt.includes('已经由系统固定来源的请求')) {
        if (request++ === 0) { yield* response({ name: 'search_tools', input: { query: '+mcp__b7__read_document' } }); return }
        if (request === 2) {
          assert.ok(params.tools.some(tool => tool.name === 'mcp__b7__read_document'), 'personal MCP must be visible on next turn after actual search')
          yield* response({ name: 'mcp__b7__read_document', input: { document_id: 'doc-fixture' } }); return
        }
        yield* response(); return
      }
      if (!params.tools.some(tool => tool.name === 'execute_request')) { yield* response({ name: 'load_tool_family', input: { family: 'crabot' } }); return }
      if (shared++ === 0) {
        const source = originalSource(params)
        yield* response({ name: 'execute_request', input: { source_id: source, delivery: 'origin' } }); return
      }
      yield* response()
    }
}
  try {
    const result = await runCase({ scenario: { id: 'offline-mcp', task: 'read' }, root: path.join(root, 'data'), liveAdapter: adapter, model: 'scripted', connection: { endpoint: 'https://example.invalid', apikey: 'not-a-real-key', format: 'openai', model_id: 'scripted' }, record: event => events.push(event), budget: { take: () => true }, timeoutMs: 15000 })
    assert.ok(events.some(event => event.type === 'controlled_mcp_result'), JSON.stringify(result))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})


test('budget exhaustion is inconclusive and never accepted as a passing empty reply', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b7-budget-'))
  const adapter = { updateConfig() { }, async *stream() { throw new Error('provider must not be called') } }
  try {
    const result = await runCase({ scenario: cases[0], root: path.join(root, 'data'), liveAdapter: adapter, model: 'scripted', connection: { endpoint: 'https://example.invalid', apikey: 'not-a-real-key', format: 'openai', model_id: 'scripted' }, record: () => { }, budget: { take: () => false }, timeoutMs: 10000 })
    assert.equal(result.status, 'inconclusive')
    assert.equal(result.fatal, 'B7_BUDGET_EXHAUSTED')
    assert.equal(result.requests, 0)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})


test('offline personal voice Worker reports once after the original reply closes, with its original request binding', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'b7-voice-completion-'))
  let shared = 0, personal = 0, worker = 0
  const events = []
  const adapter = { updateConfig() {}, async *stream(params) {
    const body = JSON.stringify(params.messages)
    if (params.tools.some(tool => tool.name === 'Read')) {
      if (worker++ === 0) yield* response({ name: 'Read', input: { file_path: path.join(root, 'data', 'owner-files', 'README.md') } })
      else yield* response(undefined, '验证码是' + body.match(/B7_PRIVATE_[0-9a-f]{8}/)?.[0])
      return
    }
    if (params.systemPrompt.includes('已经由系统固定来源的请求')) {
      if (personal++ === 0) yield* response({ name: 'spawn_worker', input: { impl: 'builtin', title: '读取资料', prompt: '读取用户授权 README.md 中的验证码。' } }, '<voice_reply>好，我帮你看看。</voice_reply>')
      else if (body.includes('turn_completed')) yield* response(undefined, '<voice_reply>刚才你让我查的验证码是' + body.match(/B7_PRIVATE_[0-9a-f]{8}/)?.[0] + '。</voice_reply>')
      else yield* response()
      return
    }
    if (!params.tools.some(tool => tool.name === 'execute_request')) { yield* response({ name: 'load_tool_family', input: { family: 'crabot' } }); return }
    yield* response(shared++ === 0 ? { name: 'execute_request', input: { source_id: originalSource(params), delivery: 'origin' } } : undefined)
  } }
  try {
    const result = await runCase({ scenario: { id: 'offline-personal-voice-completion', voice: true, task: 'read' }, root: path.join(root, 'data'), liveAdapter: adapter, model: 'scripted', connection: { endpoint: 'https://example.invalid', apikey: 'not-a-real-key', format: 'openai', model_id: 'scripted' }, record: event => events.push(event), budget: { take: () => true }, timeoutMs: 15000 })
    assert.equal(result.status, 'passed', JSON.stringify(result))
    assert.equal(result.worker_records.length, 1)
    assert.equal(worker, 2)
    const completed = result.spoken.filter(item => item.event.type === 'reply_text' && item.event.text.includes('B7_PRIVATE_'))
    assert.equal(completed.length, 1)
    assert.equal(completed[0].delivery_context.kind, 'notification')
    assert.equal(completed[0].delivery_context.binding.worker_id, result.worker_records[0].worker.worker_id)
    assert.equal(completed[0].delivery_context.binding.request_id, result.worker_records[0].bound.request.request_id)
    assert.ok(events.some(event => event.type === 'synthetic_voice_output' && event.params.event.type === 'response_end'))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
