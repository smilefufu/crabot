import test from 'node:test'
import assert from 'node:assert/strict'
import { renderSystemUserService } from '../system-service.mjs'

test('one user service is the Launcher, preserving stop/restart and the full shutdown window', () => {
  const unit = renderSystemUserService('/opt/crabot')
  assert.match(unit, /ExecStart="\/opt\/crabot\/bin\/crabot" _system-service\n/)
  assert.doesNotMatch(unit, /ExecStop=/, 'own CLI holds lifecycle lock while stopping the exact instance')
  assert.match(unit, /TasksAccounting=yes\n/)
  assert.match(unit, /Restart=on-failure\n/); assert.match(unit, /RestartForceExitStatus=42\n/)
  assert.match(unit, /RestartPreventExitStatus=64\n/, 'preparation/migration failures cannot be automatically replayed')
  assert.match(unit, /KillMode=mixed\nSendSIGKILL=no\nTimeoutStopSec=90\n/, 'systemd cannot truncate MM shutdown or blindly kill unresolved descendants')
  assert.doesNotMatch(unit, /User=root|Restart=always|WatchdogSec|Environment=.*PASSWORD/)
})
test('unit paths cannot inject directives, shell commands or systemd expansion', () => {
  const unit = renderSystemUserService('/opt/Crabot % test $name "x"')
  assert.match(unit, /%% test \$\$name \\"x\\"/)
  for (const value of ['relative', '/opt/crabot\nExecStart=/bin/sh', '/opt/crabot\0']) assert.throws(() => renderSystemUserService(value))
})
