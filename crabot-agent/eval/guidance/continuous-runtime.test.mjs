import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runContinuous, scriptedChunks } from './continuous-runtime.mjs'
import { continuousCases } from './continuous-cases.mjs'
import { remainingConditions } from './continuous-compare.mjs'
const sourceRoot = path.resolve(import.meta.dirname, '../../..')
const image = 'crabot-guidance-tools:local'
const call = (name, input) => ({ type: 'tool_use', id: crypto.randomUUID(), name, input })

test('incident replay preserves progressive surface, historical delivery, clock and successive wakes', { timeout: 45000 }, async () => {
  const previous = process.env.CRABOT_MANAGER_TOOL_LOADING_MODE
  process.env.CRABOT_MANAGER_TOOL_LOADING_MODE = 'progressive'
  try {
    const c = structuredClone(continuousCases.find(c => c.id === 'idle-paused'))
    c.replay = { managerKey: 'bot-replay::incident', model: 'incident-model', thinking: { custom: 'max' },
      startedAt: '2026-09-17T22:46:14.051Z', cycles: 2,
      sessionState: { rollingSummary: '历史摘要：任务已暂停。', recent: [{ id: 'prior-report', role: 'assistant',
        content: [{ type: 'text', text: '上次内部检查报告' }], timestamp: 1789680000000 }], foldedCount: 0 } }
    let step = 0
    const rows = await run(c, params => {
      assert.equal(params.tools.length, 14)
      assert.equal(params.model, 'incident-model')
      assert.deepEqual(params.thinking, { custom: 'max' })
      assert.match(params.systemPrompt, /bot-replay/)
      assert.match(JSON.stringify(params.messages), /历史摘要：任务已暂停/)
      assert.match(JSON.stringify(params.messages), /上次内部检查报告/)
      if (step++ === 0) return scriptedChunks([call('send_message', { channel_id: 'bot-replay', session_id: 'incident', content: '故意模拟无必要外发', post_send_action: 'none' })])
      return scriptedChunks([])
    })
    assert.equal(rows.filter(r => r.type === 'wake').length, 2)
    assert.match(JSON.stringify(rows.filter(r => r.type === 'request').at(-1).messages), /故意模拟无必要外发/)
    assert.equal(rows.find(r => r.type === 'end').outbox.length, 1)
    assert.equal(rows.find(r => r.type === 'end').outbox[0].sent_at, c.replay.startedAt)
  } finally {
    if (previous === undefined) delete process.env.CRABOT_MANAGER_TOOL_LOADING_MODE
    else process.env.CRABOT_MANAGER_TOOL_LOADING_MODE = previous
  }
})

async function run(c, stream, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guidance-continuous-test-'))
  process.env.CRABOT_AGENT_DATA_DIR = path.join(root, 'agent')
  const rows = await runContinuous({ c, sourceRoot, image, root, maxRequests: 12, timeoutMs: 25000,
    delegate: { stream }, record() {}, ...extra })
  fs.writeFileSync(path.join(root, 'test-events.json'), JSON.stringify(rows, null, 2))
  const end = rows.find(r => r.type === 'end')
  assert.equal(end.fatal, undefined, JSON.stringify(rows.filter(r => r.type.includes('error') || r.type.includes('failure'))))
  return rows
}

