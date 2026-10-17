import test from 'node:test'
import assert from 'node:assert/strict'
import { DesktopController } from '../dist/controller.js'

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
