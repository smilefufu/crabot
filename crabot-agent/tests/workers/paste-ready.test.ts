import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  BRACKETED_PASTE_ENABLE,
  DEFAULT_PASTE_READY_TIMEOUT_MS,
  describeStartupStall,
  readOutputTail,
  waitForPasteReady,
} from '../../src/workers/tmux/paste-ready.js'

describe('waitForPasteReady', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paste-ready-'))
    file = path.join(dir, 'output-1.log')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('信号已经在文件里 → 立即就绪', async () => {
    await fs.writeFile(file, `boot\n${BRACKETED_PASTE_ENABLE}rest`)
    expect(await waitForPasteReady(file, { timeoutMs: 1000, intervalMs: 5 })).toBe(true)
  })

  it('信号迟到 → 等到它出现才返回 true', async () => {
    await fs.writeFile(file, 'starting up…')
    const waiting = waitForPasteReady(file, { timeoutMs: 3000, intervalMs: 5 })
    let settled = false
    void waiting.then(() => {
      settled = true
    })
    await new Promise((r) => setTimeout(r, 60))
    expect(settled).toBe(false)

    await fs.appendFile(file, BRACKETED_PASTE_ENABLE)
    expect(await waiting).toBe(true)
  })

  it('信号始终不出现 → 超时返回 false(调用方据此暂扣,不得降级发送)', async () => {
    await fs.writeFile(file, 'a modal is blocking the TUI')
    const startedAt = Date.now()
    expect(await waitForPasteReady(file, { timeoutMs: 150, intervalMs: 5 })).toBe(false)
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140)
  })

  it('文件还不存在(pipe-pane 尚未落第一笔)不算失败,出现后照常判定', async () => {
    const waiting = waitForPasteReady(file, { timeoutMs: 3000, intervalMs: 5 })
    await new Promise((r) => setTimeout(r, 30))
    await fs.writeFile(file, BRACKETED_PASTE_ENABLE)
    expect(await waiting).toBe(true)
  })

  it('信号骑在两次增量读取的边界上也能识别(跨块重叠)', async () => {
    // 先写下信号的前半截,让第一轮扫描把它整块吃掉;后半截下一轮才到。
    const half = Math.floor(BRACKETED_PASTE_ENABLE.length / 2)
    await fs.writeFile(file, 'x'.repeat(10) + BRACKETED_PASTE_ENABLE.slice(0, half))
    const waiting = waitForPasteReady(file, { timeoutMs: 3000, intervalMs: 5 })
    await new Promise((r) => setTimeout(r, 40))
    await fs.appendFile(file, BRACKETED_PASTE_ENABLE.slice(half))
    expect(await waiting).toBe(true)
  })

  it('会话已经不在了 → 提前收工,不白等满整个超时', async () => {
    // 启动即失败(二进制缺失/PATH 不对/pane 命令立刻退出)是常见情形,让它也等满 60s
    // 等于给一条本来秒级收敛的失败路径平白加一分钟。
    await fs.writeFile(file, 'boom: command not found')
    const startedAt = Date.now()
    expect(await waitForPasteReady(file, { timeoutMs: 60_000, intervalMs: 5, isAlive: async () => false })).toBe(false)
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('进程死前最后一刻才写出的信号不算漏掉(放弃等待前再扫一次)', async () => {
    await fs.writeFile(file, 'starting…')
    let alive = true
    const waiting = waitForPasteReady(file, {
      timeoutMs: 60_000,
      intervalMs: 5,
      isAlive: async () => alive,
    })
    await new Promise((r) => setTimeout(r, 30))
    await fs.appendFile(file, BRACKETED_PASTE_ENABLE)
    alive = false
    expect(await waiting).toBe(true)
  })

  it('默认超时是数十秒量级的宽松值(宁可等久,不可漏发)', () => {
    expect(DEFAULT_PASTE_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000)
  })
})

describe('readOutputTail', () => {
  let dir: string
  let file: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paste-tail-'))
    file = path.join(dir, 'output-1.log')
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  it('取尾部而非头部——启动期的模态框在最后', async () => {
    await fs.writeFile(file, 'HEAD'.repeat(100) + 'Do you trust this folder?')
    const tail = await readOutputTail(file, 40)
    expect(tail).toContain('Do you trust this folder?')
    expect(tail).not.toContain('HEADHEADHEADHEADHEADHEADHEADHEADHEADHEAD')
  })

  it('尾窗起点落在多字节字符中间时不产生半个字符', async () => {
    await fs.writeFile(file, '啊'.repeat(50))
    const tail = await readOutputTail(file, 10) // 10 不是 3 的整数倍,必然切中间
    expect(tail).not.toContain('�')
    expect(tail).toBe('啊啊啊')
  })

  it('文件不存在/为空 → 空串,不抛错', async () => {
    expect(await readOutputTail(path.join(dir, 'nope.log'))).toBe('')
    await fs.writeFile(file, '')
    expect(await readOutputTail(file)).toBe('')
  })
})

describe('describeStartupStall', () => {
  it('说明句必须点明"没有投递",否则 manager 会当成普通的一轮结束', () => {
    const text = describeStartupStall({ impl: 'claude-code', timeoutMs: 60_000, tail: 'Enter to confirm' })
    expect(text).toContain('claude-code')
    expect(text).toContain('60s')
    expect(text).toContain('一个字符都没有投递')
    expect(text).toContain('raw')
    expect(text).toContain('Enter to confirm')
  })

  it('终端一个字节都没吐出来时也如实说明,不给空正文', () => {
    const text = describeStartupStall({ impl: 'codex', timeoutMs: 1000, tail: '' })
    expect(text).toContain('没有任何输出')
  })
})
