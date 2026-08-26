import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createReadTool } from '../../../src/engine/tools/read-tool'
import { FILE_UNCHANGED_STUB } from '../../../src/engine/tools/file-read-state'
import type { FileReadState } from '../../../src/engine/tools/file-read-state'

describe('createReadTool', () => {
  let tmpDir: string
  let tool: ReturnType<typeof createReadTool>

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-tool-test-'))
    tool = createReadTool(() => tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns correct ToolDefinition metadata', () => {
    expect(tool.name).toBe('Read')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.permissionLevel).toBe('safe')
    expect(tool.inputSchema).toHaveProperty('properties')
    expect(tool.description).toBeTruthy()
  })

  it('reads a text file with line numbers', async () => {
    const filePath = path.join(tmpDir, 'hello.txt')
    await fs.writeFile(filePath, 'line one\nline two\nline three\n')

    const result = await tool.call({ file_path: filePath }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('1\tline one')
    expect(result.output).toContain('2\tline two')
    expect(result.output).toContain('3\tline three')
  })

  it('supports offset and limit', async () => {
    const filePath = path.join(tmpDir, 'multi.txt')
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
    await fs.writeFile(filePath, lines.join('\n'))

    const result = await tool.call({ file_path: filePath, offset: 3, limit: 2 }, {})
    expect(result.isError).toBe(false)
    // offset=3 means start at 0-based index 3 → line 4
    expect(result.output).toContain('4\tline 4')
    expect(result.output).toContain('5\tline 5')
    expect(result.output).not.toContain('3\tline 3')
    expect(result.output).not.toContain('6\tline 6')
  })

  it('负数 offset 归一化为 0（与流式路径行为一致，不再从尾部数）', async () => {
    const filePath = path.join(tmpDir, 'neg-offset.txt')
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
    await fs.writeFile(filePath, lines.join('\n'))

    const result = await tool.call({ file_path: filePath, offset: -3, limit: 2 }, {})
    expect(result.isError).toBe(false)
    // 归一化为 offset=0 → 从第 1 行开始，而非 slice(-3) 的尾部 3 行
    expect(result.output).toContain('1\tline 1')
    expect(result.output).toContain('2\tline 2')
    expect(result.output).not.toContain('line 10')
  })

  it('小数 offset 归一化为向下取整的整数', async () => {
    const filePath = path.join(tmpDir, 'frac-offset.txt')
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
    await fs.writeFile(filePath, lines.join('\n'))

    const result = await tool.call({ file_path: filePath, offset: 3.7, limit: 2 }, {})
    expect(result.isError).toBe(false)
    // floor(3.7)=3 → 从第 4 行开始（流式与非流式路径一致）
    expect(result.output).toContain('4\tline 4')
    expect(result.output).toContain('5\tline 5')
    expect(result.output).not.toContain('3\tline 3')
  })

  it('returns error for non-existent file', async () => {
    const filePath = path.join(tmpDir, 'does-not-exist.txt')
    const result = await tool.call({ file_path: filePath }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('ENOENT')
  })

  it('detects binary files', async () => {
    const filePath = path.join(tmpDir, 'binary.bin')
    const buf = Buffer.alloc(100)
    buf[50] = 0x00 // null byte
    buf.fill(0x41, 0, 50) // 'A' before null
    buf.fill(0x42, 51) // 'B' after null
    await fs.writeFile(filePath, buf)

    const result = await tool.call({ file_path: filePath }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Binary file')
  })

  it('handles empty files', async () => {
    const filePath = path.join(tmpDir, 'empty.txt')
    await fs.writeFile(filePath, '')

    const result = await tool.call({ file_path: filePath }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toBe('')
  })

  it('resolves relative paths against cwd', async () => {
    const filePath = path.join(tmpDir, 'relative.txt')
    await fs.writeFile(filePath, 'content here\n')

    const result = await tool.call({ file_path: 'relative.txt' }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('1\tcontent here')
  })

  it('caps a single response at 50KB for large files', async () => {
    const filePath = path.join(tmpDir, 'large.txt')
    // Create a file slightly over 500KB
    const lineContent = 'x'.repeat(100) + '\n'
    const lineCount = Math.ceil((500 * 1024 + 1000) / lineContent.length)
    const content = lineContent.repeat(lineCount)
    await fs.writeFile(filePath, content)

    const result = await tool.call({ file_path: filePath }, {})
    expect(result.isError).toBe(false)
    // 单次返回字节上限 50KB（截断标记除外，留余量）
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(50 * 1024 + 200)
    // 截断提示引导 offset 续读
    expect(result.output).toContain('[...truncated')
    expect(result.output).toContain('offset')
  })

  it('keeps the 50KB budget when an oversized line follows normal output', async () => {
    const filePath = path.join(tmpDir, 'normal-then-oversized.txt')
    const prefix = Array.from({ length: 350 }, (_, index) => `row-${index}-${'x'.repeat(120)}`)
    const oversized = 'y'.repeat(60 * 1024)
    await fs.writeFile(filePath, [...prefix, oversized, 'afterwards'].join('\n'))

    const result = await tool.call({ file_path: filePath }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('1\trow-0-')
    expect(result.output).not.toContain('y'.repeat(100))
    expect(result.output).toContain('[...truncated')
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(52 * 1024)
  })

  it('reads the tail of a >500KB file via offset (no more 500KB hard cap)', async () => {
    const filePath = path.join(tmpDir, 'paged.txt')
    // 8000 行 × ~90B ≈ 700KB，超过旧的 500KB 硬上限
    const lines = Array.from({ length: 8000 }, (_, i) => `line-${i + 1}-${'y'.repeat(80)}`)
    await fs.writeFile(filePath, lines.join('\n') + '\n')

    const result = await tool.call({ file_path: filePath, offset: 7900, limit: 100 }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('8000\tline-8000-')
    expect(result.output).toContain('7901\tline-7901-')
    // 尾部完整读到了，不是截断视图
    expect(result.output).not.toContain('[...truncated')
  })

  it('单行超 50KB 时降级为行内截断（不返回空内容，可 bash 续读）', async () => {
    const filePath = path.join(tmpDir, 'minified.js')
    const bigLine = 'a'.repeat(60 * 1024) // 单行 60KB，超 MAX_OUTPUT_BYTES
    await fs.writeFile(filePath, bigLine + '\n' + 'second line\n')

    const result = await tool.call({ file_path: filePath }, {})
    expect(result.isError).toBe(false)
    // 行内容真的返回了前 ~50KB，而不是空
    expect(result.output).toContain(`1\t${'a'.repeat(100)}`)
    expect(result.output).toContain('[...line truncated')
    expect(result.output).toContain('60-byte line'.replace('60', String(60 * 1024)))
    // 行内续读提示指向正确的行号和文件
    expect(result.output).toContain(`sed -n '1p' '${filePath}'`)
  })

  it('流式路径下单行超 50KB 同样降级为行内截断', async () => {
    const filePath = path.join(tmpDir, 'huge-longline.log')
    // 首行 60KB + 13MB filler（走流式路径），第一行就超单次上限
    const bigLine = 'b'.repeat(60 * 1024)
    const filler = Array.from({ length: 150000 }, (_, i) => `row-${i}-${'z'.repeat(80)}`)
    await fs.writeFile(filePath, [bigLine, ...filler].join('\n') + '\n')

    const result = await tool.call({ file_path: filePath, limit: 10 }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('b'.repeat(100))
    expect(result.output).toContain('[...line truncated')
    expect(result.output).toContain(`sed -n '1p' '${filePath}'`)
  })

  it('为探测窗口内的超长单行报告精确长度', async () => {
    const filePath = path.join(tmpDir, 'probed-longline.log')
    const bigLine = 'c'.repeat(192 * 1024)
    await fs.writeFile(filePath, bigLine + '\nnext line\n')

    const result = await tool.call({ file_path: filePath }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('196608-byte line')
    expect(result.output).not.toContain('at least')
  })

  it('对 128 MiB 无换行文件只做有界长度探测', async () => {
    const filePath = path.join(tmpDir, 'single-128m-line.log')
    const handle = await fs.open(filePath, 'w')
    try {
      const chunk = Buffer.alloc(1024 * 1024, 'x')
      for (let index = 0; index < 128; index++) await handle.write(chunk)
    } finally {
      await handle.close()
    }

    const result = await tool.call({ file_path: filePath }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('at least 313344 bytes of the line before its end')
    expect(Buffer.byteLength(result.output, 'utf8')).toBeLessThanOrEqual(52 * 1024)
  })

  it('streams >10MB files line-by-line and can reach the tail via offset', async () => {
    const filePath = path.join(tmpDir, 'huge.txt')
    // 150000 行 × ~90B ≈ 13MB，走流式按行定位路径
    const lines = Array.from({ length: 150000 }, (_, i) => `row-${i + 1}-${'z'.repeat(80)}`)
    await fs.writeFile(filePath, lines.join('\n') + '\n')

    const tail = await tool.call({ file_path: filePath, offset: 149900, limit: 100 }, {})
    expect(tail.isError).toBe(false)
    expect(tail.output).toContain('150000\trow-150000-')
    expect(tail.output).not.toContain('[...truncated')

    // 从头读同样受 50KB 单次上限约束
    const head = await tool.call({ file_path: filePath }, {})
    expect(head.isError).toBe(false)
    expect(Buffer.byteLength(head.output, 'utf8')).toBeLessThanOrEqual(50 * 1024 + 200)
    expect(head.output).toContain('[...truncated')
  })

  it('returns image data for image files', async () => {
    const filePath = path.join(tmpDir, 'photo.png')
    // 1x1 red PNG
    const pngData = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    )
    await fs.writeFile(filePath, pngData)

    const result = await tool.call({ file_path: filePath }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('[Image:')
    expect(result.images).toBeDefined()
    expect(result.images!.length).toBe(1)
    // compressImage may convert to image/jpeg if sharp is available
    expect(['image/png', 'image/jpeg']).toContain(result.images![0].media_type)
    expect(result.images![0].data).toBeTruthy()
  })

  it('returns image data for jpg files', async () => {
    const filePath = path.join(tmpDir, 'photo.jpg')
    await fs.writeFile(filePath, Buffer.alloc(100, 0xFF))

    const result = await tool.call({ file_path: filePath }, {})
    expect(result.isError).toBe(false)
    expect(result.images).toBeDefined()
    expect(result.images![0].media_type).toBe('image/jpeg')
  })

  it('returns display-only result for non-image binary files', async () => {
    const filePath = path.join(tmpDir, 'data.bin')
    const buf = Buffer.alloc(100)
    buf[50] = 0x00
    buf.fill(0x41, 0, 50)
    buf.fill(0x42, 51)
    await fs.writeFile(filePath, buf)

    const result = await tool.call({ file_path: filePath }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('Binary file')
    expect(result.images).toBeUndefined()
  })
})

describe('createReadTool — read dedup', () => {
  let tmpDir: string
  let state: FileReadState
  let tool: ReturnType<typeof createReadTool>

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-dedup-test-'))
    state = new Map()
    tool = createReadTool(() => tmpDir, state)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns full content on first read, stub on identical second read', async () => {
    const filePath = path.join(tmpDir, 'a.txt')
    await fs.writeFile(filePath, 'line one\nline two\n')

    const first = await tool.call({ file_path: filePath }, {})
    expect(first.isError).toBe(false)
    expect(first.output).toContain('1\tline one')

    const second = await tool.call({ file_path: filePath }, {})
    expect(second.isError).toBe(false)
    expect(second.output).toBe(FILE_UNCHANGED_STUB)
  })

  it('re-reads full content after the file changes on disk (mtime bump)', async () => {
    const filePath = path.join(tmpDir, 'b.txt')
    await fs.writeFile(filePath, 'original\n')
    await tool.call({ file_path: filePath }, {})

    // 改文件并显式把 mtime 推到将来，确保 mtime 变化（避免同毫秒写入测不出）
    await fs.writeFile(filePath, 'changed\n')
    const future = new Date(Date.now() + 5000)
    await fs.utimes(filePath, future, future)

    const after = await tool.call({ file_path: filePath }, {})
    expect(after.isError).toBe(false)
    expect(after.output).toContain('1\tchanged')
  })

  it('does not stub a different offset/limit range', async () => {
    const filePath = path.join(tmpDir, 'c.txt')
    await fs.writeFile(filePath, Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'))
    await tool.call({ file_path: filePath }, {})

    const other = await tool.call({ file_path: filePath, offset: 2, limit: 2 }, {})
    expect(other.output).not.toBe(FILE_UNCHANGED_STUB)
    expect(other.output).toContain('3\tline 3')
  })

  it('without a state map (subagent path), never stubs — always full read', async () => {
    const plain = createReadTool(() => tmpDir)
    const filePath = path.join(tmpDir, 'd.txt')
    await fs.writeFile(filePath, 'hello\n')

    const r1 = await plain.call({ file_path: filePath }, {})
    const r2 = await plain.call({ file_path: filePath }, {})
    expect(r1.output).toContain('1\thello')
    expect(r2.output).toContain('1\thello')
    expect(r2.output).not.toBe(FILE_UNCHANGED_STUB)
  })

  it('byte-capped (partial) reads never stub and do not poison the cache', async () => {
    const filePath = path.join(tmpDir, 'big.txt')
    // ~264KB，默认 limit 下超 50KB 单次上限 → 部分视图
    const lines = Array.from({ length: 3000 }, (_, i) => `row-${i + 1}-${'q'.repeat(80)}`)
    await fs.writeFile(filePath, lines.join('\n') + '\n')

    const first = await tool.call({ file_path: filePath }, {})
    expect(first.output).toContain('[...truncated')

    // 部分视图不进 dedup 缓存：第二次相同读取仍返回内容，不是 stub
    const second = await tool.call({ file_path: filePath }, {})
    expect(second.output).not.toBe(FILE_UNCHANGED_STUB)
    expect(second.output).toContain('[...truncated')
    expect(second.output).toContain('1\trow-1-')
  })
})
