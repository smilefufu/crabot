import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { TmuxDriver } from '../../src/workers/tmux/driver.js'

function detectTmux(): boolean {
  try {
    execFileSync('tmux', ['display-message', '-p', '#S'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('waitFor timed out')
}

describe.skipIf(!detectTmux())('TmuxDriver', () => {
  const driver = new TmuxDriver()
  let tempDir: string
  let sessionName: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmux-driver-test-'))
    sessionName = `crabot-w-test-${randomUUID().slice(0, 8)}`
  })

  afterEach(async () => {
    await driver.killSession(sessionName)
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('available() reflects the real tmux binary', async () => {
    await expect(driver.available()).resolves.toBe(true)
    await expect(new TmuxDriver({ tmuxBin: 'definitely-not-a-real-tmux-binary' }).available()).resolves.toBe(false)
  })

  it('实时画面由 capture-pane 读取，且不含 ANSI 转义序列', async () => {
    await driver.newSession({
      name: sessionName,
      cwd: tempDir,
      command: `bash -c 'printf "\\033[31mred text\\033[0m"; sleep 30'`,
    })

    await waitFor(async () => (await driver.capturePane(sessionName)).text.includes('red text'))
    const pane = await driver.capturePane(sessionName)
    expect(pane.text).toContain('red text')
    expect(pane.text).not.toContain('\u001b')
  })

  it('pipe-pane 原始字节只驱动就绪状态，不创建 output 日志', async () => {
    const endpoint = await driver.newSession({
      name: sessionName,
      cwd: tempDir,
      command: `bash -c 'printf "\\033[?2004h"; sleep 30'`,
    })

    await waitFor(async () => (await driver.getPasteReadiness(endpoint)).state === 'ready')
    expect(await driver.getPasteReadiness(endpoint)).toMatchObject({ state: 'ready' })
    expect((await fs.readdir(tempDir)).some((name) => name.includes('output'))).toBe(false)
  })

  it('only retains a dead pane after its durable owner enables remain-on-exit', async () => {
    await driver.newSession({
      name: sessionName,
      cwd: tempDir,
      command: `bash -c 'printf "final frame"'`,
    })

    await waitFor(async () => {
      try {
        await driver.capturePane(sessionName)
        return false
      } catch {
        return true
      }
    })

    const session = await driver.newSession({
      name: sessionName,
      cwd: tempDir,
      command: `bash -c 'printf "final frame"'`,
    })
    await session.enableRemainOnExit?.()

    await waitFor(async () => !(await driver.isAlive(sessionName)))
    await expect(driver.capturePane(sessionName)).resolves.toMatchObject({
      dead: true,
      text: expect.stringContaining('Pane is dead'),
    })
  })
})
