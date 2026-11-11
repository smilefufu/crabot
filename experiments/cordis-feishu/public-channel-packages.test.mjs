import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { ChannelPackageStore, CHANNEL_NPM_REGISTRY } from '../../crabot-admin/dist/channel-package.js'
import { verifyManagedPackage } from './managed-package-fixture.mjs'
import { CHANNEL_CATALOG } from '../../crabot-admin/dist/channel-catalog.js'

test('public exact Channel versions install without a source checkout and restart offline', { timeout: 720000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cordis-public-channels-'))
  const registry = process.env.CORDIS_TEST_NPM_REGISTRY ?? CHANNEL_NPM_REGISTRY
  const store = new ChannelPackageStore(root)
  try {
    for (const item of CHANNEL_CATALOG) {
      const definition = { name: item.package_name, version: item.version }
      const directory = await store.ensure(definition, { registry })
      const record = JSON.parse(await fs.readFile(path.join(directory, '../../installation.json'), 'utf8'))
      assert.equal(record.registry, registry)
      assert.ok(record.download_origins.length > 0)
      const load = createRequire(path.join(directory, 'package.json'))
      const plugin = load('./dist/main.js')
      assert.equal(typeof plugin.apply, 'function')
      assert.equal(typeof plugin.createConfig, 'function')
      assert.equal(await new ChannelPackageStore(root).ensure(definition, { execute: async () => { throw new Error('Offline startup ran npm') } }), directory)
      if (item.platform === 'slack') {
        const sdk = await fs.readFile(path.join(directory, 'node_modules/@slack/socket-mode/dist/src/SocketModeClient.js'), 'utf8')
        assert.ok(sdk.includes('cb.apply(this).then(res, rej)'))
      }
      await verifyManagedPackage(directory, item.platform)
      console.log(JSON.stringify({ name: definition.name, version: definition.version, registry, origins: record.download_origins }))
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
