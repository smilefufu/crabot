import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(path.resolve(import.meta.dirname, '../../package.json'))
const { buildManagerToolFace } = require('./dist/manager/tools/tool-face.js')
const { createCrabMemoryServer } = require('./dist/mcp/crab-memory.js')
const { createGuidanceTool } = require('./dist/guidance/catalog.js')
const { assembleManagerSystemPrompt } = require('./dist/manager/prompt.js')
const { assembleBuiltinWorkerPrompt } = require('./dist/prompts/builtin-worker.js')
const { createExecutionCapabilitiesTool } = require('./dist/manager/tools/execution-capabilities.js')
const { BUILTIN_WORKER_PERMISSIONS } = require('./dist/workers/builtin/runtime.js')
const { StreamProcessor, createUserMessage, createAssistantMessage, createToolResultMessage } = require('./dist/engine/index.js')
const never = async () => { throw new Error('Decision probe cannot execute business operations') }
const transport = { rpcClient: { call: never }, moduleId: 'fixture', getMemoryPort: never }
const face = buildManagerToolFace({
  harness: {}, workerContext: () => ({ managerKey: 'fixture::synthetic' }),
  messagingDeps: { ...transport, getAdminPort: never, resolveChannelPort: never },
  memoryServer: createCrabMemoryServer(transport, { visibility: 'private', scopes: [], isMasterPrivate: false }),
  callAdmin: never, isSystemThread: false, managerTarget: { channel_id: 'fixture', session_id: 'synthetic' },
  workboard: { store: {}, managerKey: 'fixture::synthetic' }, projectDocs: {},
})
const names = new Set(['load_guidance', 'get_execution_capabilities', 'send_message', 'spawn_worker',
  'send_to_worker', 'get_worker_state', 'get_worker_turn', 'get_worker_activity', 'resolve_worker_turn', 'request_worker_stop', 'query_worker'])
const definitions = {
  manager: face.filter(t => names.has(t.name)),
  worker: [...['Read', 'Edit', 'Write', 'Bash'].map(name =>
    require(`./dist/engine/tools/${name.toLowerCase()}-tool.js`)[`create${name}Tool`](() => '/fixture')), createGuidanceTool('worker')],
}
export const publicMessages = messages => messages.map(m => ({ ...m,
  content: Array.isArray(m.content) ? m.content.filter(b => b.type !== 'raw_reasoning') : m.content,
}))

export function decisionCondition(c, variant, baseline) {
  return {
    prompt: variant === 'baseline' ? baseline[c.role] : c.role === 'manager'
      ? assembleManagerSystemPrompt({ managerKey: 'fixture::synthetic', isSystemThread: false,
        ...(c.event ? { guidance: ['manager.worker-events'] } : {}) })
      : assembleBuiltinWorkerPrompt({ workspaceRoot: '/fixture', imageAvailable: false }),
    tools: definitions[c.role].filter(t => variant === 'candidate' || t.name !== 'load_guidance')
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }
}

export async function decisionRead(c, name, input) {
  if (name === 'load_guidance') return createGuidanceTool(c.role).call(input, {})
  if (name === 'get_execution_capabilities') {
    const principal = { ...BUILTIN_WORKER_PERMISSIONS, tool_access: {
      ...BUILTIN_WORKER_PERMISSIONS.tool_access, task: c.task !== false, desktop: c.desktop === true,
    } }
    const deps = {
      workerContext: () => ({ managerKey: 'fixture::synthetic', principalPermissions: principal }),
      workerImplSnapshot: () => ({ statuses: ['builtin', 'claude-code', 'codex'].map(impl => ({ impl, ready: impl === 'builtin' })) }),
      describeExecutionTools: () => ({ tools: ['Read', 'Edit', 'Write', 'Bash'], source: 'current_builtin_assembly',
        observed_at: '2026-09-17T00:00:00Z', mcp_servers: [], limitations: ['人工决策快照，不执行任务。'] }),
      projectDocs: {
        ledger: { findWorker: async id => c.worker?.id === id
          ? { managerKey: 'fixture::synthetic', worker: { incarnations: [{ impl: 'builtin', workspace: '/fixture' }] } } : null },
        readWorkerContext: async () => ({ principal_permissions: principal }),
      },
    }
    return createExecutionCapabilitiesTool(deps).call(input, {})
  }
  if (name === 'get_worker_state' || name === 'get_worker_turn') {
    if (!c.worker || input.worker_id !== c.worker.id) throw new Error(`unsupported_read: ${name}`)
    // These are explicitly artificial observations, not production trace evidence.
    return { isError: false, output: JSON.stringify({ source: 'artificial_decision_snapshot', worker_id: c.worker.id,
      state: 'idle', latest_result: c.worker.result, remaining_execution_permissions: 'sufficient' }) }
  }
  throw new Error(`unsupported_read: ${name}`)
}

export async function runDecision({ c, condition, delegate, model, maxRounds, maxTokens, record }) {
  const messages = [createUserMessage(c.user)]
  const tools = condition.tools.map(t => ({ ...t, call: never }))
  const reads = new Set(['load_guidance', 'get_execution_capabilities', 'get_worker_state', 'get_worker_turn'])
  for (let round = 1; round <= maxRounds; round++) {
    record({ type: 'request', round, messages: publicMessages(messages) })
    const processor = new StreamProcessor()
    try {
      // Direct adapter stream: no consumption retry or hidden supplementary sampling.
      for await (const chunk of delegate.stream({ systemPrompt: condition.prompt, messages, tools, model,
        maxTokens, signal: AbortSignal.timeout(90000) })) processor.process(chunk)
    } catch (error) {
      if (error.code === 'EVAL_BUDGET') {
        record({ type: 'budget_stop', round })
        return { status: 'budget_stop', rounds: round - 1 }
      }
      record({ type: 'missing', round, error: String(error) })
      return { status: 'missing', rounds: round }
    }
    const response = processor.finalize()
    record({ type: 'response', round, text: response.text, tools: response.toolUseBlocks,
      usage: response.usage, stopReason: response.stopReason })
    if (response.stopReason === 'max_tokens') return { status: 'truncated', rounds: round }
    const calls = response.toolUseBlocks
    if (!calls.length) return { status: response.text.trim() ? 'decision_observed' : 'empty', rounds: round }
    if (calls.some(call => !tools.some(t => t.name === call.name))) return { status: 'invalid_tool', rounds: round }
    if (calls.some(call => !reads.has(call.name))) {
      // Record the whole choice, including simultaneous guide reads; execute none of it.
      return { status: 'decision_observed', rounds: round }
    }
    messages.push(createAssistantMessage([
      ...response.reasoningBlocks, ...(response.text ? [{ type: 'text', text: response.text }] : []), ...calls,
    ], response.stopReason, response.usage))
    for (const call of calls) {
      try {
        const result = await decisionRead(c, call.name, call.input)
        record({ type: 'local_read', round, name: call.name, input: call.input, result })
        messages.push(createToolResultMessage(call.id, result.output, result.isError))
      } catch (error) {
        record({ type: 'coverage_gap', round, error: String(error) })
        return { status: 'coverage_gap', rounds: round }
      }
    }
  }
  return { status: 'round_limit', rounds: maxRounds }
}
