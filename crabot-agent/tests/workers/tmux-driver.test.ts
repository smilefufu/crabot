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

// POSIX shell 单引号转义,拼 `env VAR=... node mock-cli.mjs` 命令行用(与 adapter 测试里的
// 同名 helper 用法一致)。
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

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

  it('newSession clears a runtime bearer retained by the tmux server', async () => {
    process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER = 'runtime-secret-marker'
    try {
      await driver.newSession({
        name: sessionName,
        cwd: tempDir,
        command: `bash -c 'printf %s "$CRABOT_CORE_AGENT_RUNTIME_BEARER"; sleep 5'`,
        outputFile,
      })
      await waitFor(async () => (await fs.readFile(outputFile, 'utf8')) === '')
      expect(await fs.readFile(outputFile, 'utf8')).toBe('')
    } finally {
      delete process.env.CRABOT_CORE_AGENT_RUNTIME_BEARER
    }
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

  it('sendText delivers multi-line text to a plain (non-bracketed-paste) consumer and it echoes back through cat', async () => {
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

  it('sendText 发送多行文本时,bracketed-paste 消费方把它当一条完整消息收到,不按行拆成多条提交', async () => {
    const mockCli = path.resolve(__dirname, 'fixtures/mock-cli.mjs')
    const stdinLogFile = path.join(tempDir, 'stdin.log')
    const readyFile = path.join(tempDir, 'ready')
    const command = `env MOCK_CLI_SCRIPT=${shQuote('[]')} MOCK_CLI_STDIN_LOG=${shQuote(stdinLogFile)} MOCK_CLI_READY_FILE=${shQuote(readyFile)} node ${shQuote(mockCli)}`

    await driver.newSession({
      name: sessionName,
      cwd: tempDir,
      command,
      outputFile,
    })

    // 等 mock 真正起来、已经请求过 bracketed paste,再发送——否则 sendText 会和 node 进程
    // 自身的启动耗时赛跑(纯测试时序问题,不是 sendText 机制本身的问题)。
    await waitFor(async () => {
      try {
        await fs.access(readyFile)
        return true
      } catch {
        return false
      }
    })
    await new Promise((resolve) => setTimeout(resolve, 100))

    const multilineText = '标题:修复登录闪退\n背景:v3.2 上线后部分用户反馈登录后立即闪退\n验收:连续登录 10 次不再复现'
    await driver.sendText(sessionName, multilineText)

    await waitFor(async () => {
      try {
        return (await fs.readFile(stdinLogFile, 'utf-8')).trim().length > 0
      } catch {
        return false
      }
    })

    // 消费方(mock CLI)只应观察到一次"提交",且内容就是完整的多行原文——如果 sendText
    // 仍是逐行 send-keys + Enter,第一行会被当独立消息立即提交,mock 会记到 3 条日志而不是 1 条。
    const logLines = (await fs.readFile(stdinLogFile, 'utf-8')).trim().split('\n')
    expect(logLines).toHaveLength(1)
    expect(JSON.parse(logLines[0])).toBe(multilineText)
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
