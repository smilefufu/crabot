import { it, expect, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { assertRequestUpgradeReady } from '../../src/manager/request-upgrade.js'
let root: string
afterEach(async () => { if (root) await fs.rm(root, { recursive: true, force: true }) })
it('entry gate rejects absent, corrupt and unknown readiness, accepts only completed preparation', async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'request-ready-'))
  await expect(assertRequestUpgradeReady(root)).rejects.toThrow()
  for (const value of ['broken', JSON.stringify({ schema_version: 2, status: 'ready' }), JSON.stringify({ schema_version: 1, status: 'pending' })]) {
    await fs.writeFile(path.join(root, 'shared-request-upgrade.json'), value)
    await expect(assertRequestUpgradeReady(root)).rejects.toThrow()
  }
  await fs.writeFile(path.join(root, 'shared-request-upgrade.json'), JSON.stringify({ schema_version: 1, status: 'ready', transaction: 'shared-request-upgrade-v1', plan_sha256: 'a'.repeat(64) }))
  await expect(assertRequestUpgradeReady(root)).resolves.toBeUndefined()
})
