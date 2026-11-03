import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { submitSystemOperation } from '../system-job-client.mjs'
const options = { skip: process.platform === 'win32' }

function fixture(t, { active = true, permanent = false, phase = 'completed' } = {}) {
  const root = '/crabot-system-client-fixture'
  const files = new Set([root + '/.product-runtime/node/bin/node', root + '/scripts/system-job.mjs'])
  const stat = fs.lstatSync.bind(fs)
  t.mock.method(fs, 'lstatSync', file => String(file).startsWith(root) || file === '/' ? {
    uid: 0, mode: 0o755, isSymbolicLink: () => false, isFile: () => files.has(file), isDirectory: () => !files.has(file),
  } : stat(file))
  const plan = { id: '11111111-1111-4111-8111-111111111111', items: [] }
  const progress = { results: [], exit_code: phase === 'completed' ? 0 : 1 }
  const failure = Object.assign(new Error('public completion is not yet published'), { code: 'CRABOT_SYSTEM_JOURNAL_FAILED' })
  let completions = 0, prepared = 0, submitted = 0, observations = 0
  const logs = []
  const store = {
    prepare: async () => { prepared++ }, file: () => '/unused', read: () => ({ phase, progress }),
    completion: () => { completions++; if (completions === 1 || permanent) throw failure; return progress },
  }
  const run = async command => {
    if (command === '/usr/bin/systemd-run') { submitted++; return { stdout: '' } }
    assert.equal(command, '/usr/bin/systemctl'); observations++
    return { stdout: active && observations === 1 ? 'active\n' : 'inactive\n' }
  }
  return { options: { root, store, run, log: line => logs.push(line) }, plan, failure, logs,
    counts: () => ({ completions, prepared, submitted, observations }) }
}

test('completion observed during the two journal writes waits without submitting another job', options, async t => {
  const f = fixture(t)
  assert.equal(await submitSystemOperation(f.plan, f.options), 0)
  assert.deepEqual(f.counts(), { completions: 2, prepared: 1, submitted: 1, observations: 1 })
  assert.ok(f.logs.some(line => line.startsWith('作业结束')))
})

test('coordinator exit between the first read and status query rechecks the completed records', options, async t => {
  const f = fixture(t, { active: false })
  assert.equal(await submitSystemOperation(f.plan, f.options), 0)
  assert.deepEqual(f.counts(), { completions: 2, prepared: 1, submitted: 1, observations: 1 })
})

test('a stopped coordinator with a genuinely incomplete journal retains the original error', options, async t => {
  const f = fixture(t, { active: false, permanent: true })
  await assert.rejects(submitSystemOperation(f.plan, f.options), error => error === f.failure)
  assert.ok(!f.logs.some(line => line.startsWith('作业结束')))
  assert.equal(f.counts().submitted, 1)
})

test('interrupted completion remains a failure after its journal publication finishes', options, async t => {
  const f = fixture(t, { phase: 'interrupted' })
  assert.equal(await submitSystemOperation(f.plan, f.options), 1)
  assert.ok(f.logs.some(line => line.startsWith('作业中断，保留维护保护')))
})
