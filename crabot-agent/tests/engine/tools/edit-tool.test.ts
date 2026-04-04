import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createEditTool } from '../../../src/engine/tools/edit-tool'

describe('createEditTool', () => {
  let tempDir: string
  const context = {}

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'edit-tool-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function writeTestFile(name: string, content: string): string {
    const filePath = join(tempDir, name)
    writeFileSync(filePath, content, 'utf-8')
    return filePath
  }

  it('returns correct ToolDefinition metadata', () => {
    const tool = createEditTool(tempDir)

    expect(tool.name).toBe('Edit')
    expect(tool.isReadOnly).toBe(false)
    expect(tool.permissionLevel).toBe('normal')
    expect(tool.inputSchema).toMatchObject({
      type: 'object',
      required: ['file_path', 'old_string', 'new_string'],
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
    })
  })

  it('replaces a unique string', async () => {
    const filePath = writeTestFile('test.txt', 'hello world\ngoodbye world\n')
    const tool = createEditTool(tempDir)

    const result = await tool.call(
      { file_path: filePath, old_string: 'hello world', new_string: 'hi world' },
      context,
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('1 occurrence')
    expect(result.output).toContain('line(s) 1')
    expect(readFileSync(filePath, 'utf-8')).toBe('hi world\ngoodbye world\n')
  })

  it('returns error when old_string not found', async () => {
    const filePath = writeTestFile('test.txt', 'hello world\n')
    const tool = createEditTool(tempDir)

    const result = await tool.call(
      { file_path: filePath, old_string: 'not here', new_string: 'replacement' },
      context,
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('old_string not found in file')
  })

  it('returns error when old_string found multiple times without replace_all', async () => {
    const filePath = writeTestFile('test.txt', 'aaa\nbbb\naaa\nccc\naaa\n')
    const tool = createEditTool(tempDir)

    const result = await tool.call(
      { file_path: filePath, old_string: 'aaa', new_string: 'zzz' },
      context,
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('3 times')
    expect(result.output).toContain('replace_all')
    // File should be unchanged
    expect(readFileSync(filePath, 'utf-8')).toBe('aaa\nbbb\naaa\nccc\naaa\n')
  })

  it('replace_all=true replaces all occurrences', async () => {
    const filePath = writeTestFile('test.txt', 'aaa\nbbb\naaa\nccc\naaa\n')
    const tool = createEditTool(tempDir)

    const result = await tool.call(
      { file_path: filePath, old_string: 'aaa', new_string: 'zzz', replace_all: true },
      context,
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('3 occurrence(s)')
    expect(result.output).toContain('line(s) 1, 3, 5')
    expect(readFileSync(filePath, 'utf-8')).toBe('zzz\nbbb\nzzz\nccc\nzzz\n')
  })

  it('returns error when old_string === new_string', async () => {
    const filePath = writeTestFile('test.txt', 'hello world\n')
    const tool = createEditTool(tempDir)

    const result = await tool.call(
      { file_path: filePath, old_string: 'hello', new_string: 'hello' },
      context,
    )

    expect(result.isError).toBe(true)
    expect(result.output).toContain('old_string must differ from new_string')
  })

  it('reports correct line numbers', async () => {
    const filePath = writeTestFile('test.txt', 'line1\nline2\ntarget\nline4\nline5\ntarget\n')
    const tool = createEditTool(tempDir)

    const result = await tool.call(
      { file_path: filePath, old_string: 'target', new_string: 'replaced', replace_all: true },
      context,
    )

    expect(result.isError).toBe(false)
    expect(result.output).toContain('line(s) 3, 6')
  })

  it('resolves relative file paths against cwd', async () => {
    writeTestFile('relative.txt', 'old content\n')
    const tool = createEditTool(tempDir)

    const result = await tool.call(
      { file_path: 'relative.txt', old_string: 'old content', new_string: 'new content' },
      context,
    )

    expect(result.isError).toBe(false)
    expect(readFileSync(join(tempDir, 'relative.txt'), 'utf-8')).toBe('new content\n')
  })
})
