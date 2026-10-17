import test from 'node:test'
import assert from 'node:assert/strict'
import { DesktopController } from '../dist/controller.js'
import { fileURLToPath } from 'node:url'

test('a stopped GUI observes an externally started shared core without starting it itself', async t => {
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: '/unused', appVersion: 'fixture', platform: process.platform })
  t.after(() => controller.close())
  let connects = 0
  controller.current = async () => ({ mmAlive: true, record: { generation: 'external-start' } })
  controller.load = async () => { throw new Error('Observation must never load a start/stop adapter') }
  controller.host.reconnect = async () => { connects++ }
  controller.host.status('stopped')
  await controller.reconnectIfChanged()
  assert.equal(connects, 1)
})

test('restoring a stopped GUI while its core remains stopped never starts or authenticates it', async t => {
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: '/unused', appVersion: 'fixture', platform: process.platform })
  t.after(() => controller.close())
  controller.current = async () => ({ mmAlive: false, record: null })
  controller.load = async () => { throw new Error('Observation must never load a start/stop adapter') }
  controller.host.reconnect = async () => { throw new Error('No core to authenticate') }
  controller.host.status('stopped')
  await controller.reconnectIfChanged()
  assert.equal(controller.host.snapshot().phase, 'stopped')
})

test('a damaged packaged version cannot bypass verification through reconnect or an external CLI start', async t => {
  const controller = new DesktopController({ coreRoot: fileURLToPath(new URL('../..', import.meta.url)), dataRoot: '/unused',
    appVersion: '0.1.0-desktop.2', platform: process.platform, packaged: true })
  t.after(() => controller.close())
  let connects = 0
  controller.current = async () => ({ mmAlive: true, record: { generation: 'external-start' } })
  controller.host.reconnect = async () => { connects++ }
  assert.equal((await controller.start()).phase, 'error')
  assert.equal((await controller.reconnect()).phase, 'error')
  controller.host.status('stopped')
  await controller.reconnectIfChanged()
  assert.equal(controller.host.snapshot().phase, 'error')
  assert.equal(controller.host.snapshot().code, 'CRABOT_CORE_INTEGRITY')
  assert.equal(connects, 0)
})

test('a completed explicit stop invalidates a watcher still verifying the installation', async t => {
  const controller = new DesktopController({ coreRoot: '/unused', dataRoot: '/unused', appVersion: 'fixture', platform: process.platform })
  t.after(() => controller.close())
  let checking, release
  const started = new Promise(resolve => { checking = resolve })
  const verification = new Promise(resolve => { release = resolve })
  controller.verifyInstallation = async () => { checking(); await verification }
  controller.current = async () => ({ mmAlive: true, record: { generation: 'external-start' } })
  controller.load = async file => {
    if (file.endsWith('cli-lock.mjs')) return { acquireCliLock: async () => 'fixture-lock', releaseCliLock: () => {} }
    if (file.endsWith('instance-controller.mjs')) return { stopInstance: async () => {} }
    throw new Error('Unexpected adapter')
  }
  let connects = 0
  controller.host.reconnect = async () => { connects++ }
  controller.host.status('stopped')
  const watching = controller.reconnectIfChanged()
  await started
  assert.equal((await controller.stop()).phase, 'stopped')
  release(); await watching
  assert.equal(controller.host.snapshot().phase, 'stopped')
  assert.equal(connects, 0)
})
