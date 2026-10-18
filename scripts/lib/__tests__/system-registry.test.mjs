import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { SystemRegistry, validateSystemEntries, resolveLinuxAccount } from '../system-registry.mjs'

const entry = (uid = 1001) => ({ user: 'alice', uid, gid: uid, home: '/home/alice', data_dir: '/home/alice/.crabot/data-100', port_offset: 100, enabled: true, autostart: false })
function fixture(t) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'crabot-system-')))
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }))
  const accounts = new Map([['alice', { user: 'alice', uid: 1001, gid: 1001, home: '/home/alice' }], ['bob', { user: 'bob', uid: 1002, gid: 1002, home: '/home/bob' }]])
  const registry = new SystemRegistry({ directory: path.join(parent, 'system'), ownerUid: process.getuid(), accountLookup: user => structuredClone(accounts.get(user)) })
  return { registry, accounts, parent }
}
const options = { skip: process.platform === 'win32' }

test('system registration refuses conflicting UID, path, offset, root and injected fields', () => {
  assert.deepEqual(validateSystemEntries([entry()]), [entry()])
  for (const patch of [{ uid: 0 }, { port_offset: 1 }, { data_dir: '/' }, { data_dir: '/home/alice/../bob' },
    { command: 'shell' }, { user: '--help' }, { home: '/home/alice\nroot' }, { autostart: 'yes' }]) {
    assert.throws(() => validateSystemEntries([{ ...entry(), ...patch }]))
  }
  for (const patch of [{ uid: 1001 }, { user: 'alice' }, { port_offset: 100 }, { data_dir: entry().data_dir }]) {
    assert.throws(() => validateSystemEntries([entry(), { ...entry(1002), user: 'bob', home: '/home/bob', data_dir: '/home/bob/.crabot/data-200', port_offset: 200, ...patch }]))
  }
})

test('account lookup uses fixed NSS executable and refuses root, multiline or mismatched identity', () => {
  let args
  const lookup = (_, values, options) => { args = { values, options }; return 'alice:x:1001:1002::/home/alice:/bin/bash\n' }
  assert.deepEqual(resolveLinuxAccount('alice', lookup), { user: 'alice', uid: 1001, gid: 1002, home: '/home/alice' })
  assert.deepEqual(args.values, ['passwd', 'alice']); assert.equal(args.options.env.DATA_DIR, undefined)
  for (const response of ['alice:x:0:0::/root:/bin/bash', 'bob:x:1001:1001::/home/bob:/bin/bash', 'alice:x:1:1::/home/alice:/bin/bash\nroot:x:0:0::/root:/bin/bash']) {
    assert.throws(() => resolveLinuxAccount('alice', () => response))
  }
  assert.throws(() => resolveLinuxAccount('--help', lookup))
})

test('new registry is explicit; registration preserves repeat state and allocates unique offsets', options, async t => {
  const { registry } = fixture(t)
  registry.initialize()
  assert.throws(() => registry.read())
  await registry.update(() => [], { create: true })
  const calls = []
  const alice = await registry.register('alice', { prepare: async value => calls.push(value.uid) })
  const bob = await registry.register('bob')
  assert.equal(alice.port_offset, 100); assert.equal(bob.port_offset, 200); assert.equal(alice.autostart, false)
  assert.equal(fs.existsSync(alice.data_dir), false, 'root registry must not create or read employee directories')
  assert.deepEqual(await registry.register('alice', { prepare: () => assert.fail('must not reset existing credentials or environment') }), alice)
  assert.equal((await registry.register('alice', { autostart: true })).autostart, true)
  assert.equal((await registry.register('alice')).autostart, true)
  assert.equal((await registry.register('alice', { autostart: false })).autostart, false)
  assert.deepEqual(calls, [1001]); assert.equal(registry.read().length, 2)
})

test('preparation failure leaves registry unchanged and never records incomplete user', options, async t => {
  const { registry } = fixture(t)
  await registry.update(() => [], { create: true })
  await assert.rejects(registry.register('alice', { prepare: () => { throw new Error('credentials failed') } }), /credentials failed/)
  assert.deepEqual(registry.read(), [])
  assert.equal((await registry.register('bob')).port_offset, 100)
})

test('changed accounts are refused; explicit reopening preserves the disabled binding and never initializes data', options, async t => {
  const { registry, accounts } = fixture(t)
  await registry.update(() => [entry()], { create: true })
  accounts.get('alice').uid = 1010
  await assert.rejects(registry.register('alice'), /身份已变化/)
  accounts.get('alice').uid = 1001
  await registry.update(entries => entries.map(value => ({ ...value, enabled: false })))
  let reopening = false
  const reopened = await registry.register('alice', { prepare: () => assert.fail('never reset old data or credentials'),
    configure: async (value, context) => { reopening = context.reopening; assert.equal(value.data_dir, entry().data_dir) } })
  assert.equal(reopening, true); assert.deepEqual(reopened, entry())
})

test('corrupt, writable, hardlinked or redirected registry is never treated as empty', options, async t => {
  const { registry, parent } = fixture(t)
  await registry.update(() => [entry()], { create: true })
  const file = path.join(registry.directory, 'instances.json'), original = fs.readFileSync(file)
  fs.writeFileSync(file, '{bad')
  assert.throws(() => registry.read()); await assert.rejects(registry.register('bob'))
  fs.writeFileSync(file, original); fs.chmodSync(file, 0o666)
  assert.throws(() => registry.read()); fs.chmodSync(file, 0o644)
  const other = path.join(parent, 'original'); fs.linkSync(file, other)
  assert.throws(() => registry.read()); fs.unlinkSync(file)
  fs.symlinkSync(other, file)
  assert.throws(() => registry.read())
})

test('registration uses OS mutual exclusion for concurrent allocations', options, async t => {
  const { registry } = fixture(t)
  await registry.update(() => [], { create: true })
  await Promise.all([registry.register('alice'), registry.register('bob')])
  assert.deepEqual(registry.read().map(value => value.port_offset).sort(), [100, 200])
})


test('a repeated opening still checks the maintenance gate while holding the registry lock', options, async t => {
  const { registry } = fixture(t); await registry.update(() => [entry()], { create: true })
  await assert.rejects(registry.register('alice', { assertAvailable: () => { throw new Error('maintenance is active') } }), /maintenance is active/)
  assert.deepEqual(registry.read(), [entry()])
})
test('service configuration failure retains the old enabled and autostart flags', options, async t => {
  const { registry } = fixture(t), disabled = { ...entry(), enabled: false, autostart: true }
  await registry.update(() => [disabled], { create: true })
  await assert.rejects(registry.register('alice', { autostart: false, configure: () => { throw new Error('service could not disable') } }), /service could not disable/)
  assert.deepEqual(registry.read(), [disabled])
})
test('NSS is rechecked inside the lock before preparation and publication', options, async t => {
  const { registry, accounts } = fixture(t); await registry.update(() => [], { create: true })
  let lookups = 0
  registry.accountLookup = user => {
    lookups++; return { ...accounts.get(user), uid: lookups === 1 ? 1001 : 1003 }
  }
  const registered = await registry.register('alice', { prepare: value => assert.equal(value.uid, 1003) })
  assert.equal(registered.uid, 1003)
})


test('an explicit unchanged autostart flag still reconciles the actual service after a prior partial failure', options, async t => {
  const { registry } = fixture(t); await registry.update(() => [entry()], { create: true })
  let configured = 0
  await registry.register('alice', { autostart: false, configure: () => { configured++ } })
  assert.equal(configured, 1)
})
