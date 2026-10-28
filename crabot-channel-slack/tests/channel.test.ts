import { RpcError } from 'crabot-shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigStore } from '../src/config.js'
import { SlackChannel } from '../src/slack-channel.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
function setup(dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-test-'))) {
  dirs.push(dir)
  let outboundTimestamp = Date.now() / 1000 + 1
  const api = { call: vi.fn(async (method: string, args: any) => {
    if (method === 'conversations.info') return { channel: { id: args.channel, is_im: args.channel.startsWith('D'), is_member: true, name: 'room' } }
    if (method === 'conversations.open') return { channel: { id: 'D1', is_im: true, user: 'U1' } }
    if (method === 'users.info') return { user: { id: args.user, name: 'Alice', profile: {} } }
    if (method === 'chat.postMessage') return { ts: String(outboundTimestamp += 0.001) }
    return { channels: [] }
  }), start: vi.fn(async () => {}), stop: vi.fn(async () => {}), connected: true }
  const events: any[] = []
  const channel = new SlackChannel({ module_id: 'slack-test', port: 0, data_dir: dir,
    env: { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_APP_TOKEN: 'xapp-test' } }, api as any)
  ;(channel as any).identity = { team_id: 'T1', user_id: 'B1', app_id: 'A1' }
  ;(channel as any).rpcClient.publishEvent = vi.fn(async (event: any) => { events.push(event) })
  const rpc = (method: string, params: any = {}) => Promise.resolve().then(() => (channel as any).methodHandlers.get(method)(params))
  const receive = (event: any, id = event.ts) => channel.receive({ team_id: 'T1', api_app_id: 'A1', event_id: id, event })
  let timestamp = Date.now() / 1000
  const message = (channel = 'C1', text = '<@B1> hello', extra = {}) => ({ type: 'message', channel, user: 'U1', ts: String(timestamp += 0.001), text, ...extra })
  return { channel, api, events, rpc, receive, message, dir }
}
describe('Slack ordinary conversation routing', () => {
  it('admits DMs and real group mentions; thread history grants no exception', async () => {
    const s = setup()
    await s.receive(s.message('D1', 'hi'), 'dm')
    await s.receive(s.message('C1', '<@B1> hi', { thread_ts: '100.001' }), 'mention')
    await s.receive(s.message('C1', 'follow up', { thread_ts: '100.001' }), 'follow')
    await s.receive(s.message('C1', '@Crabot / <@B10>'), 'fake')
    const incoming = s.events.filter(e => e.type === 'channel.message_received').map(e => e.payload.message)
    expect(incoming).toHaveLength(2)
    expect(incoming[0].session.type).toBe('private')
    expect(incoming[1].session.type).toBe('group')
    expect(incoming[1].features.thread_id).toBe('100.001')
    expect(incoming[1].sender).toEqual({ platform_user_id: 'U1', platform_display_name: 'Alice' })
    expect((await s.rpc('get_history', { session_id: incoming[1].session.session_id })).items).toHaveLength(1)
  })
  it('hot reloads false, keeps it through restart, masks tokens, validates atomically', async () => {
    const s = setup()
    expect((await s.rpc('get_config')).config.group.only_respond_to_mentions).toBe(true)
    await s.rpc('update_config', { config: { group: { only_respond_to_mentions: 'false' } } })
    await s.receive(s.message('C1', 'no mention'), 'plain')
    expect(s.events.some(e => e.type === 'channel.message_received')).toBe(true)
    const restarted = setup(s.dir)
    expect((await restarted.rpc('get_config')).config.group.only_respond_to_mentions).toBe(false)
    expect((await restarted.rpc('get_config')).config.credentials.bot_token).toBe('***')
    await expect(s.rpc('update_config', { config: { group: { only_respond_to_mentions: true }, cache: { max_days: 0 } } })).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
    expect((await s.rpc('get_config')).config.group.only_respond_to_mentions).toBe(false)
    await expect(s.rpc('update_config', {config:{group:{constructor:true}}})).rejects.toMatchObject({code:'INVALID_PARAMS'})
    await s.rpc('update_config', { config: { group: { only_respond_to_mentions: true }, credentials: { bot_token: '***', app_token: '***' } } })
    const n = s.events.length
    await s.receive(s.message('C1', 'again'), 'again')
    expect(s.events).toHaveLength(n)
  })
  it('deduplicates message/app_mention but retries failed MM publish, never readmits filtered events', async () => {
    const s = setup(), event = s.message()
    const publish = (s.channel as any).rpcClient.publishEvent
    publish.mockRejectedValueOnce(new Error('MM unavailable'))
    await expect(s.receive(event, 'e1')).rejects.toThrow()
    await s.receive(event, 'e1')
    await s.receive({ ...event, type: 'app_mention' }, 'e2')
    expect(s.events.filter(e => e.type === 'channel.message_received')).toHaveLength(1)
    const filtered = s.message('C1', 'plain')
    await s.receive(filtered, 'filtered')
    await s.rpc('update_config', { config: { group: { only_respond_to_mentions: false } } })
    await s.receive(filtered, 'filtered')
    expect(s.events.filter(e => e.type === 'channel.message_received')).toHaveLength(1)
  })
  it('ignores bots, edits, deletes, other workspaces and MPIM', async () => {
    const s = setup()
    for (const extra of [{bot_id:'B2'}, {user:'B1'}, {subtype:'message_changed'}, {subtype:'message_deleted'}]) await s.receive(s.message('C1', '<@B1>', extra), JSON.stringify(extra))
    await s.channel.receive({ team_id: 'T2', api_app_id: 'A1', event_id:'foreign', event:s.message() })
    s.api.call.mockResolvedValueOnce({ channel: { id: 'G1', is_mpim: true, is_member: true } })
    await s.receive(s.message('G1'), 'mpim')
    expect(s.events).toHaveLength(0)
  })
  it('converges passive and active DMs across restart; never makes a user-id session', async () => {
    const s = setup()
    await s.receive(s.message('D1','hi'), 'dm')
    const first = await s.rpc('find_or_create_private_session', { platform_user_id: 'U1' })
    const second = await setup(s.dir).rpc('find_or_create_private_session', { platform_user_id: 'U1' })
    expect(first.created).toBe(false)
    expect(second.session.id).toBe(first.session.id)
    expect(first.session.platform_session_id).toBe('D1')
    expect((await s.rpc('get_sessions')).items).toHaveLength(1)
    expect(Object.values(first.session.permissions.tool_access)).not.toContain(true)
    expect(first.session.permissions.storage).toBeNull()
  })
  it('stores attachment placeholders and thread relationship; always sends to main surface', async () => {
    const s = setup(), e = s.message('D1', 'see', { thread_ts:'99.001', files:[{name:'secret.png'}] })
    await s.receive(e)
    const session = (await s.rpc('get_sessions')).items[0]
    const history = (await s.rpc('get_history', {session_id:session.id})).items
    expect(history[0].content.text).toContain('secret.png')
    expect(history[0].content.text).toContain('未读取')
    expect(history[0].features.thread_id).toBe('99.001')
    await s.rpc('send_message', { session_id:session.id, content:{type:'text',text:'answer'}, request_ids:['SECRET'], task_id:'SECRET' })
    const sent = s.api.call.mock.calls.filter(c => c[0] === 'chat.postMessage')
    expect(sent[0][1]).toEqual({channel:'D1',text:'answer',mrkdwn:true,unfurl_links:false,unfurl_media:false})
    for (const features of [{thread_id:'99'}, {quote_message_id:'99'}, {reply_to_message_id:'99'}, {native_channel_id:'C2'}]) await expect(s.rpc('send_message', {session_id:session.id,content:{type:'text',text:'x'},features})).rejects.toMatchObject({code:'CHANNEL_UNSUPPORTED_FEATURE'})
    await expect(s.rpc('send_message',{session_id:session.id,content:{type:'file',file_path:'/sensitive'}})).rejects.toMatchObject({code:'CHANNEL_UNSUPPORTED_MESSAGE_TYPE'})
  })
})

