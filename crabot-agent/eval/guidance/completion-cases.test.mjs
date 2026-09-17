import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { completionCases, completionFacts } from './completion-cases.mjs'
import { runHistory, scriptedChunks } from './history-runtime.mjs'
import { FixtureContainer } from './docker-fixtures.mjs'

const image = 'crabot-guidance-tools:local'
const call = (name, input) => ({ type: 'tool_use', id: `script-${Math.random()}`, name, input })
for (const c of completionCases.filter(c => c.set === 'new-completion-input')) test(`complete new fixture: ${c.id}`, { timeout: 45000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guidance-completion-check-'))
  let workerStep = 0, managerStep = 0, delivered = false
  const rows = await runHistory({ c, variant: 'candidate', image, root, baseline: {}, maxRequests: 12, timeoutMs: 20000, record() {},
    delegate: { stream(params, { role }) {
      if (role === 'manager') {
        const workerId = JSON.stringify(params.messages).match(/w-[a-z0-9-]+/)?.[0]
        if (managerStep++ === 0) return scriptedChunks([call('send_to_worker', { worker_id: workerId, text: c.history })])
        if (!delivered && JSON.stringify(params.messages).includes('人工脚本已完成')) { delivered = true; return scriptedChunks([call('send_message', { channel_id: 'fixture', session_id: 'synthetic', content: '三项均正确，校验通过。', post_send_action: 'none' })]) }
        return scriptedChunks([])
      }
      if (c.id === 'worker-list-without-operations') return scriptedChunks([call('finish_task', { outcome: 'completed', summary: '保留 source/engine.py、source/questions.jsonl、source/validator.py；排除 source/runtime/events.jsonl。未执行归档。' })])
      if (workerStep++ > 0) return scriptedChunks([call('finish_task', { outcome: 'completed', summary: '人工脚本已完成，核验通过。' })])
      const command = c.role === 'manager' ? 'python run.py && python check.py' : `python -B - <<'PY'
import csv,json
from decimal import Decimal
from pathlib import Path
result={}
for row in csv.DictReader(Path('orders.csv').open()):
    if row['status']!='paid': continue
    item=result.setdefault(row['customer'],{'total':Decimal(0),'count':0})
    item['total']+=Decimal(row['amount']);item['count']+=1
Path('summary.json').write_text(json.dumps([{'customer':k,'total':float(v['total']),'count':v['count']} for k,v in sorted(result.items(),key=lambda x:-x[1]['total'])]))
PY`
      return scriptedChunks([call('Bash', { command })])
    } },
  })
  const facts = completionFacts(c, rows)
  assert.equal(facts.fatal, null, JSON.stringify(rows.filter(r => r.type.includes('error'))))
  assert.deepEqual(facts.protectedChanges, [])
  if (c.verify) assert.equal(facts.oraclePassed, true)
  if (c.role === 'manager') assert.ok(facts.deliveredMessages > 0)
  if (c.id === 'worker-list-without-operations') assert.equal(facts.noOperations, true)
})

test('independent result checker rejects the seeded omission', async () => {
  const c = completionCases.find(c => c.id === 'manager-missing-result')
  const box = new FixtureContainer(image)
  try {
    await box.start(c)
    assert.match((await box.verify(c)).result.output, /^exit_code: 1/)
  } finally { await box.close() }
})
