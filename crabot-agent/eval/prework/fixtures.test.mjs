import test from 'node:test'
import assert from 'node:assert/strict'
import { cases } from './cases.mjs'
import { PreworkFixture } from './docker-fixture.mjs'

async function fixture(kind, run) {
  const f = new PreworkFixture(cases.find(c => c.id === kind))
  try { await f.start(); await run(f) } finally { await f.close() }
}
const bash = async (f, command) => {
  const r = await f.call('Bash', { command })
  assert.equal(r.isError, false, r.output)
  assert.match(r.output, /^exit_code: 0\n/, r.output)
  return r.output.split('stdout:\n')[1].split('\nstderr:')[0]
}

test('real Shell supports compound writes, substitutions, pipelines, heredocs and redirection', () => fixture('changed-owner', async f => {
  const output = await bash(f, `set -euo pipefail
inspect=$(python3 tools/ops.py inspect --target user-17)
container=$(printf '%s' "$inspect" | python3 -c 'import sys,json; print(json.load(sys.stdin)["container_id"])')
python3 tools/ops.py add --target user-17 --container "$container" --amount 1000 > /tmp/add.json
tx=$(python3 - <<'PY'
import json
print(json.load(open('/tmp/add.json'))['transaction_id'])
PY
)
python3 tools/ops.py receipt --transaction "$tx" && python3 tools/ops.py save
cat /tmp/add.json | head -80`)
  assert.match(output, /bag-29/)
  assert.equal((await f.outcome()).goal, true)
}))

test('failed prerequisite stops later writes; help does not perform the operation', () => fixture('changed-owner', async f => {
  await bash(f, 'python3 tools/ops.py add --help')
  const r = await f.call('Bash', { command: 'python3 tools/ops.py add --target user-17 --container bag-17 --amount 1000 && python3 tools/ops.py save' })
  assert.equal(r.isError, false); assert.match(r.output, /^exit_code: 1\n/)
  const { state } = await f.outcome()
  assert.equal(state.additions, 0); assert.equal(state.saved, false)
}))

test('unknown previous write uses its receipt without adding again', () => fixture('unknown-previous-write', async f => {
  await bash(f, 'python3 tools/ops.py receipt --transaction tx-previous && python3 tools/ops.py save')
  const { goal, state } = await f.outcome()
  assert(goal); assert.equal(state.additions, 1)
  assert(!state.operations.some(x => x.operation === 'add'))
}))

test('saving before a write or reading an unrelated receipt cannot prove completion', () => fixture('worker-known-method', async f => {
  await bash(f, 'python3 tools/ops.py inspect --target user-17; python3 tools/ops.py save; python3 tools/ops.py add --target user-17 --container bag-17 --amount 1000')
  const r = await f.call('Bash', { command: 'python3 tools/ops.py receipt --transaction unrelated && python3 tools/ops.py save' })
  assert.equal(r.isError, false); assert.match(r.output, /^exit_code: 1\n/)
  assert.equal((await f.outcome()).goal, false)
}))

test('real Git has no phantom diff and cannot commit an unstaged change', () => fixture('development-boundary', async f => {
  const clean = await bash(f, 'git status --porcelain && git diff && git diff --cached')
  assert.equal(clean.trim(), '')
  await f.act('load_guidance', { name: 'worker.project-context' }, () => 'guide')
  const edit = await f.call('Edit', { file_path: '/fixture/project/src/Shield.cs', old_string: 'HeavyShield.Defense=18', new_string: 'HeavyShield.Defense=24' })
  assert.equal(edit.isError, false, edit.output)
  assert.match(await bash(f, 'git diff -- src/Shield.cs'), /HeavyShield.Defense=24/)
  const unstaged = await f.call('Bash', { command: 'git commit -m unstaged' })
  assert.equal(unstaged.isError, false); assert.match(unstaged.output, /^exit_code: 1\n/)
  assert.equal((await f.outcome()).goal, false)
  await bash(f, 'python3 tools/ops.py verify-shields && git diff --check && git add src/Shield.cs && git commit -m defense')
  assert.equal((await f.outcome()).goal, true)
}))

test('Read, Glob, Grep and Skill use actual product result contracts', () => fixture('worker-known-method', async f => {
  const list = await f.call('Skill', { skill: 'list' })
  assert.equal(list.isError, false); assert.match(list.output, /Available skills:.*\n- tmp-page/)
  const missing = await f.call('Skill', { skill: 'missing' })
  assert(missing.isError); assert.match(missing.output, /Skill not found/)
  const read = await f.call('Read', { file_path: '/fixture/project/AGENTS.md' })
  assert.match(read.output, /这是人工测试项目/)
  const glob = await f.call('Glob', { pattern: 'src/*.cs', path: '/fixture/project' })
  assert.match(glob.output, /Shield.cs/); assert.match(glob.output, /Combat.cs/)
  const grep = await f.call('Grep', { pattern: 'HeavyShield', path: '/fixture/project/src', output_mode: 'content' })
  assert.match(grep.output, /HeavyShield.Defense=18/)
}))
