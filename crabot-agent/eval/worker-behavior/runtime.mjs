import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'

export const repo = path.resolve(import.meta.dirname, '../../..')
export const requireAgent = createRequire(path.join(repo, 'crabot-agent/package.json'))
const ts = requireAgent('typescript')
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')
export const never = async () => { throw new Error('Replay tools cannot execute') }

export function toolResultMessage(receipts) {
  return requireAgent('./dist/engine/types.js').createBatchToolResultMessage(receipts.map(r => ({
    tool_use_id: r.tool_use_id, content: r.output, is_error: r.isError,
  })))
}

export function source(relative, variant) {
  return variant === 'baseline'
    ? execFileSync('git', ['show', `07872f60:${relative}`], { cwd: repo, encoding: 'utf8' })
    : fs.readFileSync(path.join(repo, relative), 'utf8')
}

export function load(relative, variant = 'candidate') {
  const code = ts.transpileModule(source(relative, variant), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  const module = { exports: {} }
  const localRequire = createRequire(path.join(repo, relative.replace('/src/', '/dist/').replace(/\.ts$/, '.js')))
  const resolve = name => name === './daily-reflection-prompt.js'
    ? load('crabot-agent/src/manager/daily-reflection-prompt.ts', variant)
    : localRequire(name)
  vm.runInNewContext('(function(require,module,exports){' + code + '\n})', {})(resolve, module, module.exports)
  return module.exports
}

export function idlePrompt(variant) {
  const file = 'crabot-agent/src/manager/loop.ts'
  const ast = ts.createSourceFile(file, source(file, variant), ts.ScriptTarget.Latest, true)
  let value
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'WORKBOARD_IDLE_REVIEW_PROMPT') {
      assert(ts.isNoSubstitutionTemplateLiteral(node.initializer))
      value = node.initializer.text
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert(value)
  return value
}

export function skill(variant = 'candidate') {
  return source('crabot-admin/builtin-skills/workspace-context-maintenance/SKILL.md', variant)
}

export function promptFor(role, variant, workspace = '/workspace') {
  if (role.startsWith('worker')) {
    return load('crabot-agent/src/prompts/builtin-worker.ts', variant).assembleBuiltinWorkerPrompt({
      workspaceRoot: workspace, imageAvailable: false,
      skillListing: '<available_skills><skill><name>workspace-context-maintenance</name><description>按任务读取和维护项目文档，遵循项目约定</description></skill></available_skills>',
    })
  }
  return load('crabot-agent/src/manager/prompt.ts', variant).assembleManagerSystemPrompt({
    managerKey: 'bot-2::2eais6e9', isSystemThread: false,
  })
}

export function toolDefinitions(role, workspace = '/workspace') {
  let tools
  if (role.startsWith('worker')) {
    tools = ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'].map(name =>
      requireAgent(`./dist/engine/tools/${name.toLowerCase()}-tool.js`)[`create${name}Tool`](() => workspace))
    tools.push(requireAgent('./dist/engine/tools/skill-tool.js').createSkillTool({ availableSkills: [] }))
    tools.push(requireAgent('./dist/agent/delegate-task-tool.js').createDelegateTaskTool({
      subAgents: [{ name: 'code_writer', description: '编码实现', when_to_use: '需要委派实现时' }], runSubAgent: never,
    }))
    tools.push({ name: 'finish_task', description: '完成或确认失败时报告实际结果。', inputSchema: {
      type: 'object', properties: { outcome: { type: 'string', enum: ['completed', 'failed'] }, summary: { type: 'string' } }, required: ['outcome', 'summary'],
    } })
  } else {
    const deps = { rpcClient: { call: never }, moduleId: 'replay', getMemoryPort: never }
    const memoryServer = requireAgent('./dist/mcp/crab-memory.js').createCrabMemoryServer(deps, { visibility: 'private', scopes: [], isMasterPrivate: false })
    tools = requireAgent('./dist/manager/tools/tool-face.js').buildManagerToolFace({
      harness: {}, workerContext: () => ({ managerKey: 'bot-2::2eais6e9' }),
      messagingDeps: { ...deps, getAdminPort: never, resolveChannelPort: never }, memoryServer,
      callAdmin: never, isSystemThread: false, managerTarget: { channel_id: 'bot-2', session_id: '2eais6e9' },
      workboard: { store: {}, managerKey: 'bot-2::2eais6e9' }, projectDocs: {},
    })
  }
  return tools.map(({ name, description, inputSchema, isReadOnly }) => ({ name, description, inputSchema, isReadOnly }))
}

export async function connection() {
  const data = process.env.REPLAY_DATA_DIR
  const runtime = process.env.REPLAY_RUNTIME_ROOT
  assert(data && runtime, 'REPLAY_DATA_DIR and REPLAY_RUNTIME_ROOT required')
  const adminRequire = createRequire(path.join(runtime, 'crabot-admin/package.json'))
  const { ModelProviderManager } = adminRequire('./dist/model-provider-manager.js')
  const config = JSON.parse(fs.readFileSync(path.join(data, 'admin/agent-configs/crabot-agent.json'), 'utf8'))
  const ref = config.model_config.powerful
  const manager = new ModelProviderManager(path.join(data, 'admin'))
  await manager.initialize()
  const conn = await manager.buildConnectionInfo(ref.provider_id, ref.model_id)
  assert.equal(conn.endpoint.replace(/\/$/, ''), 'https://mirror.xinshu.ai/v1')
  assert.equal(conn.model_id, 'gpt-6-astra')
  assert.equal(conn.format, 'openai')
  return conn
}

export async function generate(condition, conn) {
  const { OpenAIAdapter } = requireAgent('./dist/engine/openai-adapter.js')
  const { StreamProcessor } = requireAgent('./dist/engine/stream-processor.js')
  const processor = new StreamProcessor()
  const adapter = new OpenAIAdapter({ endpoint: conn.endpoint, apikey: conn.apikey })
  const started = Date.now()
  try {
    for await (const chunk of adapter.stream({
      model: conn.model_id, systemPrompt: condition.prompt, messages: condition.messages,
      tools: condition.tools.map(t => ({ ...t, call: never })), maxTokens: 6000,
      signal: AbortSignal.timeout(180000),
    })) {
      processor.process(chunk)
      if (chunk.type === 'error') throw new Error(chunk.error)
    }
    const response = processor.finalize()
    return { status: 'response', elapsed_ms: Date.now() - started, response: {
      text: response.text, stopReason: response.stopReason, toolUseBlocks: response.toolUseBlocks,
    } }
  } catch (error) {
    return { status: 'missing', elapsed_ms: Date.now() - started, error: String(error.message).replaceAll(conn.apikey, '[REDACTED]') }
  }
}
