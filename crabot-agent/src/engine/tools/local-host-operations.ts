import { createReadStream, existsSync, unlinkSync } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { relative } from 'node:path'
import { rgPath } from '@vscode/ripgrep'
import { compressImage } from '../image-utils'
import { inferMediaType } from '../../agent/media-resolver'
import { truncateUtf8, byteLength } from '../byte-cap'
import { FILE_UNCHANGED_STUB } from './file-read-state'
import type { ToolCallResult } from '../types'
import type { LocalHostOperation, ReadObservation } from './local-host-protocol'

const MAX_READ_OUTPUT_BYTES = 50 * 1024
const MAX_LINE_LENGTH_PROBE_BYTES = 256 * 1024
const DEFAULT_READ_LIMIT = 2000
const BINARY_CHECK_SIZE = 8192
const MAX_IMAGE_SIZE = 20 * 1024 * 1024
const MAX_SKILL_BYTES = 256 * 1024
const MAX_SKILL_RESOURCES = 500
const MAX_SKILL_DEPTH = 8
const MAX_GLOB_RESULTS = 200
const MAX_GREP_OUTPUT_BYTES = 95_000
const MAX_GREP_COLUMNS = 500

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp'])
const inFlightTemporaryFiles = new Set<string>()

/** The helper calls this synchronously before exiting from SIGTERM/SIGINT. */
export function cleanUpInFlightTemporaryFiles(): void {
  for (const filePath of inFlightTemporaryFiles) {
    try {
      unlinkSync(filePath)
    } catch {
      // The temporary file may not have been created yet or was already renamed.
    }
  }
  inFlightTemporaryFiles.clear()
}

function trackTemporaryFile(filePath: string): void {
  inFlightTemporaryFiles.add(filePath)
}

function releaseTemporaryFile(filePath: string): void {
  inFlightTemporaryFiles.delete(filePath)
}

export interface LocalOperationResult {
  readonly result: ToolCallResult
  readonly effect?: ReadObservation
}

function asString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key]
  return typeof value === 'string' ? value : undefined
}

function asFiniteInteger(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback
}

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(path.extname(filePath).slice(1).toLowerCase())
}

function containsNullBytes(buffer: Buffer): boolean {
  const length = Math.min(buffer.length, BINARY_CHECK_SIZE)
  for (let index = 0; index < length; index++) {
    if (buffer[index] === 0) return true
  }
  return false
}

