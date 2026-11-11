import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { stopInstance } from '../../scripts/lib/instance-controller.mjs'
import { inspectInstance } from '../../scripts/lib/instance-runtime.mjs'
const require=createRequire(import.meta.url)
const {writeCredentials,newCredentialsFromPassword}=require('../../crabot-admin/dist/credentials.js')
const root=path.resolve(process.env.CORDIS_CORE_ROOT??fileURLToPath(new URL('../..',import.meta.url))),run=promisify(execFile)

test('actual CLI starts in background, reads pipe status and stops the normal source instance', {timeout:120000}, async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'crabot-cordis-cli-'))
  const data=path.join(directory,'data')
  await fs.mkdir(data,{mode:0o700})
  await writeCredentials(path.join(data,'admin'),await newCredentialsFromPassword('synthetic-cli-only',{is_temp:false,changed_via:'start'}))
  const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve))
  const web=probe.address().port;await new Promise(resolve=>probe.close(resolve))
  const env={...process.env,HOME:directory,USERPROFILE:directory,DATA_DIR:data,WORKSPACE_DIR:directory,
    PATH:`${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH||''}`,CRABOT_PORT_OFFSET:'0',
    CRABOT_ADMIN_WEB_PORT:String(web),CRABOT_ADMIN_WEB_HOST:'127.0.0.1',CRABOT_DEV:'false',CRABOT_PRODUCT_REQUIRED:'0',UV_OFFLINE:'1'}
  delete env.PORT;delete env.CRABOT_INSTANCE_GENERATION;delete env.NODE_OPTIONS
  let passed=false,output=''
  const cli=async(entry,args=[])=>{
    const result=await run(process.execPath,[path.join(root,'scripts',entry+'.mjs'),...args],{cwd:root,env,timeout:90000,maxBuffer:1024*1024})
    output+=result.stdout+result.stderr;return result
  }
  try{
    await cli('init')
    const started=await cli('start',['-d'])
    assert.match(started.stdout,/local IPC/)
    let status
    const deadline=Date.now()+45000
    do {
      status=JSON.parse((await cli('status',['--json'])).stdout)
      if(status.modules.filter(module=>['admin-web','crabot-agent','memory-default'].includes(module.module_id)&&module.status==='running').length===3)break
      await new Promise(resolve=>setTimeout(resolve,100))
    } while(Date.now()<deadline)
    assert.equal(status.running,true)
    assert.equal(status.endpoints.mm.url,null);assert.equal(status.endpoints.mm.transport,'pipe')
    assert.equal(status.endpoints.admin_rpc.url,null);assert.equal(status.endpoints.admin_rpc.transport,'ipc')
    assert.equal(status.endpoints.admin_ui.url,`http://localhost:${web}`)
    assert.ok(status.modules.some(module=>module.module_id==='crabot-agent'&&module.status==='running'))
    assert.equal((await fetch(`http://127.0.0.1:${web}/api/auth/me`)).status,401)
    await cli('check')
    await cli('stop')
    assert.equal(inspectInstance(data).state,'stopped')
    passed=true
  }finally{
    if(inspectInstance(data).state==='running')await stopInstance(data)
    if(passed)await fs.rm(directory,{recursive:true,force:true})
    else{await fs.writeFile(path.join(directory,'cli-fixture.log'),output);console.log('Retained CLI fixture:',directory)}
  }
})
