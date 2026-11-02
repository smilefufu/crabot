import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
const root = '.desktop-build/slack18-diagnosis/'
const report = JSON.parse(await fs.readFile(root + 'summary.json', 'utf8'))
assert.ok(report.positive_control)
const hooks = report.report.filter(item => item.phase.startsWith('official-hooks-manifest-'))
assert.equal(hooks.length, 3)
for (const item of hooks) {
  assert.equal(item.code, 0, item.output)
  const manifest = JSON.parse(item.output)
  assert.equal(manifest.display_information.name, 'slack-on-win')
  assert.equal(manifest.features.bot_user.display_name, 'slack-on-win')
}
assert.equal(report.shown_windows.filter(item => item.phase.startsWith('official-hooks-manifest-')).length, 0, 'Generated product hooks must never show a terminal')
const processes = (await fs.readFile(root + 'process-starts.tsv', 'utf8')).split(/\r?\n/).filter(Boolean).map(line => line.split('\t'))
assert.equal(processes.filter(row => row[0].startsWith('official-hooks-manifest-') && /^(OpenConsole|WindowsTerminal)\.exe$/i.test(row[4])).length, 0, 'Generated product hooks must not start a delegated terminal host')
console.log('Original product hook commands: 3 correct manifests, zero terminal SHOW events or newly observed delegated terminal hosts.')
