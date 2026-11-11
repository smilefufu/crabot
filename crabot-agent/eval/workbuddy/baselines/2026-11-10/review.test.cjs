const test = require('node:test')
const assert = require('node:assert/strict')
const { createReview } = require('./delegation-review.cjs')
const calls = [{ id: 'a', name: 'spawn_worker', input: { prompt: '调查' } }, { id: 'b', name: 'spawn_worker', input: { prompt: '配套证据' } }]
const snapshot = (tools = []) => ({ systemPrompt: '主控策略', messages: [{ role: 'user', content: '先调查' }], tools, calls })
const issue = { call_ids: ['a'], source_quote: '先调查', handoff_quote: '', impact: '缺调查' }
test('full batch and visible context reach reviewer; allowed original tools stay identical', async () => {
  const tools = [{ name: 'spawn_worker', call: async () => ({ output: 'real' }) }]
  const gate = createReview({ originalSource: { text: '原消息' }, observe: () => {}, invoke: async x => {
    assert.equal(x.proposedCalls.length, 2); assert.equal(x.managerSystem, '主控策略'); assert.equal(x.managerMessages[0].content, '先调查')
    return JSON.stringify({ verdict: 'allow', issues: [] })
  } })
  assert.equal(await gate.prepare(snapshot(tools)), tools)
})
test('same-name calls retain separate issue attribution; neither real action executes', async () => {
  const gate = createReview({ observe: () => {}, invoke: async () => JSON.stringify({ verdict: 'revise', issues: [issue] }) })
  const tools = await gate.prepare(snapshot([{ name: 'spawn_worker', call: async () => assert.fail('side effect') }]))
  const a = JSON.parse((await tools[0].call(calls[0].input)).output), b = JSON.parse((await tools[0].call(calls[1].input)).output)
  assert.deepEqual(a.affected_call_ids, ['a']); assert.equal(a.issues.length, 1)
  assert.deepEqual(b.affected_call_ids, ['b']); assert.equal(b.issues.length, 0); assert.equal(b.other_call_issues.length, 1)
})
test('arbitrary-size revised batch is reviewed again', async () => {
  let n = 0
  const gate = createReview({ observe: () => {}, invoke: async x => { n++; assert.equal(x.proposedCalls.length, 2); return JSON.stringify({ verdict: n===1?'revise':'allow', issues:n===1?[issue]:[] }) } })
  await gate.prepare(snapshot()); const tools=[]; assert.equal(await gate.prepare(snapshot(tools)), tools); assert.equal(n, 2)
})
test('transport failure has separate technical evidence and no dispatch', async () => {
  const gate = createReview({ observe: () => {}, invoke: async () => { throw Error('HTTP503') } })
  const tools=await gate.prepare(snapshot([{name:'spawn_worker',call:async()=>assert.fail('side effect')}]))
  assert.equal(JSON.parse((await tools[0].call(calls[0].input)).output).status,'review_unavailable'); assert.equal(gate.technicalErrors.length,1)
})
test('changed or aborted source cannot use stale approval', async () => {
  const data=snapshot([{name:'spawn_worker',call:async()=>assert.fail('stale')}])
  const gate=createReview({observe:()=>{},invoke:async()=>{data.messages.push({role:'user',content:'停止'});return '{"verdict":"allow","issues":[]}'}})
  const tools=await gate.prepare(data);assert.equal(JSON.parse((await tools[0].call(calls[0].input)).output).status,'review_unavailable')
})
test('review never rewrites source, identity, routing or non-dispatch tools', async () => {
  const tools=[{name:'Read',call:async()=>42},{name:'send_to_worker',call:async input=>input}]
  const data={...snapshot(tools),calls:[{id:'x',name:'send_to_worker',input:{worker_id:'same-worker',text:'继续',immediate_redirect:true}}]}
  const gate=createReview({observe:()=>{},invoke:async()=>'{"verdict":"allow","issues":[]}'})
  const returned=await gate.prepare(data);assert.equal(returned,tools);assert.deepEqual(await returned[1].call(data.calls[0].input),data.calls[0].input)
})
