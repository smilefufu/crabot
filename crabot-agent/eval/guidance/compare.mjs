// Isolated decision comparison using current production prompt/schema assembly.
// All business tool calls are simulated; only product guidance reads are evaluated locally.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { initialFile, simulateFixtureTool, fixtureCapabilities } from './fixtures.mjs'
const repo=path.resolve(import.meta.dirname,'../../..')
const req=createRequire(path.join(repo,'crabot-agent/package.json'))
const frozen=JSON.parse(fs.readFileSync(process.env.GUIDANCE_FROZEN,'utf8'))
const out=process.env.GUIDANCE_OUTPUT
fs.mkdirSync(out,{recursive:true,mode:0o700})
if(fs.existsSync(path.join(out,'events.jsonl')))throw Error('Output already contains a run; use a new directory')
const never=async()=>{throw Error('Business tool execution disabled')}
const {createCrabMemoryServer}=req('./dist/mcp/crab-memory.js')
const {buildManagerToolFace}=req('./dist/manager/tools/tool-face.js')
const {assembleManagerSystemPrompt}=req('./dist/manager/prompt.js')
const {assembleBuiltinWorkerPrompt}=req('./dist/prompts/builtin-worker.js')
const {createGuidanceTool,renderGuidance}=req('./dist/guidance/catalog.js')
const transport={rpcClient:{call:never},moduleId:'fixture',getMemoryPort:never}
const face=buildManagerToolFace({harness:{},workerContext:()=>({managerKey:'fixture::synthetic'}),messagingDeps:{...transport,getAdminPort:never,resolveChannelPort:never},memoryServer:createCrabMemoryServer(transport,{visibility:'private',scopes:[],isMasterPrivate:false}),callAdmin:never,isSystemThread:false,managerTarget:{channel_id:'fixture',session_id:'synthetic'},workboard:{store:{},managerKey:'fixture::synthetic'},projectDocs:{}})
const subset=new Set(['send_message','spawn_worker','get_worker_activity','get_worker_turn','resolve_worker_turn','get_execution_capabilities','load_guidance'])
const worker=['Read','Edit','Bash'].map(name=>req(`./dist/engine/tools/${name.toLowerCase()}-tool.js`)[`create${name}Tool`](()=>'/fixture'))
worker.push(createGuidanceTool('worker'))
const finish={name:'finish_task',description:'完成或受阻时报告实际成果与依据。',inputSchema:{type:'object',properties:{outcome:{type:'string',enum:['completed','failed']},summary:{type:'string'}},required:['outcome','summary']}}
worker.push(finish)
const defs={manager:face.filter(t=>subset.has(t.name)),worker}
const cases=frozen.cases.map(c=>({...c,user:c.user.replace('请整理 /fixture/data.csv。','请按整行去重 /fixture/data.csv，另存 /fixture/dedup.csv，不改变行顺序。')}))
function wire(t){return{type:'function',function:{name:t.name,description:t.description,parameters:t.inputSchema}}}
const conditions=cases.flatMap(c=>['baseline','candidate'].map(variant=>{
 const prompt=variant==='baseline'?frozen.baseline[c.role] : c.role==='manager'?assembleManagerSystemPrompt({managerKey:'fixture::synthetic',isSystemThread:false}):assembleBuiltinWorkerPrompt({workspaceRoot:'/fixture',imageAvailable:false})
 const guidance=variant==='candidate'&&c.role==='manager'&&c.event?[renderGuidance('manager','manager.worker-events')]:[]
 return{id:c.id+'/'+variant,c,variant,prompt,guidance,tools:defs[c.role].filter(t=>variant==='candidate'||t.name!=='load_guidance').map(wire)}
}))
const frozenPlan={conditions,maxRounds:6,replicates:1,noBusinessTools:true,synthetic:true}
const hash=createHash('sha256').update(JSON.stringify(frozenPlan)).digest('hex')
const inputsFile=path.join(out,'inputs.json')
const inputs=JSON.stringify({...frozenPlan,sha256:hash},null,2)
if(fs.existsSync(inputsFile)){if(fs.readFileSync(inputsFile,'utf8')!==inputs)throw Error('Prepared inputs changed; use a new directory')}
else fs.writeFileSync(inputsFile,inputs,{mode:0o600,flag:'wx'})
if(process.argv.includes('--prepare')){console.log(JSON.stringify({out,hash,trajectories:12,maxRequests:72}));process.exit()}
const adminReq=createRequire(path.join(process.env.REPLAY_RUNTIME_ROOT,'crabot-admin/package.json'))
const {ModelProviderManager}=adminReq('./dist/model-provider-manager.js')
const config=JSON.parse(fs.readFileSync(path.join(process.env.REPLAY_DATA_DIR,'admin/agent-configs/crabot-agent.json'),'utf8'))
const resolver=new ModelProviderManager(path.join(process.env.REPLAY_DATA_DIR,'admin'));await resolver.initialize()
const ref=config.model_config.powerful;const conn=await resolver.buildConnectionInfo(ref.provider_id,ref.model_id)
if(conn.endpoint!=='https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'||conn.model_id!=='qwen3.8-max'||conn.format!=='openai')throw Error('Provider changed')
const journal=fs.openSync(path.join(out,'events.jsonl'),'ax',0o600)
function record(x){fs.writeSync(journal,JSON.stringify(x)+'\n');fs.fsyncSync(journal)}
record({type:'plan',hash,endpoint:conn.endpoint,model:conn.model_id,maxRequests:72})
async function run(condition){
 const {id,c}=condition;const messages=[{role:'system',content:condition.prompt},...condition.guidance.map(content=>({role:'user',content})),{role:'user',content:c.user}]
 const state={file:initialFile,passed:false};let reminded=false;record({type:'start',id})
 const finish=(reason)=>record({type:'end',id,reason,fixtureVerified:state.passed})
 for(let round=0;round<6;round++){
  record({type:'request',id,round,messages,tools:condition.tools});let response
  try{const r=await fetch(conn.endpoint+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+conn.apikey,'Content-Type':'application/json'},body:JSON.stringify({model:conn.model_id,messages,tools:condition.tools,max_tokens:2000,stream:false}),signal:AbortSignal.timeout(90000)});response=await r.json();if(!r.ok)throw Error(JSON.stringify(response))}
  catch(error){record({type:'missing',id,round,error:String(error).replaceAll(conn.apikey,'[REDACTED]')});return}
  record({type:'response',id,round,response});const m=response.choices?.[0]?.message
  if(!m){record({type:'missing',id,round,error:'no message'});return}
  messages.push(m)
  if(!m.tool_calls?.length){
   if(c.role==='manager'&&!reminded&&!messages.some(x=>x.role==='tool'&&x.content.includes('"delivered":true'))){
    reminded=true;messages.push({role:'user',content:'[系统提醒] 普通 assistant text 只留在内部，人类看不到。若刚才的内容需要人类看到且尚未投递，调用 send_message 发送一次；内部记录则直接结束。'});continue
   }
   finish('response-ended');return
  }
  for(const call of m.tool_calls){
   const name=call.function.name;let a;try{a=JSON.parse(call.function.arguments)}catch{record({type:'harness_gap',id,reason:'invalid arguments'});return}
   let receipt
   if(name==='load_guidance'){const r=await createGuidanceTool(c.role).call(a,{});receipt={...r};}
   else if(name==='send_message')receipt={delivered:true}
   else if(name==='spawn_worker')receipt={status:'spawned',worker_id:'w-simulated',impl:'builtin'}
   else if(name==='get_execution_capabilities')receipt=fixtureCapabilities(c.id,a.worker_id)
   else if(name==='get_worker_activity'&&c.id==='idle-with-error')receipt={worker_id:'w-fixture',status:'idle',activities:[{kind:'error',text:'Permission denied: principal file_io=false'}],result:null}
   else if(name==='get_worker_turn'&&c.id==='idle-with-error')receipt={worker_id:'w-fixture',turn:null,reason:'activity notification, no completed turn'}
   else try{receipt=simulateFixtureTool(name,a,state)}catch{record({type:'harness_gap',id,name,args:a});return}
   record({type:'simulated_tool',id,name,args:a,receipt});messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(receipt)})
   if(name==='spawn_worker'||name==='finish_task'){finish('decision-observed');return}
  }
 }
 finish('round-limit')
}
const slots=[...conditions];async function consume(){while(slots.length)await run(slots.shift())}
await Promise.all([consume(),consume()]);fs.closeSync(journal);console.log(JSON.stringify({finished:out,hash}))
