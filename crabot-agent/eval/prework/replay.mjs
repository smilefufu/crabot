import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cases, files, rules, workspace, initialState, complete, simulate } from './cases.mjs'

const repo = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(path.join(repo, 'crabot-agent/package.json'))
const out = process.env.REPLAY_OUTPUT_DIR
assert(out, 'REPLAY_OUTPUT_DIR required')
const frozen = process.argv[2] === 'prepare' ? undefined : JSON.parse(fs.readFileSync(path.join(out,'plan.json')))
const baselineCommit = frozen?.baseline_commit ?? execFileSync('git',['rev-parse',process.env.REPLAY_BASELINE_REF ?? 'HEAD'],{cwd:repo,encoding:'utf8'}).trim()
const hash = x => createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex')
const save = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
const log = value => fs.appendFileSync(path.join(out, 'journal.jsonl'), JSON.stringify(value) + '\n', { mode: 0o600 })
const never = () => { throw new Error('Production tool execution is forbidden') }
const ts = require('typescript')
const { OpenAIAdapter } = require('./dist/engine/openai-adapter.js')
const { StreamProcessor } = require('./dist/engine/stream-processor.js')
const { createUserMessage, createAssistantMessage, createBatchToolResultMessage } = require('./dist/engine/types.js')
const { getAllBuiltinTools } = require('./dist/engine/tools/index.js')
const { createGuidanceTool } = require('./dist/guidance/catalog.js')
const variants = ['baseline', 'candidate']

