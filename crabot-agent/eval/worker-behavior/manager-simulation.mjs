import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { requireAgent } from './runtime.mjs'

const key = 'bot-2::2eais6e9'
const target = { channel_id: 'bot-2', session_id: '2eais6e9' }
const timestamp = '2026-09-13T00:00:00.000Z'
const ok = value => ({ output: JSON.stringify(value), isError: false })
const permissions = { tool_access: { file_io: true }, storage: null, memory_scopes: [] }

// Production tool validation/projection around scripted external Worker events.
// A scripted completion is not evidence that the dispatched prose can execute.
export async function createManagerSimulation(scenario) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-manager-replay-'))
  const workspace = path.join(root, 'project')
  const { buildWorkerTools } = requireAgent('./dist/manager/tools/worker-tools.js')
  const { buildWorkboardTools } = requireAgent('./dist/manager/tools/workboard-tools.js')
  const { buildProjectDocTools } = requireAgent('./dist/manager/tools/project-doc-tools.js')
  const { ManagerWorkboardStore } = requireAgent('./dist/manager/workboard-store.js')
  const { WorkerTurnStore } = requireAgent('./dist/workers/harness/worker-turn-store.js')
  const { projectWorkerActivity } = requireAgent('./dist/workers/trace/activity-projection.js')
  const { WorkspaceGitInspector } = requireAgent('./dist/workers/harness/workspace-git-inspector.js')
  const { createCrabMemoryServer } = requireAgent('./dist/mcp/crab-memory.js')
  const { mcpServerToToolDefinitions } = requireAgent('./dist/agent/mcp-tool-bridge.js')
  const git = new WorkspaceGitInspector()
  let gitBaseline
  const board = new ManagerWorkboardStore(path.join(root, 'managers'), () => timestamp)
  const turns = new WorkerTurnStore(path.join(root, 'workers'))
  const state = { workers: {}, dispatched: [], reported: [], unsupported: [], violations: [], operations: [],
    events: [], observations: [], boardChanges: [], memoryQueries: [], tick: 0, outcome: null }
  const memory = createCrabMemoryServer({ moduleId: 'isolated-replay', getMemoryPort: async () => 0,
    rpcClient: { call: async (_port, method, input) => {
      if (!['search_short_term', 'search_long_term', 'list_entries'].includes(method)) throw new Error(`Unsupported fixture RPC: ${method}`)
      state.memoryQueries.push({ method, input })
      return method === 'list_entries' ? { items: [], total: 0 } : { results: [] }
    } },
  }, { visibility: 'private', scopes: [], isMasterPrivate: false })
  const queue = []
  const activity = {}
  const queries = {}
  const continued = new Set()
  let serial = 0
  const visible = value => JSON.stringify(value).replaceAll(root, '/replay').replaceAll('/replay/project', '/workspace')
  const worker = id => {
    if (!state.workers[id]) throw new Error(`Worker not found: ${id}`)
    return state.workers[id]
  }
  const incarnation = w => w.incarnations[0]
  const snapshot = w => structuredClone(w)
  function addWorker(id, status, params = {}) {
    const w = { worker_id: id, manager_key: key, task: { id, title: params.title ?? '报告运行', status, created_at: timestamp },
      origin: params.origin ?? { trigger_type: 'message' }, report_to: target,
      incarnations: [{ incarnation_id: `${id}-inc`, seq: 1, impl: params.impl ?? 'builtin',
        state: status === 'halted' ? 'idle' : 'running', workspace, session_ref: `${id}-session`, started_at: timestamp }], updated_at: timestamp }
    state.workers[id] = w
    activity[id] = [{ ts: timestamp, kind: 'message', role: 'assistant', source_offset: 0,
      summary: scenario.id === 'healthy-running' ? '计算已进入第二阶段，60%；产物持续更新，完成后主动通知。' : '连续两轮寻找 special-loader，未运行报告。' }]
    return w
  }
  function schedule(kind, workerId, extra = {}) { queue.push({ kind, workerId, due: state.tick + 1, ...extra }) }
  function dispatch(id, text) {
    const w = worker(id)
    if (w.task.status === 'closed') throw new Error('Closed worker cannot accept input')
    state.dispatched.push({ worker_id: id, text, tick: state.tick })
    w.task.status = 'running'
    incarnation(w).state = 'running'
    schedule('result', id)
  }
  async function advance() {
    state.tick++
    const event = queue[0]
    if (!event || event.due > state.tick) return null
    queue.shift()
    const w = worker(event.workerId)
    if (event.kind === 'stop') {
      event.operation.status = 'succeeded'
      event.operation.settled_at = timestamp
      w.task.status = 'closed'
      w.task.closed = { at: timestamp, by: 'manager_stop' }
      incarnation(w).state = 'exited'
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].workerId === w.worker_id) queue.splice(i, 1)
      const text = `[Worker event] operation_settled: ${JSON.stringify(event.operation)}; task_status=closed; 主线及已登记后台执行均已核验停止。`
      state.events.push({ kind: 'stop', worker_id: w.worker_id, tick: state.tick })
      return text
    }
    if (event.kind === 'query') {
      queries[event.queryId].text = activity[w.worker_id].at(-1).summary
      return `[Worker event] query completed: worker_id=${w.worker_id}, fork_seq=${event.seq}; 读取侧问结果。`
    }
    const input = JSON.parse(await fs.readFile(path.join(workspace, 'input.json'), 'utf8'))
    const report = { count: input.length, total: input.reduce((sum, row) => sum + row, 0) }
    const content = JSON.stringify(report)
    await fs.writeFile(path.join(workspace, 'report.json'), content)
    const evidence = [
      { kind: 'tool_call', role: 'assistant', summary: 'Read input.json and report.mjs', detail: { input, script: await fs.readFile(path.join(workspace, 'report.mjs'), 'utf8') } },
      { kind: 'tool_result', role: 'user', summary: 'node report.mjs exited 0', detail: { command: 'node report.mjs', exit_code: 0, stdout: 'report written' } },
      { kind: 'tool_result', role: 'user', summary: 'Read /workspace/report.json', detail: { path: '/workspace/report.json', content, expected: report, matches: true } },
      { kind: 'message', role: 'assistant', summary: '已按 input.json 全部三行运行现有脚本，读取 report.json 并核对 count=3、total=12；无其它文件改动。' },
    ].map((e, i) => ({ ...e, ts: timestamp, source_offset: activity[w.worker_id].length + i }))
    activity[w.worker_id].push(...evidence)
    w.task.status = 'halted'
    incarnation(w).state = 'idle'
    const turn = await turns.create({ worker_id: w.worker_id, manager_key: key, incarnation_id: incarnation(w).incarnation_id,
      impl: incarnation(w).impl, seq: 1, session_ref: incarnation(w).session_ref,
      activity_from: String(evidence[0].source_offset), activity_through: String(evidence.at(-1).source_offset),
      completed_at: timestamp, completion_source: 'builtin_end_turn' })
    state.events.push({ kind: 'scripted_result', worker_id: w.worker_id, turn_id: turn.turn_id, tick: state.tick })
    return `[Worker event] turn_completed: worker_id=${w.worker_id}, turn_id=${turn.turn_id}, turn_pending=true; 读取回合和活动验收。`
  }
  const harness = {
    findWorker: async id => state.workers[id] ? { managerKey: key, worker: snapshot(worker(id)) } : undefined,
    listWorkers: async () => Object.values(state.workers).map(snapshot),
    getWorkerTurn: (id, turnId) => turns.get(id, turnId),
    getWorkerTurnActivities: async turn => ({ events: activity[turn.worker_id].filter(e => e.source_offset >= Number(turn.activity_from) && e.source_offset <= Number(turn.activity_through)) }),
    getLatestWorkerActivity: async id => projectWorkerActivity(activity[id], 'all', { worker_id: id, incarnation_id: incarnation(worker(id)).incarnation_id }).at(-1),
    getWorkerControlOperations: async id => structuredClone(state.operations.filter(o => o.worker_id === id)),
    getWorkerTerminal: async (id, options) => ({ kind: 'headless_text', text: options?.seq
      ? Object.values(queries).find(q => q.worker_id === id && q.seq === options.seq)?.text ?? '侧问尚未完成'
      : activity[id].map(e => e.detail ? `${e.summary}\n${JSON.stringify(e.detail)}` : e.summary).join('\n') }),
    spawnWorker: async params => {
      if (params.workspace !== '/workspace') throw new Error('This fixture project is /workspace')
      if (Object.values(state.workers).some(w => w.task.status === 'running')) state.violations.push('replacement overlaps active work')
      const w = addWorker(`w-new-${++serial}`, 'halted', params)
      dispatch(w.worker_id, params.prompt)
      return snapshot(w)
    },
    sendToWorker: async (id, text) => {
      if (scenario.id === 'healthy-running') state.violations.push('interfered with healthy worker')
      dispatch(id, text)
      return { status: 'delivered', worker_id: id, delivery_id: `delivery-${++serial}` }
    },
    queryWorker: async (id, question) => {
      const seq = ++serial + 1
      const queryId = `query-${seq}`
      queries[queryId] = { worker_id: id, seq, question }
      schedule('query', id, { queryId, seq })
      return { status: 'started', query_id: queryId, fork_seq: seq }
    },
    requestWorkerStop: async id => {
      const w = worker(id)
      if (scenario.id === 'healthy-running') state.violations.push('stopped healthy worker')
      const existing = state.operations.find(o => o.worker_id === id && o.status === 'accepted')
      if (existing) return structuredClone(existing)
      const operation = { operation_id: `stop-${++serial}`, worker_id: id, manager_key: key,
        incarnation_id: incarnation(w).incarnation_id, seq: 1, impl: incarnation(w).impl, kind: 'stop', status: 'accepted', created_at: timestamp }
      state.operations.push(operation)
      schedule('stop', id, { operation })
      return structuredClone(operation)
    },
    resolveWorkerTurn: (id, turnId, resolution, reason) => turns.resolve(id, turnId, resolution, timestamp, reason),
    inspectWorkspaceGit: async id => ({ worker_id: id, incarnation_id: incarnation(worker(id)).incarnation_id,
      git: await git.inspect(workspace, gitBaseline) }),
  }
  try {
    await fs.mkdir(workspace)
    await fs.writeFile(path.join(workspace, 'README.md'), '# Report\nRun `node report.mjs`. Input input.json, all rows; output report.json.\n')
    await fs.writeFile(path.join(workspace, 'AGENTS.md'), '# Project\nUse the existing script. Maintain only relevant documentation. No publication.\n')
    await fs.writeFile(path.join(workspace, 'input.json'), '[2,4,6]')
    await fs.writeFile(path.join(workspace, 'report.mjs'), "import fs from 'node:fs';\nconst rows=JSON.parse(fs.readFileSync('input.json','utf8'));\nfs.writeFileSync('report.json',JSON.stringify({count:rows.length,total:rows.reduce((s,x)=>s+x,0)}));\nconsole.log('report written');\n")
    await fs.writeFile(path.join(workspace, '.gitignore'), 'report.json\n')
    for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Crabot Eval', '-c', 'user.email=eval@localhost', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Replay fixture']]) {
      execFileSync('git', args, { cwd: workspace, stdio: 'pipe' })
    }
    gitBaseline = (await git.inspect(workspace)).current
    addWorker('w-old', ['idle-premise', 'summary-correction'].includes(scenario.id) ? 'halted' : 'running')
    const objective = await board.createObjective(key, { title: '报告', completion_criteria: ['完整输入生成 report.json，提供运行和结果核验证据'] })
    const healthy = scenario.id === 'healthy-running'
    await board.createWorkItem(key, objective.value.objective_id, { title: '运行报告', status: healthy ? 'in_progress' : 'blocked', project_root: '/workspace',
      current_judgement: healthy ? '计算正常推进' : '主控此前认为需要 special-loader', next_action: healthy ? '等待完成通知' : '解除阻塞后执行报告',
      ...(!healthy ? { blocker: '等待 special-loader' } : {}) })
    const tools = new Map([
      ...mcpServerToToolDefinitions(memory, 'crab-memory').filter(t => ['mcp__crab-memory__search_memory', 'mcp__crab-memory__list_entries'].includes(t.name)),
      ...buildWorkerTools({ harness, context: () => ({ managerKey: key, reportTo: target }),
        authorizeProjectRead: async value => value,
        readWorkerActivity: async p => {
          const inc = incarnation(worker(p.worker_id)).incarnation_id
          if (p.incarnation_id && p.incarnation_id !== inc) throw new Error('Unknown incarnation')
          const cursorPrefix = `${inc}:${p.view}:`
          if (p.after && !p.after.startsWith(cursorPrefix)) throw new Error('Invalid activity cursor')
          const offset = p.after ? Number(p.after.slice(cursorPrefix.length)) : 0
          if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid activity cursor')
          return { incarnation_id: inc, activities: projectWorkerActivity(activity[p.worker_id].slice(offset), p.view, { worker_id: p.worker_id, incarnation_id: inc }), next_cursor: cursorPrefix + activity[p.worker_id].length }
        },
        hasSuccessfulSendMessageTo: t => t.channel_id === target.channel_id && t.session_id === target.session_id && state.reported.length > 0,
        hasContinuedWorker: id => continued.has(id), onWorkerContinuation: id => continued.add(id),
        workerImplSnapshot: () => ({ revision: 1, default_impl: 'builtin', preference: {}, observed_at: timestamp,
          statuses: ['builtin', 'codex', 'claude-code'].map(impl => ({ impl, enabled: true, ready: true, installed: true, verification: 'passed' })) }),
      }),
      ...buildWorkboardTools({ store: board, managerKey: key }),
      ...buildProjectDocTools({ ledger: harness, readWorkerContext: async () => ({ principal_permissions: permissions }), managerKey: key,
        wakeEvent: { kind: 'human_messages', messages: [], principalPermissions: permissions } }),
    ].map(tool => [tool.name, tool]))
    return {
      state,
      advance,
      event: advance,
      dispose: async () => { await memory.close(); await fs.rm(root, { recursive: true, force: true }) },
      async call(name, input) {
        if (name === 'send_message' || name === 'get_history') {
          if (input.channel_id !== target.channel_id || input.session_id !== target.session_id) return { output: 'Incorrect channel/session target', isError: true }
          if (name === 'send_message') {
            if (typeof input.content !== 'string' || !input.content.trim()) return { output: 'content required', isError: true }
            state.reported.push({ content: input.content, tick: state.tick })
            return ok({ sent: true, message_id: `message-${state.reported.length}` })
          }
          state.observations.push({ name, tick: state.tick })
          return ok({ items: [{ platform_message_id: 'latest-correction', content: { type: 'text', text: healthy ? '按已确认任务继续，完成后告诉我。' : 'special-loader 从来不是我的限制，是先前执行器自行选择的方案。直接用已存在的 input.json 完成报告。' } }] })
        }
        const tool = tools.get(name)
        // Unsupported Harness methods are evaluation gaps, never model-visible tool failures.
        const supported = ['spawn_worker', 'send_to_worker', 'query_worker', 'inspect_workspace_git', 'get_worker_state', 'get_worker_activity', 'get_worker_turn', 'request_worker_stop', 'resolve_worker_turn', 'get_worker_terminal', 'list_workers', 'list_worker_implementations', 'get_worker_detail', 'inspect_workboard', 'change_workboard', 'inspect_project_docs', 'mcp__crab-memory__search_memory', 'mcp__crab-memory__list_entries']
        if (!tool || !supported.includes(name)) {
          state.unsupported.push({ name, input })
          return { harnessGap: true, output: 'Unmodeled operation', isError: false }
        }
        const args = name === 'inspect_project_docs' && input.project_root === '/workspace' ? { ...input, project_root: workspace } : input
        const result = await tool.call(args, {})
        if (!result.isError) {
          state.observations.push({ name, input, tick: state.tick })
          if (name === 'change_workboard') state.boardChanges.push({ input, tick: state.tick })
        }
        return { ...result, output: JSON.parse(visible(result.output)) }
      },
      async findings() {
        const results = state.events.filter(e => e.kind === 'scripted_result')
        const reads = state.observations.filter(o => ['get_worker_turn', 'get_worker_activity', 'get_worker_terminal'].includes(o.name)
          && results.some(e => e.worker_id === o.input.worker_id && e.tick <= o.tick))
        const delivered = state.reported.filter(m => reads.some(o => o.tick <= m.tick))
        return { objective_evidence: null, semantic_review_required: true, violations: state.violations, unsupported: state.unsupported,
          evidence: { scripted_worker_results: results, result_reads: reads, messages_after_result_read: delivered, board: await board.load(key), pending_events: queue.length },
          delegation_execution_verified: false }
      },
    }
  } catch (error) { await memory.close(); await fs.rm(root, { recursive: true, force: true }); throw error }
}
