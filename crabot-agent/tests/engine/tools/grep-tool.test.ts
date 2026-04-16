import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createGrepTool } from '../../../src/engine/tools/grep-tool'
import type { ToolDefinition } from '../../../src/engine/types'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('createGrepTool', () => {
  let tmpDir: string
  let tool: ToolDefinition

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-tool-test-'))
    tool = createGrepTool(tmpDir)

    // Create test file structure
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, 'node_modules', 'pkg'), { recursive: true })
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true })

    fs.writeFileSync(
      path.join(tmpDir, 'src', 'hello.ts'),
      'const greeting = "hello world"\nconst farewell = "goodbye"\nexport { greeting, farewell }\n'
    )
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'utils.ts'),
      'export function hello() {\n  return "hello"\n}\n\nexport function world() {\n  return "world"\n}\n'
    )
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'readme.md'),
      '# Hello\n\nThis is a hello world project.\n'
    )
    fs.writeFileSync(
      path.join(tmpDir, 'node_modules', 'pkg', 'index.js'),
      'const hello = "should be skipped"\n'
    )
    fs.writeFileSync(
      path.join(tmpDir, '.git', 'config'),
      'hello = should be skipped\n'
    )
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns correct ToolDefinition metadata', () => {
    expect(tool.name).toBe('Grep')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.permissionLevel).toBe('safe')
    expect(tool.inputSchema).toBeDefined()
    expect(typeof tool.call).toBe('function')
  })

  it('finds matches in files_with_matches mode', async () => {
    const result = await tool.call({ pattern: 'hello' }, {})

    expect(result.isError).toBe(false)
    const lines = result.output.trim().split('\n')
    const normalized = lines.map((l) => l.replace(tmpDir + '/', ''))
    expect(normalized).toContain('src/hello.ts')
    expect(normalized).toContain('src/utils.ts')
    expect(normalized).toContain('src/readme.md')
    // Should not include node_modules or .git
    expect(result.output).not.toContain('node_modules')
    expect(result.output).not.toContain('.git')
  })

  it('shows content with line numbers in content mode', async () => {
    const result = await tool.call(
      { pattern: 'greeting', output_mode: 'content' },
      {}
    )

    expect(result.isError).toBe(false)
    // Should contain path:line_number:content format
    expect(result.output).toContain(':1:')
    expect(result.output).toContain('greeting')
    expect(result.output).toContain('hello.ts')
  })

  it('shows match counts in count mode', async () => {
    const result = await tool.call(
      { pattern: 'hello', output_mode: 'count' },
      {}
    )

    expect(result.isError).toBe(false)
    const lines = result.output.trim().split('\n')
    // Each line should end with :count format (path:count)
    for (const line of lines) {
      expect(line).toMatch(/:\d+$/)
    }
    // Verify we found hello in at least the expected files
    expect(lines.length).toBeGreaterThanOrEqual(2)
  })

  it('supports context lines', async () => {
    const result = await tool.call(
      { pattern: 'farewell', output_mode: 'content', context: 1 },
      {}
    )

    expect(result.isError).toBe(false)
    // Should include the line before and after the match
    expect(result.output).toContain('hello world')
    expect(result.output).toContain('farewell')
    expect(result.output).toContain('export')
  })

  it('filters by glob pattern', async () => {
    const result = await tool.call(
      { pattern: 'hello', glob: '*.ts' },
      {}
    )

    expect(result.isError).toBe(false)
    const lines = result.output.trim().split('\n')
    const normalized = lines.map((l) => l.replace(tmpDir + '/', ''))
    expect(normalized).toContain('src/hello.ts')
    expect(normalized).toContain('src/utils.ts')
    // Should NOT include .md file
    expect(result.output).not.toContain('readme.md')
  })

  it('skips binary files', async () => {
    // Create a binary file with null bytes
    const binaryContent = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x68, 0x65, 0x6c, 0x6c, 0x6f])
    fs.writeFileSync(path.join(tmpDir, 'src', 'image.png'), binaryContent)

    const result = await tool.call({ pattern: 'hello' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).not.toContain('image.png')
  })

  it('returns "No matches found" for no matches', async () => {
    const result = await tool.call({ pattern: 'zzz_nonexistent_zzz' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toBe('No matches found')
  })

  it('respects head_limit', async () => {
    const result = await tool.call(
      { pattern: 'hello', head_limit: 1 },
      {}
    )

    expect(result.isError).toBe(false)
    const lines = result.output.trim().split('\n')
    expect(lines).toHaveLength(1)
  })

  it('uses path parameter to narrow search directory', async () => {
    fs.mkdirSync(path.join(tmpDir, 'other'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, 'other', 'data.txt'),
      'hello from other\n'
    )

    const result = await tool.call(
      { pattern: 'hello', path: path.join(tmpDir, 'other') },
      {}
    )

    expect(result.isError).toBe(false)
    const lines = result.output.trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(result.output).toContain('data.txt')
  })

  it('returns error for invalid regex pattern', async () => {
    const result = await tool.call({ pattern: '[invalid' }, {})

    expect(result.isError).toBe(true)
    expect(result.output).toContain('Invalid regex')
  })
})
