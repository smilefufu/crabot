// Hosted finite Node/parent transport. Native policy answers remain actual;
// only pkexec transport is replaced with CI sudo. No GTK UX claim is made.
import fs from 'node:fs'
import path from 'node:path'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import assert from 'node:assert/strict'
assert.equal(process.env.GITHUB_ACTIONS, 'true'); assert.equal(process.platform, 'linux')
const cfg = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')), spawn = childProcess.spawn
let authorizations = 0
childProcess.spawn = (command, args, options) => {
  if (command === '/usr/bin/pkexec') {
    assert.deepEqual(args, [path.join(cfg.bundle, 'crabot-sandbox-helper'), '--prepare-removal', cfg.root])
    authorizations++
    return spawn('/usr/bin/sudo', ['-n', '/usr/bin/env', 'PKEXEC_UID=' + process.getuid(), ...args], options)
  }
  return spawn(command, args, options)
}
syncBuiltinESMExports()
const { runUbuntuInstallerRemoval } = await import('../../dist/ubuntu-installer-removal.js')
const progress = []
let result
try {
  result = { result: await runUbuntuInstallerRemoval({ installRoot: cfg.root, operationId: cfg.operationId,
    payload: path.join(cfg.bundle, 'offline'), signal: cfg.cancelled ? AbortSignal.abort() : new AbortController().signal,
    progress: message => progress.push(message) }) }
} catch (error) { result = { result: 'rejected', code: error.code ?? error.name } }
fs.writeFileSync(cfg.resultFile, JSON.stringify({ ...result, authorizations, progress, actual_node: true,
  parent_transport_fixture: true, polkit_transport_substituted: true, policy_response_substituted: false }) + '\n', { flag: 'wx', mode: 0o600 })
