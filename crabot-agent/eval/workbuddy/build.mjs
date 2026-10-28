import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
const repo = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(path.join(repo, 'package.json'))
const { build } = require('esbuild')
const output = process.argv[2]
if (!output) throw new Error('Usage: node build.mjs <isolated-build-directory>')
fs.mkdirSync(output, { recursive: true })
for (const [entry, outfile] of [
  ['eval/workbuddy/runtime.mjs', 'runtime.cjs'],
  ['src/engine/tools/local-host-helper.ts', 'tools/local-host-helper.js'],
]) await build({ entryPoints: [path.join(repo, 'crabot-agent', entry)],
  outfile: path.join(output, outfile), bundle: true, platform: 'node', format: 'cjs', target: 'node20',
  alias: { 'crabot-shared': path.join(repo, 'crabot-shared/src/index.ts') },
  external: ['sharp', '@vscode/ripgrep', 'ts-node/register/transpile-only'],
  nodePaths: [path.join(repo, 'crabot-agent/node_modules'), path.join(repo, 'node_modules')],
})
fs.cpSync(path.join(repo, 'crabot-admin/builtins/skills/tmp-page'), path.join(output, 'skills/tmp-page'), { recursive: true })
