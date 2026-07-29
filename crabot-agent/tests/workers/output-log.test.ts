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

  it('should truncate at cap and continue reading with nextCursor', async () => {
    const log = new OutputLog(logPath)

    // Write content that exceeds cap
    const largeContent = 'x'.repeat(100) // 100 bytes
    await log.append(largeContent)

    // First read with cap of 50 bytes
    const cap = 50
    const read1 = await log.read({ offset: 0 }, cap)

    // Check that chunk is truncated and includes the truncation marker
    expect(read1.chunk).toContain('[output truncated at')
    expect(read1.chunk).toContain('continue reading from cursor]')

    // Extract actual content (before the truncation marker)
    const contentBeforeTruncation = read1.chunk.split('\n[output truncated')[0]
    expect(contentBeforeTruncation).toBe('x'.repeat(50))

    // nextCursor should point to actual consumed bytes (50, not including marker)
    expect(read1.nextCursor.offset).toBe(50)

    // Second read: continue from nextCursor, should get remaining content
    const read2 = await log.read(read1.nextCursor)
    expect(read2.chunk).toBe('x'.repeat(50))
    expect(read2.nextCursor.offset).toBe(100)

    // Third read: already at end
    const read3 = await log.read(read2.nextCursor)
    expect(read3.chunk).toBe('')
    expect(read3.nextCursor.offset).toBe(100)
  })

  it('should return empty chunk for non-existent file', async () => {
    const nonExistentPath = path.join(tempDir, 'does-not-exist.log')
    const log = new OutputLog(nonExistentPath)

    const result = await log.read({ offset: 0 })
    expect(result.chunk).toBe('')
    expect(result.nextCursor.offset).toBe(0)
  })
})
