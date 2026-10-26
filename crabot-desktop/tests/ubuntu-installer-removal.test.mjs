import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { runUbuntuInstallerRemoval } from '../dist/ubuntu-installer-removal.js'

test('Ubuntu installer continuation rejects other platforms before changing cwd or reading an installation', { skip: process.platform === 'linux' }, async () => {
  const cwd = process.cwd(), installRoot = path.resolve('never-created-removal-installation')
  await assert.rejects(runUbuntuInstallerRemoval({ installRoot, payload: path.join(installRoot, 'offline'), operationId: randomUUID(),
    signal: new AbortController().signal, progress: () => assert.fail('No UI on an unsupported platform') }), { code: 'CRABOT_DESKTOP_REMOVAL' })
  assert.equal(process.cwd(), cwd)
  const { resumeInstallerDesktopRemovalNode } = await import('../../scripts/lib/desktop-removal-job.mjs')
  assert.throws(() => resumeInstallerDesktopRemovalNode({ installRoot }), { code: 'CRABOT_DESKTOP_REMOVAL' })
})
