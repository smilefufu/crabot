import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { runContinuous, scriptedChunks } from './continuous-runtime.mjs'
import { summarize } from './continuous-compare.mjs'
import { docker } from './docker-fixtures.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
const root = path.resolve(import.meta.dirname, '../../..')
const out = process.env.IDLE_REPLAY_OUTPUT
const baselineRoot = process.env.IDLE_REPLAY_BASELINE
const dataRoot = process.env.IDLE_REPLAY_DATA
if (!out || !baselineRoot || !dataRoot) throw new Error('IDLE_REPLAY_OUTPUT, IDLE_REPLAY_BASELINE and IDLE_REPLAY_DATA required')
const planPath = path.join(out, 'plan.json')
function compiledHash(source) {
  const base = path.join(source, 'crabot-agent/dist'), rows = []
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, e.name)
      if (e.isDirectory()) walk(file)
      else if (e.name.endsWith('.js')) rows.push([path.relative(base, file), sha(fs.readFileSync(file))])
    }
  }
  walk(base)
  return sha(JSON.stringify(rows))
}
const scriptFiles = ['idle-replay.mjs', 'continuous-runtime.mjs', 'continuous-compare.mjs', 'continuous-cases.mjs', 'docker-fixtures.mjs', 'docker-project-docs.mjs']
if (process.argv.includes('--prepare')) {
  if (fs.existsSync(planPath)) throw new Error('Plan already frozen')
  const evidence = read(process.env.IDLE_REPLAY_EVIDENCE)
  const key = 'bot-2::2eais6e9'
  const board = read(path.join(dataRoot, 'agent/managers', encodeURIComponent(key), 'workboard.json'))
  const config = read(path.join(dataRoot, 'admin/agent-configs/crabot-agent.json'))
  const ref = config.model_config.powerful
  if (ref.provider_id !== 'ab890126-9337-4df4-9594-6787bc367ff5' || ref.model_id !== 'gpt-5.6-sol') throw new Error('Incident model no longer configured')
  const provider = read(path.join(dataRoot, 'admin/model_providers.json')).find(p => p.id === ref.provider_id)
  const model = provider.models.find(m => m.model_id === ref.model_id)
  const friend = read(path.join(dataRoot, 'admin/friends.json')).find(f => f.id === 'e55b0cdc-d2d8-48c2-9df6-89886771f17e')
  const profile = read(path.join(out, 'scene-profile-response.json')).data.profile
  const cases = evidence.incidents.map((incident, i) => {
    const bytes = fs.readFileSync(incident.episode_file)
    if (sha(bytes) !== incident.episode_sha256) throw new Error('Incident episode changed')
    const rows = bytes.toString().trim().split('\n').map(JSON.parse).slice(0, incident.persisted_history_prefix_records)
    const summary = rows.shift()
    const prefix = '[以下是本次对话更早历史的滚动摘要,不是用户刚发的话]\n\n'
    if (!summary.content.startsWith(prefix)) throw new Error('Unexpected summary marker')
    const trace = JSON.parse(fs.readFileSync(incident.trace_file, 'utf8').split('\n')[incident.trace_line - 1]).trace
    const inspect = trace.spans.find(s => s.type === 'tool_call' && s.details.name === 'inspect_workboard')
    const projected = JSON.parse(inspect.details.output_summary.split('\n').slice(1).join('\n'))
    const archive = board.archive.filter(e => e.archived_at < incident.started_at)
    if (archive.length !== projected.counts.archive_entries) throw new Error('Historical archive unavailable')
    return { id: `incident-${i + 1}`, role: 'manager', trigger: 'idle', files: {},
      criterion: '实际查板并内部结束；无新情况时不发送消息、不派工、不改板。',
      replay: { managerKey: key, model: ref.model_id, thinking: { custom: config.thinking.powerful.thinking_custom },
        contextWindow: model.context_window, personality: config.system_prompt,
        sceneProfile: profile ? { label: profile.label, content: profile.content, source: { scene: profile.scene } } : null,
        // Both incident episodes preceded this process's first human ingress for this conversation.
        // Its in-memory self-handle cache was empty; current channel health is not a historical snapshot.
        friend, permissions: read(path.join(out, 'permissions.json')).resolved, startedAt: incident.started_at,
        sessionState: { key, recent: rows, rollingSummary: summary.content.slice(prefix.length), foldedCount: 0 },
        boardSnapshot: { schema_version: 4, manager_key: key, revision: 0, objectives: projected.objectives, archive },
      },
      provenance: { traceId: incident.trace_id, historySha256: sha(bytes), prefixRecords: rows.length + 1 },
      expectedTools: trace.spans.find(s => s.type === 'agent_loop').details.initial_tool_names,
    }
  })
  const scripts = Object.fromEntries(scriptFiles.map(f => [f, sha(fs.readFileSync(path.join(import.meta.dirname, f)))]))
  const plan = { endpoint: provider.endpoint, providerId: provider.id, model: ref.model_id, format: provider.format,
    sources: { baseline: { root: baselineRoot, compiledSha256: compiledHash(baselineRoot) }, candidate: { root, compiledSha256: compiledHash(root) } },
    scripts, image: (await docker(['image', 'inspect', 'crabot-guidance-tools:local', '--format', '{{.Id}}'])).trim(), cases,
    baselineConditions: [1, 2, 3].flatMap(repeat => cases.map(c => ({ id: `${c.id}/${repeat}/baseline`, caseId: c.id, repeat, variant: 'baseline', cycles: 1 }))),
    comparisonConditions: [1, 2, 3].flatMap(repeat => cases.map(c => ({ id: `${c.id}/${repeat}/candidate`, caseId: c.id, repeat, variant: 'candidate', cycles: 1 })))
      .concat(['baseline', 'candidate'].map(variant => ({ id: `continuous/5/${variant}`, caseId: 'incident-1', variant, cycles: 5 }))),
    maxRequestsPerWake: 8, maxReportedTokensPerPhase: 1500000, timeoutMs: 180000,
    isolation: '原 Manager/Harness 循环；文件和命令仅在无网络 Docker，消息写本地 outbox，记忆/渠道历史缺失返回明确缺口，不伪造成功。实际 Provider 请求使用既有同一端点。',
    limitations: ['历史完整 Provider payload 未留存；按 episode 历史、部署源码和当前同一会话配置重建。',
      '权限、性格、思考强度与场景画像为当前快照，不能证明事故时逐字段相同；bot handle 按事故前入站证据留空。',
      'Worker 历史台账及 Memory/Channel 历史服务未还原；若本次决策访问这些边界，该轨迹记还原缺口。',
      'workboard 内部 revision 重置为 0；工具返回的 active JSON 与事故一致，旧 archive 按时间筛选。',
      '调用生产 idle wake 入口并推进测试时钟，不验证真实一小时时间器等待；主控循环在独立本地数据目录，执行工具在 Docker。',
      '同一端点和模型标识不能证明 Provider 内部模型实现未变；基线与候选分阶段，不以缓存和墙钟差证明性能提升。'],
  }
  fs.mkdirSync(path.join(out, 'scripts'), { recursive: true })
  for (const f of scriptFiles) fs.copyFileSync(path.join(import.meta.dirname, f), path.join(out, 'scripts', f))
  write(planPath, { ...plan, sha256: sha(JSON.stringify(plan)) })
  console.log(JSON.stringify({ prepared: out, sha256: sha(JSON.stringify(plan)), baselineRuns: 6, candidateRuns: 6, continuousWakes: 10, endpoint: plan.endpoint, model: plan.model }))
  process.exit()
}

