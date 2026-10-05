import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
const source = readFileSync(new URL('../../../install.sh', import.meta.url), 'utf8').split('# --- OS 检测 ---')[0]
function directory(args, env = {}) {
  const result = spawnSync('bash', ['-c', 'id() { echo 0; };\n' + source + '\nprintf "%s" "$INSTALL_DIR"', 'install', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, HOME: '/fixture/root', ...env },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}
test('installation default and explicit path precedence', () => {
  assert.equal(directory(['--system']), '/opt/crabot')
  assert.equal(directory([]), '/fixture/root/.crabot')
  assert.equal(directory(['--system'], { CRABOT_INSTALL_DIR: '/fixture/env' }), '/fixture/env')
  assert.equal(directory(['--system', '--install-dir=/fixture/explicit'], { CRABOT_INSTALL_DIR: '/fixture/env' }), '/fixture/explicit')
})
