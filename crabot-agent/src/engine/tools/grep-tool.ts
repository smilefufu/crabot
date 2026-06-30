import { existsSync } from 'node:fs'
import { defineTool } from '../tool-framework'
import type { ToolDefinition } from '../types'
import { byteLength } from '../byte-cap'
import { resolvePath } from './utils'
import { runRipgrep, DEFAULT_EXCLUDE_GLOBS, getProtectedExcludeGlobs } from './ripgrep-helper'

// Grep 输出按 UTF-8 字节累加上限。命中行内容很长（K 线 / CSV / JSON 单行数 KB～MB）时，
// 仅靠 head_limit（行数）无法兜住——必须按字节裁剪，否则会塞 N MB 进 toolResult。
const MAX_OUTPUT_BYTES = 200_000

// 单行最大列数。base64 / minified 单行能到几 MB，rg 默认无上限会把这种行
// 完整吐出来撑爆 stdout 缓冲；500 列已经足够人读、超出截断显示 "[...]"。
const MAX_COLUMNS = 500

function truncationHint(): string {
  return (
    `\n[truncated: hit ${MAX_OUTPUT_BYTES} byte cap. ` +
    `用 glob 收窄文件类型 / 用 path 缩小搜索目录 / 降低 head_limit / 改用 count 模式。]`
  )
}

/**
 * 按 UTF-8 字节累加把 lines 收集成单字符串，超出 MAX_OUTPUT_BYTES / headLimit 即停。
 * 三个 output_mode formatter 共用，确保截断行为一致。
 */
function joinWithCap(lines: Iterable<string>, headLimit: number): string {
  const collected: string[] = []
  let bytes = 0
  let truncated = false

  for (const line of lines) {
    if (collected.length >= headLimit) break
    const lineBytes = byteLength(line) + 1 // +1 for join newline
    if (bytes + lineBytes > MAX_OUTPUT_BYTES) {
      truncated = true
      break
    }
    collected.push(line)
    bytes += lineBytes
  }

  if (collected.length === 0) return 'No matches found'
  const joined = collected.join('\n')
  return truncated ? joined + truncationHint() : joined
}

/** rg stdout 按 \n 切，去掉空尾行。 */
function* splitLines(stdout: string): Generator<string> {
  if (!stdout) return
  let start = 0
  for (let i = 0; i < stdout.length; i++) {
    if (stdout.charCodeAt(i) === 0x0a) {
      if (i > start) yield stdout.slice(start, i)
      start = i + 1
    }
  }
  if (start < stdout.length) yield stdout.slice(start)
}

