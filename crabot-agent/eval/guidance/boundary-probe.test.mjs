import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { assembly, runProbe } from './boundary-probe.mjs'
import { boundaryCases } from './boundary-cases.mjs'
const root = path.resolve(import.meta.dirname, '../../..')
import { scriptedChunks as chunksFromContent } from './history-runtime.mjs'

test('real assemblies keep system fixed; only idle and worker events auto-provide a workflow', () => {
  const manager = boundaryCases.filter(c => c.role === 'manager').map(c => [c, assembly(root, c)])
  assert.equal(new Set(manager.map(([, a]) => a.prompt)).size, 1)
  for (const [c, a] of manager) assert.equal(Boolean(a.guide), ['workboard_idle_review', 'worker_event'].includes(c.wake?.kind))
  assert.equal(Object.keys(assembly(root, boundaryCases[0]).guides).length, 4)
  assert.equal(Object.keys(assembly(root, boundaryCases.at(-1)).guides).length, 3)
})
test('business choices including a simultaneous guide read are recorded without any execution', async () => {
  const c = boundaryCases[0], condition = assembly(root, c), rows = []
  const adapter = { async *stream() { yield* chunksFromContent([
    { type: 'tool_use', id: 'g', name: 'load_guidance', input: { name: 'manager.workboard' } },
    { type: 'tool_use', id: 's', name: 'send_message', input: { text: 'internal report' } },
  ], 'tool_use') } }
  const result = await runProbe({ c, condition, adapter, model: 'fixture', record: r => rows.push(r) })
  assert.equal(result.status, 'action_observed')
  assert.equal(rows.filter(r => r.type === 'guidance_read').length, 0)
  assert.equal(rows.find(r => r.type === 'response').tools.length, 2)
})
test('a guide result enters the tail; no silent retry follows a provider failure', async () => {
  const c = boundaryCases.at(-2), condition = assembly(root, c), rows = []; let count = 0
  const adapter = { async *stream(params) {
    count++
    if (count === 1) yield* chunksFromContent([{ type: 'tool_use', id: 'g', name: 'load_guidance', input: { name: 'worker.diagnosis' } }], 'tool_use')
    else { assert.match(JSON.stringify(params.messages.at(-1)), /最早发生偏差/); throw new Error('provider unavailable') }
  } }
  const result = await runProbe({ c, condition, adapter, model: 'fixture', record: r => rows.push(r) })
  assert.equal(result.status, 'request_error'); assert.equal(count, 2)
  assert.equal(rows.filter(r => r.type === 'guidance_read').length, 1)
})
