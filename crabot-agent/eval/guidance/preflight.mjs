// Decision-level, synthetic prompt comparison. No business tool is executable.
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
const repo = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(path.join(repo, 'crabot-agent/package.json'))
const ts = require('typescript')
const spec = fs.readFileSync(process.env.GUIDANCE_SPEC, 'utf8')
const out = process.env.GUIDANCE_OUTPUT
fs.mkdirSync(out, { recursive: true, mode: 0o700 })
if (fs.existsSync(path.join(out, 'events.jsonl'))) throw Error('Output already contains a run; use a new directory')
const baselineRef = process.env.GUIDANCE_BASELINE_REF
if (!baselineRef) throw Error('GUIDANCE_BASELINE_REF must identify the frozen pre-change commit')
function section(n) { return spec.split(`## ${n}. `)[1].split('\n## ')[0] }
function block(s) { return s.match(/```text\n([\s\S]*?)\n```/)[1] }
const cores = { manager: block(section(3)), worker: block(section(4)) }
const guides = Object.fromEntries([...spec.matchAll(/### [67]\.\d ([\w.-]+)：[^\n]+\n\n```text\n([\s\S]*?)\n```/g)].map(m => [m[1], m[2]]))
const catalog = role => Object.entries(guides).filter(([id])=>id.startsWith(role+'.')).map(([id,body])=>`${id}: ${body.split('\n')[0]}`).join('\n')
function literal(file, name) {
 const source=execFileSync('git',['show',`${baselineRef}:${file}`],{cwd:repo,encoding:'utf8'}); const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true); let found
 function visit(node) { if(ts.isVariableDeclaration(node)&&node.name.getText(ast)===name&&ts.isNoSubstitutionTemplateLiteral(node.initializer))found=node.initializer.text;ts.forEachChild(node,visit) };visit(ast)
 if(!found)throw Error('Missing literal '+name);return found
}
const oldManager=['MANAGER_IDENTITY','MANAGER_PROJECT_WORKSPACE_CONTEXT','MANAGER_WORKBOARD_CONTEXT','MANAGER_TOOL_DISCOVERY_CONTEXT'].map(n=>literal('crabot-agent/src/manager/prompt.ts',n)).join('\n\n').replace('{{sessionTarget}}','{"channel_id":"fixture","session_id":"synthetic"}')
const oldWorker=literal('crabot-agent/src/prompts/builtin-worker.ts','BUILTIN_WORKER_PROMPT').replace('{{workspaceRoot}}','/fixture')
const tool=(name,description,properties,required=Object.keys(properties))=>({type:'function',function:{name,description,parameters:{type:'object',properties,required}}})
const str={type:'string'}
const common=[tool('send_message','向当前会话投递消息。',{text:str}),tool('spawn_worker','向新执行器派发任务。',{prompt:str}),tool('read_worker_activity','读取指定执行器的结果或错误证据。',{worker_id:str}),tool('load_guidance','读取当前角色的内置工作流指南。',{name:str})]
const workerTools=[tool('Read','读取指定文件。',{file_path:str}),tool('Edit','精确替换文件中的一次文本。',{file_path:str,old_string:str,new_string:str}),tool('Bash','运行本例给定的核验命令。',{command:str}),tool('finish_task','报告完成结果或具体阻塞。',{outcome:{type:'string',enum:['completed','failed']},summary:str}),common[3]]
const cases=[
 {id:'answer',role:'manager',user:'把“下午三点开会”翻译成英语。',expect:'直接交付翻译，不派发、不加载工作流。'},
 {id:'no-task-permission',role:'manager',user:'请整理 /fixture/data.csv。当前有效事实：本会话 task=false，file_io=true；新建 builtin 执行器具备文件能力，但当前会话不允许派发。',expect:'不派发，说明需要调整当前会话任务管理权限。'},
 {id:'desktop-authorized',role:'manager',user:'请在桌面日历中查看明天的会议。当前有效事实：Master 私聊，本会话 task=true；builtin 已就绪，当前委托的 desktop=true，computer-use 已连接且可用。目标只读，不创建或发送邀请。',expect:'委托桌面只读查询，不因执行器身份拒绝，不扩大任务。'},
 {id:'idle-with-error',role:'manager',user:'执行器 w-fixture 通知：status=idle，kind=error。任务是读取报表，尚未取得成果。当前会话允许读取活动和继续委托。',expect:'先读取错误证据，不以 idle 当完成；区分普通错误与真实权限拒绝。',event:true},
 {id:'simple-fix',role:'worker',user:'一次性脚本 /fixture/add.py 的加法结果不对；请修复并运行 python /fixture/check.py 验证。这是独立临时文件，不属于项目或 Git 仓库，无需协作。你已有读写和执行权限。',expect:'读取、最小修复、核验，不初始化项目或强制分工。'},
 {id:'unclear-failure',role:'worker',user:'报表读取连续两次失败，原因不明。第二次只重试了相同输入。当前目录 /fixture，完整错误在 /fixture/error.log。请定位原因；保持只读，不能修改权限或换账号。',expect:'读取诊断工作流和错误，辨别真实授权拒绝，不绕过。'},
]
const snapshot={baseline:{manager:oldManager,worker:oldWorker},candidate:cores,guides,cases,tools:{manager:common,worker:workerTools},maxRounds:4,replicates:1}
const hash=createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')
const inputsFile=path.join(out,'inputs.json')
const inputs=JSON.stringify({...snapshot,sha256:hash},null,2)
if(fs.existsSync(inputsFile)){if(fs.readFileSync(inputsFile,'utf8')!==inputs)throw Error('Prepared inputs changed; use a new directory')}
else fs.writeFileSync(inputsFile,inputs,{mode:0o600,flag:'wx'})
if(process.argv.includes('--prepare')) {console.log(JSON.stringify({prepared:out,hash,cases:6,trajectories:12,maxRequests:48}));process.exit()}
// Uses the existing provider resolver. Secrets never enter artifacts or logs.
const host=process.env.REPLAY_RUNTIME_ROOT
const adminRequire=createRequire(path.join(host,'crabot-admin/package.json'))
const {ModelProviderManager}=adminRequire('./dist/model-provider-manager.js')
const config=JSON.parse(fs.readFileSync(path.join(process.env.REPLAY_DATA_DIR,'admin/agent-configs/crabot-agent.json'),'utf8'))
const resolver=new ModelProviderManager(path.join(process.env.REPLAY_DATA_DIR,'admin'));await resolver.initialize()
const ref=config.model_config.powerful;const conn=await resolver.buildConnectionInfo(ref.provider_id,ref.model_id)
if(conn.endpoint!=='https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'||conn.model_id!=='qwen3.8-max'||conn.format!=='openai')throw Error('Provider changed; review comparison scope')
const journal=fs.openSync(path.join(out,'events.jsonl'),'ax',0o600)
function record(row){fs.writeSync(journal,JSON.stringify(row)+'\n');fs.fsyncSync(journal)}
record({type:'plan',hash,endpoint:conn.endpoint,model:conn.model_id,trajectories:12,maxRequests:48,noRealTools:true,synthetic:true})
const slots=cases.flatMap(c=>['baseline','candidate'].map(variant=>({c,variant})))
async function run({c,variant}) {
 const id=c.id+'/'+variant;let prompt=variant==='baseline'?snapshot.baseline[c.role]:cores[c.role]+'\n\n可按需使用 load_guidance：\n'+catalog(c.role)
 if(c.event&&variant==='candidate')prompt+='\n\n'+guides['manager.worker-events']
 const messages=[{role:'system',content:prompt},{role:'user',content:c.user}]
 const tools=(c.role==='manager'?common:workerTools).filter(t=>variant==='candidate'||t.function.name!=='load_guidance')
 let file='def add(a, b):\n    return a - b\n';record({type:'start',id})
 for(let round=0;round<4;round++){
  record({type:'request',id,round,messages,tools})
  let response
  try{
   const result=await fetch(conn.endpoint+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+conn.apikey,'Content-Type':'application/json'},body:JSON.stringify({model:conn.model_id,messages,tools,max_tokens:1800,stream:false}),signal:AbortSignal.timeout(90000)})
   response=await result.json();if(!result.ok)throw Error(JSON.stringify(response))
  }catch(error){record({type:'missing',id,round,error:String(error).replaceAll(conn.apikey,'[REDACTED]')});return}
  record({type:'response',id,round,response}); const message=response.choices?.[0]?.message
  if(!message){record({type:'missing',id,round,error:'no message'});return}
  messages.push(message)
  if(!message.tool_calls?.length){record({type:'end',id,reason:'response-ended'});return}
  for(const call of message.tool_calls){
   let args;try{args=JSON.parse(call.function.arguments)}catch{record({type:'harness_gap',id,reason:'invalid arguments'});return}
   const name=call.function.name;let receipt
   if(name==='load_guidance'&&args.name?.startsWith(c.role+'.')&&guides[args.name])receipt=guides[args.name]
   else if(name==='send_message'){receipt={delivered:true};}
   else if(name==='spawn_worker'){receipt={accepted:true,worker_id:'w-simulated',state:'running'};}
   else if(name==='read_worker_activity'&&c.id==='idle-with-error')receipt={worker_id:'w-fixture',status:'idle',error:'Permission denied: principal file_io=false',result:null}
   else if(name==='Read'&&args.file_path==='/fixture/add.py')receipt=file
   else if(name==='Read'&&args.file_path==='/fixture/error.log')receipt='Read rejected before opening report.csv. Effective principal file_io=false. Authorization denial; credentials and report are present.'
   else if(name==='Edit'&&args.file_path==='/fixture/add.py'&&file.includes(args.old_string)){file=file.replace(args.old_string,args.new_string);receipt='Updated'}
   else if(name==='Bash'&&args.command.trim()==='python /fixture/check.py')receipt=file.includes('return a + b')?'PASS: add(2,3)=5; add(-1,1)=0':'FAIL: add(2,3)=-1'
   else if(name==='finish_task')receipt={accepted:true}
   else{record({type:'harness_gap',id,name,args});return}
   record({type:'simulated_tool',id,name,args,receipt});messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(receipt)})
   if(['spawn_worker','finish_task'].includes(name)){record({type:'end',id,reason:'decision-observed'});return}
  }
 }
 record({type:'end',id,reason:'round-limit'})
}
async function consume(){while(slots.length)await run(slots.shift())}
await Promise.all([consume(),consume()]);fs.closeSync(journal);console.log(JSON.stringify({finished:out,hash}))
