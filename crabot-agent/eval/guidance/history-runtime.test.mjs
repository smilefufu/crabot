import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { runHistory, scriptedChunks } from './history-runtime.mjs'
import { historyCases } from './history-cases.mjs'
import { FixtureContainer } from './docker-fixtures.mjs'

const image = 'crabot-guidance-tools:local'
const call = (name, input) => ({ type: 'tool_use', id: `script-${Math.random()}`, name, input })
const commands = [
  `umask 077; printf '%s' '{"test_password":"EVAL_ONLY_NOT_A_SECRET"}' > preview.json; python check_preview.py`,
  `printf '%s\\n' '# 输入约定' '此前助手添加的管道限制已撤销，直接使用 --input 文件参数。' > docs/input-policy.md; python evaluate.py --input cases.json`,
  `cp -n source/engine.py source/questions.jsonl source/validator.py archive/; python -B archive/validator.py; printf '%s\\n' 'engine.py questions.jsonl validator.py; preserved KEEP.txt; excluded source/runtime/events.jsonl' > archive/MANIFEST.md`,
]

for (const [index, c] of historyCases.entries()) test(`${c.id}: actual continuation and artifact verification`, { timeout: 45000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guidance-history-check-'))
  let managerStep = 0, workerStep = 0, reviewed = false, delivered = false
  const rows = await runHistory({ c, variant: 'candidate', image, root, baseline: {}, maxRequests: 15, timeoutMs: 20000, record() {},
    delegate: { stream(params, { role }) {
      if (role === 'worker') return scriptedChunks([workerStep++ === 0 ? call('Bash', { command: commands[index] }) : call('finish_task', { outcome: 'completed', summary: '已执行并验证成功。' })])
      const workerId = JSON.stringify(params.messages).match(/w-[a-z0-9-]+/)?.[0]
      assert.ok(workerId)
      const step = managerStep++
      if (step === 0) return scriptedChunks([call('send_to_worker', { worker_id: workerId, text: c.history })])
      if (JSON.stringify(params.messages).includes('已执行并验证成功') && !reviewed) {
        reviewed = true; return scriptedChunks([call('get_worker_turn', { worker_id: workerId })])
      }
      if (reviewed && !delivered) {
        delivered = true; return scriptedChunks([call('send_message', { channel_id: 'fixture', session_id: 'synthetic', content: '已执行，验证通过。', post_send_action: 'none' })])
      }
      return scriptedChunks([])
    } },
  })
  fs.writeFileSync(path.join(root, 'test-events.json'), JSON.stringify(rows, null, 2))
  const end = rows.find(row => row.type === 'end')
  assert.equal(end.fatal, undefined, JSON.stringify(rows.filter(r => r.type.includes('error') || r.type.includes('failure'))))
  assert.match(end.oracle.result.output, /^exit_code: 0/)
  assert.ok(rows.some(r => r.type === 'executed_tool' && r.name === 'Bash' && !r.receipt.result.isError))
  if (c.role === 'manager') {
    assert.equal(rows.filter(r => r.type === 'historical_seed').length, 1)
    assert.equal(end.outbox.length, 1)
    assert.ok(rows.some(r => r.type === 'request' && r.role === 'manager' && JSON.stringify(r.messages).includes('已执行并验证成功')))
  }
  if (c.role === 'worker') for (const name of Object.keys(c.files)) assert.deepEqual(end.after[name], end.before[name])
})

test('independent archive check rejects the historical all-JSONL exclusion', async () => {
  const box = new FixtureContainer(image)
  try {
    await box.start(historyCases[2])
    await box.call('Bash', { command: 'cp -n source/engine.py source/validator.py archive/; echo complete > archive/MANIFEST.md' })
    assert.match((await box.verify(historyCases[2])).result.output, /^exit_code: 1/)
  } finally { await box.close() }
})

test('request ceiling rejects new work without aborting an already admitted response', { timeout: 30000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guidance-budget-check-'))
  let managerStep = 0, workerFinished = false
  let releaseWorker
  const gate = new Promise(resolve => { releaseWorker = resolve })
  try {
    const rows = await runHistory({ c: historyCases[0], variant: 'candidate', image, root,
      baseline: {}, maxRequests: 3, timeoutMs: 10000, record() {},
      delegate: { async *stream(params, { role }) {
        if (role === 'worker') {
          await gate
          await new Promise(resolve => setTimeout(resolve, 150))
          if (params.signal.aborted) throw new Error('admitted response was cancelled by another request')
          workerFinished = true
          yield* scriptedChunks([{ type: 'text', text: '已准入的请求正常返回；测试尚未写配置。' }])
          return
        }
        const workerId = JSON.stringify(params.messages).match(/w-[a-z0-9-]+/)?.[0]
        if (managerStep++ === 0) {
          yield* scriptedChunks([call('send_to_worker', { worker_id: workerId, text: '继续处理。' })])
        } else {
          releaseWorker()
          yield* scriptedChunks([call('get_worker_state', { worker_id: workerId })])
        }
      } },
    })
    assert.equal(rows.find(r => r.type === 'end').fatal, 'request-budget')
    assert.equal(rows.filter(r => r.type === 'request').length, 3)
    assert.equal(workerFinished, true)
    assert.equal(rows.filter(r => r.type === 'response' && r.role === 'worker').length, 1)
    assert.equal(rows.filter(r => r.type === 'error').length, 0)
  } finally { releaseWorker(); fs.rmSync(root, { recursive: true, force: true }) }
})
