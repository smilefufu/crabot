#!/usr/bin/env node
// Finite constructors and disposable data only; no business main or model calls.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const core = path.resolve(process.argv[2] ?? source)
const require = createRequire(import.meta.url)
const runtime = require(path.join(core, 'scripts/lib/product-runtime.cjs')).loadProductRuntime(core, { required: true, full: true })
const temporary = mkdtempSync(path.join(tmpdir(), 'crabot-python-gate-result-')), report = path.join(temporary, 'result.json')
try {
  const result = spawnSync(runtime.executables.node, [path.join(source, 'crabot-core/node_modules/vitest/vitest.mjs'),
    'run', 'src/workspace-human-verification.test.ts', '--testNamePattern=registered workspace gate bundled Python', '--maxWorkers=1', '--minWorkers=1',
    '--reporter=default', '--reporter=json', '--outputFile=' + report], {
    cwd: path.join(source, 'crabot-core'), env: { ...process.env, CRABOT_WORKSPACE_GATE_PYTHON: runtime.executables.python,
      CRABOT_WORKSPACE_GATE_PYTHON_BINARY: path.join(runtime.pythonHome, process.platform === 'win32' ? 'python.exe' : 'bin/python3.12') },
    stdio: 'inherit', timeout: process.platform === 'win32' ? 660000 : 300000,
  })
  if (result.error) throw result.error
  if (result.signal || result.status !== 0) throw new Error('Bundled Python gate finite regression failed')
  const outcome = JSON.parse(readFileSync(report, 'utf8'))
  const passed = outcome.testResults.flatMap(file => file.assertionResults).filter(test => test.status === 'passed')
  if (outcome.numFailedTests !== 0 || passed.length !== 1 || !passed[0].ancestorTitles.includes('registered workspace gate bundled Python')
    || passed[0].title !== 'runs the actual bundled interpreter only after its own durable gate registration') throw new Error('Bundled Python gate test was not actually passed')
} finally { rmSync(temporary, { recursive: true, force: true }) }
