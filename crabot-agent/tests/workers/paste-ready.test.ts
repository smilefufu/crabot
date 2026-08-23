import { describe, it, expect } from 'vitest'
import { execFileSync, spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  advancePasteReadiness,
  controlMonitorPipeCommand,
  createTmuxControlEndpoint,
  readTmuxControlState,
  removeTmuxControlEndpoint,
  type PasteReadiness,
} from '../../src/workers/tmux/control-monitor.js'
import {
  DEFAULT_PASTE_READY_TIMEOUT_MS,
  waitForPasteReady,
} from '../../src/workers/tmux/paste-ready.js'

async function waitForReady(endpoint: Parameters<typeof readTmuxControlState>[0]): Promise<void> {
  const deadline = Date.now() + 1_000
  while (Date.now() < deadline) {
    if ((await readTmuxControlState(endpoint, 50)).state === 'ready') return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('pipe-pane consumer did not report ready')
}

function canUseTmux(): boolean {
  try {
    execFileSync('tmux', ['display-message', '-p', '#S'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe('tmux bracketed-paste monitor', () => {
  it('识别跨 pipe-pane chunk 的开启控制序列', () => {
    let state: PasteReadiness & { suffix?: Buffer } = { state: 'unknown' }
    const sequence = Buffer.from('\u001b[?2004h', 'ascii')
    state = advancePasteReadiness(state, Buffer.concat([Buffer.from('boot'), sequence.subarray(0, 4)]))
    expect(state.state).toBe('unknown')

    state = advancePasteReadiness(state, sequence.subarray(4))
    expect(state.state).toBe('ready')
    expect(state.observed_at).toEqual(expect.any(String))
  })

  it('后续关闭控制序列覆盖 ready，普通字节不改变状态', () => {
    let state: PasteReadiness & { suffix?: Buffer } = { state: 'ready' }
    state = advancePasteReadiness(state, Buffer.from('rendered frame', 'utf-8'))
    expect(state.state).toBe('ready')

    state = advancePasteReadiness(state, Buffer.from('\u001b[?2004l', 'ascii'))
    expect(state.state).toBe('not_ready')
  })

  it('控制端点不可达时不沿用旧 ready，明确返回 unknown', async () => {
    await expect(readTmuxControlState({
      socket_path: '/private/tmp/crabot-terminal-monitor-does-not-exist.sock',
      monitor_id: 'test-monitor',
    }, 10)).resolves.toEqual({ state: 'unknown' })
  })

  it.skipIf(!canUseTmux())('pipe-pane 消费端识别真实 bracketed-paste 控制字节', async () => {
    const endpoint = await createTmuxControlEndpoint()
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'paste-ready-monitor-test-'))
    const logPath = path.join(tempDir, 'control-monitor.jsonl')
    const child = spawn(controlMonitorPipeCommand(endpoint, logPath), { shell: true, stdio: ['pipe', 'ignore', 'ignore'] })
    try {
      child.stdin?.write(Buffer.from('\u001b[?2004h', 'ascii'))
      await waitForReady(endpoint)
      const log = await fs.readFile(logPath, 'utf-8')
      expect(log).toContain('"event":"monitor_started"')
      expect(log).toContain('"event":"server_listening"')
      expect(log).toContain('"event":"readiness_changed"')
    } finally {
      child.stdin?.end()
      child.kill()
      await removeTmuxControlEndpoint(endpoint)
      await fs.rm(tempDir, { recursive: true, force: true })
    }
  })

})

describe('waitForPasteReady', () => {
  it('仅在控制监视器明确 ready 时通过', async () => {
    const states: PasteReadiness[] = [{ state: 'unknown' }, { state: 'not_ready' }, { state: 'ready' }]
    await expect(waitForPasteReady(async () => states.shift() ?? { state: 'ready' }, {
      timeoutMs: 1000,
      intervalMs: 1,
    })).resolves.toBe(true)
  })

  it('控制监视器不可用时持续暂扣，超时返回 false', async () => {
    await expect(waitForPasteReady(async () => ({ state: 'unknown' }), {
      timeoutMs: 20,
      intervalMs: 1,
    })).resolves.toBe(false)
  })

  it('会话退出时最后一次 ready 仍可被接受', async () => {
    let aliveChecks = 0
    await expect(waitForPasteReady(async () => ({ state: aliveChecks > 0 ? 'ready' : 'unknown' }), {
      timeoutMs: 60_000,
      intervalMs: 1,
      isAlive: async () => {
        aliveChecks += 1
        return false
      },
    })).resolves.toBe(true)
  })

  it('默认超时保持宽松，未知状态不得降级发送', () => {
    expect(DEFAULT_PASTE_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
  })
})
