import path from 'node:path'
import { createRequire } from 'node:module'

export const permissions = {
  tool_access: Object.fromEntries(['memory','messaging','task','mcp_skill','file_io','browser','shell','remote_exec','desktop'].map(k => [k, true])),
  cli_access: Object.fromEntries(['provider','agent','mcp','skill','schedule','channel','friend','permission','config','undo'].map(k => [k, 'write'])),
  storage: null, memory_scopes: [],
}
const forbidden = async () => { throw new Error('Replay must never execute business operations') }
export function assembly(root, external = false) {
  const require = createRequire(path.join(root, 'crabot-agent/package.json'))
  const { buildManagerToolFace } = require('./dist/manager/tools/tool-face.js')
  const { createManagerToolFaceState, serializedToolSetBytes } = require('./dist/manager/tools/tool-catalog.js')
  const { createCrabMemoryServer } = require('./dist/mcp/crab-memory.js')
  const state = createManagerToolFaceState('progressive')
  const transport = { rpcClient: { call: forbidden }, moduleId: 'fixture', getMemoryPort: forbidden }
  const externalMcpTools = external ? ['blue','green','red','orange','violet','black','white'].map(color => ({
    name: `mcp__archive__read_${color}`, description: `读取 ${color} 文档的正文。Read the ${color} document.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }, category: 'mcp_skill',
    searchMetadata: { namespace: 'mcp__archive', namespaceDescription: 'Archive 文档归档服务' },
    isReadOnly: false, call: forbidden,
  })) : []
  const deps = {
    harness: {}, workerContext: () => ({ managerKey: 'fixture::synthetic', principalPermissions: permissions }),
    messagingDeps: { ...transport, getAdminPort: forbidden, resolveChannelPort: forbidden, enableFeishuDocTool: true },
    memoryServer: createCrabMemoryServer(transport, { visibility: 'private', scopes: [], isMasterPrivate: false }),
    callAdmin: forbidden, isSystemThread: false, managerTarget: { channel_id: 'fixture', session_id: 'synthetic' },
    workboard: { store: {}, managerKey: 'fixture::synthetic' }, projectDocs: {},
    candidatePermissions: permissions, faceState: state,
    schedule: { targetSession: { channel_id: 'fixture', session_id: 'synthetic', type: 'private' },
      creatorFriendId: 'fixture-user', canCreate: true, resolvePermissions: async () => permissions },
    externalMcpTools, authorizeExternalMcpTool: async () => true,
  }
  return { state, tools: () => buildManagerToolFace(deps), bytes: serializedToolSetBytes,
    prompt: require('./dist/manager/prompt.js').assembleManagerSystemPrompt({ managerKey: 'fixture::synthetic', isSystemThread: false }),
    engine: require('./dist/engine/index.js'),
    adapter: config => require('./dist/engine/llm-adapter.js').createAdapter(config),
  }
}
const m = name => `mcp__crab-memory__${name}`
export const cases = [
  { id: 'memory-single', family: 'memory', user: '读取记忆 mem-fixture 的完整内容，告诉我它记了什么。',
    targets: [m('get_memory_detail')], queries: ['读取指定记忆详情'] },
  { id: 'memory-three', family: 'memory', user: '请先读取 mem-fixture 的全文；然后把它的 brief 改为“通用代码审查约定”；最后为它增补一条到 mem-peer 的 related 关系，保留已有关系。',
    targets: [m('get_memory_detail'),m('update_long_term'),m('set_memory_links')], queries: ['读取指定记忆详情','更新长期记忆','设置记忆关联'] },
  { id: 'schedule-two', family: 'schedule', user: '先读取定时任务 sch-fixture 的当前设置，再把它的名称改成“每日项目检查”。',
    targets: ['get_schedule','update_schedule'], queries: ['读取一个定时任务详情','修改定时任务时间'] },
  { id: 'messaging-single', family: 'messaging', user: '查一下当前会话最近 5 条聊天记录，告诉我上一条约定是什么。',
    targets: ['get_history'], queries: ['读取聊天历史记录'] },
  { id: 'mcp-absent', family: 'crabot', user: '安装并注册 MCP server 到当前 agent 运行环境，服务用 npm 包 @example/archive-server。',
    targets: ['spawn_worker'], queries: ['安装并注册 MCP server 到当前 agent 运行环境','添加配置 MCP server 到当前 agent 运行时','crabot-cli 添加 MCP server 配置 注册 重启','管理 Crabot MCP 服务器资源 add mcp server'], negative: true },
  { id: 'web-absent', family: 'messaging', user: '读取网页 GitHub README 和 TradingView MCP 文档，概括接入方法。目标是 https://github.com/example/archive-server 的公开 README。',
    targets: ['spawn_worker'], queries: ['读取网页 GitHub README 和 TradingView MCP 文档'], negative: true },
  { id: 'external-two', family: 'mcp__archive', external: true, user: '使用已连接的 archive 服务，分别读取 blue 和 green 文档。',
    targets: ['mcp__archive__read_blue','mcp__archive__read_green'], queries: ['mcp__archive__read_blue','mcp__archive__read_green'] },
]

export function simulatedResult(name, input) {
  if (name === m('get_memory_detail')) return { id: input.memory_id, brief: '审查约定', body: '提交改动前检查正确性与验证证据。', frontmatter: { links: [] } }
  if (name === 'get_schedule') return { id: 'sch-fixture', name: '原检查任务', target_session: { channel_id: 'fixture', session_id: 'synthetic', type: 'private' }, task_template: { description: '检查项目进度' }, schedule: { cron: '0 9 * * *' } }
  if (name === 'get_history') return { messages: [{ role: 'user', content: '约定先运行定向测试再提交。' }], has_more: false }
  if (name === 'inspect_crabot') return { deployment: 'synthetic', capabilities: { builtin_worker: true }, mcp_servers: [], note: '主控没有直接安装或修改 MCP 配置的业务工具，可委派执行器操作。' }
  if (name === 'get_execution_capabilities') return { source: 'synthetic', tools: ['Bash','Read','Write'], worker_implementations: [{ impl: 'builtin', ready: true, enabled: true }], limitations: [] }
  return { ok: true, source: 'simulated-business-result' }
}
