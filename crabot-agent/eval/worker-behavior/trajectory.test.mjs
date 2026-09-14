import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runTrajectory } from './trajectory.mjs'

const condition = { scenario: { initial: 'fixture', objective: 'result' }, prompt: 'frozen', tools: [{ name: 'Bash' }] }
const response = calls => ({ status: 'response', response: { text: '', stopReason: calls.length ? 'tool_use' : 'end_turn', toolUseBlocks: calls } })
const call = { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'valid but unmodeled' } }

test('an evaluator gap never becomes a model-visible execution failure or another request', async () => {
  let requests = 0
  const logs = []
  const sim = { state: {}, call: async () => ({ output: 'gap', harnessGap: true }), findings: () => ({ objective_evidence: null }) }
  const result = await runTrajectory(condition, { sim, maxTurns: 12, request: async () => { requests++; return response([call]) }, log: row => logs.push(row) })
  assert.equal(result.status, 'harness_gap')
  assert.equal(requests, 1)
  assert.equal(logs[0].kind, 'tool_receipt')
})

test('real tool errors remain visible, and external completion arrives after tool boundaries', async () => {
  let requests = 0
  let advances = 0
  const sim = { state: {}, call: async () => ({ output: 'ENOENT actual missing input', isError: true }),
    advance: () => ++advances === 1 ? '[Worker event] actual boundary' : null, findings: () => ({ objective_evidence: null }) }
  const result = await runTrajectory(condition, { sim, maxTurns: 12, log: () => {}, request: async (_phase, input) => {
    if (requests++ === 0) return response([call])
    assert.equal(input.messages.at(-1).content, '[Worker event] actual boundary')
    assert.equal(input.messages.at(-2).toolResults[0].is_error, true)
    return response([])
  } })
  assert.equal(result.status, 'ended')
  assert.equal(requests, 2)
})

test('turn budget and task evidence remain separate at the last tool receipt', async () => {
  const sim = { state: {}, call: async () => ({ output: 'delivered', isError: false }), advance: () => null,
    findings: () => ({ objective_evidence: null, evidence: { delivered: true } }) }
  const result = await runTrajectory(condition, { sim, maxTurns: 1, request: async () => response([call]), log: () => {} })
  assert.equal(result.status, 'turn_budget')
  assert.equal(result.findings.evidence.delivered, true)
  assert.equal(result.findings.objective_evidence, null)
})
