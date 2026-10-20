import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cases, rules, workspace } from './cases.mjs'
import { PreworkFixture, bundleTools } from './docker-fixture.mjs'

const repo = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(path.join(repo, 'crabot-agent/package.json'))
const out = process.env.REPLAY_OUTPUT_DIR
assert(out, 'REPLAY_OUTPUT_DIR required')
const priorDirs=process.env.REPLAY_PRIOR_DIRS?JSON.parse(process.env.REPLAY_PRIOR_DIRS):process.env.REPLAY_PRIOR_DIR?[process.env.REPLAY_PRIOR_DIR]:[]
const priorRuns=priorDirs.map(dir=>({dir,plan:JSON.parse(fs.readFileSync(path.join(dir,'plan.json'))),conditions:JSON.parse(fs.readFileSync(path.join(dir,'conditions.json'))),events:fs.readFileSync(path.join(dir,'journal.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))}))
const priorCards=new Map()
for(const run of priorRuns)for(const file of fs.readdirSync(run.dir).filter(name=>name.endsWith('.json')&&(name.includes('-baseline-')||name.includes('-candidate-')))) {
  const card=JSON.parse(fs.readFileSync(path.join(run.dir,file)));if(card.id&&Array.isArray(card.responses))priorCards.set(card.id,{card,run})
}
const priorDir=priorDirs[0]
const priorEvents=priorRuns.flatMap(run=>run.events)
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
const workerTools = getAllBuiltinTools(() => workspace, { availableSkills: skillConfigs, bgToolDeps: {} })
const transport = { rpcClient: { call: never }, moduleId: 'eval', getMemoryPort: never }
const { createCrabMemoryServer } = require('./dist/mcp/crab-memory.js')
const { buildManagerToolFace } = require('./dist/manager/tools/tool-face.js')
const managerTools = buildManagerToolFace({ harness: {}, workerContext: () => ({ managerKey: 'fixture::synthetic' }),
  messagingDeps: { ...transport, getAdminPort: never, resolveChannelPort: never },
  memoryServer: createCrabMemoryServer(transport, { visibility: 'private', scopes: [], isMasterPrivate: false }),
  callAdmin: never, isSystemThread: false, managerTarget: { channel_id: 'fixture', session_id: 'synthetic' },
  workboard: { store: {}, managerKey: 'fixture::synthetic' }, projectDocs: {},
}).filter(t => ['spawn_worker','send_to_worker','send_message','get_execution_capabilities','get_worker_state','get_worker_turn'].includes(t.name))
const serializeTools = tools => JSON.parse(JSON.stringify(tools.map(({ name, description, inputSchema, isReadOnly }) => ({ name, description, inputSchema, isReadOnly }))))
function condition(role, variant) {
  const prompt = role === 'worker' ? load('crabot-agent/src/prompts/builtin-worker.ts', variant).assembleBuiltinWorkerPrompt({ workspaceRoot: workspace, imageAvailable: true, workspaceInstructions: rules,
    skillListing: '<available_skills><skill><name>tmp-page</name><description>创建供人类查看或交互反馈的临时页面</description></skill></available_skills>' })
    : load('crabot-agent/src/manager/prompt.ts', variant).assembleManagerSystemPrompt({ managerKey: 'fixture::synthetic', isSystemThread: false })
  const guidance = load('crabot-agent/src/guidance/catalog.ts', variant).createGuidanceTool(role)
  return { role, variant, prompt, tools: serializeTools([...(role === 'worker' ? workerTools : managerTools), guidance]) }
}
const conditions = ['manager','worker'].flatMap(role => variants.map(v => condition(role,v)))
const cleanComparison = process.env.REPLAY_CLEAN_COMPARISON === 'yes'
const job=(c,variant,rep,cohort='')=>({id:`${c.id}-${variant}${cohort?'-'+cohort:''}-${rep}`,case:c.id,variant,repetition:rep,panel:c.panel??'main'})
let order = cases.filter(c=>c.panel!=='refinement-only').flatMap((c,i) => Array.from({length:c.repetitions??2},(_,n)=>n+1).flatMap(rep => ((i+rep)%2 ? variants : [...variants].reverse()).map(variant => job(c,variant,rep))))
if (priorDir) {
  const ids = JSON.parse(process.env.REPLAY_RESUME_IDS ?? '[]')
  assert(ids.length || cleanComparison, 'Explicit unchanged trajectory IDs or authorized clean comparison required')
  assert(!ids.length || !cleanComparison, 'Do not mix continuations and new sampling')
  order = cleanComparison ? cases.flatMap((c,i) => (i%2 ? [...variants].reverse() : variants).map(v => job(c,v,1,'clean'))) : ids.map(id => {
    const prior = priorCards.get(id)
    assert(prior && prior.card.status === 'incomplete', 'Only interrupted trajectories may continue')
    assert(/HTTP 50[234]|ECONNRESET|ETIMEDOUT/.test(prior.card.error ?? ''), 'Only failed transport requests may continue')
    const seedTools = prior.run.events.filter(e => e.kind === 'tool' && e.id === id)
    assert(prior.run.plan.tool_backend || seedTools.every(e => e.role === 'worker' && e.name === 'load_guidance'),
      'Migrating to Docker is allowed only before any business/file/Shell reply was given')
    return { ...prior.run.plan.order.find(j => j.id === id), seed: id }
  })
}
const priorStarts=priorEvents.filter(e=>e.kind==='start').map(e=>e.id)
assert(/^sha256:[a-f0-9]{64}$/.test(process.env.REPLAY_TOOL_IMAGE ?? ''), 'REPLAY_TOOL_IMAGE must pin a verified local image ID')
const plan = { mode: 'synthetic-multistep-prework-handoff', endpoint: 'https://mirror.xinshu.ai/v1', model: 'gpt-6.1-sol', max_requests: 512, max_requests_per_trajectory: 48, max_turns_per_trajectory:24, max_tokens: 6000,
  previous_requests: priorEvents.filter(e=>e.kind==='request').length,previous_started:priorStarts.length,max_unique_trajectories:priorDir?64:32,continuation_source:priorDir?hash(priorRuns.map(run=>run.plan)):null,
  clean_comparison:cleanComparison, repetitions: cleanComparison?1:2, trajectories: order.length, tool_backend: 'actual builtin tools in networkless Docker; no host mounts; no production tools', manager_loop: 'adapter-driven; real prompt and frozen production tool schemas, not the full ManagerLoop', worker_tools: 'builtin tools and guidance; MCP, child agents and delivery are not exercised', baseline_commit: baselineCommit,
  conditions_hash: hash(conditions), tool_image:process.env.REPLAY_TOOL_IMAGE,
  tool_bundle_hashes:Object.fromEntries(Object.entries(await bundleTools()).map(([name,text])=>[name,hash(text)])),
  source_hashes:Object.fromEntries(['cases.mjs','docker-fixture.mjs','docker-tool-entry.mjs','ops.py','attribution.mjs','replay.mjs'].map(name=>[name,hash(fs.readFileSync(path.join(import.meta.dirname,name)))])), cases, order }

function offline() {
  for (const role of ['manager','worker']) {
    const [a,b] = conditions.filter(c => c.role === role)
    assert.deepEqual(a.tools.map(({description,...t})=>t),b.tools.map(({description,...t})=>t))
    assert(a.prompt!==b.prompt)
    assert.equal(a.tools.filter((t,i)=>t.description!==b.tools[i].description).map(t=>t.name).join(','),'load_guidance')
  }
  assert(new Set([...priorStarts,...order.map(j=>j.id)]).size<=plan.max_unique_trajectories)
  assert(order.every(j=>j.seed || !priorStarts.includes(j.id)), 'Do not resample previously started trajectory IDs')
  if(cleanComparison) {
    assert(priorDir && order.length===20)
    for(const c of cases)assert.deepEqual(order.filter(j=>j.case===c.id).map(j=>j.variant).sort(),['baseline','candidate'])
    assert.deepEqual(conditions, priorRuns.at(-1).conditions, 'Do not tune the candidate during clean comparison')
  }
  return { checks: ['A/B schemas identical; only load_guidance description differs','actual role prompts differ','unique trajectories within authorization'], passed: true }
}

fs.mkdirSync(out,{recursive:true})
if (process.argv[2] === 'prepare') {
  assert(!fs.existsSync(path.join(out,'plan.json')),'Use a fresh output directory')
  save('offline.json',offline());save('conditions.json',conditions);save('plan.json',plan)
  console.log(JSON.stringify({status:'prepared',trajectories:plan.trajectories,max_requests:plan.max_requests}));process.exit(0)
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
  const c = cases.find(c => c.id === job.case), fixture = new PreworkFixture(c)
  const previous=job.seed?priorCards.get(job.seed):undefined
  const seed=previous?.card
  const seedResponses=seed?.responses??[],seedTools=previous?.run.events.filter(e=>e.kind==='tool'&&e.id===job.seed)??[]
  let responseCursor=0,toolCursor=0
  const budget = { used:seed?.requests??0 }
  const record = { ...job, started_at: new Date().toISOString(), responses: [], actions: fixture.actions, delegations: [] }
  if(seed) {
    const oldCase=previous.run.plan.cases.find(x=>x.id===c.id)
    assert.equal(oldCase.context+'\n\n当前要求：'+oldCase.task,c.context+'\n\n当前要求：'+c.task)
    for(const role of ['manager','worker'])assert.deepEqual(previous.run.conditions.find(x=>x.role===role&&x.variant===job.variant),conditions.find(x=>x.role===role&&x.variant===job.variant))
    if(previous.run.plan.tool_backend) {
      assert.equal(previous.run.plan.tool_image,plan.tool_image)
      assert.deepEqual(previous.run.plan.tool_bundle_hashes,plan.tool_bundle_hashes)
      for(const name of Object.keys(plan.source_hashes).filter(name=>name!=='replay.mjs'))assert.equal(previous.run.plan.source_hashes[name],plan.source_hashes[name], 'Fixture sources must remain unchanged')
    }
  }
  log({ kind:seed?'resume':'start', ...job,previous_requests:seed?.requests??0 })
  async function roleLoop(role, input) {
    const cfg = conditions.find(x => x.role===role && x.variant===job.variant), messages = [createUserMessage(input)]
    while (record.responses.length<plan.max_turns_per_trajectory&&(responseCursor<seedResponses.length||budget.used < plan.max_requests_per_trajectory && requests < plan.max_requests)) {
      let response;const started=Date.now()
      const replayed=responseCursor<seedResponses.length
      if(replayed) {
        response=seedResponses[responseCursor++];assert.equal(response.role,role)
      } else for(let attempt=1;attempt<=5;attempt++) {
        if(budget.used>=plan.max_requests_per_trajectory||requests>=plan.max_requests)throw new Error('REQUEST_LIMIT')
        budget.used++;requests++
        const processor=new StreamProcessor()
        log({kind:'request',id:job.id,role,ordinal:budget.used,attempt})
        try {
          for await (const chunk of adapter.stream({model:plan.model,systemPrompt:cfg.prompt,messages,tools:cfg.tools.map(t=>({...t,call:never})),maxTokens:plan.max_tokens,signal:AbortSignal.timeout(180000)})) {
            if(chunk.type==='error')throw new Error(chunk.error)
            processor.process(chunk)
          }
          response=processor.finalize();break
        } catch(e) {
          log({kind:'transport_error',id:job.id,role,ordinal:budget.used,attempt,error:String(e.message).replaceAll(conn.apikey,'[REDACTED]')})
          if(attempt===5||!/HTTP 50[234]|overloaded|ECONNRESET|ETIMEDOUT/.test(e.message))throw e
          await new Promise(resolve=>setTimeout(resolve,attempt*2000))
        }
      }
      record.responses.push({role,...response,elapsed_ms:replayed?response.elapsed_ms:Date.now()-started})
      log({kind:replayed?'reused_response':'response',id:job.id,role,ordinal:budget.used,response})
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
            r={output:JSON.stringify({worker_id:'worker-fixture',state:'idle',summary:text,result_verified:(await fixture.outcome()).goal}),isError:false}
          } else if(call.name==='load_guidance') r={output:load('crabot-agent/src/guidance/catalog.ts',job.variant).renderGuidance('manager',call.input.name),isError:false}
          else if(call.name==='get_execution_capabilities')r={output:'当前会话允许 builtin 委托，所需文件和 Shell 操作已授权，工具入口正常。',isError:false}
          else if(call.name==='send_message')r={output:'simulated delivery accepted',isError:false}
          else throw new Error('FIXTURE_GAP: unsupported Manager tool '+call.name)
        } else r=await fixture.act(call.name,call.input,name=>load('crabot-agent/src/guidance/catalog.ts',job.variant).renderGuidance('worker',name))
        if(toolCursor<seedTools.length) {
          const old=seedTools[toolCursor++]
          assert.deepEqual({role,name:call.name,input:call.input,result:r},{role:old.role,name:old.name,input:old.input,result:old.result},'Prior tool replies must remain exact')
        }
        log({kind:'tool',id:job.id,role,name:call.name,input:call.input,result:r,reconstructed:replayed})
        results.push({tool_use_id:call.id,content:r.output,is_error:r.isError})
      }
      messages.push(createBatchToolResultMessage(results))
    }
    throw new Error('TRAJECTORY_REQUEST_LIMIT')
  }
  try { await fixture.start();record.final=await roleLoop(c.role,c.context+'\n\n当前要求：'+c.task);assert.equal(responseCursor,seedResponses.length);assert.equal(toolCursor,seedTools.length);record.status='completed';record.goal_verified=(await fixture.outcome()).goal }
  catch(e) {record.status='incomplete';record.error=String(e.message).replaceAll(conn.apikey,'[REDACTED]');record.goal_verified=false}
  record.requests = budget.used
  try { record.outcome = await fixture.outcome() } catch(e) { record.fixture_error=String(e.message) }
  try { await fixture.close() } catch(e) { record.cleanup_error=String(e.message) }
  save(job.id+'.json',record);log({kind:'end',id:job.id,status:record.status,goal_verified:record.goal_verified,requests:record.requests})
  console.log(JSON.stringify({id:job.id,status:record.status,goal_verified:record.goal_verified,requests:record.requests}))
}
assert(!fs.existsSync(path.join(out,'journal.jsonl')),'Do not rerun started trajectories')
let next=0
async function lane(){while(next<order.length)await trajectory(order[next++])}
await Promise.all([lane(),lane()])
save('run-summary.json',{requests,trajectories:order.length,finished_at:new Date().toISOString()})