function load(relative, variant, cache = new Map()) {
  if (cache.has(relative)) return cache.get(relative)
  const source = variant === 'baseline' ? execFileSync('git', ['show', `${baselineCommit}:${relative}`], { cwd: repo, encoding: 'utf8' }) : fs.readFileSync(path.join(repo, relative), 'utf8')
  const module = { exports: {} }; cache.set(relative, module.exports)
  const localRequire = spec => {
    if (!spec.startsWith('.')) return require(spec)
    const rel = path.posix.normalize(path.posix.join(path.posix.dirname(relative), spec.replace(/\.js$/, '.ts')))
    if (/\/(prompts|guidance)\//.test(rel) || rel.endsWith('/manager/prompt.ts')) return load(rel, variant, cache)
    return require('./dist/' + rel.replace('crabot-agent/src/', '').replace(/\.ts$/, '.js'))
  }
  vm.runInNewContext('(function(require,module,exports){' + ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText + '\n})', {})(localRequire, module, module.exports)
  return module.exports
}

const skillConfigs = [{ name: 'tmp-page', description: '创建供人类查看或交互反馈的临时页面', skill_dir: '/fixture/skills/tmp-page' }]
const workerTools = [...getAllBuiltinTools(() => workspace, { availableSkills: skillConfigs, bgToolDeps: {} }), createGuidanceTool('worker')]
const transport = { rpcClient: { call: never }, moduleId: 'eval', getMemoryPort: never }
const { createCrabMemoryServer } = require('./dist/mcp/crab-memory.js')
const { buildManagerToolFace } = require('./dist/manager/tools/tool-face.js')
const managerTools = buildManagerToolFace({ harness: {}, workerContext: () => ({ managerKey: 'fixture::synthetic' }),
  messagingDeps: { ...transport, getAdminPort: never, resolveChannelPort: never },
  memoryServer: createCrabMemoryServer(transport, { visibility: 'private', scopes: [], isMasterPrivate: false }),
  callAdmin: never, isSystemThread: false, managerTarget: { channel_id: 'fixture', session_id: 'synthetic' },
  workboard: { store: {}, managerKey: 'fixture::synthetic' }, projectDocs: {},
}).filter(t => ['spawn_worker','send_to_worker','send_message','get_execution_capabilities','get_worker_state','get_worker_turn'].includes(t.name))
managerTools.push(createGuidanceTool('manager'))
const serializeTools = tools => tools.map(({ name, description, inputSchema, isReadOnly }) => ({ name, description, inputSchema, isReadOnly }))
function condition(role, variant) {
  const prompt = role === 'worker' ? load('crabot-agent/src/prompts/builtin-worker.ts', variant).assembleBuiltinWorkerPrompt({ workspaceRoot: workspace, imageAvailable: true, workspaceInstructions: rules,
    skillListing: '<available_skills><skill><name>tmp-page</name><description>创建供人类查看或交互反馈的临时页面</description></skill></available_skills>' })
    : load('crabot-agent/src/manager/prompt.ts', variant).assembleManagerSystemPrompt({ managerKey: 'fixture::synthetic', isSystemThread: false })
  return { role, variant, prompt, tools: serializeTools(role === 'worker' ? workerTools : managerTools) }
}
const conditions = ['manager','worker'].flatMap(role => variants.map(v => condition(role,v)))
const order = cases.flatMap((c,i) => [1,2].flatMap(rep => ((i+rep)%2 ? variants : [...variants].reverse()).map(variant => ({ id: `${c.id}-${variant}-${rep}`, case: c.id, variant, repetition: rep }))))
const plan = { mode: 'synthetic-multistep-prework', endpoint: 'https://mirror.xinshu.ai/v1', model: 'gpt-6.1-sol', max_requests: 384, max_requests_per_trajectory: 16, max_tokens: 6000,
  previous_requests: frozen?.previous_requests ?? Number(process.env.REPLAY_PREVIOUS_REQUESTS ?? 0), repetitions: 2, trajectories: 24, real_tool_executions: 0, manager_loop: 'adapter-driven; real prompt and frozen production tool schemas, not the full ManagerLoop', worker_tools: 'builtin tools and guidance; MCP, child agents and delivery are not exercised', baseline_commit: baselineCommit,
  conditions_hash: hash(conditions), cases_hash: hash(fs.readFileSync(path.join(import.meta.dirname,'cases.mjs'))), runner_hash: hash(fs.readFileSync(import.meta.filename)), cases, order }

function offline() {
  for (const role of ['manager','worker']) {
    const [a,b] = conditions.filter(c => c.role === role)
    assert.deepEqual(a.tools,b.tools)
    assert.equal(a.prompt.includes('前置检查只补'), false)
    assert.equal(b.prompt.includes(role === 'worker' ? '前置检查只补' : '不自行增加前置门槛'), true)
  }
  const guard = cases.find(c => c.kind === 'unknown'); const s = initialState(guard)
  simulate(guard,s,'Bash',{command:'python3 tools/ops.py receipt --transaction tx-previous'},never)
  simulate(guard,s,'Bash',{command:'python3 tools/ops.py save'},never)
  assert(complete(guard,s)); assert.equal(s.additions,1)
  const changed = cases.find(c => c.changed); const q = initialState(changed)
  assert(simulate(changed,q,'Bash',{command:'python3 tools/ops.py add --target user-17 --container bag-17 --amount 1000'},never).isError)
  assert.equal(q.additions,0)
  const a = initialState(changed)
  simulate(changed,a,'Bash',{command:'python3 tools/ops.py inspect --target user-17'},never)
  simulate(changed,a,'Bash',{command:'python3 tools/ops.py add --target user-17 --container bag-29 --amount 1000'},never)
  simulate(changed,a,'Bash',{command:'python3 tools/ops.py receipt --transaction tx-new'},never)
  simulate(changed,a,'Bash',{command:'python3 tools/ops.py save'},never)
  assert(complete(changed,a))
  return { checks: ['A/B tools identical','approved prompt deltas present','unknown previous write does not require repetition','stale container rejected','verified new container completes'], passed: true }
}

fs.mkdirSync(out,{recursive:true})
if (process.argv[2] === 'prepare') {
  assert(!fs.existsSync(path.join(out,'plan.json')),'Use a fresh output directory')
  save('offline.json',offline());save('conditions.json',conditions);save('plan.json',plan)
  console.log(JSON.stringify({status:'prepared',trajectories:24,max_requests:384}));process.exit(0)
}
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out,'plan.json'))),plan,'Frozen inputs changed')
assert.equal(process.env.REPLAY_ALLOW_EXTERNAL,'yes','Explicit external-test authorization required')

async function connection() {
  const data = process.env.REPLAY_DATA_DIR; const runtime = process.env.REPLAY_RUNTIME_ROOT
  assert(data && runtime)
  const admin = createRequire(path.join(runtime,'crabot-admin/package.json'))
  const { ModelProviderManager } = admin('./dist/model-provider-manager.js')
  const config = JSON.parse(fs.readFileSync(path.join(data,'admin/agent-configs/crabot-agent.json')))
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'prework-provider-'))
  try {
    fs.copyFileSync(path.join(data,'admin/model_providers.json'),path.join(temp,'model_providers.json'));fs.chmodSync(path.join(temp,'model_providers.json'),0o600)
    const providers = new ModelProviderManager(temp);await providers.initialize()
    const ref = config.model_config.powerful;const c = await providers.buildConnectionInfo(ref.provider_id,ref.model_id)
    assert.equal(c.format,'openai');assert.equal(c.endpoint.replace(/\/$/,''),plan.endpoint);assert.equal(c.model_id,plan.model)
    return c
  } finally { fs.rmSync(temp,{recursive:true,force:true}) }
}
const conn = await connection(); let requests=plan.previous_requests
const adapter = new OpenAIAdapter({endpoint:conn.endpoint,apikey:conn.apikey,format:conn.format})

