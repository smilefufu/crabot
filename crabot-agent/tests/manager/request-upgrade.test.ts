import { it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { assertRequestUpgradeReady } from '../../src/manager/request-upgrade.js'
let directory: string
beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), 'request-upgrade-gate-')) })
afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }) })
it.each([1, 2])('accepts only paired v%s completion credentials', async version => {
  await fs.writeFile(path.join(directory, 'shared-request-upgrade.json'), JSON.stringify({ schema_version: version, status: 'ready', transaction: `shared-request-upgrade-v${version}`, plan_sha256: 'a'.repeat(64) }))
  await expect(assertRequestUpgradeReady(directory)).resolves.toBeUndefined()
})
it.each([null, { schema_version: 3, status: 'ready' }, { schema_version: 2, status: 'ready', transaction: 'shared-request-upgrade-v1', plan_sha256: 'a'.repeat(64) }])('refuses missing, unknown and mismatched credentials', async marker => {
  if (marker) await fs.writeFile(path.join(directory, 'shared-request-upgrade.json'), JSON.stringify(marker))
  await expect(assertRequestUpgradeReady(directory)).rejects.toThrow()
})
