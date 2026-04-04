import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { createWriteTool } from '../../../src/engine/tools/write-tool'

describe('createWriteTool', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-tool-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('returns correct ToolDefinition metadata', () => {
    const tool = createWriteTool(tmpDir)

    expect(tool.name).toBe('Write')
    expect(tool.description).toBeTypeOf('string')
    expect(tool.description.length).toBeGreaterThan(0)
    expect(tool.isReadOnly).toBe(false)
    expect(tool.permissionLevel).toBe('normal')
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: {
        file_path: { type: 'string', description: expect.any(String) },
        content: { type: 'string', description: expect.any(String) },
      },
      required: ['file_path', 'content'],
    })
  })

  it('writes a new file', async () => {
    const tool = createWriteTool(tmpDir)
    const filePath = path.join(tmpDir, 'hello.txt')

    const result = await tool.call(
      { file_path: filePath, content: 'Hello, world!' },
      {}
    )

    expect(result.isError).toBe(false)
    const written = await fs.readFile(filePath, 'utf-8')
    expect(written).toBe('Hello, world!')
  })

  it('overwrites existing file', async () => {
    const filePath = path.join(tmpDir, 'existing.txt')
    await fs.writeFile(filePath, 'old content', 'utf-8')

    const tool = createWriteTool(tmpDir)
    const result = await tool.call(
      { file_path: filePath, content: 'new content' },
      {}
    )

    expect(result.isError).toBe(false)
    const written = await fs.readFile(filePath, 'utf-8')
    expect(written).toBe('new content')
  })

  it('creates parent directories automatically', async () => {
    const tool = createWriteTool(tmpDir)
    const filePath = path.join(tmpDir, 'a', 'b', 'c', 'deep.txt')

    const result = await tool.call(
      { file_path: filePath, content: 'deep file' },
      {}
    )

    expect(result.isError).toBe(false)
    const written = await fs.readFile(filePath, 'utf-8')
    expect(written).toBe('deep file')
  })

  it('handles empty content', async () => {
    const tool = createWriteTool(tmpDir)
    const filePath = path.join(tmpDir, 'empty.txt')

    const result = await tool.call(
      { file_path: filePath, content: '' },
      {}
    )

    expect(result.isError).toBe(false)
    const written = await fs.readFile(filePath, 'utf-8')
    expect(written).toBe('')
  })

  it('returns byte count in success message', async () => {
    const tool = createWriteTool(tmpDir)
    const content = 'Hello, world!'
    const filePath = path.join(tmpDir, 'bytes.txt')

    const result = await tool.call(
      { file_path: filePath, content },
      {}
    )

    const expectedBytes = Buffer.byteLength(content, 'utf-8')
    expect(result.output).toContain(`${expectedBytes} bytes`)
    expect(result.output).toContain(filePath)
  })

  it('resolves relative paths against cwd', async () => {
    const tool = createWriteTool(tmpDir)

    const result = await tool.call(
      { file_path: 'relative/file.txt', content: 'relative test' },
      {}
    )

    expect(result.isError).toBe(false)
    const filePath = path.join(tmpDir, 'relative', 'file.txt')
    const written = await fs.readFile(filePath, 'utf-8')
    expect(written).toBe('relative test')
  })
})
