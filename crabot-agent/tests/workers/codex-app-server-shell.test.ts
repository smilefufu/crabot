import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
const fixture = path.resolve(__dirname, 'fixtures/fake-codex-app-server.mjs')

describe('Codex app-server managed shell', () => {
  let root: string
  beforeEach(async () => {
    vi.resetModules()
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-product-shell-中文 '))
    vi.stubEnv('CRABOT_PRODUCT_ROOT', root)
  })
  afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }) })

  it('refuses a missing product shell before spawning a host fallback', async () => {
    vi.stubEnv('CRABOT_BASH_PATH', path.join(root, 'missing-bundled-bash'))
    const { CodexAppServerClient, probeCodexAppServerFork, probeCodexAppServerSubagents } = await import('../../src/workers/codex/app-server-client.js')
    const input = { command: 'exit 0', cwd: root, env: {} }
    await expect(probeCodexAppServerFork(input)).resolves.toBe(false)
    await expect(probeCodexAppServerSubagents(input)).resolves.toBe(false)
    let client: InstanceType<typeof CodexAppServerClient> | undefined
    try {
      expect(() => { client = new CodexAppServerClient({ command: 'exit 0', cwd: root, env: {} }) }).toThrow(/内置 Bash/)
    } finally { await client?.terminate() }
  })

  it.skipIf(process.platform === 'win32')('actually handshakes through the selected product shell without a model or task', async () => {
    const shell = path.join(root, 'sealed-shell'), marker = path.join(root, 'selected-shell')
    await fs.writeFile(shell, '#!/bin/sh\nprintf selected > ' + quote(marker) + '\nexec /bin/sh "$@"\n', { mode: 0o700 })
    vi.stubEnv('CRABOT_BASH_PATH', shell)
    const { CodexAppServerClient } = await import('../../src/workers/codex/app-server-client.js')
    const client = new CodexAppServerClient({ command: quote(process.execPath) + ' ' + quote(fixture) + ' app-server --stdio', cwd: root,
      env: { PATH: process.env.PATH ?? '', CODEX_HOME: root } })
    try {
      await client.initialize(new Date(Date.now() + 3000).toISOString())
      expect(await fs.readFile(marker, 'utf8')).toBe('selected')
    } finally { expect(await client.terminate()).toBe(true) }
  })
})
