import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createSimulation, expectedReport } from './simulation.mjs'
import { toolResultMessage } from './runtime.mjs'

test('Manager reads use production state and detail shapes', async () => {
  const sim = await createSimulation({ id: 'replace-worker', role: 'manager' }, 'candidate')
  try {
    const state = JSON.parse((await sim.call('get_worker_state', { worker_id: 'w-old' })).output)
    assert.equal(state.mainline.state, 'running')
    const detail = await sim.call('get_worker_detail', { worker_id: 'w-old' })
    assert.equal(detail.isError, false)
    assert.equal(JSON.parse(detail.output).worker.task.status, 'running')
    const docs = await sim.call('inspect_project_docs', { project_root: '/workspace', operation: 'read', path: 'README.md' })
    assert.equal(docs.isError, false, docs.output)
    assert.match(JSON.parse(docs.output).content, /report.mjs/)
    const git = JSON.parse((await sim.call('inspect_workspace_git', { worker_id: 'w-old' })).output)
    assert.equal(git.git.current.state.status, 'repository')
    assert.equal(git.git.comparison, 'same_head')
  } finally { await sim.dispose?.() }
})

test('Manager workboard rejects nonexistent records and does not invent successful mutations', async () => {
  const sim = await createSimulation({ id: 'idle-premise', role: 'manager-idle' }, 'candidate')
  try {
    const before = JSON.parse((await sim.call('inspect_workboard', {})).output)
    assert(Array.isArray(before.objectives[0].completion_criteria))
    const invalid = await sim.call('change_workboard', { action: 'archive_work_item', work_item_id: 'missing', archived_as: 'completed' })
    assert.equal(invalid.isError, true)
    assert.deepEqual(JSON.parse((await sim.call('inspect_workboard', {})).output), before)
  } finally { await sim.dispose?.() }
})

test('production Manager receipts preserve stop, replacement, activity and delivery boundaries', async () => {
  const sim = await createSimulation({ id: 'replace-worker', role: 'manager' }, 'candidate')
  const call = async (name, input) => {
    const r = await sim.call(name, input)
    assert.equal(r.isError, false, r.output)
    return JSON.parse(r.output)
  }
  try {
    await call('send_message', { channel_id: 'bot-2', session_id: '2eais6e9', content: '开始处理' })
    assert.deepEqual((await sim.findings()).evidence.messages_after_result_read, [])
    const stopped = await call('request_worker_stop', { worker_id: 'w-old' })
    assert.equal(stopped.operation.status, 'accepted')
    assert.equal((await call('get_worker_state', { worker_id: 'w-old' })).mainline.state, 'running')
    assert.match(await sim.advance(), /operation_settled/)
    assert.equal((await call('get_worker_detail', { worker_id: 'w-old' })).worker.task.status, 'closed')
    const spawned = await call('spawn_worker', { title: '报告运行', prompt: '运行现有报告', workspace: '/workspace' })
    const id = spawned.worker_id
    assert.equal((await call('get_worker_state', { worker_id: id })).mainline.state, 'running')
    assert.equal((await call('get_worker_turn', { worker_id: id })).turn, null)
    assert.match(await sim.advance(), /turn_completed/)
    const turn = await call('get_worker_turn', { worker_id: id })
    assert(turn.activities.some(a => a.kind === 'tool_result' && a.detail?.exit_code === 0))
    assert(turn.activities.some(a => a.detail?.content === '{"count":3,"total":12}'))
    const activities = await call('get_worker_activity', { worker_id: id, view: 'all' })
    const next = await call('get_worker_activity', { worker_id: id, view: 'all', after: activities.next_cursor })
    assert.deepEqual(next.activities, [])
    assert((await call('get_worker_terminal', { worker_id: id })).terminal.text.includes('report.json'))
    await call('send_message', { channel_id: 'bot-2', session_id: '2eais6e9', content: '结果 count=3，total=12' })
    await call('resolve_worker_turn', { worker_id: id, turn_id: turn.turn.turn_id, resolution: 'reported' })
    assert.equal((await call('get_worker_turn', { worker_id: id })).turn.disposition.status, 'resolved')
    const second = await call('spawn_worker', { title: '独立核验', prompt: '只读核验', workspace: '/workspace' })
    assert.notEqual(second.worker_id, id)
    assert.equal((await call('get_worker_state', { worker_id: id })).mainline.state, 'idle')
    assert.equal((await call('get_worker_state', { worker_id: second.worker_id })).mainline.state, 'running')
    assert.equal((await sim.findings()).evidence.messages_after_result_read.length, 1)
    assert.equal((await sim.findings()).delegation_execution_verified, false)
  } finally { await sim.dispose() }
})

test('unknown evaluator operations are gaps, not invented tool failures', async () => {
  const sim = await createSimulation({ id: 'healthy-running', role: 'manager-idle' }, 'candidate')
  try {
    const r = await sim.call('unimplemented-tool', {})
    assert.equal(r.harnessGap, true)
    assert.equal(r.isError, false)
    const activity = JSON.parse((await sim.call('get_worker_activity', { worker_id: 'w-old', view: 'all' })).output)
    assert.match(activity.activities[0].text, /60%/)
    assert.deepEqual(sim.state.dispatched, [])
    assert.deepEqual(sim.state.violations, [])
  } finally { await sim.dispose() }
})

test('production memory search uses an isolated empty store without an error or external RPC', async () => {
  const sim = await createSimulation({ id: 'replace-worker', role: 'manager' }, 'candidate')
  try {
    for (const level of ['short_term', 'long_term']) {
      const r = await sim.call('mcp__crab-memory__search_memory', { level, query: 'report history', limit: 10 })
      assert.equal(r.harnessGap, undefined)
      assert.equal(r.isError, false)
      assert.deepEqual(JSON.parse(r.output), { results: [] })
    }
    assert.deepEqual(sim.state.memoryQueries.map(q => q.method), ['search_short_term', 'search_long_term'])
  } finally { await sim.dispose() }
})