const plan = read(planPath)
const { sha256, ...unsigned } = plan
if (sha(JSON.stringify(unsigned)) !== sha256) throw new Error('Frozen plan changed')
for (const [name, digest] of Object.entries(plan.scripts)) if (sha(fs.readFileSync(path.join(import.meta.dirname, name))) !== digest) throw new Error(`Script changed: ${name}`)
for (const [name, source] of Object.entries(plan.sources)) if (compiledHash(source.root) !== source.compiledSha256) throw new Error(`Compiled product changed: ${name}`)
process.env.CRABOT_MANAGER_TOOL_LOADING_MODE = 'progressive'
delete process.env.CRABOT_MANAGER_TOOL_LOADING_KEYS
const preflight = process.argv.includes('--preflight')
const phase = preflight ? 'preflight' : process.argv.includes('--comparison') ? 'comparison' : 'baseline'
if (phase === 'comparison') {
  const prior = read(path.join(out, 'baseline-summary.json'))
  if (!prior.results.some(r => !r.fatal && r.coverageGaps.length === 0 && r.outbox?.length)) throw new Error('No valid baseline reproduction; comparison cannot claim repair')
}
const conditions = preflight ? [plan.baselineConditions[0], plan.comparisonConditions[0]] : plan[phase === 'baseline' ? 'baselineConditions' : 'comparisonConditions']
const log = path.join(out, `${phase}-events.jsonl`)
if (fs.existsSync(log)) throw new Error('Refusing to replace prior run')
const require = createRequire(path.join(baselineRoot, 'crabot-agent/package.json'))
let live, conn
if (!preflight) {
  const admin = createRequire(path.join(baselineRoot, 'crabot-admin/package.json'))
  const resolver = new (admin('./dist/model-provider-manager.js').ModelProviderManager)(path.join(dataRoot, 'admin'))
  await resolver.initialize()
  conn = await resolver.buildConnectionInfo(plan.providerId, plan.model)
  if (conn.endpoint !== plan.endpoint || conn.format !== plan.format) throw new Error('Frozen Provider changed')
  live = require('./dist/engine/llm-adapter.js').createAdapter({ endpoint: conn.endpoint, apikey: conn.apikey, format: conn.format })
}
let requests = 0, totalTokens = 0
const results = []
const priorUsage = phase === 'baseline' ? plan.priorBaselineUsage : undefined
const requestLimit = conditions.reduce((n, c) => n + plan.maxRequestsPerWake * c.cycles, 0) - (priorUsage?.requests ?? 0)
const tokenLimit = plan.maxReportedTokensPerPhase - (priorUsage?.totalTokens ?? 0)
for (const condition of conditions) {
  if (requests >= requestLimit || totalTokens >= tokenLimit) { results.push({ id: condition.id, fatal: 'budget-not-started' }); continue }
  const c = structuredClone(plan.cases.find(c => c.id === condition.caseId))
  c.replay.cycles = condition.cycles
  const runtimeRoot = path.join(out, 'runtime', phase, condition.id.replaceAll('/', '--'))
  process.env.CRABOT_AGENT_DATA_DIR = path.join(runtimeRoot, 'agent')
  let step = 0
  const rows = await runContinuous({ c, sourceRoot: plan.sources[condition.variant].root, image: plan.image, root: runtimeRoot,
    maxRequests: plan.maxRequestsPerWake * condition.cycles, timeoutMs: 1200000,
    delegate: { stream(params) {
      if (step === 0 && JSON.stringify(params.tools.map(t => t.name)) !== JSON.stringify(c.expectedTools)) throw new Error('Initial tool surface mismatch')
      step++
      if (preflight) return scriptedChunks(step === 1 ? [{ type: 'tool_use', id: 'preflight-inspect', name: 'inspect_workboard', input: { view: 'active', page: 1, page_size: 100 } }] : [])
      if (requests >= requestLimit || totalTokens >= tokenLimit) throw Object.assign(new Error('Frozen phase budget reached'), { code: 'EVAL_BUDGET' })
      requests++
      return live.stream(params)
    } },
    record(row) {
      if (row.type === 'response') totalTokens += (row.usage?.inputTokens ?? 0) + (row.usage?.cacheReadTokens ?? 0) + (row.usage?.outputTokens ?? 0)
      let line = JSON.stringify({ id: condition.id, ...row })
      if (conn?.apikey) line = line.replaceAll(conn.apikey, '[REDACTED]')
      fs.appendFileSync(log, line + '\n', { mode: 0o600 })
    },
  })
  const result = { id: condition.id, ...summarize(c, rows), coverageGaps: rows.filter(r => r.type === 'coverage_gap'),
    historicalWorkerQueries: rows.filter(r => r.type === 'response').flatMap(r => r.tools).filter(t => /^(get_worker|list_workers|list_all_workers)/.test(t.name)) }
  if (result.historicalWorkerQueries.length) result.coverageGaps.push({ boundary: 'historical-worker-ledger', count: result.historicalWorkerQueries.length })
  results.push(result)
  fs.writeFileSync(path.join(out, `${phase}-summary.json`), JSON.stringify({ planSha256: sha256, requests, totalTokens, results }, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ id: condition.id, fatal: result.fatal, sends: result.outbox?.length, coverageGaps: result.coverageGaps.length, requests, totalTokens }))
}
fs.writeFileSync(path.join(out, `${phase}-summary.json`), JSON.stringify({ planSha256: sha256, requests, totalTokens, results }, null, 2), { mode: 0o600 })
