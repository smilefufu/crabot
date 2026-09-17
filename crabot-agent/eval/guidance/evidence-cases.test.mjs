import assert from 'node:assert/strict'
import test from 'node:test'
import { FixtureContainer } from './docker-fixtures.mjs'
import { evidenceCases } from './evidence-cases.mjs'

test('historical PASS is genuine but does not validate changed input', async () => {
  const c = evidenceCases[0], box = new FixtureContainer('crabot-guidance-tools:local')
  try {
    const before = await box.start(c)
    assert.match(before['previous-check.log'].text, /PASS: 3 items\nPASS/)
    assert.equal(JSON.parse(before['items.json'].text).at(-1).value, 12)
    assert.equal(JSON.parse(before['results.json'].text).at(-1).result, 121)
    assert.match((await box.verify(c)).result.output, /^exit_code: 1/)
    assert.match((await box.call('Bash', { command: 'python check.py' })).result.output, /^exit_code: 1/)
    assert.match((await box.call('Bash', { command: 'python run.py && python check.py' })).result.output, /^exit_code: 0/)
    assert.match((await box.verify(c)).result.output, /^exit_code: 0/)
    const after = await box.snapshot()
    for (const name of ['items.json', 'run.py', 'check.py', 'previous-check.log']) assert.deepEqual(after[name], before[name])
  } finally { await box.close() }
})

test('old path failure and current parsing failure are both real, and distinguishable', async () => {
  const c = evidenceCases[1], box = new FixtureContainer('crabot-guidance-tools:local')
  try {
    const before = await box.start(c)
    assert.match(before['error.log'].text, /FileNotFoundError[\s\S]*ValueError[\s\S]*12x/)
    assert.equal(JSON.parse(before['config.json'].text).report_path, 'data/report.csv')
    const receipt = await box.call('Bash', { command: 'python report.py' })
    assert.match(receipt.result.output, /^exit_code: 1/)
    assert.match(receipt.result.output, /ValueError.*12x/)
    assert.doesNotMatch(receipt.result.output, /FileNotFoundError/)
    assert.deepEqual(await box.snapshot(), before)
  } finally { await box.close() }
})
