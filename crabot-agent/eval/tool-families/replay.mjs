import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { assembly, cases, simulatedResult, supportsFixture, restoreFixtureGap } from './runtime.mjs'

const baseline = process.env.FAMILY_BASELINE
const candidate = path.resolve(import.meta.dirname, '../../..')
const output = process.env.FAMILY_OUTPUT
if (!baseline || !output) throw new Error('FAMILY_BASELINE and FAMILY_OUTPUT are required')
fs.mkdirSync(output, { recursive: true, mode: 0o700 })
const rows = []
const offlineCases = [...cases,
  { id: 'cross-family', families: ['memory', 'messaging'], targets: ['mcp__crab-memory__get_memory_detail', 'get_history'], queries: ['读取指定记忆详情', '读取聊天历史记录'] },
  { id: 'core-only', families: [], targets: ['send_message'], queries: [] },
]
for (const c of offlineCases) {
  for (const [variant, root] of [['baseline', baseline], ['candidate', candidate]]) {
    const face = assembly(root, c.external)
    const snapshots = [face.bytes(face.tools())]
    const calls = []
    if (variant === 'baseline') {
      for (const query of c.queries) {
        const result = await face.tools().find(t => t.name === 'search_tools').call({ query, limit: c.id === 'mcp-absent' ? 5 : c.id === 'web-absent' ? 2 : 3 }, {})
        calls.push(JSON.parse(result.output)); snapshots.push(face.bytes(face.tools()))
      }
    } else {
      for (const family of c.families ?? [c.family]) {
        calls.push(JSON.parse((await face.tools().find(t => t.name === 'load_tool_family').call({ family }, {})).output))
        snapshots.push(face.bytes(face.tools()))
      }
    }
    const loaded = [...face.state.loadedNames]
    rows.push({ id: c.id, variant, discoveryCalls: calls.length, initialBytes: snapshots[0], finalBytes: snapshots.at(-1),
      discoveryRequestBytes: snapshots.slice(0, -1).reduce((a,b) => a+b, 0), loaded,
      targetsVisible: c.targets.every(n => face.tools().some(t => t.name === n)), calls,
      note: c.negative ? 'Counterfactual family lookup, followed by delegation; does not prove autonomous choice.' : 'Explicit frozen discovery path; excludes downstream business requests.' })
  }
}
fs.writeFileSync(path.join(output, 'offline.json'), JSON.stringify({ baseline, rows }, null, 2))
const plan = { endpoint: process.env.FAMILY_ENDPOINT ?? '', model: process.env.FAMILY_MODEL ?? '', format: 'openai', cases,
  trajectories: cases.length * 2, maxRounds: 7, maxRequests: cases.length * 2 * 7, maxTokens: 2200,
  scope: 'Public tool definitions and synthetic inputs only. No production history, credentials, business tool execution, messages, schedules, Workers, Memory writes or deployment. Local discovery handlers and static guidance only; business results simulated.',
  variants: Object.fromEntries([['baseline',baseline],['candidate',candidate]].map(([v,r]) => {
    const f = assembly(r, true)
    const initial = f.tools()
    const definition = ({name,description,inputSchema}) => ({name,description,inputSchema})
    return [v, {prompt: f.prompt, tools: f.state.catalog.tools.map(definition), initial: initial.map(definition)}]
  })),
}
const planText=JSON.stringify(plan,null,2);const digest=createHash('sha256').update(planText).digest('hex')
const planPath=path.join(output,'plan.json')
if (fs.existsSync(planPath) && fs.readFileSync(planPath,'utf8')!==planText) throw new Error('Frozen inputs changed; use a fresh output directory')
fs.writeFileSync(planPath,planText,{mode:0o600})
console.log(JSON.stringify({prepared:output,digest,trajectories:plan.trajectories,maxRequests:plan.maxRequests,rows:rows.map(({id,variant,discoveryCalls,initialBytes,finalBytes})=>({id,variant,discoveryCalls,initialBytes,finalBytes}))}))
if (!process.argv.includes('--live')) process.exit()

