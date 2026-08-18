import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import {
  CodexAppServerClient,
  CodexAppServerRpcError,
  probeCodexAppServerFork,
} from '../../src/workers/codex/app-server-client.js'

const FIXTURE = resolve(__dirname, 'fixtures/fake-codex-app-server.mjs')

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

describe('CodexAppServerClient', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'codex-app-server-client-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('按 request id 关联乱序响应，stderr 与无关 notification 不破坏 JSONL', async () => {
    const client = new CodexAppServerClient({
      command: `node ${quote(FIXTURE)} app-server --stdio`,
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', CODEX_HOME: dir },
    })
    const notifications: string[] = []
    client.onNotification((notification) => notifications.push(notification.method))
    const deadline = new Date(Date.now() + 2000).toISOString()
    await client.initialize(deadline)

    const [fork, turn] = await Promise.allSettled([
      client.request('thread/fork', {
        threadId: '00000000-0000-0000-0000-000000000001',
        ephemeral: true,
        excludeTurns: true,
      }, deadline),
      client.request('turn/start', {
        threadId: '00000000-0000-0000-0000-000000000002',
        input: [{ type: 'text', text: 'probe' }],
      }, deadline),
    ])

    expect(fork.status).toBe('rejected')
    expect(turn.status).toBe('rejected')
    expect((fork as PromiseRejectedResult).reason).toMatchObject({ message: expect.stringContaining('no rollout') })
    expect((turn as PromiseRejectedResult).reason).toMatchObject({ message: expect.stringContaining('thread not found') })
    expect((fork as PromiseRejectedResult).reason).toBeInstanceOf(CodexAppServerRpcError)
    expect(notifications).toContain('unrelated/notification')
    expect(client.stderrTail).toContain('initialized')
    await client.terminate()
  })

  it('capability probe 只在 app-server 同时接受 fork fields 与结构化 turn input 时返回 true', async () => {
    await expect(probeCodexAppServerFork({
      command: `node ${quote(FIXTURE)} app-server --stdio`,
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', CODEX_HOME: dir },
    })).resolves.toBe(true)

    await expect(probeCodexAppServerFork({
      command: `env FAKE_APP_SERVER_MODE=unsupported node ${quote(FIXTURE)} app-server --stdio`,
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', CODEX_HOME: dir },
    })).resolves.toBe(false)
  })

  it('子进程关闭 stdin 时把 EPIPE 收口为 RPC 失败', async () => {
    const client = new CodexAppServerClient({
      command: `exec node -e ${quote('process.stdin.destroy(); setTimeout(() => {}, 1000)')}`,
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', CODEX_HOME: dir },
    })

    await expect(client.initialize(new Date(Date.now() + 2000).toISOString())).rejects.toThrow()
    await client.terminate()
  })
})
