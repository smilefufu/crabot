import * as fs from 'fs/promises'
import { AsyncMutex } from './async-mutex'
import type { OutputCursor } from './types'

// A cap-truncated read can land in the middle of a multi-byte UTF-8 character.
// Given the number of valid bytes in `buffer[0, len)`, return the largest prefix
// length that does not split a UTF-8 character, by dropping an incomplete
// trailing sequence (if any). Only relevant when the read was cut off by `cap`;
// a read that reaches EOF is already a complete, valid UTF-8 file and needs no trimming.
function trimIncompleteUtf8Tail(buffer: Buffer, len: number): number {
  const maxLookback = Math.min(3, len)
  for (let i = 1; i <= maxLookback; i++) {
    const byte = buffer[len - i]
    if ((byte & 0xc0) !== 0x80) {
      // Found the lead byte of the last character in the buffer.
      let seqLen: number
      if ((byte & 0x80) === 0x00) seqLen = 1
      else if ((byte & 0xe0) === 0xc0) seqLen = 2
      else if ((byte & 0xf0) === 0xe0) seqLen = 3
      else if ((byte & 0xf8) === 0xf0) seqLen = 4
      else seqLen = 1 // not a valid lead byte; treat as standalone

      return i < seqLen ? len - i : len
    }
  }
  // Last `maxLookback` bytes are all continuation bytes with no lead byte found
  // in range: the lead byte is further back, meaning the sequence is complete.
  return len
}

// Determine the byte length of a UTF-8 character given its lead byte.
function utf8CharLength(leadByte: number): number {
  if ((leadByte & 0x80) === 0x00) return 1
  else if ((leadByte & 0xe0) === 0xc0) return 2
  else if ((leadByte & 0xf0) === 0xe0) return 3
  else if ((leadByte & 0xf8) === 0xf0) return 4
  else return 1 // invalid lead byte; treat as standalone
}

export class OutputLog {
  private mutex = new AsyncMutex()

  constructor(private filePath: string) {}

  async append(text: string): Promise<void> {
    return this.mutex.run(async () => {
      await fs.appendFile(this.filePath, text, 'utf-8')
    })
  }

  async read(cursor: OutputCursor, cap: number = 50_000): Promise<{ chunk: string; nextCursor: OutputCursor }> {
    return this.mutex.run(async () => {
      try {
        const stat = await fs.stat(this.filePath)
        const fileSize = stat.size

        // If cursor is already at or past end of file, return empty chunk
        if (cursor.offset >= fileSize) {
          return { chunk: '', nextCursor: cursor }
        }

        // Calculate bytes to read: up to cap, but not beyond file size
        let bytesToRead = Math.min(cap, fileSize - cursor.offset)
        let buffer = Buffer.alloc(bytesToRead)

        const fd = await fs.open(this.filePath, 'r')
        try {
          await fd.read(buffer, 0, bytesToRead, cursor.offset)

          // Truncation occurs only if we hit the cap limit and there's more content
          let isTruncated = bytesToRead === cap && cursor.offset + bytesToRead < fileSize

          // Only cap-truncated reads risk splitting a multi-byte UTF-8 character
          // mid-sequence; a read that reaches EOF is complete and needs no trimming.
          let usedBytes = bytesToRead
          if (isTruncated) {
            usedBytes = trimIncompleteUtf8Tail(buffer, bytesToRead)
          }

          // If trimming left us with zero bytes (first character was incomplete) and
          // there's more content in the file, we must guarantee progress by reading
          // at least one complete character. cap is a soft limit; progress is a hard requirement.
          if (usedBytes === 0 && cursor.offset + bytesToRead < fileSize) {
            // Determine how many bytes the first character needs
            const firstByte = buffer[0]
            const charBytesNeeded = utf8CharLength(firstByte)

            // Re-read with enough capacity for the complete character
            const newBytesToRead = charBytesNeeded
            buffer = Buffer.alloc(newBytesToRead)
            await fd.read(buffer, 0, newBytesToRead, cursor.offset)

            // Since we're reading the full character without truncation, no trimming needed
            usedBytes = newBytesToRead
            isTruncated = false
          }

          let chunk = buffer.toString('utf-8', 0, usedBytes)

          if (isTruncated) {
            // Add truncation marker
            chunk += `\n[output truncated at ${usedBytes} bytes, continue reading from cursor]`
          }

          return {
            chunk,
            nextCursor: { offset: cursor.offset + usedBytes },
          }
        } finally {
          await fd.close()
        }
      } catch (error) {
        // File not found: return empty chunk with same cursor
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { chunk: '', nextCursor: cursor }
        }
        throw error
      }
    })
  }
}
