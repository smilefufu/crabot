import * as path from 'path'
import { homedir } from 'os'
import type { ContentBlock } from '../types'

export function isBinaryBuffer(buf: Buffer, checkBytes = 512): boolean {
  const len = Math.min(buf.length, checkBytes)
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true
  }
  return false
}

export function resolvePath(cwd: string, inputPath: string): string {
  // 前导 `~` 展开到 home。LLM 天然爱用 `~/codes/...` shorthand，但 path.isAbsolute('~/x')
  // 为 false → resolve(cwd,'~/x') 把字面量 `~` 当子目录拼进去（/Users/fufu/~/x）→ ENOENT
  // （m2u 实测踩过）。在 canonical 解析入口统一处理，所有吃路径的工具都受益。
  const expanded = inputPath === '~'
    ? homedir()
    : inputPath.startsWith('~/')
      ? path.join(homedir(), inputPath.slice(2))
      : inputPath
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd, expanded)
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
