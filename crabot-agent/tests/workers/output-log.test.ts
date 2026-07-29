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

  it('should not split a multi-byte UTF-8 character when cap boundary falls mid-character', async () => {
    const log = new OutputLog(logPath)

    // 49 'A' + '中' (3-byte UTF-8) + 'BBBB'; cap=50 lands right in the middle of '中'
    const original = 'A'.repeat(49) + '中' + 'BBBB'
    await log.append(original)

    const cap = 50
    let cursor = { offset: 0 }
    let assembled = ''
    let guard = 0
    while (true) {
      const { chunk, nextCursor } = await log.read(cursor, cap)
      const contentBeforeTruncation = chunk.split('\n[output truncated')[0]
      assembled += contentBeforeTruncation
      if (nextCursor.offset === cursor.offset) break // no progress => done
      cursor = nextCursor
      guard += 1
      if (guard > 20) throw new Error('read loop did not terminate')
    }

    expect(assembled).toBe(original)
    expect(assembled).not.toContain('�')
    expect(cursor.offset).toBe(Buffer.byteLength(original, 'utf-8'))
  })

  it('should not split a 4-byte emoji when cap boundary falls mid-character', async () => {
    const log = new OutputLog(logPath)

    // emoji '🎉' is 4 bytes in UTF-8; place cap boundary inside it
    const original = 'A'.repeat(48) + '🎉' + 'BBBB'
    await log.append(original)

    const cap = 50 // 48 'A' bytes + 2 of the 4 emoji bytes = boundary mid-character
    let cursor = { offset: 0 }
    let assembled = ''
    let guard = 0
    while (true) {
      const { chunk, nextCursor } = await log.read(cursor, cap)
      const contentBeforeTruncation = chunk.split('\n[output truncated')[0]
      assembled += contentBeforeTruncation
      if (nextCursor.offset === cursor.offset) break
      cursor = nextCursor
      guard += 1
      if (guard > 20) throw new Error('read loop did not terminate')
    }

    expect(assembled).toBe(original)
    expect(assembled).not.toContain('�')
    expect(cursor.offset).toBe(Buffer.byteLength(original, 'utf-8'))
  })

  it('should guarantee progress with extremely small cap=1 when encountering 3-byte UTF-8 character', async () => {
    const log = new OutputLog(logPath)

    // File: 'A' (1 byte) + '中' (3 bytes) + 'B' (1 byte) = 5 bytes total
    const original = 'A中B'
    await log.append(original)

    const cap = 1 // Extremely small cap, smaller than any multi-byte character
    let cursor = { offset: 0 }
    let assembled = ''
    const offsets: number[] = []
    let guard = 0

    while (true) {
      offsets.push(cursor.offset)
      const { chunk, nextCursor } = await log.read(cursor, cap)
      const contentBeforeTruncation = chunk.split('\n[output truncated')[0]
      assembled += contentBeforeTruncation

      // Check for progress: nextCursor.offset must strictly increase or we're done
      if (nextCursor.offset === cursor.offset) {
        break
      }
      expect(nextCursor.offset).toBeGreaterThan(cursor.offset)
      cursor = nextCursor
      guard += 1
      if (guard > 20) throw new Error('read loop did not terminate')
    }

    // Verify the assembled content matches original
    expect(assembled).toBe(original)
    expect(assembled).not.toContain('�') // No broken characters
    expect(cursor.offset).toBe(Buffer.byteLength(original, 'utf-8'))

    // Verify offsets are strictly increasing
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1])
    }
  })

  it('should guarantee progress with cap=3 when encountering 4-byte emoji', async () => {
    const log = new OutputLog(logPath)

    // File: 'AB' (2 bytes) + '🎉' (4 bytes) + 'C' (1 byte) = 7 bytes total
    const original = 'AB🎉C'
    await log.append(original)

    const cap = 3 // cap < emoji's 4-byte size
    let cursor = { offset: 0 }
    let assembled = ''
    const offsets: number[] = []
    let guard = 0

    while (true) {
      offsets.push(cursor.offset)
      const { chunk, nextCursor } = await log.read(cursor, cap)
      const contentBeforeTruncation = chunk.split('\n[output truncated')[0]
      assembled += contentBeforeTruncation

      if (nextCursor.offset === cursor.offset) {
        break
      }
      expect(nextCursor.offset).toBeGreaterThan(cursor.offset)
      cursor = nextCursor
      guard += 1
      if (guard > 20) throw new Error('read loop did not terminate')
    }

    expect(assembled).toBe(original)
    expect(assembled).not.toContain('�')
    expect(cursor.offset).toBe(Buffer.byteLength(original, 'utf-8'))

    // Verify offsets are strictly increasing
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1])
    }
  })
})
