import * as fs from 'fs/promises'
import { AsyncMutex } from './async-mutex'
import type { OutputCursor } from './types'

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
        const bytesToRead = Math.min(cap, fileSize - cursor.offset)
        const buffer = Buffer.alloc(bytesToRead)

        const fd = await fs.open(this.filePath, 'r')
        try {
          await fd.read(buffer, 0, bytesToRead, cursor.offset)
          let chunk = buffer.toString('utf-8')

          // Truncation occurs only if we hit the cap limit and there's more content
          const isTruncated = bytesToRead === cap && cursor.offset + bytesToRead < fileSize

          if (isTruncated) {
            // Add truncation marker
            chunk += `\n[output truncated at ${bytesToRead} bytes, continue reading from cursor]`
          }

          return {
            chunk,
            nextCursor: { offset: cursor.offset + bytesToRead },
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
