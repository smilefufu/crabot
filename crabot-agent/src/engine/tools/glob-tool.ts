import { relative } from 'path'
import { defineTool } from '../tool-framework'
import type { ToolDefinition } from '../types'
import { resolvePath } from './utils'
import { runRipgrep, DEFAULT_EXCLUDE_GLOBS, getProtectedExcludeGlobs } from './ripgrep-helper'

const MAX_RESULTS = 200

/**
 * Glob tool — 走 ripgrep `--files --glob`，把目录扫描丢给 rg 子进程。
 *
 * 旧实现用 fast-glob (纯 JS 全 walk)，跟旧 grep-tool 的 walkDirectory 同款隐患——
 * 大仓里可能把几万个文件路径全拉进 JS 堆。rg --files 把扫描留在 rg 进程内部，
 * 流式吐出来 + 应用层 MAX_RESULTS 截断，agent 堆只承担最多 200 个路径字符串。
 */
export function createGlobTool(getCwd: () => string): ToolDefinition {
  return defineTool({
    name: 'Glob',
    category: 'file_io',
    description: 'Fast file pattern matching (powered by ripgrep). Returns matching file paths sorted alphabetically.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern to match files (e.g., "**/*.ts")' },
        path: { type: 'string', description: 'Base directory to search in. Defaults to working directory.' },
      },
      required: ['pattern'],
    },
    isReadOnly: true,
    permissionLevel: 'safe',
    call: async (input) => {
      const pattern = input.pattern as string
      const pathInput = input.path as string | undefined

      const resolvedPath = pathInput ? resolvePath(getCwd(), pathInput) : getCwd()

      const args: string[] = [
        '--no-config',
        '--no-ignore',
        '--hidden',
        '--files',
        '--no-messages',
      ]
      // ripgrep glob 按顺序应用、**最后匹配胜出**：用户 pattern 必须在排除 glob
      // 之前 push，否则像 `**/*` 这种广模式会把 !node_modules / !.git 反向包含进来。
      args.push('--glob', pattern)
      for (const g of DEFAULT_EXCLUDE_GLOBS) {
        args.push('--glob', g)
      }
      // macOS 受保护目录（~/Library 等）：默认排除以避开 TCC 弹窗 / EPERM，
      // 仅当用户开启 CRABOT_ENABLE_FDA 且真持有 FDA 时才放开。
      for (const g of getProtectedExcludeGlobs(resolvedPath)) {
        args.push('--glob', g)
      }
      args.push(resolvedPath)

      let rg
      try {
        rg = await runRipgrep(args)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        return { output: `Glob error: ${message}`, isError: true }
      }

      // 退出码 2 且没有任何 stdout = 真错误（路径不存在 / 参数非法）。
      // 有 stdout 时（如某子目录权限被拒 EPERM，其它目录已列出文件）→ 当 partial
      // 处理，不丢弃已搜到的结果（--no-messages 已抑制 stderr 噪音）。
      if (rg.exitCode === 2 && !rg.stdout) {
        const msg = (rg.stderr || '').trim() || 'ripgrep exited with code 2'
        return { output: `Glob error: ${msg}`, isError: true }
      }

      // rg --files 输出绝对路径（因为传了绝对路径作为 search root），
      // 旧契约（fast-glob）返回的是相对 resolvedPath 的路径，这里 normalize 回去。
      const allEntries: string[] = []
      for (const line of rg.stdout.split('\n')) {
        if (!line) continue
        const rel = relative(resolvedPath, line)
        // relative 可能输出空字符串（path === resolvedPath，理论不会出现在 --files 输出里），跳过
        if (rel) allEntries.push(rel)
      }

      const sorted = [...allEntries].sort()

      // 超时提示：rg 被墙钟超时 kill，结果可能不完整，引导收窄范围。
      const timeoutHint = rg.timedOut
        ? `\n[搜索超时，结果可能不完整。请用更具体的 path 缩小目录、或收窄 pattern。]`
        : ''

      if (sorted.length === 0) {
        if (rg.timedOut) {
          return { output: `Glob 搜索超时，未在时限内列出任何文件。请缩小 path 或收窄 pattern。`, isError: false }
        }
        return { output: `No files found matching pattern: ${pattern}`, isError: false }
      }

      const truncated = sorted.length > MAX_RESULTS
      const displayed = truncated ? sorted.slice(0, MAX_RESULTS) : sorted
      const lines = truncated
        ? [...displayed, `[...${sorted.length - MAX_RESULTS} more results truncated]`]
        : displayed

      return { output: lines.join('\n') + timeoutHint, isError: false }
    },
  })
}