async function readHeadBytes(filePath: string, size: number): Promise<Buffer> {
  const handle = await fs.open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(size)
    const { bytesRead } = await handle.read(buffer, 0, size, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

function formatLineNumber(line: number, width: number): string {
  return String(line).padStart(width, ' ')
}

interface LineLength {
  readonly bytes: number
  readonly exact: boolean
}

function oversizedLine(line: string, lineNumber: number, width: number, filePath: string, lineLength: LineLength): string {
  const shown = truncateUtf8(line, MAX_READ_OUTPUT_BYTES - 256)
  const shownBytes = byteLength(shown)
  const total = lineLength.exact
    ? `a ${lineLength.bytes}-byte line`
    : `at least ${lineLength.bytes} bytes of the line before its end`
  return `${formatLineNumber(lineNumber, width)}\t${shown}` +
    `[...line truncated: showing first ${shownBytes} bytes of ${total}. ` +
    `Use Bash: sed -n '${lineNumber}p' '${filePath}' | tail -c +${shownBytes + 1} | head -c ${MAX_READ_OUTPUT_BYTES} to read more.]`
}

function readMarker(fileSize: number): string {
  return `\n[...truncated: output capped at ${MAX_READ_OUTPUT_BYTES} bytes (file is ${fileSize} bytes total). Use offset to continue reading.]`
}

interface StreamedLines {
  readonly lines: ReadonlyArray<string>
  readonly truncated: boolean
  readonly reachedEof: boolean
}

/** Reads only a bounded view. It never holds an arbitrary physical line in memory. */
async function readTextWindow(filePath: string, offset: number, limit: number): Promise<StreamedLines> {
  if (limit === 0) return { lines: [], truncated: false, reachedEof: false }
  const decoder = new StringDecoder('utf8')
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 })
  const lines: string[] = []
  let current = ''
  let currentBytes = 0
  let oversizedLineBytes: number | undefined
  let lineIndex = 0
  let outputBytes = 0
  let truncated = false
  let reachedEof = true
  let stopped = false

  const stop = (): void => {
    stopped = true
    reachedEof = false
    stream.destroy()
  }
  const consumeLine = (): void => {
    if (lineIndex >= offset && lines.length < limit) {
      const normalized = current.endsWith('\r') ? current.slice(0, -1) : current
      const candidateBytes = byteLength(normalized) + 16
      if (outputBytes + candidateBytes > MAX_READ_OUTPUT_BYTES) {
        if (lines.length === 0) {
          lines.push(oversizedLine(normalized, lineIndex + 1, String(lineIndex + 2).length, filePath, { bytes: currentBytes, exact: true }))
        }
        truncated = true
        stop()
        return
      }
      lines.push(normalized)
      outputBytes += candidateBytes
      if (lines.length >= limit) {
        stop()
        return
      }
    }
    lineIndex++
    current = ''
    currentBytes = 0
    oversizedLineBytes = undefined
  }

  try {
    for await (const chunk of stream) {
      let text = decoder.write(chunk as Buffer)
      while (text.length > 0 && !stopped) {
        const newline = text.indexOf('\n')
        const part = newline === -1 ? text : text.slice(0, newline)
        if (lineIndex >= offset && lines.length < limit) {
          const partBytes = byteLength(part)
          if (oversizedLineBytes !== undefined) {
            const nextLineBytes = oversizedLineBytes + partBytes
            const probeLimit = MAX_READ_OUTPUT_BYTES + MAX_LINE_LENGTH_PROBE_BYTES
            if ((newline !== -1 && nextLineBytes <= probeLimit) || nextLineBytes >= probeLimit) {
              lines.push(oversizedLine(current, lineIndex + 1, String(lineIndex + 2).length, filePath, {
                bytes: newline !== -1 && nextLineBytes <= probeLimit ? nextLineBytes : probeLimit,
                exact: newline !== -1 && nextLineBytes <= probeLimit,
              }))
              truncated = true
              stop()
              break
            }
            oversizedLineBytes = nextLineBytes
          } else if (currentBytes + partBytes > MAX_READ_OUTPUT_BYTES) {
            const remaining = Math.max(0, MAX_READ_OUTPUT_BYTES - currentBytes)
            if (remaining > 0) current += truncateUtf8(part, remaining)
            const observedLineBytes = currentBytes + partBytes
            const probeLimit = MAX_READ_OUTPUT_BYTES + MAX_LINE_LENGTH_PROBE_BYTES
            if (newline !== -1 || observedLineBytes >= probeLimit) {
              lines.push(oversizedLine(current, lineIndex + 1, String(lineIndex + 2).length, filePath, {
                bytes: newline !== -1 ? observedLineBytes : probeLimit,
                exact: newline !== -1,
              }))
              truncated = true
              stop()
              break
            }
            oversizedLineBytes = observedLineBytes
          } else {
            current += part
            currentBytes += partBytes
          }
        }
        if (newline === -1) break
        consumeLine()
        text = text.slice(newline + 1)
      }
    }
    if (!stopped) {
      const tail = decoder.end()
      if (tail) {
        if (lineIndex >= offset && lines.length < limit) {
          const tailBytes = byteLength(tail)
          if (oversizedLineBytes !== undefined) {
            const probeLimit = MAX_READ_OUTPUT_BYTES + MAX_LINE_LENGTH_PROBE_BYTES
            const exactLineBytes = oversizedLineBytes + tailBytes
            lines.push(oversizedLine(current, lineIndex + 1, String(lineIndex + 2).length, filePath, {
              bytes: Math.min(exactLineBytes, probeLimit),
              exact: exactLineBytes <= probeLimit,
            }))
            truncated = true
          } else if (currentBytes + tailBytes > MAX_READ_OUTPUT_BYTES) {
            const remaining = Math.max(0, MAX_READ_OUTPUT_BYTES - currentBytes)
            if (remaining > 0) current += truncateUtf8(tail, remaining)
            lines.push(oversizedLine(current, lineIndex + 1, String(lineIndex + 2).length, filePath, {
              bytes: currentBytes + tailBytes,
              exact: true,
            }))
            truncated = true
          } else {
            current += tail
            currentBytes += tailBytes
          }
        }
      }
      if (!truncated && oversizedLineBytes !== undefined) {
        lines.push(oversizedLine(current, lineIndex + 1, String(lineIndex + 2).length, filePath, { bytes: oversizedLineBytes, exact: true }))
        truncated = true
      }
      if (!truncated && current.length > 0 && lineIndex >= offset && lines.length < limit) consumeLine()
    }
  } catch (error) {
    // Destroying a stream after a complete bounded window causes Node to surface
    // ERR_STREAM_PREMATURE_CLOSE through async iteration; that is our success path.
    if (!stopped) throw error
  } finally {
    stream.destroy()
  }

  return { lines, truncated, reachedEof }
}

