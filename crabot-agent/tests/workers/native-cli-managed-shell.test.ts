import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
for (const impl of ['codex', 'claude-code'] as const) describe('native CLI version shell: ' + impl, () => {
  let root: string, binary: string
  beforeEach(async () => {
    vi.resetModules()
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native-version-shell-中文 ')))
    vi.stubEnv('CRABOT_PRODUCT_ROOT', root)
    const script = path.join(root, 'version.mjs')
    const fixture = pathToFileURL(path.resolve(__dirname, 'fixtures/fake-codex-app-server.mjs')).href
    await fs.writeFile(script, `if(process.argv.includes('--version')) process.stdout.write(${JSON.stringify(impl === 'codex' ? 'codex-cli 0.147.0\n' : '2.1.246 (Claude Code)\n')}); else await import(${JSON.stringify(fixture)});`)
    binary = quote(process.execPath.replaceAll('\\', '/')) + ' ' + quote(script.replaceAll('\\', '/'))
  })
  afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }) })
  async function adapter() {
    if (impl === 'codex') {
      const { CodexWorkerAdapter } = await import('../../src/workers/codex/adapter.js')
      return new CodexWorkerAdapter({ dataDir: root, codexBin: binary, codexHomeSource: path.join(root, 'unused') })
    }
    const { ClaudeCodeAdapter } = await import('../../src/workers/claude-code/adapter.js')
    return new ClaudeCodeAdapter({ dataDir: root, claudeBin: binary, claudeProjectsDir: path.join(root, 'unused/projects'), claudeConfigPath: path.join(root, 'unused-config') })
  }
  it('reports a missing product shell without executing the host version command', async () => {
    vi.stubEnv('CRABOT_BASH_PATH', path.join(root, 'missing-bash'))
    const current = await adapter()
    try {
      const result = await current.detect()
      expect(result.installed).toBe(false); expect(result.detail).toContain('内置 Bash')
    } finally { await current.dispose() }
  })
  it.skipIf(process.platform === 'win32')('executes version detection through the selected product shell', async () => {
    const shell = path.join(root, 'selected-shell'), marker = path.join(root, 'shell-calls')
    await fs.writeFile(shell, '#!/bin/sh\nprintf "%s\\n" "$*" >> ' + quote(marker) + '\nexec /bin/sh "$@"\n', { mode: 0o700 })
    vi.stubEnv('CRABOT_BASH_PATH', shell)
    const current = await adapter()
    try {
      expect((await current.detect()).installed).toBe(true)
      expect(await fs.readFile(marker, 'utf8')).toContain('--version')
    } finally { await current.dispose() }
  })
})
