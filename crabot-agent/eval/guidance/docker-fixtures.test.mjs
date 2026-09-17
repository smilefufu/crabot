import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { createRequire } from 'node:module'
import { FixtureContainer, cases, docker } from './docker-fixtures.mjs'

const require = createRequire(path.resolve(import.meta.dirname, '../../package.json'))
const image = 'crabot-guidance-tools:local'

test('real tools fail, repair and independently verify; engine denial prevents the edit', async () => {
  const box = new FixtureContainer(image)
  try {
    await box.start(cases[0])
    const [state] = JSON.parse(await docker(['inspect', box.name]))
    assert.equal(state.HostConfig.NetworkMode, 'none')
    assert.equal(state.HostConfig.ReadonlyRootfs, true)
    assert.equal(state.Config.User, '65534:65534')
    assert.equal(state.Mounts.some(m => m.Type === 'bind'), false)
    const input = { file_path: 'add.py', old_string: 'a - b', new_string: 'a + b' }
    const read = await box.call('Read', { file_path: 'add.py' })
    assert.equal(read.result.isError, false)
    assert.match(read.result.output, /return a - b/)
    assert.match((await box.call('Bash', { command: 'python check.py' })).result.output, /^exit_code: 1/)
    const before = await box.snapshot()
    const denied = await box.call('Edit', input, { mode: 'denyList', toolNames: ['Edit'] })
    assert.equal(denied.permission.allowed, false)
    assert.equal(denied.result.isError, true)
    assert.deepEqual(await box.snapshot(), before)
    assert.equal((await box.call('Edit', input)).result.isError, false)
    assert.match((await box.call('Bash', { command: 'python check.py && cat add.py' })).result.output, /^exit_code: 0/)
    assert.match((await box.verify(cases[0])).result.output, /^exit_code: 0/)
    assert.deepEqual((await box.snapshot())['check.py'], before['check.py'])
  } finally { await box.close() }
  await assert.rejects(docker(['inspect', box.name]), /no such object/i)
})

test('diagnosis starts with two genuine failures and allows arbitrary read-only shell inspection', async () => {
  const box = new FixtureContainer(image)
  try {
    const before = await box.start(cases[1])
    assert.equal((before['error.log'].text.match(/FileNotFoundError/g) ?? []).length, 2)
    const result = await box.call('Bash', { command: 'find . -type f | sort; cat config.json; cat data/report.csv; stat data/report.csv' })
    assert.match(result.result.output, /apples,12/)
    assert.deepEqual(await box.snapshot(), before)
  } finally { await box.close() }
})

test('actual capability query and spawn guard agree on task=false; no harness spawn occurs', async () => {
  const { BUILTIN_WORKER_PERMISSIONS } = require('./dist/workers/builtin/runtime.js')
  const { createExecutionCapabilitiesTool } = require('./dist/manager/tools/execution-capabilities.js')
  const { buildWorkerTools } = require('./dist/manager/tools/worker-tools.js')
  const context = () => ({ managerKey: 'fixture::synthetic', principalPermissions: {
    ...BUILTIN_WORKER_PERMISSIONS,
    tool_access: { ...BUILTIN_WORKER_PERMISSIONS.tool_access, task: false, file_io: true },
  } })
  let attempts = 0
  const harness = { spawnWorker: async () => { attempts++; throw Error('Unexpected spawn') } }
  const observation = await createExecutionCapabilitiesTool({ workerContext: context }).call({ impl: 'builtin' }, {})
  assert.equal(observation.isError, false)
  const facts = JSON.parse(observation.output)
  assert.equal(facts.can_spawn, false)
  assert.equal(facts.implementations[0].permissions.tool_access.file_io, true)
  const spawn = buildWorkerTools({ harness, context }).find(t => t.name === 'spawn_worker')
  const result = await spawn.call({ title: '人工测试', prompt: '读取人工数据' }, {})
  assert.equal(result.isError, true)
  assert.match(result.output, /没有任务派发权限/)
  assert.equal(attempts, 0)
})