describe('Slack cache, synchronization and write failures', () => {
  it('returns standard pagination, limit wins, retains features across restart and reports unavailable cache', async () => {
    const s = setup()
    for (let i=0; i<5; i++) await s.receive(s.message('D1', `message ${i}`, {thread_ts:'100.1'}), `e${i}`)
    const id = (await s.rpc('get_sessions')).items[0].id
    const latest = await s.rpc('get_history', {session_id:id,limit:3,pagination:{page:9,page_size:1}})
    expect(latest.items.map((m:any)=>m.content.text)).toEqual(['message 2','message 3','message 4'])
    expect(latest.pagination).toEqual({page:1,page_size:3,total_items:3,total_pages:1})
    const detail = await setup(s.dir).rpc('get_message',{session_id:id,platform_message_id:latest.items[0].platform_message_id})
    expect(detail.features.thread_id).toBe('100.1')
    const filtered = await s.rpc('get_history',{session_id:id,keyword:'message 1'})
    expect(filtered.items).toHaveLength(1)
    await expect(s.rpc('get_history',{session_id:id,limit:0})).rejects.toMatchObject({code:'INVALID_ARGUMENT'})
    await expect(s.rpc('get_message',{session_id:id,platform_message_id:'uncached'})).rejects.toMatchObject({code:'CHANNEL_HISTORY_UNAVAILABLE'})
    await expect(s.rpc('get_message',{session_id:'missing',platform_message_id:'none'})).rejects.toMatchObject({code:'NOT_FOUND'})
    await s.rpc('update_config',{config:{cache:{max_messages_per_session:2}}})
    expect((await s.rpc('get_history',{session_id:id})).items).toHaveLength(2)
    await expect(s.rpc('get_history',{session_id:id,time_range:{start:latest.items[0].platform_timestamp}})).rejects.toMatchObject({code:'CHANNEL_HISTORY_UNAVAILABLE'})
    await expect(s.rpc('get_history',{session_id:id,time_range:{end:'2000-01-01T00:00:00Z'}})).rejects.toMatchObject({code:'CHANNEL_HISTORY_UNAVAILABLE'})
  })
  it('does not remove any session when a later sync page fails; emits changes after complete discovery', async () => {
    const s = setup()
    await s.receive(s.message('D1','hi'), 'initial')
    s.api.call.mockImplementation(async (method:string,args:any)=>{
      if (method==='conversations.list' && !args.cursor) return {channels:[{id:'C2',is_member:true,name:'new'}],response_metadata:{next_cursor:'next'}}
      if (method==='conversations.list') throw new Error('second page unavailable')
      return {user:{id:'U1',name:'Alice'}}
    })
    await expect(s.rpc('sync_sessions')).rejects.toThrow('second page')
    expect((await s.rpc('get_sessions')).items.map((s:any)=>s.platform_session_id)).toEqual(['D1'])
    s.api.call.mockImplementation(async (method:string,args:any)=>{
      if (method==='conversations.list') return {channels:args.cursor ? [{id:'C3',is_member:true,name:'private'}, {id:'G1',is_mpim:true}, {id:'C4',is_member:false}] : [{id:'C2',is_member:true,name:'new'}],response_metadata:args.cursor ? {} : {next_cursor:'next'}}
      return {user:{id:'U1',name:'Alice'}}
    })
    expect(await s.rpc('sync_sessions')).toEqual({added:2,updated:0,removed:1})
    expect(s.events.filter(e=>e.type==='channel.session_changed').map(e=>e.payload.type)).toContain('removed')
    expect((await s.rpc('list_groups')).items.map((s:any)=>s.platform_session_id)).toEqual(['C2','C3'])
    const id=(await s.rpc('get_sessions')).items[0].id
    expect(await s.rpc('delete_session',{session_id:id})).toEqual({deleted:true})
    expect(await s.rpc('delete_session',{session_id:id})).toEqual({deleted:false})
  })
  it('enumerates actual members, propagates permission failure, and rejects repeated pagination cursors', async () => {
    const s=setup()
    await s.receive(s.message(), 'seed')
    const id=(await s.rpc('get_sessions')).items[0].id
    s.api.call.mockImplementation(async(method:string,args:any)=>{
      if(method==='conversations.members') return {members:args.cursor?['U2','U1']:['U1'],response_metadata:args.cursor?{}:{next_cursor:'two'}}
      return {user:{id:args.user,name:args.user}}
    })
    const members=await s.rpc('list_group_members',{session_id:id,pagination:{page:1,page_size:1}})
    expect(members).toMatchObject({member_count:2,members_complete:true,pagination:{total_items:2}})
    expect(members.items).toHaveLength(1)
    s.api.call.mockRejectedValueOnce(Object.assign(new Error('denied'),{code:'PERMISSION_DENIED'}))
    await expect(s.rpc('list_contacts')).rejects.toMatchObject({code:'PERMISSION_DENIED'})
    s.api.call.mockResolvedValue({members:[],response_metadata:{next_cursor:'same'}})
    await expect(s.rpc('list_contacts')).rejects.toMatchObject({code:'SERVICE_UNAVAILABLE'})
  })
  it('sends Unicode safely in order, returns partial IDs, and ignores system-only metadata', async () => {
    const s=setup()
    await s.receive(s.message('D1','hi'), 'seed')
    const id=(await s.rpc('get_sessions')).items[0].id
    const sentTs = String(Date.now()/1000)
    s.api.call.mockImplementation(async(method:string,args:any)=>{
      if(method==='chat.postMessage' && args.text.length>10) return {ts:sentTs}
      throw new RpcError('RATE_LIMITED','rate limit',{retry_after:2})
    })
    await expect(s.rpc('send_message',{session_id:id,content:{type:'text',text:'😀'.repeat(4000)+'tail'},request_ids:['SECRET']})).rejects.toMatchObject({code:'RATE_LIMITED',details:{sent_platform_message_ids:[sentTs],partial_success:true}})
    const calls=s.api.call.mock.calls.filter(c=>c[0]==='chat.postMessage')
    expect(calls.map(c=>Array.from(c[1].text).length)).toEqual([4000,4])
    expect(calls.every(c=>!('thread_ts' in c[1])&&!JSON.stringify(c[1]).includes('SECRET'))).toBe(true)
    expect((await s.rpc('get_history',{session_id:id})).items.some((m:any)=>m.platform_message_id===sentTs)).toBe(true)
  })
  it('persists before applying and handles mixed credentials without replacing masked tokens', async () => {
    const s=setup()
    const changed=await s.rpc('update_config',{config:{credentials:{bot_token:'xoxb-replaced',app_token:'***'},group:{only_respond_to_mentions:false}}})
    expect(changed.requires_restart).toBe(true)
    const saved=JSON.parse(fs.readFileSync(path.join(s.dir,'config.json'),'utf8'))
    expect(saved.config.credentials).toEqual({bot_token:'xoxb-replaced',app_token:'xapp-test'})
    expect(saved.config.group.only_respond_to_mentions).toBe(false)
    const stat=fs.statSync(path.join(s.dir,'config.json'))
    if(process.platform==='win32'){
      const {execFileSync}=await import('node:child_process')
      const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$a=Get-Acl -LiteralPath $env:CRABOT_TEST_CREDENTIAL_FILE; @{protected=$a.AreAccessRulesProtected;own=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;allowed=@($a.Access | Where-Object AccessControlType -eq Allow | ForEach-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value})} | ConvertTo-Json -Compress`],{encoding:'utf8',env:{...process.env,CRABOT_TEST_CREDENTIAL_FILE:path.join(s.dir,'config.json')}})
      const acl=JSON.parse(output);expect(acl.protected).toBe(true);expect(acl.allowed).toEqual([acl.own])
    }else expect(stat.mode&0o777).toBe(0o600)
    fs.mkdirSync(path.join(s.dir,'config.json.tmp'))
    await expect(s.rpc('update_config',{config:{group:{only_respond_to_mentions:true}}})).rejects.toThrow()
    expect((await s.rpc('get_config')).config.group.only_respond_to_mentions).toBe(false)
  })
  it('honors explicitly changed stopped-instance env while preserving unrelated runtime values', async()=>{
    const s=setup()
    await s.rpc('update_config',{config:{group:{only_respond_to_mentions:false},cache:{max_days:12}}})
    const same=new ConfigStore(s.dir,{SLACK_BOT_TOKEN:'xoxb-test',SLACK_APP_TOKEN:'xapp-test'})
    expect(same.value.group.only_respond_to_mentions).toBe(false)
    const changed=new ConfigStore(s.dir,{SLACK_BOT_TOKEN:'xoxb-test',SLACK_APP_TOKEN:'xapp-test',SLACK_ONLY_RESPOND_TO_MENTIONS:'true'})
    expect(changed.value.group.only_respond_to_mentions).toBe(true)
    expect(changed.value.cache.max_days).toBe(12)
  })
})

describe('Fresh directed mentions and metadata fallback',()=>{
  it('does not forward old mentions in code/quotes and tolerates missing display metadata',async()=>{
    const s=setup()
    for(const text of ['`<@B1>`','```<@B1>```','> <@B1> old','&gt; <@B1> old','```\n<@B1> unfinished']) await s.receive(s.message('C1',text),text)
    expect(s.events).toHaveLength(0)
    const original=s.api.call.getMockImplementation()!
    s.api.call.mockImplementation(async(method,args)=>{
      if(method==='users.info' || method==='conversations.info') throw new Error('display name unavailable')
      return original(method,args)
    })
    await s.receive(s.message('C1','> <@B1> old\n<@B1> fresh', {channel_type:'channel'}),'fresh')
    const incoming=s.events.find(e=>e.type==='channel.message_received').payload.message
    expect(incoming.sender).toEqual({platform_user_id:'U1',platform_display_name:'U1'})
    expect(incoming.features.is_mention_crab).toBe(true)
  })
  it('binds an instance to one installation and reflects disconnect health',async()=>{
    const s=setup()
    s.api.call.mockImplementation(async(method)=>method==='auth.test'?{team_id:'T1',user_id:'B1',bot_id:'BB1'}:{bot:{app_id:'A1'}})
    await (s.channel as any).onStart()
    expect(await (s.channel as any).getHealthStatus()).toBe('healthy')
    s.api.connected=false
    expect(await (s.channel as any).getHealthStatus()).toBe('degraded')
    await s.channel.stop()
    const other=setup(s.dir)
    other.api.call.mockImplementation(async(method)=>method==='auth.test'?{team_id:'T2',user_id:'B2',bot_id:'BB2'}:{bot:{app_id:'A2'}})
    await expect((other.channel as any).onStart()).rejects.toMatchObject({code:'INVALID_PARAMS'})
    expect(other.api.stop).toHaveBeenCalled()
  })
})

describe('Existing outbound mention ABI',()=>{
  it('accepts resolved platform mentions and protocol Friend IDs, preserving sent mention features',async()=>{
    const s=setup()
    await s.receive(s.message('D1','hi'), 'seed')
    const id=(await s.rpc('get_sessions')).items[0].id
    ;(s.channel as any).rpcClient.resolve=vi.fn(async()=>[{port:1}])
    ;(s.channel as any).rpcClient.call=vi.fn(async()=>({friend:{channel_identities:[{channel_id:'slack-test',platform_user_id:'U2'}]}}))
    const result=await s.rpc('send_message',{session_id:id,content:{type:'text',text:'hi'},features:{mentions:[{platform_user_id:'U1'},'friend-two']}})
    const call=s.api.call.mock.calls.find(c=>c[0]==='chat.postMessage')!
    expect(call[1].text).toBe('<@U1> <@U2> hi')
    const sent=(await s.rpc('get_history',{session_id:id})).items.find((m:any)=>m.platform_message_id===result.platform_message_id)
    expect(sent.features.mentions.map((m:any)=>m.platform_user_id)).toEqual(['U1','U2'])
    expect(result.sent_at).toBe(sent.platform_timestamp)
  })
})