async function readOperation(input: Record<string, unknown>): Promise<LocalOperationResult> {
  const filePath = asString(input, 'file_path')
  if (!filePath) return { result: { output: 'Error reading file: file_path is required', isError: true } }
  const offset = asFiniteInteger(input.offset, 0)
  const limit = asFiniteInteger(input.limit, DEFAULT_READ_LIMIT)

  try {
    const stat = await fs.stat(filePath)
    if (stat.size === 0) return { result: { output: '', isError: false } }

    const previous = input.previous_read
    if (previous !== null && typeof previous === 'object') {
      const read = previous as Record<string, unknown>
      if (read.mtime_ms === stat.mtimeMs && read.offset === offset && read.limit === limit) {
        return { result: { output: FILE_UNCHANGED_STUB, isError: false } }
      }
    }

    if (isImageFile(filePath)) {
      if (stat.size > MAX_IMAGE_SIZE) return { result: { output: `[Image too large: ${filePath}, ${stat.size} bytes]`, isError: false } }
      const image = await fs.readFile(filePath)
      const compressed = await compressImage({ media_type: inferMediaType(undefined, filePath), data: image.toString('base64') })
      return {
        result: { output: `[Image: ${filePath}, ${stat.size} bytes]`, isError: false, images: [compressed] },
      }
    }

    const head = await readHeadBytes(filePath, BINARY_CHECK_SIZE)
    if (containsNullBytes(head)) return { result: { output: 'Binary file, cannot display', isError: false } }
    const window = await readTextWindow(filePath, offset, limit)
    const startLine = offset + 1
    const width = String(startLine + window.lines.length).length
    const text = window.lines.map((line, index) => {
      if (/^\s*\d+\t/.test(line) && line.includes('[...line truncated:')) return line
      return `${formatLineNumber(startLine + index, width)}\t${line}`
    }).join('\n')
    const output = window.truncated ? `${text}${readMarker(stat.size)}` : text
    const complete = !window.truncated && (window.reachedEof || window.lines.length >= limit)
    return {
      result: { output, isError: false },
      ...(complete ? { effect: { kind: 'read_observation' as const, path: filePath, mtime_ms: stat.mtimeMs, offset, limit } } : {}),
    }
  } catch (error) {
    return { result: { output: `Error reading file: ${error instanceof Error ? error.message : String(error)}`, isError: true } }
  }
}

