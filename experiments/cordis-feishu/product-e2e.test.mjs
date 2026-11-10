import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import control from '../../scripts/lib/runtime-control.cjs'
import identity from '../../scripts/lib/process-identity.cjs'
import { launchNormalFixture } from './normal-instance-fixture.mjs'
const root = fileURLToPath(new URL('../..', import.meta.url))

async function freePort() {
  const listener = net.createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  return port
}

test('normal Crabot completes npm Feishu QR onboarding and delivers a synthetic model reply through the real Agent', { timeout: 120_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-normal-cordis-'))
  const web = await freePort()
  const artifact = process.env.CORDIS_PLUGIN_TARBALL, npmCache = process.env.CORDIS_NPM_CACHE_DIR
  if (!artifact || !npmCache) throw new Error('CORDIS_PLUGIN_TARBALL and CORDIS_NPM_CACHE_DIR must point to the test npm artifact and prepared domestic cache')
  const packageVersion = path.join(directory, 'admin/channel-packages/crabot-channel-feishu/0.1.0')

  const plugin = path.join(packageVersion, 'node_modules/crabot-channel-feishu')
  const incoming = path.join(directory, 'platform-input.json'), outgoing = path.join(directory, 'platform-output.jsonl')
  const preload = path.join(directory, 'synthetic-platform.cjs')
  await fs.writeFile(preload, String.raw`
    const fs=require('node:fs'),path=require('node:path')
    const originalFetch=globalThis.fetch
    globalThis.fetch=async(url,options)=>{
      const text=String(url)
      if(text==='https://accounts.feishu.cn/oauth/v1/app/registration'){
        const action=new URLSearchParams(options.body).get('action')
        const body=action==='init'?{supported_auth_methods:['client_secret']}:
          action==='begin'?{device_code:'synthetic-device',verification_uri_complete:'https://accounts.feishu.cn/synthetic',interval:1,expires_in:120}:
          {client_id:'synthetic-app',client_secret:'synthetic-secret',user_info:{open_id:'synthetic-owner'}}
        return new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}})
      }
      if(/^https?:/.test(text)&&!/^http:\/\/(?:127[.]0[.]0[.]1|localhost)(?::|\/)/.test(text))throw new Error('External fetch forbidden in synthetic fixture')
      return originalFetch(url,options)
    }
    const net=require('node:net'),connect=net.Socket.prototype.connect
    net.Socket.prototype.connect=function(...args){
      const first=Array.isArray(args[0])?args[0][0]:args[0]
      const options=typeof first==='object'?first:undefined
      const host=options?.host??(typeof args[1]==='string'?args[1]:undefined)
      const socketPath=typeof args[0]==='string'?args[0]:options?.path
      if(socketPath&&!socketPath.startsWith('/tmp/')&&!socketPath.startsWith('/private/tmp/')&&!socketPath.startsWith('\\\\.'))throw new Error('External pipe forbidden')
      if(host&&!['127.0.0.1','localhost','::1'].includes(host))throw new Error('External TCP forbidden in synthetic fixture')
      return connect.apply(this,args)
    }
    const {ChannelPackageStore}=require(${JSON.stringify(path.join(root,'crabot-admin/dist/channel-package.js'))})
    const ensure=ChannelPackageStore.prototype.ensure
    ChannelPackageStore.prototype.ensure=function(definition,options={}){return ensure.call(this,definition,{...options,specification:${JSON.stringify(artifact)},cache:${JSON.stringify(npmCache)},execute:(node,args,opts)=>require('node:util').promisify(require('node:child_process').execFile)(node,[...args,'--offline'],opts)})}
    let patched=false
    function patchPlatform(){
      if(patched||!fs.existsSync(${JSON.stringify(path.join(plugin,'dist/main.js'))}))return
      patched=true
    const {FeishuClient}=require(${JSON.stringify(path.join(plugin,'dist/feishu-client.js'))})
    const {WsSubscriber}=require(${JSON.stringify(path.join(plugin,'dist/ws-subscriber.js'))})
    const {FeishuChannel}=require(${JSON.stringify(path.join(plugin,'dist/feishu-channel.js'))})
    FeishuClient.prototype.addReaction=async()=>{}
    FeishuClient.prototype.getBotInfo=async()=>({app_id:'synthetic-app',app_name:'Synthetic bot',open_id:'synthetic-bot'})
    FeishuClient.prototype.listChats=async()=>({items:[]})
    FeishuClient.prototype.getUser=async(id)=>({open_id:id,name:'Synthetic user'})
    FeishuClient.prototype.getChat=async(id)=>({chat_id:id,name:'Synthetic group'})
    FeishuClient.prototype.getChatMembers=async()=>[{open_id:'synthetic-owner',name:'Synthetic user'}]
    FeishuClient.prototype.listMessages=async()=>({items:fs.existsSync(${JSON.stringify(incoming)})?JSON.parse(fs.readFileSync(${JSON.stringify(incoming)},'utf8')).map(event=>({message_id:event.message.message_id,chat_id:event.message.chat_id,msg_type:event.message.message_type,body:{content:event.message.content},sender:{id:event.sender.sender_id.open_id,sender_type:'user'},create_time:event.message.create_time})):[],has_more:false})
    FeishuClient.prototype.downloadResource=async(_message,_key,type)=>type==='image'?Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'):Buffer.from('synthetic file')
    const record=(type,receive,content)=>{
      fs.appendFileSync(${JSON.stringify(outgoing)},JSON.stringify({type,receive,content})+'\n')
      return {message_id:'synthetic-sent-'+Date.now(),create_time:String(Date.now())}
    }
    FeishuClient.prototype.sendText=async(receive,text)=>record('text',receive,text)
    FeishuClient.prototype.sendCard=async(receive,card)=>record('card',receive,card)
    FeishuClient.prototype.sendImage=async(receive,key)=>record('image',receive,key)
    FeishuClient.prototype.sendFile=async(receive,key)=>record('file',receive,key)
    FeishuClient.prototype.reply=async(id,type,content)=>record(type,{type:'reply',id},content)
    FeishuClient.prototype.uploadImage=async()=> 'synthetic-image'
    FeishuClient.prototype.uploadFile=async()=> 'synthetic-file'
    WsSubscriber.prototype.start=async function(){this.state='connected'}
    WsSubscriber.prototype.close=async function(){this.state='idle'}
    const start=FeishuChannel.prototype.start,stop=FeishuChannel.prototype.stop
    FeishuChannel.prototype.start=async function(){
      await start.call(this)
      const seen=new Set()
      this.fixtureTimer=setInterval(()=>{
        if(!fs.existsSync(${JSON.stringify(incoming)}))return
        for(const event of JSON.parse(fs.readFileSync(${JSON.stringify(incoming)},'utf8'))){
          if(seen.has(event.message.message_id))continue
          seen.add(event.message.message_id)
          this.handleMessageReceive(event).catch(error=>fs.appendFileSync(${JSON.stringify(outgoing)},JSON.stringify({error:error.message})+'\n'))
        }
      },25)
    }
    FeishuChannel.prototype.stop=async function(){clearInterval(this.fixtureTimer);return stop.call(this)}
    }
    const Module=require('node:module'),load=Module._load
    Module._load=function(request,...args){if(typeof request==='string'&&request.startsWith(${JSON.stringify(plugin)}))patchPlatform();return load.call(this,request,...args)}
    patchPlatform()
  `)
  const requests = []
  let replySession
  const provider = http.createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const input = JSON.parse(body)
    requests.push(input)
    if (requests.length > 20) { response.writeHead(500).end('{}'); return }
    const shouldSend = input.tools?.some(tool=>tool.function?.name==='send_message') && input.messages?.at(-1)?.role !== 'tool'
    const message = shouldSend ? { role:'assistant',content:null,tool_calls:[{id:'synthetic-call-'+requests.length,type:'function',function:{name:'send_message',arguments:JSON.stringify({channel_id:'飞书验证',session_id:replySession,content:'SYNTHETIC_CORDIS_REPLY',post_send_action:'none'})}}] } : {role:'assistant',content:''}
    const finishReason = shouldSend ? 'tool_calls' : 'stop'
    const delta = shouldSend ? {...message,tool_calls:message.tool_calls.map((tool,index)=>({...tool,index}))} : message
    if (input.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write('data: ' + JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', model: 'synthetic-model', choices: [{index:0,delta,finish_reason:null}] }) + '\n\n')
      response.end('data: ' + JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', model: 'synthetic-model', choices: [{index:0,delta:{},finish_reason:finishReason}] }) + '\n\ndata: [DONE]\n\n')
    } else response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ id:'synthetic',object:'chat.completion',model:'synthetic-model',choices:[{index:0,message,finish_reason:finishReason}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2} }))
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))

  const fixture = launchNormalFixture(directory, web, { preload, initializeCredentials: true })
  const { child, exited } = fixture
  let passed = false
  try {
    const [ready] = await fixture.ready
    assert.equal(ready.type, 'ready')
    const response = await fetch(`http://127.0.0.1:${web}/api/auth/me`)
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error, 'Unauthorized')
    assert.deepEqual(identity.listListeningTcpPorts(ready.pid), [])
    const ports = []
    for (const module of ready.modules) {
      const listening = identity.listListeningTcpPorts(module.pid)
      if (module.module_id === 'admin-web') assert.deepEqual(listening, [web])
      else assert.deepEqual(listening, [])
      ports.push(...listening)
    }
    assert.deepEqual(ports, [web])
    assert.ok(['healthy', 'degraded'].includes((await control.callRuntimeControl(directory,
      { target: 19339, source: 'fixture', method: 'health', params: {} }, { timeoutMs: 1500 })).status))

    const base = `http://127.0.0.1:${web}`
    let token
    async function api(route, method = 'GET', body) {
      const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const value = await response.json()
      assert.ok(response.ok, `${route}: ${response.status}: ${JSON.stringify(value)}`)
      return value
    }
    token = (await api('/api/auth/login', 'POST', { password: 'synthetic-test-only' })).token
    const model = await api('/api/model-providers', 'POST', { name:'Synthetic local only',type:'manual',format:'openai',endpoint:`http://127.0.0.1:${provider.address().port}/v1`,api_key:'synthetic-only',models:[{model_id:'synthetic-model',display_name:'Synthetic',type:'llm',supports_vision:true,context_window:200000,max_tokens:2048}] })
    await api('/api/model-config/global', 'PATCH', {default_llm_provider_id:model.id,default_llm_model_id:'synthetic-model'})
    const admissionDeadline = Date.now() + 30000
    let admitted = false
    while (Date.now() < admissionDeadline) {
      const adminHealth = await control.callRuntimeControl(directory, {target:ready.modules.find(module=>module.module_id==='admin-web').port,source:'fixture',method:'health',params:{}})
      if (adminHealth.details.cutover_ready) { admitted = true; break }
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    assert.equal(admitted, true, 'Actual authenticated Admin/Agent cutover did not complete')
    const begin = await api('/api/channels/onboard/begin', 'POST', {implementation_id:'channel-feishu',method_id:'device_code_oauth'})
    assert.equal(begin.ui_mode, 'qrcode')
    assert.ok(begin.verification_uri.includes('from=onboard'))
    const poll = await fetch(base + `/api/channels/onboard/poll?implementation_id=channel-feishu&method_id=device_code_oauth&session_id=${begin.session_id}&token=${encodeURIComponent(token)}`)
    assert.equal(poll.status, 200)
    assert.match(await poll.text(), /event: success/)
    const finished = await api('/api/channels/onboard/finish', 'POST', {implementation_id:'channel-feishu',method_id:'device_code_oauth',session_id:begin.session_id,name:'飞书验证'})
    assert.equal(finished.instance.id, '飞书验证')
    assert.ok(finished.master_friend_id)
    assert.ok(finished.scope_grant_url)
    assert.ok(finished.event_subscription)
    assert.equal(JSON.stringify(finished).includes('synthetic-secret'), false)
    const beforeMessage = await control.callRuntimeControl(directory,{target:19339,source:'fixture',method:'list_modules',params:{}})
    const channel = beforeMessage.modules.find(module=>module.module_id==='飞书验证')
    replySession = (await control.callRuntimeControl(directory,{target:channel.port,source:'fixture',method:'find_or_create_private_session',params:{platform_user_id:'synthetic-owner'}})).session.id
    const deadline = Date.now() + 30000
    const inbound = {sender:{sender_id:{open_id:'synthetic-owner'},sender_type:'user'},message:{message_id:'synthetic-inbound',chat_id:'synthetic-chat',chat_type:'p2p',message_type:'text',content:JSON.stringify({text:'你好，请回复收到。'}),create_time:String(Date.now())}}
    await fs.writeFile(incoming, JSON.stringify([inbound]))
    let delivered
    while (Date.now() < deadline) {
      try { delivered = (await fs.readFile(outgoing,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(item=>JSON.stringify(item.content).includes('SYNTHETIC_CORDIS_REPLY')) } catch {}
      if (delivered) break
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    assert.ok(delivered, `No synthetic Agent reply after ${requests.length} local model requests`)
    assert.ok(requests.length > 0)
    assert.equal(delivered.receive.id, 'synthetic-owner')
    const currentModules = await control.callRuntimeControl(directory, {target:19339,source:'fixture',method:'list_modules',params:{}})
    const feishu = currentModules.modules.find(module=>module.module_id==='飞书验证')
    assert.equal(feishu.status,'running')
    assert.deepEqual(identity.listListeningTcpPorts(feishu.pid),[])
    const callChannel = (method, params) => control.callRuntimeControl(directory,{target:feishu.port,source:'fixture',method,params},{timeoutMs:5000})
    const events = [inbound]
    const deliveryCount = async () => (await fs.readFile(outgoing,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line)).filter(item=>JSON.stringify(item.content).includes('SYNTHETIC_CORDIS_REPLY')).length
    async function receive(event, count) {
      events.push(event)
      await fs.writeFile(incoming+'.tmp',JSON.stringify(events)); await fs.rename(incoming+'.tmp',incoming)
      const deadline=Date.now()+30000
      while(Date.now()<deadline){if(await deliveryCount()>=count)break;await new Promise(resolve=>setTimeout(resolve,50))}
      assert.equal(await deliveryCount(),count)
      await new Promise(resolve=>setTimeout(resolve,100))
    }
    const image = {...inbound,message:{...inbound.message,message_id:'synthetic-image-in',message_type:'image',content:JSON.stringify({image_key:'synthetic-image'}),create_time:String(Date.now())}}
    const imageRequestStart = requests.length
    await receive(image,2)
    assert.ok(requests.slice(imageRequestStart).some(request=>JSON.stringify(request.messages).includes('data:image/png;base64,')), 'Real Agent did not include downloaded image in its local model input')
    const storedImage = await callChannel('get_message',{session_id:replySession,platform_message_id:'synthetic-image-in'})
    assert.equal(storedImage.content.status,'ready')
    const file = {...inbound,message:{...inbound.message,message_id:'synthetic-file-in',message_type:'file',content:JSON.stringify({file_key:'synthetic-file',file_name:'synthetic.txt',file_size:14}),create_time:String(Date.now())}}
    await receive(file,3)
    const storedFile = await callChannel('get_message',{session_id:replySession,platform_message_id:'synthetic-file-in'})
    assert.equal(storedFile.content.status,'not_fetched')
    assert.ok(storedFile.content.handle)
    const fetched = await callChannel('fetch_media',{handle:storedFile.content.handle})
    assert.equal(await fs.readFile(fetched.file_path,'utf8'),'synthetic file')
    const history = await callChannel('get_history',{session_id:replySession,limit:20})
    assert.ok(history.items.some(item=>item.platform_message_id==='synthetic-file-in'))
    assert.ok(history.items.some(item=>item.platform_message_id==='synthetic-image-in'))
    await callChannel('send_message',{session_id:replySession,content:{type:'image',file_path:storedImage.content.file_path || storedImage.content.media?.[0]?.media_url}})
    await callChannel('send_message',{session_id:replySession,content:{type:'file',file_path:fetched.file_path,filename:'synthetic.txt'}})
    const sentMedia = (await fs.readFile(outgoing,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line))
    assert.ok(sentMedia.some(item=>item.type==='image'))
    assert.ok(sentMedia.some(item=>item.type==='file'))
    const privateSession=replySession
    const group={...inbound,message:{...inbound.message,message_id:'synthetic-group-bootstrap',chat_id:'synthetic-group',chat_type:'group',mentions:[{key:'@_user_1',id:{open_id:'synthetic-bot'},name:'Synthetic bot'}],content:JSON.stringify({text:'@_user_1 你好'}),create_time:String(Date.now())}}
    // Discover the real canonical group session before the simulated model selects its reply target.
    events.push(group)
    await fs.writeFile(incoming+'.tmp',JSON.stringify(events)); await fs.rename(incoming+'.tmp',incoming)
    const groupDeadline=Date.now()+5000
    let groupSession
    while(Date.now()<groupDeadline){groupSession=(await callChannel('get_sessions',{type:'group'})).items.find(session=>session.platform_session_id==='synthetic-group');if(groupSession)break;await new Promise(resolve=>setTimeout(resolve,10))}
    assert.ok(groupSession)
    replySession=groupSession.id
    const groupWait=Date.now()+30000
    while(Date.now()<groupWait){if(await deliveryCount()>=4)break;await new Promise(resolve=>setTimeout(resolve,50))}
    assert.equal(await deliveryCount(),4)
    const groupSent=(await fs.readFile(outgoing,'utf8')).split('\n').filter(Boolean).map(line=>JSON.parse(line)).find(item=>item.receive?.id==='synthetic-group'&&JSON.stringify(item.content).includes('SYNTHETIC_CORDIS_REPLY'))
    assert.ok(groupSent)
    await fs.writeFile(incoming+'.tmp','[]');await fs.rename(incoming+'.tmp',incoming)
    const restarted=await api('/api/channel-instances/'+encodeURIComponent('飞书验证')+'/restart','POST',{})
    const restartDeadline=Date.now()+10000
    let newChannel
    while(Date.now()<restartDeadline){const list=await control.callRuntimeControl(directory,{target:19339,source:'fixture',method:'list_modules',params:{}});newChannel=list.modules.find(module=>module.module_id==='飞书验证');if(newChannel.status==='running'&&newChannel.pid!==feishu.pid)break;await new Promise(resolve=>setTimeout(resolve,50))}
    assert.equal(newChannel.status,'running');assert.notEqual(newChannel.pid,feishu.pid)
    const restored=await control.callRuntimeControl(directory,{target:newChannel.port,source:'fixture',method:'find_or_create_private_session',params:{platform_user_id:'synthetic-owner'}})
    assert.equal(restored.session.id,privateSession)
    assert.deepEqual(identity.listListeningTcpPorts(newChannel.pid),[])

    child.kill('SIGTERM')
    const [code, signal] = await exited
    assert.equal(code, 0); assert.equal(signal, null)
    assert.equal((await fs.readdir(directory)).includes('instance-runtime.json'), false)
    passed = true
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await exited }
    provider.closeAllConnections(); await new Promise(resolve=>provider.close(resolve))
    if (passed) await fs.rm(directory, { recursive: true, force: true })
    else { await fs.writeFile(path.join(directory, 'fixture.log'), fixture.output()); console.log('Retained normal-instance diagnostics:', directory) }
  }
})
