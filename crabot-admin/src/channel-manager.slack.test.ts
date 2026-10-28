import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ChannelManager } from './channel-manager.js'
import { SlackChannel } from '../../crabot-channel-slack/src/slack-channel.js'

const dirs: string[] = [], channels: SlackChannel[] = []
afterEach(async()=>{
  for(const channel of channels.splice(0)) await channel.stop()
  for(const dir of dirs.splice(0)) await fs.rm(dir,{recursive:true,force:true})
})
describe('Slack Admin -> real module RPC -> persistent restart',()=>{
  it('rolls back a new Slack instance if its initial private credential write fails, allowing a same-session retry', async () => {
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'slack-config-failure-')); dirs.push(dir)
    const manager=new ChannelManager(dir,{registerModuleDefinition:vi.fn()} as any)
    await manager.initialize()
    const write=vi.spyOn(manager,'saveLocalConfig').mockRejectedValueOnce(new Error('fixture disk failure'))
    const params={implementation_id:'channel-slack',name:'slack-retry',auto_start:false,env:{SLACK_BOT_TOKEN:'xoxb-fixture',SLACK_APP_TOKEN:'xapp-fixture'}}
    await expect(manager.createInstance(params)).rejects.toThrow('fixture disk failure')
    expect(manager.getInstance('slack-retry')).toBeUndefined()
    expect(JSON.parse(await fs.readFile(path.join(dir,'channel-instances.json'),'utf8'))).not.toEqual(expect.arrayContaining([expect.objectContaining({id:'slack-retry'})]))
    write.mockRestore()
    expect((await manager.createInstance(params)).id).toBe('slack-retry')
  })

  it('discovers the builtin schema and retains false through runtime save and restart env',async()=>{
    const dir=await fs.mkdtemp(path.join(os.tmpdir(),'slack-admin-')); dirs.push(dir)
    let port=0
    const rpc={ registerModuleDefinition:vi.fn(), resolve:vi.fn(async()=>[{port}]), call:vi.fn(async(_port:number,method:string,params:any)=>{
      const result=await fetch(`http://127.0.0.1:${port}/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:'test',source:'admin',method,params,timestamp:new Date().toISOString()})}).then(r=>r.json()) as any
      if(!result.success) throw Object.assign(new Error(result.error.message),{code:result.error.code})
      return result.data
    }) }
    const manager=new ChannelManager(dir,rpc as any); await manager.initialize()
    const implementation=manager.getImplementation('channel-slack')!
    expect(implementation.config_schema).toMatchObject({properties:{SLACK_ONLY_RESPOND_TO_MENTIONS:{default:'true','x-runtime-path':'group.only_respond_to_mentions'}}})
    const instance=await manager.createInstance({implementation_id:'channel-slack',name:'slack-test',env:{SLACK_BOT_TOKEN:'xoxb-test',SLACK_APP_TOKEN:'xapp-test',SLACK_ONLY_RESPOND_TO_MENTIONS:'true'}})
    const api={connected:true,start:vi.fn(),stop:vi.fn(),call:vi.fn(async(method:string)=>method==='auth.test'?{team_id:'T1',user_id:'B1',bot_id:'BB1'}:{bot:{app_id:'A1'}})}
    async function boot(){
      const env=await (manager as any).buildModuleEnv(instance)
      const channel=new SlackChannel({module_id:instance.id,port:0,data_dir:env.DATA_DIR,env},api)
      channels.push(channel); await channel.start()
      port=(channel as any).server.address().port
      return channel
    }
    const first=await boot()
    const changed=await manager.updateConfig({instance_id:instance.id,config:{group:{only_respond_to_mentions:false}}})
    const credentialFile=path.join(dir,'channel-configs','slack-test.json')
    if(process.platform==='win32'){
      const {promisify}=await import('node:util'),{execFile}=await import('node:child_process')
      const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$a=Get-Acl -LiteralPath $env:CRABOT_TEST_CREDENTIAL_FILE; @{protected=$a.AreAccessRulesProtected;own=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;allowed=@($a.Access | Where-Object AccessControlType -eq Allow | ForEach-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value})} | ConvertTo-Json -Compress`],{env:{...process.env,CRABOT_TEST_CREDENTIAL_FILE:credentialFile}})
      const acl=JSON.parse(stdout);expect(acl.protected).toBe(true);expect(acl.allowed).toEqual([acl.own])
    }else expect((await fs.stat(credentialFile)).mode & 0o777).toBe(0o600)
    expect(changed.requires_restart).toBe(false)
    expect(changed.config.group.only_respond_to_mentions).toBe(false)
    expect((await manager.loadLocalConfig(instance.id))?.SLACK_ONLY_RESPOND_TO_MENTIONS).toBe('false')
    await first.stop(); await boot()
    expect((await manager.getConfig(instance.id)).config.group.only_respond_to_mentions).toBe(false)
    const full=(await manager.getConfig(instance.id)).config
    expect(full.credentials.bot_token).toBe('***')
    // Real Admin form submits the full masked config, including derived Bot identity.
    await manager.updateConfig({instance_id:instance.id,config:{...full,group:{only_respond_to_mentions:true}}})
    const saved=await manager.loadLocalConfig(instance.id)
    expect(saved).toMatchObject({SLACK_BOT_TOKEN:'xoxb-test',SLACK_APP_TOKEN:'xapp-test',SLACK_ONLY_RESPOND_TO_MENTIONS:'true'})
    await expect(manager.updateConfig({instance_id:instance.id,config:{group:{only_respond_to_mentions:'invalid' as any}}})).rejects.toMatchObject({code:'INVALID_PARAMS'})
    expect(await manager.loadLocalConfig(instance.id)).toEqual(saved)
  })
})