async function replacementPath(filePath: string): Promise<string> {
  const stat = await fs.lstat(filePath)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
  return stat?.isSymbolicLink() ? fs.realpath(filePath) : filePath
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const targetPath = await replacementPath(filePath)
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  const existingMode = await fs.stat(targetPath)
    .then((stat) => stat.mode & 0o777)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined
      throw error
    })
  const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.tmp`)
  trackTemporaryFile(tempPath)
  try {
    const handle = await fs.open(tempPath, 'wx')
    try {
      if (existingMode !== undefined) await handle.chmod(existingMode)
      await handle.writeFile(content, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tempPath, targetPath)
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined)
    throw error
  } finally {
    releaseTemporaryFile(tempPath)
  }
}

async function writeOperation(input: Record<string, unknown>): Promise<LocalOperationResult> {
  const filePath = asString(input, 'file_path')
  const content = asString(input, 'content')
  if (!filePath || content === undefined) return { result: { output: 'Failed to write file: file_path and content are required', isError: true } }
  try {
    await atomicWrite(filePath, content)
    return { result: { output: `Successfully wrote ${byteLength(content)} bytes to ${filePath}`, isError: false } }
  } catch (error) {
    return { result: { output: `Failed to write file: ${error instanceof Error ? error.message : String(error)}`, isError: true } }
  }
}

interface ScanResult {
  readonly count: number
  readonly lines: ReadonlyArray<number>
}

function countNewlines(value: string): number {
  let count = 0
  for (let index = 0; index < value.length; index++) if (value.charCodeAt(index) === 10) count++
  return count
}

/** First pass uses at most `oldString.length - 1` carry bytes from the file stream. */
async function scanOccurrences(filePath: string, oldString: string, stopAfterTwo: boolean): Promise<ScanResult> {
  const stream = createReadStream(filePath)
  const decoder = new StringDecoder('utf8')
  const carryLength = Math.max(0, oldString.length - 1)
  let carry = ''
  let globalBase = 0
  let lineBase = 1
  let nextAllowed = 0
  let count = 0
  const lines: number[] = []

  const process = (chunk: string, final: boolean): void => {
    const content = carry + chunk
    const maxStart = content.length - oldString.length
    const advance = final ? content.length : Math.max(0, maxStart + 1)
    if (maxStart >= 0) {
      let index = 0
      while (index <= maxStart) {
        const found = content.indexOf(oldString, index)
        if (found === -1 || found > maxStart) break
        const absolute = globalBase + found
        if (absolute >= nextAllowed) {
          count++
          if (lines.length < 200) lines.push(lineBase + countNewlines(content.slice(0, found)))
          nextAllowed = absolute + oldString.length
          if (stopAfterTwo && count > 1) return
        }
        index = found + Math.max(1, oldString.length)
      }
    }
    lineBase += countNewlines(content.slice(0, advance))
    globalBase += advance
    carry = final ? '' : content.slice(advance)
    if (!final && carry.length > carryLength) carry = carry.slice(-carryLength)
  }

  try {
    for await (const buffer of stream) {
      process(decoder.write(buffer as Buffer), false)
      if (stopAfterTwo && count > 1) break
    }
    if (!(stopAfterTwo && count > 1)) process(decoder.end(), true)
  } finally {
    stream.destroy()
  }
  return { count, lines }
}

async function transformFile(filePath: string, oldString: string, newString: string): Promise<void> {
  const targetPath = await replacementPath(filePath)
  const tempPath = path.join(path.dirname(targetPath), `.${path.basename(targetPath)}.${randomUUID()}.tmp`)
  const stream = createReadStream(targetPath)
  const decoder = new StringDecoder('utf8')
  let carry = ''
  const carryLength = Math.max(0, oldString.length - 1)
  trackTemporaryFile(tempPath)
  try {
    const handle = await fs.open(tempPath, 'wx')
    try {
      await handle.chmod((await fs.stat(targetPath)).mode & 0o777)
      const emit = async (chunk: string, final: boolean): Promise<void> => {
        const content = carry + chunk
        const maxStart = content.length - oldString.length
        const advance = final ? content.length : Math.max(0, maxStart + 1)
        let cursor = 0
        if (maxStart >= 0) {
          while (cursor <= maxStart) {
            const found = content.indexOf(oldString, cursor)
            if (found === -1 || found > maxStart) break
            await handle.writeFile(content.slice(cursor, found), 'utf8')
            await handle.writeFile(newString, 'utf8')
            cursor = found + oldString.length
          }
        }
        if (cursor < advance) await handle.writeFile(content.slice(cursor, advance), 'utf8')
        carry = final ? '' : content.slice(Math.max(advance, cursor))
        if (!final && carry.length > carryLength) carry = carry.slice(-carryLength)
      }
      for await (const buffer of stream) await emit(decoder.write(buffer as Buffer), false)
      await emit(decoder.end(), true)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await fs.rename(tempPath, targetPath)
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined)
    throw error
  } finally {
    releaseTemporaryFile(tempPath)
    stream.destroy()
  }
}

async function editOperation(input: Record<string, unknown>): Promise<LocalOperationResult> {
  const filePath = asString(input, 'file_path')
  const oldString = asString(input, 'old_string')
  const newString = asString(input, 'new_string')
  const replaceAll = input.replace_all === true
  if (!filePath || oldString === undefined || newString === undefined) return { result: { output: 'Failed to read file: file_path, old_string and new_string are required', isError: true } }
  if (oldString.length === 0) return { result: { output: 'old_string must not be empty', isError: true } }
  if (oldString === newString) return { result: { output: 'old_string must differ from new_string', isError: true } }

  let scan: ScanResult
  try {
    scan = await scanOccurrences(filePath, oldString, false)
  } catch (error) {
    return { result: { output: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`, isError: true } }
  }
  if (scan.count === 0) return { result: { output: 'old_string not found in file', isError: true } }
  if (scan.count > 1 && !replaceAll) {
    return { result: { output: `old_string found ${scan.count} times, use replace_all or provide more context`, isError: true } }
  }
  try {
    await transformFile(filePath, oldString, newString)
  } catch (error) {
    return { result: { output: `Failed to write file: ${error instanceof Error ? error.message : String(error)}`, isError: true } }
  }
  const lineList = scan.lines.join(', ')
  const suffix = scan.lines.length < scan.count ? ` (first ${scan.lines.length} shown)` : ''
  return { result: { output: `Edited ${filePath}: replaced ${scan.count} occurrence(s) at line(s) ${lineList}${suffix}`, isError: false } }
}

