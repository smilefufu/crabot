import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validateCheck } from './slack-diagnostic-checks.mjs'

test('zero exit without PowerShell configuration output is a failure', () => {
  assert.throws(() => validateCheck('powershell_without_profile_config', { code: 0, output: '' }))
})
test('zero exit without a handoff is a failure', () => {
  assert.throws(() => validateCheck('powershell_start_with_synthetic_credentials', { code: 0, output: '' }), /without.*handoff/)
})
test('a process exit and valid config are both required', () => {
  const output = JSON.stringify({ hooks: { 'get-manifest': 'manifest', start: 'handoff' } })
  assert.doesNotThrow(() => validateCheck('direct_node_config', { code: 0, output }))
  assert.throws(() => validateCheck('direct_node_config', { code: 7, output }))
  assert.throws(() => validateCheck('direct_node_config', { code: 0, output: '{}' }))
})
test('control, manifest and handoff checks require their actual result', () => {
  assert.doesNotThrow(() => validateCheck('powershell_basic_execution', { output: 'POWERSHELL_EXECUTED' }))
  assert.doesNotThrow(() => validateCheck('official_cli_local_manifest', { output: '{"display_information":{"name":"slack-on-win"}}' }))
  assert.doesNotThrow(() => validateCheck('powershell_start_with_synthetic_credentials', { output: 'SYNTHETIC_HANDOFF_OK' }))
})
