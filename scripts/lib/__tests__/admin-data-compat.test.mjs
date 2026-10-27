import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { assertAdminDataCompatibility } from '../admin-data-compat.mjs'
test('old Core without an Admin schema cannot load migrated permissions; original markers remain intact', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-compat-'))
  const data = path.join(root, 'data'), core = path.join(root, 'core')
  try {
    await fs.mkdir(path.join(data, 'admin'), { recursive: true }); await fs.mkdir(path.join(core, 'crabot-admin'), { recursive: true })
    assert.doesNotThrow(() => assertAdminDataCompatibility(core, data))
    await fs.writeFile(path.join(data, 'admin/SCHEMA_VERSION'), 'v0\n')
    assert.doesNotThrow(() => assertAdminDataCompatibility(core, data))
    await fs.writeFile(path.join(data, 'admin/SCHEMA_VERSION'), 'v1\n')
    assert.throws(() => assertAdminDataCompatibility(core, data), { code: 'CRABOT_DATA_NEWER_THAN_CODE' })
    await fs.writeFile(path.join(core, 'crabot-admin/schema_version'), 'v1\n')
    assert.doesNotThrow(() => assertAdminDataCompatibility(core, data))
    await fs.writeFile(path.join(data, 'admin/SCHEMA_VERSION'), 'v2\n')
    assert.throws(() => assertAdminDataCompatibility(core, data), { code: 'CRABOT_DATA_NEWER_THAN_CODE' })
    await fs.writeFile(path.join(data, 'admin/SCHEMA_VERSION'), 'broken')
    assert.throws(() => assertAdminDataCompatibility(core, data), { code: 'CRABOT_SCHEMA_VERSION_INVALID' })
    assert.equal(await fs.readFile(path.join(data, 'admin/SCHEMA_VERSION'), 'utf8'), 'broken')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
