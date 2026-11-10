// The actual old reader must reject new records before any transport or process operation.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import legacy from './legacy-instance-runtime-record.cjs'
import { createInstanceRuntime } from '../../scripts/lib/instance-runtime.mjs'

test('the actual old HTTP reader must reject a private-pipe runtime before using a virtual address', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-legacy-record-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  createInstanceRuntime({ root: directory, dataDir: directory, mmPort: 19000 })
  const file = path.join(directory, 'instance-runtime.json')
  const before = await fs.readFile(file)
  assert.throws(() => legacy.readInstanceRuntime(directory), { code: 'CRABOT_INSTANCE_UNVERIFIED' })
  assert.deepEqual(await fs.readFile(file), before)
})
