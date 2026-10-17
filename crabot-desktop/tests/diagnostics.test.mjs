import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectDiagnostics } from '../dist/diagnostics.js'
import { SessionHost } from '../dist/session-host.js'
import { DesktopDiagnosticsSchema } from 'crabot-client'

test('local diagnostics survive absent core resources and omit private messages, paths, logs and environment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'crabot-diagnostic-private-'))
  try {
    await writeFile(join(root, 'credentials.json'), 'fixture-sensitive-credential')
    await writeFile(join(root, 'raw.log'), 'fixture-private-chat-and-token')
    const state = { phase: 'error', app_version: 'fixture', platform: process.platform, code: 'CRABOT_RUNTIME_INVALID', message: 'fixture-private-message' }
    const report = await collectDiagnostics(root, state, [])
    const text = JSON.stringify(report)
    assert.equal(report.runtime.status, 'unavailable')
    assert.equal(report.resources.length, 3)
    assert.ok(report.resources.every(resource => resource.status === 'unavailable'))
    for (const value of [root, 'fixture-sensitive', 'fixture-private', 'credentials.json', 'raw.log']) assert.equal(text.includes(value), false)
    assert.equal(DesktopDiagnosticsSchema.safeParse({ ...report, token: 'unexpected-secret' }).success, false)
  } finally { await rm(root, { recursive: true, force: true }) }
})
test('host keeps at most 40 transition metadata entries and no messages or credentials', () => {
  const host = new SessionHost({ coreRoot: '/unused', dataRoot: '/unused', appVersion: 'fixture', platform: process.platform })
  try {
    for (let i = 0; i < 50; i++) host.status('disconnected', 'fixture-user-text-never-in-history', 'DESKTOP_UNAVAILABLE')
    assert.equal(host.recent().length, 40)
    assert.equal(JSON.stringify(host.recent()).includes('fixture-user-text'), false)
    host.recent().splice(0)
    assert.equal(host.recent().length, 40)
  } finally { host.close() }
})