export function createGrepTool(getCwd: () => string): ToolDefinition {
  return defineTool({
    name: 'Grep',
    category: 'file_io',
    description: 'Search for regex patterns in files recursively (powered by ripgrep). Supports glob filtering, context lines, and multiple output modes.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regex pattern to search for',
        },
        path: {
          type: 'string',
          description: 'Directory to search in (default: working directory)',
        },
        glob: {
          type: 'string',
          description: 'File filter pattern (e.g., "*.ts")',
        },
        output_mode: {
          type: 'string',
          enum: ['files_with_matches', 'content', 'count'],
          description: 'Output format (default: files_with_matches)',
        },
        context: {
          type: 'number',
          description: 'Lines of context before/after match (content mode only)',
        },
        head_limit: {
          type: 'number',
          description: 'Maximum number of results (default: 250)',
        },
      },
      required: ['pattern'],
    },
    isReadOnly: true,
    permissionLevel: 'safe',
    call: async (input) => {
      const pattern = input.pattern as string
      const searchPath = (input.path as string | undefined) ?? getCwd()
      const glob = input.glob as string | undefined
      const outputMode = (input.output_mode as string | undefined) ?? 'files_with_matches'
      const contextLines = (input.context as number | undefined) ?? 0
      const headLimit = (input.head_limit as number | undefined) ?? 250

      // 前置 regex 校验：避免起进程再炸（rg 错误信息没 JS 友好，且工具
      // 之前的契约就是返回 "Invalid regex pattern: ..."，不破坏调用方）。
      try {
        new RegExp(pattern)
      } catch (err) {
        return {
          output: `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }

      const args: string[] = [
        '--no-config',
        '--no-ignore',          // 测试 / 用户场景不一定有 .gitignore，保留显式排除（DEFAULT_EXCLUDE_GLOBS）
        '--hidden',             // 默认搜 hidden 文件，VCS 目录靠下面 glob 排除
        `--max-columns=${MAX_COLUMNS}`,
        // 不加 --no-messages：runRipgrep 把 stdout/stderr 分开收集，给 agent 的结果只用
        // rg.stdout，stderr 噪音本就不会污染输出；而 --no-messages 会把 code-2 时的真实
        // 错误（哪个文件 / 什么原因）一并吞掉，导致事后无法定位。stderr 改为单独处理：
        // 正常路径只记日志、不给 agent；判错路径用作错误原因（见下）。
      ]

      // ripgrep glob 顺序敏感：**最后匹配胜出**。用户 include glob（如 `*.ts`）
      // 必须先 push，排除 glob（`!node_modules` 等）放在后面，否则用户的 include
      // 会反向把 node_modules 等目录拉回来。
      if (glob) {
        args.push('--glob', glob)
      }

      for (const g of DEFAULT_EXCLUDE_GLOBS) {
        args.push('--glob', g)
      }
      // macOS 受保护目录（~/Library / ~/Documents 等）：搜索根落在家目录或其祖先时
      // 默认排除以避开 TCC 弹窗 / EPERM，仅当用户开启 CRABOT_ENABLE_FDA 且真持有 FDA 时放开。
      const searchRoot = resolvePath(getCwd(), searchPath)
      for (const g of getProtectedExcludeGlobs(searchRoot)) {
        args.push('--glob', g)
      }

      // 模式输出参数
      if (outputMode === 'files_with_matches') {
        args.push('--files-with-matches')
      } else if (outputMode === 'count') {
        args.push('--count')      // path:N（每文件总匹配数）
      } else {
        // content mode: rg 默认输出 path:line:content，加 -n 显式带行号
        args.push('--line-number', '--with-filename')
        if (contextLines > 0) args.push('--context', String(contextLines))
      }

      // pattern 必须放 args 最后第二（path 在最后），且用 -e 防止以 `-` 起头被当成 flag
      args.push('-e', pattern, searchPath)

      let rg
      try {
        rg = await runRipgrep(args)
      } catch (err) {
        return {
          output: `Grep error: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }

      // stderr 拆开走：不混进给 agent 的结果，但有内容就记日志（agent 子进程 stderr
      // 落到 data/logs/<agent>.log），便于事后排查到底是哪个文件 / 什么原因出的错。
      const stderr = (rg.stderr || '').trim()
      if (stderr) {
        console.error(
          `[Grep] ripgrep stderr (exit=${rg.exitCode}) pattern=${JSON.stringify(pattern)} path=${searchRoot}:\n${stderr}`,
        )
      }

      // exitCode 1 = 无匹配（合法，对外 "No matches found"）。
      // exitCode 2 = 错误，但仅当没有任何 stdout 时才判错（路径不存在 / 真正异常）；
      // 有 stdout 时（如某子目录权限被拒 EPERM，其它文件已命中）→ 当 partial 返回，
      // 不丢弃已搜到的结果（stderr 噪音上面已记日志、不进 agent 输出）。
      if (rg.exitCode === 2 && !rg.stdout) {
        // code-2 + 无 stdout = 真错误。stderr 此时带具体原因（如某文件 Permission denied），
        // 直接当错误返回给 agent，使其能自纠、且 trace 可追溯。
        const msg = stderr || 'ripgrep exited with code 2'
        // code-2 最常见的真因：searchPath 相对当前 cwd 不存在（cwd 没锚定到项目）。
        // 补结构化提示：点明解析后的绝对路径不存在 + 当前 cwd，引导用绝对路径或先 set_cwd。
        const hint = !existsSync(searchRoot)
          ? `\n搜索路径不存在：${searchRoot}（当前 cwd=${getCwd()}）。`
            + `若目标在别的项目目录，请先用 set_cwd 锚定到该项目，或给 path 传绝对路径。`
          : ''
        return { output: `Grep error: ${msg}${hint}`, isError: true }
      }

      const output = joinWithCap(splitLines(rg.stdout), headLimit)

      // rg stdout 自己被 ripgrep-helper 截断时，附带提示——优先于无字节超限的情况。
      let finalOutput = rg.truncated && !rg.timedOut && !output.endsWith(truncationHint())
        ? output + truncationHint()
        : output
      // 超时单独提示：墙钟超时被 kill，结果可能不完整，引导收窄范围。
      if (rg.timedOut) {
        finalOutput += `\n[搜索超时，结果可能不完整。请用更具体的 path / glob 缩小范围。]`
      }

      return { output: finalOutput, isError: false }
    },
  })
}