async function trajectory(job) {
  const c = cases.find(c => c.id === job.case), state = initialState(c), budget = { used: 0 }
  const record = { ...job, started_at: new Date().toISOString(), responses: [], actions: state.actions, delegations: [] }
  log({ kind:'start', ...job })
  async function roleLoop(role, input) {
    const cfg = conditions.find(x => x.role===role && x.variant===job.variant), messages = [createUserMessage(input)]
    while (budget.used < plan.max_requests_per_trajectory && requests < plan.max_requests) {
      budget.used++;requests++
      const processor = new StreamProcessor(); const started=Date.now()
      log({kind:'request',id:job.id,role,ordinal:budget.used})
      for await (const chunk of adapter.stream({model:plan.model,systemPrompt:cfg.prompt,messages,tools:cfg.tools.map(t=>({...t,call:never})),maxTokens:plan.max_tokens,signal:AbortSignal.timeout(180000)})) {
        if(chunk.type==='error')throw new Error(chunk.error)
        processor.process(chunk)
      }
      const response=processor.finalize();record.responses.push({role,...response,elapsed_ms:Date.now()-started})
      log({kind:'response',id:job.id,role,ordinal:budget.used,response})
      if(response.stopReason==='max_tokens')throw new Error('MODEL_TOKEN_TRUNCATION')
      const blocks=[...(response.text?[{type:'text',text:response.text}]:[]),...response.toolUseBlocks]
      messages.push(createAssistantMessage(blocks,response.stopReason??'end_turn',response.usage))
      if(!response.toolUseBlocks.length)return response.text
      const results=[]
      for(const call of response.toolUseBlocks) {
        let r
        if(role==='manager') {
          if(call.name==='spawn_worker') {
            record.delegations.push(call.input)
            if(record.delegations.length>1)throw new Error('DUPLICATE_WORKER')
            const text=await roleLoop('worker',call.input.prompt)
            r={output:JSON.stringify({worker_id:'worker-fixture',state:'idle',summary:text,result_verified:complete(c,state)}),isError:false}
          } else if(call.name==='load_guidance') r={output:load('crabot-agent/src/guidance/catalog.ts',job.variant).renderGuidance('manager',call.input.name),isError:false}
          else if(call.name==='get_execution_capabilities')r={output:'当前会话允许 builtin 委托，所需文件和 Shell 操作已授权，工具入口正常。',isError:false}
          else if(call.name==='send_message')r={output:'simulated delivery accepted',isError:false}
          else r={output:JSON.stringify({state:'idle',result_verified:complete(c,state)}),isError:false}
        } else r=simulate(c,state,call.name,call.input,name=>load('crabot-agent/src/guidance/catalog.ts',job.variant).renderGuidance('worker',name))
        log({kind:'tool',id:job.id,role,name:call.name,input:call.input,result:r})
        results.push({tool_use_id:call.id,content:r.output,is_error:r.isError})
      }
      messages.push(createBatchToolResultMessage(results))
    }
    throw new Error('TRAJECTORY_REQUEST_LIMIT')
  }
  try { record.final=await roleLoop(c.role,c.context+'\n\n当前要求：'+c.task);record.status='completed';record.goal_verified=complete(c,state) }
  catch(e) {record.status='incomplete';record.error=String(e.message).replaceAll(conn.apikey,'[REDACTED]');record.goal_verified=false}
  record.requests=budget.used;record.state={...state,source:[...state.source],repeated:[...state.repeated]}
  record.unnecessary=state.actions.filter(a=>a.unnecessary).length
  record.first_effective_call=state.actions.findIndex(a=>a.effective)+1 || null
  save(job.id+'.json',record);log({kind:'end',id:job.id,status:record.status,goal_verified:record.goal_verified,unnecessary:record.unnecessary,requests:record.requests})
  console.log(JSON.stringify({id:job.id,status:record.status,goal_verified:record.goal_verified,unnecessary:record.unnecessary,requests:record.requests}))
}
assert(!fs.existsSync(path.join(out,'journal.jsonl')),'Do not rerun started trajectories')
let next=0
async function lane(){while(next<order.length)await trajectory(order[next++])}
await Promise.all([lane(),lane()])
save('run-summary.json',{requests,trajectories:order.length,finished_at:new Date().toISOString()})