function addGlobCandidate(candidates: string[], value: string): void {
  if (candidates.length < MAX_GLOB_RESULTS) {
    candidates.push(value)
    candidates.sort()
    return
  }
  if (value < candidates[candidates.length - 1]) {
    candidates.push(value)
    candidates.sort()
    candidates.pop()
  }
}

async function globOperation(input: Record<string, unknown>): Promise<LocalOperationResult> {
  const pattern = asString(input, 'pattern')
  const searchRoot = asString(input, 'path')
  if (!pattern || !searchRoot) return { result: { output: 'Glob error: pattern and path are required', isError: true } }
  const { DEFAULT_EXCLUDE_GLOBS, getProtectedExcludeGlobs } = await import('./ripgrep-helper')
  const { runHostProcess } = await import('../host-process')
  const args = ['--no-config', '--no-ignore', '--hidden', '--files', '--no-messages', '--glob', pattern]
  for (const glob of DEFAULT_EXCLUDE_GLOBS) args.push('--glob', glob)
  for (const glob of getProtectedExcludeGlobs(searchRoot)) args.push('--glob', glob)
  args.push(searchRoot)

  const candidates: string[] = []
  let count = 0
  let pending = ''
  const consume = (chunk: Buffer): void => {
    pending += chunk.toString('utf8')
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      const full = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (full) {
        count++
        addGlobCandidate(candidates, relative(searchRoot, full))
      }
      newline = pending.indexOf('\n')
    }
    if (pending.length > 16 * 1024) pending = '' // filesystem path components are bounded; never retain malformed giant output.
  }
  const outcome = await runHostProcess({
    argv: [rgPath, '--max-filesize=10M', '--threads=1', ...args],
    cwd: searchRoot,
    // The outer helper owns the process group and must reap rg if it times out or dies.
    detached: false,
    captureStdout: false,
    onStdoutChunk: consume,
    limits: { timeoutMs: 60_000, stdoutBytes: 64 * 1024 * 1024, stderrBytes: 64 * 1024 },
  })
  if (pending) {
    count++
    addGlobCandidate(candidates, relative(searchRoot, pending))
  }
  if (outcome.kind === 'spawn_error') return { result: { output: `Glob error: ${outcome.message ?? 'ripgrep spawn failed'}`, isError: true } }
  if (outcome.kind === 'timed_out') {
    const content = candidates.length === 0
      ? 'Glob 搜索超时，未在时限内列出任何文件。请缩小 path 或收窄 pattern。'
      : `${candidates.join('\n')}\n[搜索超时，结果可能不完整。请用更具体的 path 缩小目录、或收窄 pattern。]`
    return { result: { output: content, isError: false } }
  }
  if (outcome.kind !== 'exit' || (outcome.exitCode === 2 && count === 0)) {
    return { result: { output: `Glob error: ${outcome.stderr.trim() || 'ripgrep exited with code 2'}`, isError: true } }
  }
  if (count === 0) return { result: { output: `No files found matching pattern: ${pattern}`, isError: false } }
  const suffix = count > MAX_GLOB_RESULTS ? `\n[...${count - MAX_GLOB_RESULTS} more results truncated]` : ''
  return { result: { output: candidates.join('\n') + suffix, isError: false } }
}

