import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import ts from '../../crabot-channel-slack/node_modules/typescript/lib/typescript.js'
assert.equal(process.platform, 'win32')
assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-installed-slack-diagnostic-'))
try {
  await fs.mkdir(path.join(root, 'program'))
  await fs.symlink(process.cwd(), path.join(root, 'program/core'), 'junction')
  await fs.writeFile(path.join(root, 'desktop-installation.json'), JSON.stringify({ paths: { core: 'program/core' }, data_dir: path.resolve('.desktop-build/slack18-diagnosis/data') }))
  const installedModule = path.resolve('crabot-channel-slack/dist/cli-project.js')
  const current = await fs.readFile(installedModule, 'utf8')
  const { stdout: original } = await promisify(execFile)('git', ['show', 'ab5836850e74216bc8a1ab8015a907a9dade5ee2:crabot-channel-slack/src/cli-project.ts'])
  const baseline = ts.transpileModule(original, { compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 } }).outputText
  try {
    for (const [name, source] of [['installed-local-diagnostic', current], ['installed-v18-local-diagnostic', baseline]]) {
      // Only overwrite this CI job's generated dist, and restore it below.
      await fs.writeFile(installedModule, source)
      const output = path.resolve('.desktop-build/slack18-diagnosis/' + name + '.json')
      await promisify(execFile)(process.execPath, ['.github/scripts/diagnose-installed-slack-hooks.mjs', root, output], { windowsHide: true, timeout: 120000 })
      const report = JSON.parse(await fs.readFile(output, 'utf8'))
      assert.equal(report.local_only, true)
      assert.equal(report.preparation_error, undefined)
      assert.equal(report.cleanup_error, undefined)
      assert.equal(report.checks.length, 9)
      const baselineFailures = new Set(['powershell_without_profile_config', 'powershell_encoded_config', 'powershell_start_with_synthetic_credentials', 'official_cli_local_manifest'])
      for (const check of report.checks) {
        const expected = name !== 'installed-v18-local-diagnostic' || !baselineFailures.has(check.name)
        assert.equal(check.passed, expected, JSON.stringify(check))
      }
      if (name === 'installed-v18-local-diagnostic') console.log('Reproduced v18: silent config, absent handoff and manifest fallback dependency; windowless controls succeed.')
      else console.log('Fixed hooks: nine semantic checks passed, including real handoff and no manifest file fallback.')
    }
  } finally { await fs.writeFile(installedModule, current) }
} finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) }
