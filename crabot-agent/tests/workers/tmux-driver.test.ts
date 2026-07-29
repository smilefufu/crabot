import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { TmuxDriver } from '../../src/workers/tmux/driver.js'

function detectTmux(): boolean {
  try {
    execFileSync('which', ['tmux'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

const tmuxAvailable = detectTmux()

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error('waitFor timed out')
}

describe.skipIf(!tmuxAvailable)('TmuxDriver', () => {
  const driver = new TmuxDriver()
  let tempDir: string
  let sessionName: string
  let outputFile: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tmux-driver-test-'))
    sessionName = `crabot-w-test-${randomUUID().slice(0, 8)}`
    outputFile = path.join(tempDir, 'output.log')
  })

  afterEach(async () => {
    // 哪怕断言失败也要清理,不留孤儿会话
    await driver.killSession(sessionName)
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  it('available() resolves true for the real tmux binary', async () => {
    expect(await driver.available()).toBe(true)
  })

  it('available() resolves false for a bogus binary', async () => {
    const bogus = new TmuxDriver({ tmuxBin: 'definitely-not-a-real-tmux-binary' })
    expect(await bogus.available()).toBe(false)
  })

  it('newSession runs the command and pipes its output to outputFile', async () => {
    await driver.newSession({
      name: sessionName,
      cwd: tempDir,
      command: `bash -c 'echo hello; sleep 30'`,
      outputFile,
    })

    await waitFor(async () => (await fs.readFile(outputFile, 'utf-8')).includes('hello'))
    expect(await fs.readFile(outputFile, 'utf-8')).toContain('hello')
  })

  it('newSession quotes outputFile paths containing spaces and quotes safely', async () => {
    const trickyOutput = path.join(tempDir, "out with space & 'quote.log")
    await driver.newSession({
      name: sessionName,
      cwd: tempDir,
      command: `bash -c 'echo marker; sleep 5'`,
      outputFile: trickyOutput,
    })

    await waitFor(async () => (await fs.readFile(trickyOutput, 'utf-8')).includes('marker'))
    expect(await fs.readFile(trickyOutput, 'utf-8')).toContain('marker')
  })

  it('newSession passes env vars through to the command', async () => {
    await driver.newSession({
      name: sessionName,
      cwd: tempDir,
      command: `bash -c 'echo "VAL=$FOO"; sleep 5'`,
      env: { FOO: 'bar123' },
      outputFile,
    })

    await waitFor(async () => (await fs.readFile(outputFile, 'utf-8')).includes('VAL=bar123'))
    expect(await fs.readFile(outputFile, 'utf-8')).toContain('VAL=bar123')
  })

  it('sendText sends multi-line input line by line and it echoes back through cat', async () => {
    await driver.newSession({
      name: sessionName,
      cwd: tempDir,
      command: 'cat',
      outputFile,
    })

    await driver.sendText(sessionName, 'line one\nline two')

    await waitFor(async () => (await fs.readFile(outputFile, 'utf-8')).includes('line two'))
    const content = await fs.readFile(outputFile, 'utf-8')
    expect(content).toContain('line one')
    expect(content).toContain('line two')
  })

  it('isAlive reflects session lifecycle', async () => {
    expect(await driver.isAlive(sessionName)).toBe(false)

    await driver.newSession({
      name: sessionName,
      cwd: tempDir,
      command: `bash -c 'sleep 30'`,
      outputFile,
    })
    expect(await driver.isAlive(sessionName)).toBe(true)
  })

  it('killSession terminates the session and is idempotent', async () => {
    await driver.newSession({
      name: sessionName,
      cwd: tempDir,
      command: `bash -c 'sleep 30'`,
      outputFile,
    })
    expect(await driver.isAlive(sessionName)).toBe(true)

    await driver.killSession(sessionName)
    expect(await driver.isAlive(sessionName)).toBe(false)

    // 幂等:再次 kill 一个不存在的会话不应抛错
    await expect(driver.killSession(sessionName)).resolves.toBeUndefined()
  })

  it('sendKeys drives an interactive read -p prompt with raw key names', async () => {
    const scriptPath = path.join(tempDir, 'confirm.sh')
    await fs.writeFile(
      scriptPath,
      `#!/bin/bash\nread -p "confirm? " ans\necho "answer=$ans" >> ${JSON.stringify(outputFile)}\n`,
      { mode: 0o755 },
    )

    await driver.newSession({
      name: sessionName,
      cwd: tempDir,
      command: `bash ${JSON.stringify(scriptPath)}`,
      outputFile,
    })

    await driver.sendKeys(sessionName, ['y', 'Enter'])

    await waitFor(async () => (await fs.readFile(outputFile, 'utf-8')).includes('answer=y'))
    expect(await fs.readFile(outputFile, 'utf-8')).toContain('answer=y')
  })

  it('paneCommand reports the pane foreground command, and null for a dead session', async () => {
    expect(await driver.paneCommand(sessionName)).toBeNull()

    await driver.newSession({
      name: sessionName,
      cwd: tempDir,
      command: `bash -c 'sleep 30'`,
      outputFile,
    })

    await waitFor(async () => (await driver.paneCommand(sessionName)) !== null)
    expect(await driver.paneCommand(sessionName)).toBe('sleep')
  })
})