const { createRequire }=await import('node:module')
const adminRequire=createRequire(path.join(process.env.FAMILY_RUNTIME,'crabot-admin/package.json'))
const {ModelProviderManager}=adminRequire('./dist/model-provider-manager.js')
const manager=new ModelProviderManager(path.join(process.env.FAMILY_DATA,'admin')); await manager.initialize()
const config=JSON.parse(fs.readFileSync(path.join(process.env.FAMILY_DATA,'admin/agent-configs/crabot-agent.json'),'utf8'))
const ref=config.model_config.powerful;const conn=await manager.buildConnectionInfo(ref.provider_id,ref.model_id)
if (conn.endpoint!==plan.endpoint || conn.model_id!==plan.model || conn.format!==plan.format) throw new Error('Configured model differs from frozen plan')
const resumeFixtures=process.argv.includes('--resume-fixtures')
const journalPath=path.join(output,'events.jsonl')
const previousEvents=resumeFixtures?fs.readFileSync(journalPath,'utf8').trim().split('\n').map(line=>JSON.parse(line)):[]
const journal=fs.openSync(journalPath,resumeFixtures?'a':'ax',0o600)
const record=row=>fs.writeSync(journal,JSON.stringify(row).replaceAll(conn.apikey,'[REDACTED]')+'\n')
let requests=previousEvents.filter(e=>e.type==='request').length
let reportedTokens=previousEvents.filter(e=>e.type==='response').reduce((total,e)=>{const u=e.response.usage;return total+(u?u.inputTokens+(u.cacheReadTokens??0)+u.outputTokens:0)},0)
const results=[...new Map(previousEvents.filter(e=>e.type==='end').map(e=>[`${e.id}/${e.variant}`,e])).values()]
if(resumeFixtures && results.length!==plan.trajectories)throw new Error('Complete the original run before resuming fixture gaps')
async function run(c,variant,root,previous) {
 const face=assembly(root,c.external),{StreamProcessor,createUserMessage,createAssistantMessage,createToolResultMessage}=face.engine
 const messages=previous?await restoreFixtureGap(face,previousEvents,previous):[createUserMessage(c.user)]
 if(!messages)return
 if(previous)record({type:'resume_fixture',id:c.id,variant,afterRound:previous.rounds,reason:'Supply synthetic Memory or workboard supporting results; earlier model requests are unchanged.'})
 const adapter=face.adapter(conn), reached=new Set(previous?.reached??[]), actions=[...(previous?.actions??[])]
 let discovery=previous?.discovery??0, status='round_limit', usage={...(previous?.usage??{input:0,cached:0,output:0,missing:0})}, round=0
 for(round=(previous?.rounds??0)+1;round<=plan.maxRounds;round++) {
  if(requests>=plan.maxRequests || reportedTokens>=800000){status='budget_stop';break}
  const tools=face.tools(); const processor=new StreamProcessor();const start=Date.now()
  record({type:'request',id:c.id,variant,round,number:++requests,toolNames:tools.map(t=>t.name),schemaBytes:face.bytes(tools),messages})
  try {for await(const chunk of adapter.stream({model:conn.model_id,systemPrompt:face.prompt,messages,tools,maxTokens:plan.maxTokens,signal:AbortSignal.timeout(60000)}))processor.process(chunk)}
  catch(error){status='provider_error';record({type:'error',id:c.id,variant,round,error:String(error)});break}
  const response=processor.finalize(); const u=response.usage
  if(u){usage.input+=u.inputTokens;usage.cached+=u.cacheReadTokens??0;usage.output+=u.outputTokens;reportedTokens+=u.inputTokens+(u.cacheReadTokens??0)+u.outputTokens}else usage.missing++
  record({type:'response',id:c.id,variant,round,elapsed:Date.now()-start,response})
  if(response.stopReason==='max_tokens'){status='truncated';break}
  if(!response.toolUseBlocks.length){status=c.targets.every(t=>reached.has(t))?'completed':'incomplete';break}
  messages.push(createAssistantMessage([...response.reasoningBlocks,...(response.text?[{type:'text',text:response.text}]:[]),...response.toolUseBlocks],response.stopReason,response.usage))
  let stop=false
  for(const call of response.toolUseBlocks) {
   actions.push({name:call.name,input:call.input})
   const visible=tools.find(t=>t.name===call.name);let result
   if(!visible){result={output:face.state.catalog.missingToolOutput(call.name),isError:true}}
   else if(['search_tools','load_tool_family','load_guidance'].includes(call.name)){
    discovery+=call.name!=='load_guidance'?1:0;result=await visible.call(call.input,{})
   } else if(c.targets.includes(call.name) || ['get_execution_capabilities','inspect_crabot'].includes(call.name) || supportsFixture(call.name,call.input)) {
    reached.add(call.name); result={output:JSON.stringify(simulatedResult(call.name,call.input)),isError:false}
   } else if(call.name==='send_message'){
    result={output:'Synthetic delivery recorded. No message was sent.',isError:false}
    status=c.targets.every(t=>reached.has(t))?'completed':'incomplete';stop=true
   } else {status='unsupported_business_action';result={output:'Replay does not execute this business operation.',isError:true};stop=true}
   messages.push(createToolResultMessage(call.id,result.output,result.isError));record({type:'result',id:c.id,variant,round,name:call.name,result})
  }
  if(stop)break
  if(c.targets.every(t=>reached.has(t))){status='targets_reached';break}
 }
 const row={id:c.id,variant,status,rounds:Math.min(round,plan.maxRounds),discovery,actions,reached:[...reached],usage,promptTokens:usage.input+usage.cached}
 const previousIndex=results.findIndex(r=>r.id===c.id&&r.variant===variant)
 if(previousIndex<0)results.push(row);else results[previousIndex]=row
 record({type:'end',...row}); console.log(JSON.stringify({id:c.id,variant,status,rounds:row.rounds,discovery,promptTokens:row.promptTokens,outputTokens:usage.output}))
}
try {
 for(const [i,c] of cases.entries()) {
  const arms=i%2?[['candidate',candidate],['baseline',baseline]]:[['baseline',baseline],['candidate',candidate]]
  for(const [variant,root] of arms) {
   const previous=results.find(r=>r.id===c.id&&r.variant===variant)
   if(resumeFixtures && previous?.status!=='unsupported_business_action')continue
   await run(c,variant,root,resumeFixtures?previous:undefined)
  }
 }
 fs.writeFileSync(path.join(output,'live.json'),JSON.stringify({digest,requests,reportedTokens,results},null,2))
} finally {fs.closeSync(journal)}
