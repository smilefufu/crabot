// Sealed CI fixture prefix, excluded from ordinary releases. The same GTK
// source drives its own buttons; sudo substitutes only the Polkit transport.
import fixtureFs from 'node:fs'
import fixturePath from 'node:path'
import fixtureChild from 'node:child_process'
import { syncBuiltinESMExports as fixtureSync } from 'node:module'
import fixtureIdentity from './bootstrap/scripts/lib/process-identity.cjs'
const fixtureControl = __CRABOT_UNINSTALL_CONTROL__
const fixtureEvent = (name, fields) => {
  const file = fixturePath.join(fixtureControl, name + '.json'), temporary = file + '.tmp-' + process.pid
  fixtureFs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, ...fields }) + '\n', { flag: 'wx', mode: 0o600 })
  fixtureFs.renameSync(temporary, file)
}
const fixtureSpawn = fixtureChild.spawn
fixtureChild.spawn = (command, args, options) => command === '/usr/bin/pkexec'
  ? fixtureSpawn('/usr/bin/sudo', ['-n', '/usr/bin/env', 'PKEXEC_UID=' + process.getuid(), ...args], options)
  : fixtureSpawn(command, args, options)
fixtureSync()
fixtureEvent('maintenance-started', { identity: fixtureIdentity.inspectProcess(process.pid), directory: fixturePath.dirname(process.execPath) })
const fixtureError = console.error
console.error = (...args) => {
  fixtureFs.appendFileSync(fixturePath.join(fixtureControl, 'driver-error-' + process.pid + '.log'), args.map(String).join(' ') + '\n')
  fixtureError(...args)
}
