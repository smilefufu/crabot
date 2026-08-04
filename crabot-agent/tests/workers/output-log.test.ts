import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { OutputLog } from '../../src/workers/output-log'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'

describe('OutputLog', () => {
  let tempDir: string
  let logPath: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'output-log-test-'))
    logPath = path.join(tempDir, 'output.log')
  })

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true })
    } catch {
      // ignore cleanup errors
    }
  })

  it('should support incremental reads without duplication or loss', async () => {
    const log = new OutputLog(logPath)

    // Write content
    await log.append('Hello')
    await log.append(' ')
    await log.append('World')

    // First read: get first 5 bytes ("Hello"), use large cap to avoid truncation
    const read1 = await log.read({ offset: 0 }, 1000)
    expect(read1.chunk).toBe('Hello World')
    expect(read1.nextCursor.offset).toBe(11)

    // Second read: continue from offset 11 (end), should get empty chunk
    const read2 = await log.read(read1.nextCursor)
    expect(read2.chunk).toBe('')
    expect(read2.nextCursor.offset).toBe(11)
  })

  it('超 cap 时返回尾部而非头部:诊断要的是"现在卡在哪"', async () => {
    const log = new OutputLog(logPath)

    // 复刻真实事故的形状:开头是启动噪音,致命错误落在远超 cap 的位置
    await log.append('STARTUP-NOISE-')
    await log.append('n'.repeat(200))
    await log.append('FATAL: 401 Unauthorized')

    const cap = 50
    const { chunk, nextCursor } = await log.read({ offset: 0 }, cap)

    expect(chunk).toContain('FATAL: 401 Unauthorized')
    expect(chunk).not.toContain('STARTUP-NOISE-')
    // 游标直接落到文件末尾:被跳过的头部对这个游标而言已经消费掉了
    expect(nextCursor.offset).toBe(237)
  })

  it('截断标记是前缀,并说明丢掉了多少', async () => {
    const log = new OutputLog(logPath)
    await log.append('x'.repeat(100))

    const { chunk } = await log.read({ offset: 0 }, 50)

    expect(chunk.startsWith('[output truncated')).toBe(true)
    expect(chunk).toContain('trimmed 50 leading chars')
    const body = chunk.split('\n').slice(1).join('\n')
    expect(body).toBe('x'.repeat(50))
  })

  it('未超 cap 时不加任何标记', async () => {
    const log = new OutputLog(logPath)
    await log.append('x'.repeat(50))

    const { chunk } = await log.read({ offset: 0 }, 50)
    expect(chunk).toBe('x'.repeat(50))
  })

  it('增量游标语义不被破坏:每次只拿到新增部分,不重不漏', async () => {
    const log = new OutputLog(logPath)

    await log.append('first-')
    const read1 = await log.read({ offset: 0 }, 1000)
    expect(read1.chunk).toBe('first-')

    await log.append('second-')
    const read2 = await log.read(read1.nextCursor, 1000)
    expect(read2.chunk).toBe('second-')

    await log.append('third')
    const read3 = await log.read(read2.nextCursor, 1000)
    expect(read3.chunk).toBe('third')

    const read4 = await log.read(read3.nextCursor, 1000)
    expect(read4.chunk).toBe('')
    expect(read4.nextCursor.offset).toBe(read3.nextCursor.offset)
  })

  it('增量读时若两次之间新增超过 cap,同样保留新增部分的尾部', async () => {
    const log = new OutputLog(logPath)

    await log.append('already-read')
    const read1 = await log.read({ offset: 0 }, 1000)
    expect(read1.chunk).toBe('already-read')

    // 一轮之间涌出远超 cap 的输出,结尾是关键信息
    await log.append('b'.repeat(300) + 'LATEST')
    const read2 = await log.read(read1.nextCursor, 50)

    expect(read2.chunk).toContain('LATEST')
    expect(read2.nextCursor.offset).toBe(12 + 306)
  })

  it('should return empty chunk for non-existent file', async () => {
    const nonExistentPath = path.join(tempDir, 'does-not-exist.log')
    const log = new OutputLog(nonExistentPath)

    const result = await log.read({ offset: 0 })
    expect(result.chunk).toBe('')
    expect(result.nextCursor.offset).toBe(0)
  })

  it('取尾部时不会切出半个多字节字符(3 字节)', async () => {
    const log = new OutputLog(logPath)

    // 尾部是多字节字符,cap 落在它们中间时不许出现替换字符
    const original = 'A'.repeat(20) + '中'.repeat(4)
    await log.append(original)

    const { chunk } = await log.read({ offset: 0 }, 10)
    const body = chunk.split('\n').slice(1).join('\n')

    expect(body).not.toContain('�')
    expect(original.endsWith(body)).toBe(true)
  })

  it('取尾部时不会切出半个多字节字符(4 字节 emoji)', async () => {
    const log = new OutputLog(logPath)

    const original = 'A'.repeat(20) + '🎉'.repeat(3)
    await log.append(original)

    const { chunk } = await log.read({ offset: 0 }, 10)
    const body = chunk.split('\n').slice(1).join('\n')

    expect(body).not.toContain('�')
    expect(original.endsWith(body)).toBe(true)
  })

  it('日志超过原始读窗上限时,尾窗起点落在多字节字符中间也不产生半个字符', async () => {
    const log = new OutputLog(logPath)

    // 原始读窗上限 1MB;开头放 20 个 3 字节的 '中'(共 60 字节),让 1MB 尾窗的起点(byte 59)
    // 正好落在第 20 个 '中' 的最后一个字节上
    await log.append('中'.repeat(20) + 'A'.repeat(999_999))

    const { chunk, nextCursor } = await log.read({ offset: 0 }, 1_000_000)

    expect(chunk).toContain('skipped 59 earlier bytes')
    const body = chunk.split('\n').slice(1).join('\n')
    expect(body).not.toContain('�')
    expect(body.startsWith('A')).toBe(true)
    expect(nextCursor.offset).toBe(60 + 999_999)
  })

  it('cap 极小时游标依然前进到文件末尾,不会卡死在原地', async () => {
    const log = new OutputLog(logPath)
    await log.append('A中B')

    const { nextCursor } = await log.read({ offset: 0 }, 1)
    expect(nextCursor.offset).toBe(5)

    const next = await log.read(nextCursor, 1)
    expect(next.chunk).toBe('')
    expect(next.nextCursor.offset).toBe(5)
  })

  it('decode 在返回路径上生效,且 cap 作用在解码后的文本上', async () => {
    const log = new OutputLog(logPath)

    // 原文 900 字节里绝大部分是控制序列,解码后只剩 30 字节 —— cap=100 不该再截它
    const raw = '\x1b[2J'.repeat(200) + 'the only line that matters'
    await log.append(raw)

    const { chunk } = await log.read({ offset: 0 }, 100, (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, ''))

    expect(chunk).toBe('the only line that matters')
    // 原始日志一字未动
    expect(await fs.readFile(logPath, 'utf-8')).toBe(raw)
  })
})
