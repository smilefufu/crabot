// Pinned test-only CLIs; never resolves a user's login/config or starts a Crabot MM.
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
const root = process.cwd(), installed = path.join(root, '.desktop-build/native-cli-tools')
const require = createRequire(path.join(installed, 'package.json'))
const triples = { 'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin', 'linux-x64': 'x86_64-unknown-linux-musl', 'win32-x64': 'x86_64-pc-windows-msvc' }
const target = process.platform + '-' + process.arch
if (!triples[target]) throw new Error('This native CLI acceptance target is not configured')
const codex = path.join(path.dirname(require.resolve('@openai/codex-' + target + '/package.json')), 'vendor', triples[target], 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex')
const claude = path.join(path.dirname(require.resolve('@anthropic-ai/claude-code/package.json')), 'bin/claude.exe')
await fs.access(codex); await fs.access(claude)
const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', 'tests/workers/native-project-cli.acceptance.test.ts', '--maxWorkers=1', '--minWorkers=1'], {
  cwd: path.join(root, 'crabot-agent'), stdio: 'inherit', env: { ...process.env, CRABOT_TEST_CODEX_BIN: codex, CRABOT_TEST_CLAUDE_BIN: claude },
})
child.on('error', error => { console.error(error); process.exitCode = 1 })
child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1 })
