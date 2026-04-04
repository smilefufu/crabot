import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createReadTool } from '../../../src/engine/tools/read-tool'

describe('createReadTool', () => {
  let tmpDir: string
  let tool: ReturnType<typeof createReadTool>

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'read-tool-test-'))
    tool = createReadTool(tmpDir)
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
    expect(result.isError).toBe(true)
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

  it('truncates files larger than 500KB', async () => {
    const filePath = path.join(tmpDir, 'large.txt')
    // Create a file slightly over 500KB
    const lineContent = 'x'.repeat(100) + '\n'
    const lineCount = Math.ceil((500 * 1024 + 1000) / lineContent.length)
    const content = lineContent.repeat(lineCount)
    await fs.writeFile(filePath, content)

    const result = await tool.call({ file_path: filePath }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('[...truncated')
  })
})
