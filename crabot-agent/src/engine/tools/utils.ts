import * as path from 'path'
import type { ContentBlock } from '../types'

export function isBinaryBuffer(buf: Buffer, checkBytes = 512): boolean {
  const len = Math.min(buf.length, checkBytes)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export function resolvePath(cwd: string, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath)
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function extractTextFromBlocks(
  blocks: ReadonlyArray<ContentBlock>,
  separator = ' ',
): string {
  return blocks
    .filter((b): b is { readonly type: 'text'; readonly text: string } => b.type === 'text')
    .map((b) => b.text)
    .join(separator)
}
