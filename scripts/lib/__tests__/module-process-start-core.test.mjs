import test from 'node:test'
import assert from 'node:assert/strict'

test('shared module-start probe preserves the existing Core producer identity for the current process', async () => {
  const { probeProcessStartIdentity } = await import('../module-process-start.cjs')
  const core = await import('../../../crabot-core/dist/module-runtime-registry.js')
  const expected = await core.probeProcessStartIdentity(process.pid)
  assert.equal(typeof expected, 'string')
  assert.equal(await probeProcessStartIdentity(process.pid), expected)
  assert.equal(await probeProcessStartIdentity(2_147_483_647), null)
})

test('Windows FILETIME conversion reproduces the CIM microsecond identity text', async () => {
  const { windowsStartIdentityFromFiletime } = await import('../module-process-start.cjs')
  assert.equal(windowsStartIdentityFromFiletime(134391297733548722n), 'win32:2026-11-14T11:36:13.3548720Z')
  assert.equal(windowsStartIdentityFromFiletime(134391243239790487n), 'win32:2026-11-14T10:05:23.9790480Z')
})

test('Windows start identity probe works without PowerShell in PATH', { skip: process.platform !== 'win32' }, async t => {
  const { probeProcessStartIdentity } = await import('../module-process-start.cjs')
  const previous = process.env.PATH
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous })
  process.env.PATH = ''
  const identity = await probeProcessStartIdentity(process.pid)
  assert.match(identity, /^win32:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}0Z$/)
})


test('Windows Core listener and process-tree observations work without PowerShell in PATH', { skip: process.platform !== 'win32', timeout: 30_000 }, async t => {
  const net = await import('node:net'), { once } = await import('node:events'), path = await import('node:path')
  const core = await import('../../../crabot-core/dist/module-runtime-registry.js'), tree = await import('../../../crabot-core/dist/process-tree.js')
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(resolve)))
  const previous = process.env.PATH
  t.after(() => { if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous })
  process.env.PATH = path.join(process.env.SystemRoot, 'System32')
  const port = server.address().port, owners = await core.inspectWindowsPortOwners(port)
  assert.equal(owners.some(owner => owner.pid === process.pid), true)
  assert.equal(await tree.waitForProcessTreeExit(process.pid, 0, 1, port), false)
  assert.equal(server.listening, true)
})
