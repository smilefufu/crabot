import assert from 'node:assert/strict'
import test from 'node:test'
import { decisionCases } from './decision-cases.mjs'
import { decisionCondition, decisionRead, publicMessages, runDecision } from './decision-runtime.mjs'
import { scriptedChunks } from './history-runtime.mjs'

const call = (name, input) => ({ type: 'tool_use', id: `test-${name}`, name, input })
const baseline = { manager: 'frozen manager', worker: 'frozen worker' }
const run = async (c, blocks, overrides = {}) => {
  const rows = []
  let next = 0
  const result = await runDecision({ c, condition: decisionCondition(c, 'candidate', baseline), model: 'scripted',
    maxRounds: 3, maxTokens: 2400, record: row => rows.push(row),
    delegate: { stream: () => scriptedChunks(blocks[next++]) }, ...overrides })
  return { result, rows }
}

test('permission probe uses product narrowing and does not convert readiness into task or desktop permission', async () => {
  for (const id of ['m-task-denied', 'm-desktop-denied']) {
    const c = decisionCases.find(c => c.id === id)
    const result = await decisionRead(c, 'get_execution_capabilities', { impl: 'builtin' })
    assert.equal(result.isError, false)
    const facts = JSON.parse(result.output)
    assert.equal(facts.implementations[0].ready, true)
    assert.equal(facts.can_spawn, id !== 'm-task-denied')
    assert.equal(facts.implementations[0].permissions.tool_access.desktop, false)
  }
})

test('automatic guidance changes only candidate tail messages, never the system or baseline arm', async () => {
  const normal = decisionCondition(decisionCases[0], 'candidate', baseline)
  const event = decisionCases.find(c => c.event)
  const candidate = decisionCondition(event, 'candidate', baseline)
  const old = decisionCondition(event, 'baseline', baseline)
  assert.equal(candidate.prompt, normal.prompt)
  assert.deepEqual(normal.guidance, [])
  assert.deepEqual(old.guidance, [])
  assert.equal(candidate.guidance.length, 1)
  for (const condition of [candidate, old]) {
    const { rows } = await run(event, [[]], { condition })
    const request = rows.find(r => r.type === 'request')
    assert.equal(request.messages.at(-1).content, event.user)
    assert.equal(JSON.stringify(request.messages).includes('## Guidance:'), condition === candidate)
  }
})

test('business choices, even combined with guidance, are recorded without executing a tool or inventing a receipt', async () => {
  const { result, rows } = await run(decisionCases[1], [[
    call('load_guidance', { name: 'manager.delegation' }), call('spawn_worker', { title: 'sample', prompt: 'sample' }),
  ]])
  assert.equal(result.status, 'decision_observed')
  assert.equal(rows.some(r => r.type === 'local_read'), false)
  assert.equal(rows.filter(r => r.type === 'response')[0].tools.length, 2)
})

test('actual guidance result reaches the next request without sending reviewer criteria', async () => {
  const c = decisionCases[8]
  const { result, rows } = await run(c, [
    [call('load_guidance', { name: 'worker.project-context' })], [{ type: 'text', text: '旧限制撤销，本次使用 --input。' }],
  ])
  assert.equal(result.status, 'decision_observed')
  const requests = rows.filter(r => r.type === 'request')
  assert.match(JSON.stringify(requests[1]), /项目规则与文档维护/)
  assert.equal(JSON.stringify(requests).includes(c.rubric), false)
})

test('unsupported Worker observation is a coverage gap, not a failed decision', async () => {
  const { result } = await run(decisionCases[4], [[call('get_worker_turn', { worker_id: 'w-unknown' })]])
  assert.equal(result.status, 'coverage_gap')
})

test('missing model response is recorded once without retry', async () => {
  let attempts = 0
  const { result, rows } = await run(decisionCases[0], [], {
    delegate: { async *stream() { attempts++; throw new Error('offline test') } },
  })
  assert.equal(result.status, 'missing')
  assert.equal(attempts, 1)
  assert.equal(rows.filter(r => r.type === 'missing').length, 1)
})

test('public journal removes raw reasoning blocks', () => {
  assert.deepEqual(publicMessages([{ content: [{ type: 'raw_reasoning', text: 'private' }, { type: 'text', text: 'public' }] }]),
    [{ content: [{ type: 'text', text: 'public' }] }])
})

test('round allowance limits guide-only loops without calling them successful decisions', async () => {
  const guide = [call('load_guidance', { name: 'worker.project-context' })]
  const { result, rows } = await run(decisionCases[8], [guide, guide, guide])
  assert.equal(result.status, 'round_limit')
  assert.equal(rows.filter(r => r.type === 'response').length, 3)
})

test('budget refusal and output truncation remain separate from model failures', async () => {
  const budget = await run(decisionCases[0], [], { delegate: { async *stream() {
    throw Object.assign(new Error('test allowance'), { code: 'EVAL_BUDGET' })
  } } })
  assert.equal(budget.result.status, 'budget_stop')
  assert.equal(budget.rows.some(r => r.type === 'missing'), false)
  const truncated = await run(decisionCases[0], [], { delegate: { async *stream() {
    yield { type: 'text_delta', text: 'partial' }
    yield { type: 'message_end', stopReason: 'max_tokens' }
  } } })
  assert.equal(truncated.result.status, 'truncated')
})