function grepTruncationHint(): string {
  return `\n[truncated: hit ${MAX_GREP_OUTPUT_BYTES} byte cap. 用 glob 收窄文件类型 / 用 path 缩小搜索目录 / 降低 head_limit / 改用 count 模式。]`
}

function formatGrepOutput(stdout: string, headLimit: number): string {
  const lines = stdout.split('\n').filter(Boolean)
  const selected: string[] = []
  let used = 0
  for (const line of lines) {
    if (selected.length >= headLimit) break
    const bytes = byteLength(line) + 1
    if (used + bytes > MAX_GREP_OUTPUT_BYTES) return selected.length === 0 ? 'No matches found' : selected.join('\n') + grepTruncationHint()
    selected.push(line)
    used += bytes
  }
  return selected.length === 0 ? 'No matches found' : selected.join('\n')
}

async function grepOperation(input: Record<string, unknown>): Promise<LocalOperationResult> {
  const pattern = asString(input, 'pattern')
  const searchRoot = asString(input, 'path')
  if (!pattern || !searchRoot) return { result: { output: 'Grep error: pattern and path are required', isError: true } }
  if (!existsSync(searchRoot)) {
    const cwd = asString(input, 'calling_cwd') ?? searchRoot
    return {
      result: {
        output: `Grep error: 搜索路径不存在：${searchRoot}（当前 cwd=${cwd}）。` +
          '若目标在别的项目目录，请先用 set_cwd 锚定到该项目，或给 path 传绝对路径。',
        isError: true,
      },
    }
  }
  try {
    new RegExp(pattern)
  } catch (error) {
    return { result: { output: `Invalid regex pattern: ${error instanceof Error ? error.message : String(error)}`, isError: true } }
  }
  const { DEFAULT_EXCLUDE_GLOBS, getProtectedExcludeGlobs, runRipgrep } = await import('./ripgrep-helper')
  const glob = asString(input, 'glob')
  const outputMode = asString(input, 'output_mode') ?? 'files_with_matches'
  const contextLines = asFiniteInteger(input.context, 0)
  const headLimit = asFiniteInteger(input.head_limit, 250)
  const args = ['--no-config', '--no-ignore', '--hidden', `--max-columns=${MAX_GREP_COLUMNS}`]
  if (glob) args.push('--glob', glob)
  for (const excluded of DEFAULT_EXCLUDE_GLOBS) args.push('--glob', excluded)
  for (const excluded of getProtectedExcludeGlobs(searchRoot)) args.push('--glob', excluded)
  if (outputMode === 'files_with_matches') args.push('--files-with-matches')
  else if (outputMode === 'count') args.push('--count')
  else {
    args.push('--line-number', '--with-filename')
    if (contextLines > 0) args.push('--context', String(contextLines))
  }
  args.push('-e', pattern, searchRoot)
  let result
  try {
    result = await runRipgrep(args, { cwd: searchRoot, maxBytes: 2 * 1024 * 1024, timeoutMs: 60_000, detached: false })
  } catch (error) {
    return { result: { output: `Grep error: ${error instanceof Error ? error.message : String(error)}`, isError: true } }
  }
  const stderr = result.stderr.trim()
  if (stderr) console.error(`[Grep] ripgrep stderr (exit=${result.exitCode}) pattern=${JSON.stringify(pattern)} path=${searchRoot}:\n${stderr}`)
  if (result.exitCode === 2 && !result.stdout) {
    return { result: { output: `Grep error: ${stderr || 'ripgrep exited with code 2'}`, isError: true } }
  }
  let output = formatGrepOutput(result.stdout, headLimit)
  if (result.truncated && !result.timedOut && !output.endsWith(grepTruncationHint())) output += grepTruncationHint()
  if (result.timedOut) output += '\n[搜索超时，结果可能不完整。请用更具体的 path / glob 缩小范围。]'
  return { result: { output, isError: false } }
}

