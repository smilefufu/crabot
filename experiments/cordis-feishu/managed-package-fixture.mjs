import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import identity from '../../scripts/lib/process-identity.cjs'
const core = path.resolve(process.env.CORDIS_CORE_ROOT ?? fileURLToPath(new URL('../..', import.meta.url)))

/** Real npm business + Cordis/IPC host; only the external platform clients are synthetic. */
export async function verifyManagedPackage(packageDirectory, platform) {
  const plugin = await fs.realpath(packageDirectory)
  const data = await fs.mkdtemp(path.join(os.tmpdir(), `cordis-${platform}-host-`))
  const id = `${platform}-fixture`
  const loader = path.join(data, 'platform.mjs')
  await fs.writeFile(loader, String.raw`
    import { createRequire } from 'node:module'; import path from 'node:path'; import fs from 'node:fs'; import net from 'node:net'; import { pathToFileURL } from 'node:url';
    const root=process.env.FIXTURE_PLUGIN, platform=process.env.FIXTURE_PLATFORM;
    const load=createRequire(path.join(root,'package.json'));
    const file=async name=>import(pathToFileURL(path.join(root,'dist',name+'.js')).href);
    const sent=target=>process.send({type:'fixture:sent',target});
    const connect=net.Socket.prototype.connect;
    net.Socket.prototype.connect=function(...args){const first=Array.isArray(args[0])?args[0][0]:args[0];const host=typeof first==='object'?first?.host:typeof args[1]==='string'?args[1]:undefined;if(host&&!['localhost','127.0.0.1','::1'].includes(host))throw new Error('External TCP forbidden');return connect.apply(this,args)};
    globalThis.fetch=async()=>{throw new Error('External fetch forbidden')};
    if(platform==='telegram'){
      const {TelegramClient}=await file('telegram-client');let delivered=false;
      TelegramClient.prototype.getMe=async()=>({id:999,first_name:'Synthetic bot',username:'synthetic_bot'});
      TelegramClient.prototype.deleteWebhook=async()=>true;
      TelegramClient.prototype.getUpdates=async()=>{await new Promise(r=>setTimeout(r,25));if(delivered)return [];delivered=true;return [{update_id:1,message:{message_id:1,date:Math.floor(Date.now()/1000),from:{id:101,is_bot:false,first_name:'Synthetic user'},chat:{id:101,type:'private'},text:'synthetic inbound'}}]};
      TelegramClient.prototype.sendMessage=async target=>{sent(target);return {message_id:2,date:Math.floor(Date.now()/1000)}};
    }
    if(platform==='wechat'){
      const {WechatClient}=await file('wechat-client');
      WechatClient.prototype.getPuppet=async()=>({wechatNickname:'Synthetic',wechatUsername:'wxid_bot',status:'online'});
      WechatClient.prototype.listGroups=async()=>({items:[],pagination:{totalPages:0}});
      WechatClient.prototype.sendText=async target=>{sent(target);return {taskId:'synthetic-send'}};
      const Module=load('node:module'), original=Module._load;
      Module._load=function(request,parent,...args){
        if(request==='socket.io-client'&&parent?.filename.startsWith(root))return {io:()=>({on(event,handler){if(event==='wechat_message')queueMicrotask(()=>handler({eventId:'synthetic-in',timestamp:Date.now(),puppet:{puppetId:'puppet',wxid:'wxid_bot',nickname:'Bot'},message:{id:'synthetic-in',msgSvrId:'server-id',type:0,createTime:String(Date.now()),content:{type:0,text:'synthetic inbound'}},sender:{wxid:'wxid_sender',name:'Synthetic'},conversation:{id:'wxid_sender',name:'Synthetic',isGroup:false}}));return this},disconnect(){}})};
        return original.call(this,request,parent,...args)
      };
    }
    if(platform==='dingtalk'){
      const {StreamSubscriber}=await file('stream-subscriber');const {DingtalkClient}=await file('dingtalk-client');
      StreamSubscriber.prototype.start=async function(){this.state='connected';this.client={connected:true,disconnect(){}};queueMicrotask(()=>this.opts.onMessage({conversationId:'private-id',conversationType:'1',chatbotUserId:'bot',senderStaffId:'staff_user',senderNick:'Synthetic',robotCode:'robot',msgId:'synthetic-in',msgtype:'text',text:{content:'synthetic inbound'},createAt:Date.now()}))};
      DingtalkClient.prototype.sendOneToOneMessage=async target=>{sent(target);return 'synthetic-send'};
    }
    if(platform==='slack'){
      const {SlackClient}=await file('slack-client');
      SlackClient.prototype.call=async function(method,args={}){
        if(method==='auth.test')return {ok:true,team_id:'T1',user_id:'B1',bot_id:'BB1',response_metadata:{scopes:['files:read','files:write','reactions:write']}};
        if(method==='bots.info')return {bot:{app_id:'A1'}};
        if(method==='users.info')return {user:{id:args.user,name:'Synthetic',is_bot:false}};
        if(method==='conversations.info')return {channel:{id:args.channel,is_im:true,is_member:true}};
        if(method==='chat.postMessage'){sent(args.channel);return {ok:true,ts:String(Date.now()/1000)}};
        throw new Error('Unexpected synthetic Slack API: '+method)
      };
      SlackClient.prototype.start=async function(handler){this.fixtureConnected=true;Object.defineProperty(this,'connected',{get:()=>this.fixtureConnected&&!fs.existsSync(path.join(process.env.DATA_DIR,'disconnect')),set:value=>{this.fixtureConnected=value}});queueMicrotask(()=>handler({team_id:'T1',api_app_id:'A1',event_id:'synthetic-in',event:{type:'message',channel:'D1',channel_type:'im',user:'U1',ts:String(Date.now()/1000),text:'synthetic inbound'}}))};
      SlackClient.prototype.stop=async function(){this.connected=false};
    }
    if(platform==='feishu'){
      const {FeishuClient}=await file('feishu-client');const {WsSubscriber}=await file('ws-subscriber');const {FeishuChannel}=await file('feishu-channel');
      FeishuClient.prototype.getBotInfo=async()=>({app_id:'app',app_name:'Synthetic',open_id:'bot'});
      FeishuClient.prototype.listChats=async()=>({items:[]});
      FeishuClient.prototype.getUser=async id=>({open_id:id,name:'Synthetic'});
      FeishuClient.prototype.getChat=async id=>({chat_id:id,name:'Synthetic'});
      FeishuClient.prototype.getChatMembers=async()=>[];
      FeishuClient.prototype.sendText=async target=>{sent(target);return {message_id:'synthetic-send',create_time:String(Date.now())}};
      WsSubscriber.prototype.start=async function(){this.state='connected'};WsSubscriber.prototype.close=async function(){this.state='idle'};
      const start=FeishuChannel.prototype.start;
      FeishuChannel.prototype.start=async function(){await start.call(this);queueMicrotask(()=>this.handleMessageReceive({sender:{sender_id:{open_id:'synthetic-user'},sender_type:'user'},message:{message_id:'synthetic-in',chat_id:'synthetic-chat',chat_type:'p2p',message_type:'text',content:JSON.stringify({text:'synthetic inbound'}),create_time:String(Date.now())}}))};
    }
  `)
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|LANG|LC_[A-Z_]+)$/i.test(key)) env[key] = value
  }
  Object.assign(env, { DATA_DIR: data, CRABOT_HOME: core, CRABOT_RPC_TRANSPORT: 'ipc', CRABOT_MM_PORT: '19000',
    Crabot_MODULE_ID: id, Crabot_PORT: '24001', CRABOT_CHANNEL_IMPLEMENTATION_ID: `channel-${platform}`,
    CRABOT_CHANNEL_PLUGIN_PATH: path.join(plugin, 'dist/main.js'), FIXTURE_PLUGIN: plugin, FIXTURE_PLATFORM: platform,
    FEISHU_APP_ID: 'app', FEISHU_APP_SECRET: 'synthetic', TELEGRAM_BOT_TOKEN: 'synthetic',
    WECHAT_CONNECTOR_URL: 'http://127.0.0.1:9', WECHAT_API_KEY: 'synthetic', DINGTALK_APP_KEY: 'synthetic',
    DINGTALK_APP_SECRET: 'synthetic', DINGTALK_ROBOT_CODE: 'robot', SLACK_BOT_TOKEN: 'xoxb-synthetic', SLACK_APP_TOKEN: 'xapp-synthetic',
    ...(platform === 'voice' ? { CRABOT_VOICE_RUNTIME_BEARER: 'synthetic-runtime' } : {}) })
  const program = `import {startCordisChannel} from ${JSON.stringify(pathToFileURL(path.join(core, 'crabot-core/dist/channel-host.js')).href)};await startCordisChannel();process.send({type:'fixture:ready',listeners:process.listenerCount('message'),bearer_present:process.env.CRABOT_VOICE_RUNTIME_BEARER!==undefined})`
  const child = spawn(process.execPath, ['--import', pathToFileURL(loader).href, '--input-type=module', '-e', program], {
    cwd: core, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], serialization: 'advanced' })
  let output = '', ready
  const events = [], sends = []
  child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  child.on('message', message => { if (message?.type === 'fixture:ready') ready = message; if (message?.type === 'fixture:sent') sends.push(message.target) })
  const { RuntimeRpcPeer } = await import(pathToFileURL(path.join(core, 'crabot-shared/dist/runtime-rpc.js')).href)
  const peer = new RuntimeRpcPeer(child)
  let registered = false
  peer.handle(call => {
    if (call.method === 'register' || call.method === 'register_voice_runtime') {
      assert.equal(call.params.module_id, id); assert.equal(call.params.version, platform === 'feishu' ? '0.1.1' : '0.1.3')
      if (platform === 'voice') { assert.equal(call.method, 'register_voice_runtime'); assert.equal(call.metadata.authorizationBearer, 'synthetic-runtime'); assert.equal(call.params.protocol_version, '0.9.0') }
      registered = true; return { registered: true }
    }
    if (call.method === 'publish_event') { events.push(call.params.event); return { subscriber_count: 0 } }
    if (call.method === 'resolve') return { modules: [{ module_id: 'admin-web', port: 19002 }] }
    if (call.method === 'get_voice_config') { assert.equal(call.metadata.authorizationBearer, 'synthetic-runtime'); return { terminal_entry: null, contacts: [] } }
    throw new Error('Unexpected fixture RPC: ' + call.method)
  })
  const exited = once(child, 'exit')
  async function until(predicate) {
    const deadline = Date.now() + 10000
    while (!predicate()) {
      assert.equal(child.exitCode, null, output)
      if (Date.now() > deadline) throw new Error(`${platform} fixture timed out: ${output}`)
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  const call = (method, params = {}) => peer.call({ target: 24001, source: 'fixture', method, params }, 3000)
  try {
    await until(() => ready)
    assert.ok(registered); assert.equal(ready.listeners, 1); assert.equal(ready.bearer_present, false)
    assert.deepEqual(identity.listListeningTcpPorts(child.pid), [])
    assert.ok((await call('get_capabilities')).supported_message_types.length)
    if (platform === 'voice') {
      const description = await call('get_voice_transport'); assert.equal(description.server.pid, child.pid)
    } else {
      await until(() => events.some(event => event.type === 'channel.message_received'))
      const message = events.find(event => event.type === 'channel.message_received').payload.message
      assert.equal(message.session.channel_id, id)
      assert.ok((await call('get_sessions')).items.some(session => session.id === message.session.session_id))
      await call('send_message', { session_id: message.session.session_id, content: { type: 'text', text: 'synthetic reply' } })
      const expected = { telegram: '101', wechat: 'wxid_sender', dingtalk: ['staff_user'], slack: 'D1', feishu: { type: 'open_id', id: 'synthetic-user' } }[platform]
      assert.ok(sends.some(target => JSON.stringify(target) === JSON.stringify(expected)), `${platform}: wrong reply target ${JSON.stringify(sends)}`)
      if (platform === 'slack') {
        await fs.writeFile(path.join(data, 'disconnect'), '')
        assert.equal((await call('health')).status, 'degraded')
      }
    }
    child.disconnect()
    let timer
    try { assert.deepEqual(await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Cleanup timed out: ${output}`)), 10000) })]), [0, null], output) }
    finally { clearTimeout(timer) }
    assert.equal(output.includes('synthetic-runtime'), false)
  } finally {
    peer.close()
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
    await fs.rm(data, { recursive: true, force: true })
  }
}