test('memory completion lookup uses the isolated empty list contract', async () => {
  const sim = await createSimulation({ id: 'replace-worker', role: 'manager' }, 'candidate')
  try {
    const r = await sim.call('mcp__crab-memory__list_entries', { tags: ['worker_completion:w-new-2:1'], limit: 20 })
    assert.equal(r.harnessGap, undefined)
    assert.equal(r.isError, false)
    assert.deepEqual(JSON.parse(r.output), { items: [], total: 0 })
    assert.equal(sim.state.memoryQueries[0].method, 'list_entries')
    assert.equal((await sim.call('mcp__crab-memory__delete_memory', { id: 'unknown' })).harnessGap, true)
  } finally { await sim.dispose() }
})

test('scripted report receipt agrees with executing the fixed local fixture', async () => {
  const sim = await createSimulation({ id: 'idle-premise', role: 'manager-idle' }, 'candidate')
  try {
    const response = await sim.call('spawn_worker', { title: '报告', prompt: '运行报告', workspace: '/workspace' })
    const id = JSON.parse(response.output).worker_id
    await sim.advance()
    const turn = JSON.parse((await sim.call('get_worker_turn', { worker_id: id })).output)
    const command = turn.activities.find(a => a.detail?.exit_code === 0).detail
    const report = turn.activities.find(a => a.detail?.path === '/workspace/report.json').detail
    const workspace = sim.state.workers[id].incarnations[0].workspace
    assert.equal(await fs.readFile(path.join(workspace, 'report.json'), 'utf8'), report.content)
    await fs.unlink(path.join(workspace, 'report.json'))
    const stdout = execFileSync(process.execPath, ['report.mjs'], { cwd: workspace, encoding: 'utf8' })
    assert.equal(stdout.trim(), command.stdout)
    assert.equal(await fs.readFile(path.join(workspace, 'report.json'), 'utf8'), report.content)
  } finally { await sim.dispose() }
})

test('simulated receipts use the Engine message contract', () => {
  const message = toolResultMessage([{ tool_use_id: 'read', output: 'body', isError: false }])
  assert.deepEqual(message.toolResults, [{ tool_use_id: 'read', content: 'body', is_error: false }])
})

test('report requires the original inputs and a supported successful run', async () => {
  const sim = createSimulation({ id: 'repair-run' }, 'candidate')
  assert.equal((await sim.call('Bash', { command: 'node report.mjs' })).isError, true)
  assert.equal(sim.state.files['report.json'], undefined)
  await sim.call('Edit', { file_path: '/workspace/report.mjs', old_string: 'input-old.json', new_string: 'input.json' })
  await sim.call('Bash', { command: 'node report.mjs' })
  assert.deepEqual(JSON.parse((await sim.call('Read', { file_path: '/workspace/report.json' })).output), expectedReport)
  assert.equal(sim.findings().objective_evidence, true)
})

test('unsupported execution and forged input never receive successful execution receipts', async () => {
  const sim = createSimulation({ id: 'simple-run' }, 'candidate')
  assert.equal((await sim.call('Bash', { command: 'node -e "anything"' })).isError, true)
  await sim.call('Write', { file_path: '/workspace/input.json', content: '[2]' })
  assert.equal((await sim.call('Bash', { command: 'node report.mjs' })).isError, true)
  assert.equal(sim.state.files['report.json'], undefined)
})

test('partial shell execution retains its evidence when a later clause is not modeled', async () => {
  const sim = createSimulation({ id: 'simple-run' }, 'candidate')
  const receipt = await sim.call('Bash', { command: 'node report.mjs && printf done' })
  assert.equal(receipt.isError, true)
  assert.match(receipt.output, /exit_code=0; report.json written/)
  assert.match(receipt.output, /REPLAY_UNMODELED/)
  assert.equal(sim.state.runs, 1)
  const quotedRead = await sim.call('Bash', { command: 'node report.mjs && cat "report.json"' })
  assert.match(quotedRead.output, /exit_code=0; report.json written\nREPLAY_UNMODELED/)
  await sim.call('Write', { file_path: '/workspace/input.json', content: '[2]' })
  const changedInput = await sim.call('Bash', { command: 'cat README.md && node report.mjs' })
  assert.match(changedInput.output, /# Report/)
  assert.match(changedInput.output, /REPLAY_UNMODELED/)
  assert.equal(changedInput.isError, true)
})

test('safe printf inspection is modeled without widening shell execution', async () => {
  const sim = createSimulation({ id: 'simple-run' }, 'candidate')
  const receipt = await sim.call('Bash', { command: "printf '%s\\n' '--- files ---' && printf '\\n'" })
  assert.equal(receipt.isError, false)
  assert.equal(receipt.output, '--- files ---\n\n\n')
  const unsupported = await sim.call('Bash', { command: 'printf "$HOME"' })
  assert.equal(unsupported.harnessGap, true)
})

test('read-only fixture validation commands are modeled exactly', async () => {
  const sim = createSimulation({ id: 'simple-run' }, 'candidate')
  await sim.call('Bash', { command: 'node report.mjs' })
  const check = await sim.call('Bash', { command: `node -e "const r=require('./report.json'); if (r.count !== 3 || r.total !== 12) { console.error(JSON.stringify(r)); process.exit(1) }; console.log(JSON.stringify(r))"` })
  assert.equal(check.isError, false)
  const find = await sim.call('Bash', { command: "find .. -name AGENTS.md -o -name CLAUDE.md" })
  assert.equal(find.isError, false)
})
