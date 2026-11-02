import test from 'node:test'
import assert from 'node:assert/strict'
import { ubuntuDebPolicy, ubuntuDebRunningGuard, ubuntuDebUnloadPolicy } from '../ubuntu-deb.mjs'

const files = {
  '.scrapling-runtime-test/browsers/chromium-123/chrome-linux64/chrome': {},
  '.scrapling-runtime-test/browsers/chromium_headless_shell-123/chrome-headless-shell-linux64/headless_shell': {},
  '.scrapling-runtime-test/packages/not-an-executable': {},
}
test('DEB grants user namespaces to the exact GUI and two packaged browsers, with stable profile names', () => {
  const policy = ubuntuDebPolicy({ files })
  assert.equal((policy.match(/userns,/g) ?? []).length, 3)
  assert.match(policy, /profile crabot-desktop-gui "\/opt\/Crabot\/crabot-desktop"/)
  assert.match(policy, /profile crabot-desktop-headless /)
  assert.match(policy, /profile crabot-desktop-chromium /)
  assert.doesNotMatch(policy, /\*|sysctl|no-sandbox|packages\/not/)
  assert.throws(() => ubuntuDebPolicy({ files: {} }))
  assert.throws(() => ubuntuDebPolicy({ files: Object.fromEntries(Object.entries(files).map(([k,v]) => ['../' + k,v])) }))
})
test('preinst uses Debian exact executable status and never signals or reads user data', () => {
  assert.match(ubuntuDebRunningGuard, /start-stop-daemon --status --exec/)
  assert.doesNotMatch(ubuntuDebRunningGuard, /--stop|--signal|kill|mm\.pid|DATA_DIR|current-release/)
})

test('removal unloads only the package policy; dpkg retains administrator configuration', () => {
  assert.match(ubuntuDebUnloadPolicy, /\$\{1:-\}.*= remove/)
  assert.match(ubuntuDebUnloadPolicy, /apparmor_parser --remove \/etc\/apparmor.d\/crabot-desktop/)
  assert.doesNotMatch(ubuntuDebUnloadPolicy, /rm -|sysctl|restart|userData/)
})
