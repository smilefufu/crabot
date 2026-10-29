import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, renameSync, existsSync, chmodSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import binding from '../mac-app-binding.cjs'
const mac = { skip: process.platform !== 'darwin' }
function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'Crabot App 绑定 '))), home = join(root, 'home'), appPath = join(root, 'Applications/Crabot.app')
  const core = join(appPath, 'Contents/Resources/core'), dataDir = join(root, '数据'); mkdirSync(core, { recursive: true }); mkdirSync(home); mkdirSync(dataDir)
  writeFileSync(join(core, 'desktop-host.json'), JSON.stringify({ schema_version: 1, platform: 'darwin', arch: process.arch }))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return { root, home, appPath, core, dataDir }
}
test('Mac GUI and owning bundled CLI resolve the same external data without copying programs', mac, t => {
  const f = fixture(t); writeFileSync(join(f.dataDir, 'retained'), 'business')
  binding.writeMacAppBinding(f)
  const env = {}; binding.applyMacAppEnvironment(f.core, { home: f.home, env })
  assert.equal(env.DATA_DIR, f.dataDir); assert.equal(env.CRABOT_PORT_OFFSET, '0'); assert.equal(env.CRABOT_PRODUCT_REQUIRED, '1')
  assert.equal(existsSync(join(f.dataDir, 'Contents')), false)
  assert.equal(readFileSync(join(f.dataDir, 'retained'), 'utf8'), 'business')
  assert.throws(() => binding.applyMacAppEnvironment(f.core, { home: f.home, env: { DATA_DIR: f.home } }), /冲突/)
})
test('source CLI ignores the Mac locator, including a broken locator', mac, t => {
  const f = fixture(t); binding.writeMacAppBinding(f)
  writeFileSync(binding.bindingFile(f.home), 'broken')
  const env = { DATA_DIR: '/source/data' }
  assert.equal(binding.applyMacAppEnvironment(f.root, { home: f.home, env }), null)
  assert.equal(env.DATA_DIR, '/source/data')
  assert.throws(() => binding.readMacAppBinding({ home: f.home }), /损坏/)
})
test('moving the App preserves data, requires GUI rebinding and never creates missing data', mac, t => {
  const f = fixture(t); binding.writeMacAppBinding(f)
  const moved = join(f.root, 'Moved.app'); renameSync(f.appPath, moved)
  const core = join(moved, 'Contents/Resources/core')
  assert.throws(() => binding.applyMacAppEnvironment(core, { home: f.home, env: {} }), /移动/)
  binding.writeMacAppBinding({ ...f, appPath: moved })
  const env = {}; binding.applyMacAppEnvironment(core, { home: f.home, env }); assert.equal(env.DATA_DIR, f.dataDir)
  rmSync(f.dataDir, { recursive: true })
  assert.throws(() => binding.applyMacAppEnvironment(core, { home: f.home, env: {} }), { code: 'CRABOT_DATA_MISSING' })
  assert.equal(existsSync(f.dataDir), false)
})
test('old 0755 data remains usable while broad locator access and in-App data are refused', mac, t => {
  const f = fixture(t); chmodSync(f.dataDir, 0o755); binding.writeMacAppBinding(f)
  assert.equal(binding.readMacAppBinding({ home: f.home }).data_dir, f.dataDir)
  assert.throws(() => binding.writeMacAppBinding({ ...f, dataDir: f.appPath }), /App之外/)
  chmodSync(binding.bindingFile(f.home), 0o644)
  assert.throws(() => binding.readMacAppBinding({ home: f.home }), /无法核验/)
})
