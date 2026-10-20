import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ClaudeCodeAdapter } from '../../src/workers/claude-code/adapter.js'
import { CodexWorkerAdapter } from '../../src/workers/codex/adapter.js'
import type { IncarnationHandle } from '../../src/workers/types.js'
import { TmuxDriver } from '../../src/workers/tmux/driver.js'
import { removeTmuxControlEndpoint, type TmuxControlEndpoint } from '../../src/workers/tmux/control-monitor.js'

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

describe('TmuxDriver.readProcessCarrier', () => {
  const name = 'crabot-w-scope-one'
  it('reads only the exact registered session and returns identity metadata without pane text', async () => {
    const driver = new TmuxDriver(), run = vi.fn(async () => ({ stdout: `${name}\t$7\t%12\t123\t0\t99\n`, stderr: '' }))
    ;(driver as any).run = run
    expect(await driver.readProcessCarrier(name)).toEqual({ session_name: name, session_id: '$7', pane_id: '%12', pane_pid: 123, dead: false, server_pid: 99 })
    expect(run.mock.calls[0][0]).toEqual(['list-panes', '-s', '-t', '=' + name, '-F', '#{session_name}\t#{session_id}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pid}'])
  })
  it.each(['', 'crabot-w-scope', 'other', 'crabot-w-scope-one:0', 'crabot-w-scope-one\nnext'])('rejects an invalid or ambiguous carrier observation: %j', async value => {
    const driver = new TmuxDriver(), run = vi.fn(async () => ({ stdout: value, stderr: '' })); (driver as any).run = run
    await expect(driver.readProcessCarrier(name)).rejects.toThrow()
  })
  it.each(['bad session', 'bad pane', 'bad pid', 'bad dead', 'bad server', 'multiple panes'])('does not turn %s into a guessed process', async damage => {
    const values = [name, '$7', '%12', '123', '0', '99']
    if (damage === 'bad session') values[1] = '$-1'
    if (damage === 'bad pane') values[2] = '12'
    if (damage === 'bad pid') values[3] = '0'
    if (damage === 'bad dead') values[4] = 'unknown'
    if (damage === 'bad server') values[5] = '2147483648'
    const line = values.join('\t'), driver = new TmuxDriver()
    ;(driver as any).run = vi.fn(async () => ({ stdout: damage === 'multiple panes' ? line + '\n' + line : line, stderr: '' }))
    await expect(driver.readProcessCarrier(name)).rejects.toThrow()
  })
  it('rejects otherwise valid metadata from a prefix-matched different session', async () => {
    const driver = new TmuxDriver(); (driver as any).run = vi.fn(async () => ({ stdout: `${name}-other\t$7\t%12\t123\t0\t99\n`, stderr: '' }))
    await expect(driver.readProcessCarrier(name)).rejects.toMatchObject({ code: 'WORKER_CARRIER_UNVERIFIED' })
  })
  it('rejects tmux target selectors before calling the command and propagates native query failures', async () => {
    const driver = new TmuxDriver(), run = vi.fn(async () => { throw new Error('tmux unavailable') }); (driver as any).run = run
    await expect(driver.readProcessCarrier('crabot-w-scope-one:0')).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
    await expect(driver.readProcessCarrier(name)).rejects.toThrow('tmux unavailable')
  })
  it('preserves dead-pane status without interpreting its retained PID as a live execution', async () => {
    const driver = new TmuxDriver(); (driver as any).run = vi.fn(async () => ({ stdout: `${name}\t$7\t%12\t123\t1\t99\n`, stderr: '' }))
    expect(await driver.readProcessCarrier(name)).toMatchObject({ dead: true, pane_pid: 123 })
  })
})

function hasTmuxBinary(): boolean {
  try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true } catch { return false }
}

describe.skipIf(process.platform === 'win32' || !hasTmuxBinary())('TmuxDriver private process carrier', () => {
  it('binds the exact private pane to a real OS scope without using the default tmux server', async () => {
    const { default: native } = await import('../../../scripts/lib/process-identity.cjs')
    const { default: tree } = await import('../../../scripts/lib/tmux-process-tree.cjs')
    const { default: processExit } = await import('../../../scripts/lib/known-process-exit.cjs')
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'crabot-private-carrier-'))
    const socket = 'crabot-carrier-' + randomUUID(), workerId = 'scope-' + randomUUID(), name = `crabot-w-${workerId}-1`
    const wrapper = path.join(directory, 'tmux-private'), ready = path.join(directory, 'ready')
    await fs.writeFile(wrapper, `#!/bin/sh\nexec tmux -L ${socket} "$@"\n`, { mode: 0o700 })
    const driver = new TmuxDriver({ tmuxBin: wrapper }), quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'"
    const source = `require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));const timer=setInterval(()=>{},1000);setTimeout(()=>clearInterval(timer),30000)`
    let endpoint: TmuxControlEndpoint | undefined
    try {
      endpoint = await driver.newSession({ name, cwd: directory, command: quote(process.execPath) + ' -e ' + quote(source) })
      await waitFor(async () => (await fs.stat(ready).catch(() => null)) !== null)
      const carrier = await driver.readProcessCarrier(name)
      expect(carrier).toMatchObject({ session_name: name, pane_pid: Number(await fs.readFile(ready, 'utf8')), dead: false })
      expect(carrier.server_pid).not.toBe(carrier.pane_pid)
      const scope = await tree.captureTmuxProcessTree(() => driver.readProcessCarrier(name))
      expect(scope).toMatchObject([{ pid: carrier.pane_pid, owner: native.inspectProcess(process.pid).owner }])
      expect(await driver.readProcessCarrier(name)).toEqual(carrier)
      const adapters = [new ClaudeCodeAdapter({ dataDir: directory, tmux: driver, claudeConfigPath: path.join(directory, 'claude.json'), claudeProjectsDir: directory }),
        new CodexWorkerAdapter({ dataDir: directory, tmux: driver, codexHomeSource: directory })]
      for (const adapter of adapters) {
        const h: IncarnationHandle = { worker_id: workerId, incarnation_id: 'fixed-' + adapter.implId, seq: 1, impl: adapter.implId, session_ref: 'observed-session' }
        ;(adapter as any).runtimes.set(`${workerId}#1`, { worker_id: workerId, incarnation_id: h.incarnation_id, seq: 1, sessionName: name })
        expect(await adapter.captureExecutionProcesses(h)).toEqual(scope)
      }
      await expect(driver.readProcessCarrier('crabot-w-scope')).rejects.toThrow()
      await driver.killSession(name)
      await waitFor(async () => processExit.probeKnownProcessExit(scope).state === 'stopped')
    } finally {
      try { execFileSync(wrapper, ['kill-server'], { stdio: 'ignore', timeout: 5000 }) } catch { /* The private server exits after its last session. */ }
      if (endpoint) await removeTmuxControlEndpoint(endpoint)
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})

describe.skipIf(process.platform === 'win32')('TmuxDriver POSIX command deadlines', () => {
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
