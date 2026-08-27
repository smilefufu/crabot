import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
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

describe('TmuxDriver.capturePane', () => {
  it('先抓取再探测 dead，避免 dead-pane 提示被当作 live 画面', async () => {
    const driver = new TmuxDriver()
    const run = vi.fn(async () => ({ stdout: 'Pane is dead (status 1, Tue Aug 19 00:00:00 2026)\n', stderr: '' }))
    ;(driver as unknown as { run: typeof run }).run = run
    const isAlive = vi.spyOn(driver, 'isAlive').mockResolvedValue(false)

    await expect(driver.capturePane('crabot-w-test-race')).resolves.toEqual({
      text: 'Pane is dead (status 1, Tue Aug 19 00:00:00 2026)\n',
      styled_text: 'Pane is dead (status 1, Tue Aug 19 00:00:00 2026)\n',
      dead: true,
    })
    expect(run).toHaveBeenCalledWith(['capture-pane', '-p', '-J', '-t', 'crabot-w-test-race'])
    expect(run).toHaveBeenCalledWith(['capture-pane', '-p', '-e', '-t', 'crabot-w-test-race'])
    expect(run.mock.invocationCallOrder[0]).toBeLessThan(isAlive.mock.invocationCallOrder[0])
  })
})

describe('TmuxDriver command deadlines', () => {
  it('bounds both execFile tmux commands and load-buffer stdin processes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmux-driver-timeout-'))
    const hangingBin = path.join(tempDir, 'tmux-hanging.sh')
    await fs.writeFile(hangingBin, '#!/bin/sh\nsleep 5\n', { mode: 0o700 })
    const driver = new TmuxDriver({ tmuxBin: hangingBin, commandTimeoutMs: 25 })

    const commandStartedAt = Date.now()
    await expect(driver.sendKeys('crabot-w-timeout', ['Enter'])).rejects.toBeTruthy()
    expect(Date.now() - commandStartedAt).toBeLessThan(1000)

    const bufferStartedAt = Date.now()
    await expect(driver.pasteText('crabot-w-timeout', 'input')).rejects.toThrow(/timed out|exited|SIGKILL/i)
    expect(Date.now() - bufferStartedAt).toBeLessThan(1000)

    await fs.rm(tempDir, { recursive: true, force: true })
  })
})

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
    expect(pane.styled_text).toContain('\u001b[')
    expect(pane.cursor).toEqual({ x: expect.any(Number), y: expect.any(Number) })
  })

  it('pipe-pane 原始字节只驱动就绪状态，不创建 output 日志', async () => {
    const controlLogPath = path.join(tempDir, 'control-monitor.jsonl')
    const endpoint = await driver.newSession({
      name: sessionName,
      cwd: tempDir,
      command: `bash -c 'printf "\\033[?2004h"; sleep 30'`,
      control_log_path: controlLogPath,
    })

    await waitFor(async () => (await driver.getPasteReadiness(endpoint)).state === 'ready')
    expect(await driver.getPasteReadiness(endpoint)).toMatchObject({ state: 'ready' })
    expect(await driver.panePipe(sessionName)).toMatch(/^\d+$/)
    await waitFor(async () => {
      const log = await fs.readFile(controlLogPath, 'utf-8').catch(() => '')
      return log.includes('"event":"server_listening"') && log.includes('"event":"readiness_changed"') && log.includes('"event":"pipe_attached"')
    })
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
