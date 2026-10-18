import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { systemUserCommand, systemUserEnvironment, runSystemUser, readSystemUserPermit, verifyRootExecutable } from '../system-user.mjs'

const entry = { user: 'alice', uid: 1001, gid: 1002, home: '/home/alice', data_dir: '/srv/alice/crabot-data', port_offset: 100, enabled: true, autostart: false }
test('UID helper drops primary and supplementary root groups before Node or employee data loads', () => {
  const request = systemUserCommand(entry, { node: '/opt/crabot/node', helper: '/opt/crabot/helper.mjs', action: 'start' })
  assert.equal(request.command, '/usr/bin/setpriv')
  assert.deepEqual(request.args, ['--reuid=1001', '--regid=1002', '--init-groups', '--', '/opt/crabot/node', '/opt/crabot/helper.mjs', 'start'])
  assert.equal(request.cwd, '/')
  assert.equal(request.env.HOME, '/home/alice'); assert.equal(request.env.DATA_DIR, '/srv/alice/crabot-data')
  assert.equal(request.env.XDG_RUNTIME_DIR, '/run/user/1001')
  assert.equal(request.args.includes('/srv/alice/crabot-data'), false)
})
test('root credentials, proxy settings, import hooks and arbitrary executable arguments are not inherited', () => {
  const before = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = '--import=/root/root-secret.mjs'
  try {
    const env = systemUserEnvironment(entry)
    assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.CRABOT_CORE_AGENT_RUNTIME_BEARER, undefined)
    assert.equal(env.HTTP_PROXY, undefined); assert.equal(env.CRABOT_HOME, undefined)
  } finally { if (before === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = before }
  for (const action of ['upgrade', 'eval', '../start', 'start;id']) {
    assert.throws(() => systemUserCommand(entry, { node: '/trusted/node', helper: '/trusted/helper', action }))
  }
  assert.throws(() => systemUserCommand(entry, { node: 'node', helper: '/trusted/helper', action: 'start' }))
})
test('nonadministrator cannot use the cross-user executor', { skip: process.platform === 'linux' && process.getuid() === 0 }, async () => {
  await assert.rejects(runSystemUser(entry, { root: '/opt/crabot', action: 'start', spawnProcess: () => assert.fail() }), { code: 'CRABOT_SYSTEM_ADMIN_REQUIRED' })
})

test('delegation requires a private administrator descriptor rather than a forgeable parent PID/env', { skip: process.platform === 'win32' }, t => {
  const parent = fs.mkdtempSync(path.join(tmpdir(), 'crabot-system-permit-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const file = path.join(parent, 'permit.json')
  fs.writeFileSync(file, JSON.stringify({ schema_version: 1, id: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12), action: 'inspect', entry }), { mode: 0o600 })
  let fd = fs.openSync(file, 'r')
  try { assert.throws(() => readSystemUserPermit(fd, process.getuid() + 1)) } finally { fs.closeSync(fd) }
  fd = fs.openSync(file, 'r')
  try { assert.equal(readSystemUserPermit(fd, process.getuid()).entry.uid, 1001) } finally { fs.closeSync(fd) }
  fs.chmodSync(file, 0o644); fd = fs.openSync(file, 'r')
  try { assert.throws(() => readSystemUserPermit(fd, process.getuid())) } finally { fs.closeSync(fd) }
})


test('an untrusted shared executable reports the exact path and ownership before dispatch', { skip: process.platform === 'win32' || process.getuid() === 0 }, t => {
  const parent = fs.mkdtempSync(path.join(tmpdir(), 'crabot-system-authority-'))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const file = path.join(parent, 'helper.mjs'); fs.writeFileSync(file, 'throw new Error("must not execute")')
  assert.throws(() => verifyRootExecutable(file), error => error.message.includes(file) && error.message.includes('uid=' + process.getuid()))
})
