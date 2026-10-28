import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { transformSync } = require('esbuild')
test('judge forwarding preserves transient retry and meters JSON/SSE without real credentials', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-judge-fixture-'))
  let attempt = 0
  const provider = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    assert.equal(req.headers.authorization, 'Bearer fixture-only')
    assert.equal(body.model, 'gpt-6.1-sol'); assert.equal(body.reasoning_effort, 'high')
    assert.equal(body.max_tokens, undefined)
    attempt++
    if (attempt === 1) { res.writeHead(503, {'content-type':'application/json'}); res.end('{"error":{"type":"upstream_error","message":"overloaded"}}'); return }
    if (attempt === 2) { res.writeHead(200, {'content-type':'application/json'}); res.end('{"choices":[{"message":{"content":"ok"}}],"usage":{"prompt_tokens":25,"completion_tokens":4}}'); return }
    assert.equal(body.stream_options.include_usage, true)
    res.writeHead(200, {'content-type':'text/event-stream'})
    if (attempt === 3) res.write('data: {"error":{"type":"upstream_error","message":"overloaded"}}\n\n')
    else res.write('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n')
    const usage = attempt === 3 ? {prompt_tokens:7,completion_tokens:3} : {prompt_tokens:6,completion_tokens:2}
    setTimeout(() => res.end('data: '+JSON.stringify({usage})+'\n\ndata: [DONE]\n\n'), 5)
  })
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve))
  try {
    for (const relative of ['crabot-admin/dist','crabot-agent/dist/engine','data/admin/agent-configs']) fs.mkdirSync(path.join(root,relative), {recursive:true})
    for (const pkg of ['crabot-admin','crabot-agent']) fs.writeFileSync(path.join(root,pkg,'package.json'),'{}')
    fs.writeFileSync(path.join(root,'crabot-admin/dist/model-provider-manager.js'), `exports.ModelProviderManager=class {async initialize(){} async buildConnectionInfo(){return {format:'openai',model_id:'gpt-6.1-sol',endpoint:process.env.FIXTURE_PROVIDER_ENDPOINT,apikey:'fixture-only'}}}`)
    const retrySource = fs.readFileSync(path.resolve(import.meta.dirname,'../../src/engine/retry-utils.ts'),'utf8')
    fs.writeFileSync(path.join(root,'crabot-agent/dist/engine/retry-utils.js'), transformSync(retrySource,{loader:'ts',format:'cjs'}).code)
    fs.writeFileSync(path.join(root,'data/admin/agent-configs/crabot-agent.json'),JSON.stringify({model_config:{powerful:{provider_id:'fixture',model_id:'fixture'}},thinking:{powerful:{thinking_level:'high'}}}))
    const client = path.join(root,'fixture-python.mjs')
    fs.writeFileSync(client, `#!/usr/bin/env node
import assert from 'node:assert/strict'
for(let i=1;i<=4;i++){
 const r=await fetch(process.env.WORKBUDDY_VERIFIER_LLM_BASE_URL.replace('host.docker.internal','127.0.0.1')+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+process.env.WORKBUDDY_VERIFIER_LLM_API_KEY,'content-type':'application/json'},body:JSON.stringify({model:'foreign',max_tokens:1,messages:[{role:'user',content:'fixture'}],stream:i>2})})
 const text=await r.text();assert.equal(r.status,i===1?503:200)
 if(i===3)assert.ok(text.includes('upstream_error')&&text.includes('prompt_tokens'))
 if(i===4)assert.ok(text.includes('[DONE]'))
}
`, {mode:0o755})
    const output = path.join(root,'result')
    const child = spawn(process.execPath,[path.join(import.meta.dirname,'judge.mjs')],{env:{...process.env,REPLAY_DATA_DIR:path.join(root,'data'),REPLAY_RUNTIME_ROOT:root,WORKBUDDY_JUDGE_OUTPUT:output,WORKBUDDY_PYTHON:client,WORKBUDDY_PRIOR_TOKENS:'417627',WORKBUDDY_UNKNOWN_RESERVE:'20000000',FIXTURE_PROVIDER_ENDPOINT:`http://127.0.0.1:${provider.address().port}`},stdio:['ignore','pipe','pipe']})
    let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{log+=chunk})
    const exit=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject)})
    assert.equal(exit,0,log+fs.readFileSync(path.join(output,'verify.log'),'utf8'));assert.equal(attempt,4)
    const usage=JSON.parse(fs.readFileSync(path.join(output,'usage.json'),'utf8'))
    assert.equal(usage.used,417674);assert.equal(usage.reserved,30000000);assert.equal(usage.stopped,false)
    const receipts=fs.readFileSync(path.join(output,'requests.jsonl'),'utf8').trim().split('\n').map(JSON.parse)
    assert.equal(receipts.filter(row=>row.type==='unknown_usage').length,1)
    assert.equal(receipts.filter(row=>row.type==='usage').length,3)
  } finally {provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));fs.rmSync(root,{recursive:true,force:true})}
})