async function readUtf8Prefix(filePath: string, limit: number): Promise<{ text: string; truncated: boolean }> {
  const handle = await fs.open(filePath, 'r')
  const decoder = new StringDecoder('utf8')
  const parts: string[] = []
  let remaining = limit
  let position = 0
  try {
    while (remaining > 0) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, remaining + 4))
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) return { text: parts.join('') + decoder.end(), truncated: false }
      position += bytesRead
      const allowed = Math.min(bytesRead, remaining)
      parts.push(decoder.write(buffer.subarray(0, allowed)))
      remaining -= allowed
      if (bytesRead > allowed) return { text: parts.join('') + decoder.end(), truncated: true }
    }
    const extra = Buffer.alloc(1)
    const { bytesRead } = await handle.read(extra, 0, 1, position)
    return { text: parts.join('') + decoder.end(), truncated: bytesRead > 0 }
  } finally {
    await handle.close()
  }
}

function stripFrontmatter(content: string): string {
  const match = content.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/)
  return match ? match[1] : content
}

async function enumerateResources(skillDir: string): Promise<ReadonlyArray<string>> {
  const result: string[] = []
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > MAX_SKILL_DEPTH || result.length >= MAX_SKILL_RESOURCES) return
    try {
      const dir = await fs.opendir(directory)
      for await (const entry of dir) {
        if (result.length >= MAX_SKILL_RESOURCES) break
        if (entry.name.startsWith('.')) continue
        const fullPath = path.join(directory, entry.name)
        if (entry.isDirectory()) await walk(fullPath, depth + 1)
        else if (entry.name !== 'SKILL.md' && entry.name !== 'skill.md') result.push(relative(skillDir, fullPath))
      }
    } catch {
      // A disappearing optional resource does not invalidate its skill content.
    }
  }
  await walk(skillDir, 0)
  return result.sort()
}

interface SkillSnapshot {
  readonly name: string
  readonly skill_dir: string
}

async function skillOperation(input: Record<string, unknown>): Promise<LocalOperationResult> {
  const raw = asString(input, 'skill') ?? ''
  const skills = Array.isArray(input.available_skills)
    ? input.available_skills.filter((value): value is SkillSnapshot => value !== null && typeof value === 'object'
      && typeof (value as Record<string, unknown>).name === 'string'
      && typeof (value as Record<string, unknown>).skill_dir === 'string')
    : []
  const names = skills.map((skill) => skill.name).sort()
  if (raw.trim() === '' || raw.trim() === 'list') {
    return { result: { output: names.length === 0 ? 'No skills available.' : `Available skills:\n${names.map((name) => `- ${name}`).join('\n')}`, isError: false } }
  }
  const requested = raw.trim().toLowerCase()
  const selected = skills.find((skill) => skill.name.toLowerCase() === requested)
  if (!selected) {
    const hint = names.length === 0 ? '' : `\nAvailable skills: ${names.join(', ')}`
    return { result: { output: `Skill not found: ${raw.trim()}${hint}`, isError: true } }
  }
  try {
    const content = await readUtf8Prefix(path.join(selected.skill_dir, 'SKILL.md'), MAX_SKILL_BYTES)
    const resources = await enumerateResources(selected.skill_dir)
    const resourceXml = resources.length === 0 ? '' : `\n<skill_resources>\n${resources.map((resource) => `  <file>${resource}</file>`).join('\n')}\n</skill_resources>`
    const truncated = content.truncated ? `\n\n[skill content truncated at ${MAX_SKILL_BYTES} bytes]` : ''
    return {
      result: {
        output: `<skill_content name="${selected.name}">\n${stripFrontmatter(content.text)}${truncated}\n\nSkill directory: ${selected.skill_dir}\nRelative paths in this skill are relative to the skill directory.${resourceXml}\n</skill_content>`,
        isError: false,
      },
    }
  } catch {
    return { result: { output: `Failed to read skill: ${selected.name}`, isError: true } }
  }
}

export async function executeLocalHostOperation(operation: LocalHostOperation, input: Record<string, unknown>): Promise<LocalOperationResult> {
  switch (operation) {
    case 'read': return readOperation(input)
    case 'write': return writeOperation(input)
    case 'edit': return editOperation(input)
    case 'glob': return globOperation(input)
    case 'grep': return grepOperation(input)
    case 'skill': return skillOperation(input)
  }
}
