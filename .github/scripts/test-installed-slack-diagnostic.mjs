import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-installed-slack-diagnostic-'))
try {
  await fs.mkdir(path.join(root, 'program'))
  await fs.symlink(process.cwd(), path.join(root, 'program/core'), 'junction')
  await fs.writeFile(path.join(root, 'desktop-installation.json'), JSON.stringify({ paths: { core: 'program/core' }, data_dir: path.resolve('.desktop-build/slack18-diagnosis/data') }))
  const output = path.resolve('.desktop-build/slack18-diagnosis/installed-local-diagnostic.json')
  await promisify(execFile)(process.execPath, ['.github/scripts/diagnose-installed-slack-hooks.mjs', root, output], { windowsHide: true, timeout: 75000 })
  const report = JSON.parse(await fs.readFile(output, 'utf8'))
  assert.equal(report.local_only, true)
  assert.equal(report.preparation_error, undefined)
  assert.equal(report.cleanup_error, undefined)
  assert.equal(report.checks.length, 4)
  for (const check of report.checks) assert.equal(check.code, 0, JSON.stringify(check))
  assert.equal(JSON.parse(report.checks[1].output).display_information.name, 'slack-on-win')
  console.log('Installed-tool local diagnostic: all four local checks returned successfully without Slack login or App creation.')
} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
