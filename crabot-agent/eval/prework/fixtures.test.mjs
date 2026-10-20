import test from 'node:test'
import assert from 'node:assert/strict'
import { cases, initialState, simulate, complete, splitCommands } from './cases.mjs'

const guide = () => 'fixture guidance'
test('compound receipt and save both execute in one Bash call', () => {
  const c=cases.find(c=>c.kind==='unknown'), s=initialState(c)
  const r=simulate(c,s,'Bash',{command:'cd /fixture/project && python3 tools/ops.py receipt --transaction tx-previous && python3 tools/ops.py save'},guide)
  assert.equal(r.isError,false);assert(complete(c,s));assert.equal(s.additions,1)
  assert(r.output.includes('committed'));assert(r.output.includes('saved'))
  assert.equal(s.actions.length,1)
})
test('compound inspect, add, receipt and save preserve current owner and exact addition', () => {
  const c=cases.find(c=>c.changed), s=initialState(c)
  simulate(c,s,'Bash',{command:'python3 tools/ops.py inspect --target user-17 && python3 tools/ops.py add --target user-17 --container bag-29 --amount 1000; python3 tools/ops.py receipt --transaction tx-new; python3 tools/ops.py save'},guide)
  assert(complete(c,s));assert.equal(s.additions,1)
})
test('a failed prerequisite prevents later compound writes', () => {
  const c=cases.find(c=>c.changed), s=initialState(c)
  const r=simulate(c,s,'Bash',{command:'python3 tools/ops.py add --target user-17 --container bag-17 --amount 1000 && python3 tools/ops.py save'},guide)
  assert(r.isError);assert.equal(s.additions,0);assert.equal(s.saved,false)
})
test('quoted operators do not become shell command boundaries', () => {
  assert.deepEqual(splitCommands("printf 'receipt && save'; python3 tools/ops.py save"),["printf 'receipt && save'",'python3 tools/ops.py save'])
})
test('a shell file read returns file content rather than API side effects', () => {
  const c=cases[1], s=initialState(c)
  const r=simulate(c,s,'Bash',{command:"pwd; sed -n '1,240p' tools/ops.py"},guide)
  assert(r.output.includes('已验证操作接口'));assert.equal(s.additions,0)
})
test('saving before a write cannot prove the new write was persisted', () => {
  const c=cases[1], s=initialState(c)
  simulate(c,s,'Bash',{command:'python3 tools/ops.py inspect --target user-17; python3 tools/ops.py save; python3 tools/ops.py add --target user-17 --container bag-17 --amount 1000; python3 tools/ops.py receipt --transaction tx-new'},guide)
  assert.equal(s.additions,1);assert.equal(complete(c,s),false)
})
test('unrelated transaction receipts cannot verify the requested write', () => {
  const c=cases.find(c=>c.kind==='unknown'), s=initialState(c)
  const r=simulate(c,s,'Bash',{command:'python3 tools/ops.py receipt --transaction unrelated && python3 tools/ops.py save'},guide)
  assert(r.isError);assert.equal(s.receipt,false);assert.equal(complete(c,s),false)
})