for (const variant of ['candidate', 'baseline']) test(`actual ${variant} idle wake reaches the send AFTER inspecting board`, { timeout: 45000, skip: variant === 'baseline' && !process.env.GUIDANCE_BASELINE_ROOT }, async () => {
  let step = 0
  const rows = await run(continuousCases[0], params => {
    if (!params.tools.some(t => t.name === 'inspect_workboard')) return scriptedChunks([call('search_tools', { query: 'inspect_workboard' })])
    if (step++ === 0) return scriptedChunks([call('inspect_workboard', { view: 'active' })])
    if (step === 2) {
      assert.match(JSON.stringify(params.messages), /人类要求无限期暂停/)
      assert.match(JSON.stringify(params.messages), /## Guidance: manager.workboard/)
      return scriptedChunks([call('send_message', { channel_id: 'fixture', session_id: 'synthetic', content: '本次自省检查完成，无变化。', post_send_action: 'none' })])
    }
    return scriptedChunks([])
  }, { sourceRoot: variant === 'baseline' ? process.env.GUIDANCE_BASELINE_ROOT : sourceRoot })
  assert.equal(rows.find(r => r.type === 'end').outbox.length, 1, 'regression oracle must SEE the forbidden send, not stop before it')
  assert.ok(rows.filter(r => r.type === 'response').length >= 3)
})

test('guide plus business tool in the same turn both execute and appear in the next decision', { timeout: 45000 }, async () => {
  let step = 0
  const rows = await run(continuousCases.find(c => c.id === 'worker-diagnosis'), params => {
    if (step++ === 0) return scriptedChunks([call('load_guidance', { name: 'worker.diagnosis' }), call('Read', { file_path: '/fixture/config.json' })])
    assert.match(JSON.stringify(params.messages), /archive\/report.csv/)
    assert.match(JSON.stringify(params.messages), /最早发生偏差/)
    return scriptedChunks([call('finish_task', { outcome: 'completed', summary: '脚本夹具完成；此测试仅验证完整工具循环。' })])
  })
  assert.equal(rows.filter(r => r.type === 'request').length, 2)
  assert.deepEqual(rows.find(r => r.type === 'end').changed, [])
})

test('real permission lookup precedes locally captured permission question and cannot start Worker', { timeout: 45000 }, async () => {
  let step = 0
  const rows = await run(continuousCases.find(c => c.id === 'permission'), params => {
    if (step++ === 0) return scriptedChunks([call('get_execution_capabilities', {})])
    if (step === 2) {
      assert.match(JSON.stringify(params.messages), /can_spawn.*false/)
      return scriptedChunks([call('send_message', { channel_id: 'fixture', session_id: 'synthetic', content: '请开启当前会话 task 权限，才能安排目录整理。', post_send_action: 'none' })])
    }
    return scriptedChunks([])
  })
  assert.equal(rows.find(r => r.type === 'end').outbox.length, 1)
  assert.equal(rows.find(r => r.type === 'workers_after').workers.length, 0)
})

test('a forged completed report does not pass the actual file oracle', { timeout: 45000 }, async () => {
  const rows = await run(continuousCases.find(c => c.id === 'simple-fix'), () => scriptedChunks([call('finish_task', { outcome: 'completed', summary: '已经修复并验证。' })]))
  assert.match(rows.find(r => r.type === 'end').oracle.result.output, /^exit_code: 1/)
})

test('real project Git fixture has protected dirty work and fails independent oracle before repair', { timeout: 45000 }, async () => {
  const rows = await run(continuousCases.find(c => c.id === 'worker-project'), () => scriptedChunks([call('finish_task', { outcome: 'completed', summary: '没有修改。' })]))
  const end = rows.find(r => r.type === 'end')
  assert.match(end.before['PERSONAL.txt'].text, /uncommitted human note/)
  assert.match(end.oracle.result.output, /^exit_code: 1/)
})

test('builtin reviewer uses isolated prompt and returns an actual child notification', { timeout: 45000 }, async () => {
  let parentStep = 0, childStep = 0
  const rows = await run(continuousCases.find(c => c.reviewer), (params, { role }) => {
    if (role === 'reviewer') {
      assert.ok(!params.tools.some(t => ['load_guidance', 'Write', 'Edit'].includes(t.name)))
      assert.ok(!params.systemPrompt.includes('## Guidance'))
      if (childStep++ === 0) return scriptedChunks([call('Read', { file_path: '/fixture/normalize.py' })])
      return scriptedChunks([{ type: 'text', text: '独立审查发现空白处理尚未修复。' }])
    }
    if (parentStep++ === 0) return scriptedChunks([call('delegate_task', { subagent_type: 'reviewer', task: '只读检查 /fixture/normalize.py 是否去除了空白。' })])
    if (!JSON.stringify(params.messages).includes('独立审查发现')) return scriptedChunks([])
    return scriptedChunks([call('finish_task', { outcome: 'failed', summary: '审查确认尚未修复。' })])
  })
  assert.ok(rows.some(r => r.type === 'child_completion' && r.text.includes('独立审查发现')))
  assert.ok(rows.some(r => r.type === 'request' && r.role === 'worker' && JSON.stringify(r.messages).includes('独立审查发现')))
})

test('Manager can spawn in the container project and receive real verified completion', { timeout: 45000 }, async () => {
  let spawned = false, workerStep = 0, sent = false
  const rows = await run(continuousCases.find(c => c.id === 'manager-project'), (params, { role }) => {
    if (role === 'worker') {
      if (workerStep++ === 0) return scriptedChunks([call('Bash', { command: "python - <<'PY'\nfrom pathlib import Path\nPath('parser.py').write_text('def parse_rows(text):\\n    return [int(line) for line in text.splitlines() if line.strip()]\\n')\nPY\npython check.py && git add parser.py && git commit -m fix-parser" })])
      return scriptedChunks([call('finish_task', { outcome: 'completed', summary: '实际修复解析器、验证和本地提交完成。' })])
    }
    if (!spawned) {
      spawned = true
      return scriptedChunks([call('spawn_worker', { title: 'Cedar 解析器修复', workspace: '/fixture', prompt: '按原要求修复 parser.py，运行 python check.py，只提交本次修改。' })])
    }
    if (workerStep > 1 && !sent) {
      sent = true
      return scriptedChunks([call('send_message', { channel_id: 'fixture', session_id: 'synthetic', content: '解析器已修复、验证并本地提交。', post_send_action: 'none' })])
    }
    return scriptedChunks([])
  })
  const end = rows.find(r => r.type === 'end')
  assert.match(end.oracle.result.output, /^exit_code: 0/)
  assert.equal(end.outbox.length, 1)
})

test('continuation includes only not-started cases, preserving completed and interrupted results', () => {
  const plan = { conditions: ['done', 'cut', 'pending'].map(id => ({ id })) }
  const summary = { results: [{ id: 'done', fatal: null }, { id: 'cut', fatal: 'request-budget' }, { id: 'pending', fatal: 'budget-not-started' }] }
  assert.deepEqual(remainingConditions(plan, summary), [{ id: 'pending' }])
  assert.throws(() => remainingConditions(plan, { results: [] }), /not recorded every condition/)
})

test('synthetic read-only channel inventory and identity lookup return actual fixture state', { timeout: 45000 }, async () => {
  let step = 0
  const c = { ...continuousCases.find(c => c.id === 'idle-duplicate'), trigger: 'human' }
  const rows = await run(c, params => {
    if (step++ === 0) return scriptedChunks([
      call('list_sessions', { channel_id: 'fixture' }),
      call('get_history', { channel_id: 'fixture', session_id: 'synthetic' }),
      call('inspect_crabot', { view: 'deployment' }),
      call('inspect_crabot', { view: 'capabilities' }),
    ])
    assert.match(JSON.stringify(params.messages), /人工评测会话/)
    assert.match(JSON.stringify(params.messages), /采购交付缺少交付日期/)
    assert.doesNotMatch(JSON.stringify(params.messages), /Unsupported local/)
    return scriptedChunks([])
  })
  assert.equal(rows.filter(r => r.type === 'coverage_gap').length, 0)
})

// The child can be between model calls while a real tool is still running.
test('parent wait includes a child executing a slow tool between model responses', { timeout: 45000 }, async () => {
  let parentStep = 0, childStep = 0
  const rows = await run(continuousCases.find(c => c.reviewer), (params, { role }) => {
    if (role === 'reviewer') {
      if (childStep++ === 0) return scriptedChunks([call('Bash', { command: 'sleep 2; cat /fixture/normalize.py' })])
      return scriptedChunks([{ type: 'text', text: '慢速独立审查已完成，代码仍有空白处理缺陷。' }])
    }
    if (parentStep++ === 0) return scriptedChunks([call('delegate_task', { subagent_type: 'reviewer', task: '只读检查 /fixture/normalize.py。' })])
    if (!JSON.stringify(params.messages).includes('慢速独立审查已完成')) return scriptedChunks([])
    return scriptedChunks([call('finish_task', { outcome: 'failed', summary: '已收到完整审查结果。' })])
  })
  assert.ok(rows.some(r => r.type === 'child_completion' && r.text.includes('慢速独立审查已完成')))
  assert.ok(rows.some(r => r.type === 'response' && r.role === 'worker' && r.tools.some(t => t.name === 'finish_task')))
})
