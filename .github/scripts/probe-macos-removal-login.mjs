// Same-identity source/copy behavior, on throwaway CI users only. No real
// Crabot entry, human session, Core, business service or model is involved.
import assert from 'node:assert/strict'
import { promises as fs, constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Login fixture is CI-only')
assert.equal(process.platform, 'darwin')
const run = promisify(execFile), temporary = process.env.RUNNER_TEMP
assert.ok(temporary && path.isAbsolute(temporary))
const root = await fs.mkdtemp(path.join(temporary, 'crabot-login-owned-'))
const identifier = 'com.crabot.test.removal-login.' + randomUUID()
const application = name => path.join(root, name, 'Fixture.app')
const executable = name => path.join(application(name), 'Contents/MacOS/CrabotLoginFixture')
const command = (file, args) => run(file, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 })
const observe = async (name, action) => JSON.parse((await command(executable(name), [action])).stdout)
let sourceBuilt = false, registrationAttempted = false, failure, cleanup
const facts = { fixture_only: true, business_started: false, identifier, observations: [] }
try {
  await fs.mkdir(path.dirname(executable('source')), { recursive: true, mode: 0o700 })
  await command('/usr/bin/clang', ['-fobjc-arc', '-mmacosx-version-min=14.0', '-framework', 'Foundation', '-framework', 'ServiceManagement',
    fileURLToPath(new URL('./fixtures/macos-removal-login.m', import.meta.url)), '-o', executable('source')])
  await fs.writeFile(path.join(application('source'), 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>CrabotLoginFixture</string><key>CFBundleName</key><string>Crabot Login Fixture</string>
<key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>1</string>
<key>CFBundleShortVersionString</key><string>1.0</string><key>LSMinimumSystemVersion</key><string>14.0</string></dict></plist>\n`)
  await command('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', identifier, application('source')])
  await command('/usr/bin/codesign', ['--verify', '--strict', application('source')]); sourceBuilt = true
  const before = await observe('source', 'status'); facts.observations.push({ role: 'source_before', ...before })
  assert.equal(before.ok, true); assert.ok(['not_registered', 'not_found'].includes(before.status))
  await fs.cp(application('source'), application('host'), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  await command('/usr/bin/codesign', ['--verify', '--strict', application('host')])
  registrationAttempted = true
  const registered = await observe('source', 'register'); facts.observations.push({ role: 'source_register', ...registered })
  assert.equal(registered.ok, true, 'OS must accept this owned registration before copy behavior can be tested')
  assert.ok(['enabled', 'requires_approval'].includes(registered.status))
  const source = await observe('source', 'status'), host = await observe('host', 'status')
  facts.observations.push({ role: 'source_registered', ...source }, { role: 'copy_registered', ...host })
  const removed = await observe('host', 'unregister'); facts.observations.push({ role: 'copy_unregister', ...removed })
  assert.equal(removed.ok, true)
  const after = await observe('source', 'status'); facts.observations.push({ role: 'source_after', ...after })
  assert.equal(after.ok, true); assert.equal(after.status, 'not_registered', 'Copy must remove the original registration, not just its own path')
  facts.copy_removed_original = true
} catch (error) { failure = error }
finally {
  if (sourceBuilt && registrationAttempted) {
    try {
      const result = await observe('source', 'unregister'); facts.observations.push({ role: 'source_final_cleanup', ...result })
      const status = await observe('source', 'status'); facts.observations.push({ role: 'source_final_status', ...status })
      assert.equal(status.status, 'not_registered'); cleanup = true
    } catch (error) { cleanup = false; failure ||= error }
  }
  console.log('CRABOT_MAC_LOGIN_COPY_PROBE ' + JSON.stringify({ ...facts, cleanup }))
  if (!registrationAttempted || cleanup) await fs.rm(root, { recursive: true, force: true })
}
if (failure) throw failure
