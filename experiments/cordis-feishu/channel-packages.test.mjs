import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pack } from '../../scripts/pack-channel.mjs'
import { ChannelPackageStore } from '../../crabot-admin/dist/channel-package.js'

const platforms = ['feishu', 'wechat', 'telegram', 'dingtalk', 'slack', 'voice']
test('all six actual npm artifacts install independently, retain exports and restart offline', { timeout: 720000 }, async () => {
  const artifacts = process.env.CORDIS_CHANNEL_ARTIFACTS
  assert.ok(artifacts, 'Set CORDIS_CHANNEL_ARTIFACTS to the candidate artifact directory')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cordis-six-packages-'))
  const store = new ChannelPackageStore(root)
  try {
    for (const platform of platforms) {
      const summary = await pack(platform, artifacts)
      assert.equal(summary.version, '0.1.1')
      const definition = { name: summary.name, version: summary.version }
      const directory = await store.ensure(definition, { specification: path.join(artifacts, summary.filename) })
      const load = createRequire(path.join(directory, 'package.json'))
      const plugin = load('./dist/main.js')
      assert.equal(typeof plugin.apply, 'function')
      assert.equal(typeof plugin.createConfig, 'function')
      assert.ok(plugin.inject.includes('crabotChannels'))
      assert.equal(await new ChannelPackageStore(root).ensure(definition, { execute: async () => { throw new Error('Offline startup must not run npm') } }), directory)
      const manifest = load('./package.json')
      assert.equal(manifest.dependencies['crabot-shared'].startsWith('file:'), false)
      if (platform === 'slack') {
        const sdk = await fs.readFile(path.join(directory, 'node_modules/@slack/socket-mode/dist/src/SocketModeClient.js'), 'utf8')
        assert.ok(sdk.includes('cb.apply(this).then(res, rej)'))
        assert.ok(sdk.includes('this.delayReconnectAttempt(this.start).catch('))
      }
      console.log(JSON.stringify({ platform, bytes: summary.size, unpacked: summary.unpackedSize, integrity: summary.integrity }))
    }
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
