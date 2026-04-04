import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createGlobTool } from '../../../src/engine/tools/glob-tool'

describe('createGlobTool', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'glob-tool-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  function createFiles(paths: ReadonlyArray<string>): void {
    for (const p of paths) {
      const fullPath = join(tempDir, p)
      const dir = fullPath.substring(0, fullPath.lastIndexOf('/'))
      mkdirSync(dir, { recursive: true })
      writeFileSync(fullPath, '')
    }
  }

  it('returns correct ToolDefinition metadata', () => {
    const tool = createGlobTool(tempDir)

    expect(tool.name).toBe('glob')
    expect(tool.description).toContain('file')
    expect(tool.isReadOnly).toBe(true)
    expect(tool.permissionLevel).toBe('safe')
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: {
        pattern: { type: 'string', description: expect.any(String) },
        path: { type: 'string', description: expect.any(String) },
      },
      required: ['pattern'],
    })
  })

  it('finds files matching pattern', async () => {
    createFiles(['src/a.ts', 'src/b.ts', 'src/c.js'])
    const tool = createGlobTool(tempDir)

    const result = await tool.call({ pattern: '**/*.ts' }, {})

    expect(result.isError).toBe(false)
    const lines = result.output.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines).toContain('src/a.ts')
    expect(lines).toContain('src/b.ts')
  })

  it('respects base path', async () => {
    createFiles(['src/a.ts', 'lib/b.ts'])
    const tool = createGlobTool(tempDir)

    const result = await tool.call({ pattern: '**/*.ts', path: join(tempDir, 'src') }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toBe('a.ts')
  })

  it('resolves relative path against cwd', async () => {
    createFiles(['sub/dir/file.ts'])
    const tool = createGlobTool(tempDir)

    const result = await tool.call({ pattern: '*.ts', path: 'sub/dir' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toBe('file.ts')
  })

  it('ignores node_modules and .git', async () => {
    createFiles([
      'src/a.ts',
      'node_modules/pkg/index.ts',
      '.git/objects/abc',
    ])
    const tool = createGlobTool(tempDir)

    const result = await tool.call({ pattern: '**/*' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toBe('src/a.ts')
  })

  it('returns "No files found" for no matches', async () => {
    const tool = createGlobTool(tempDir)

    const result = await tool.call({ pattern: '**/*.xyz' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toBe('No files found matching pattern: **/*.xyz')
  })

  it('sorts results alphabetically', async () => {
    createFiles(['z.ts', 'a.ts', 'm.ts', 'b.ts'])
    const tool = createGlobTool(tempDir)

    const result = await tool.call({ pattern: '**/*.ts' }, {})

    expect(result.isError).toBe(false)
    const lines = result.output.split('\n')
    expect(lines).toEqual(['a.ts', 'b.ts', 'm.ts', 'z.ts'])
  })

  it('limits results to 200 and shows truncation message', async () => {
    const files = Array.from({ length: 210 }, (_, i) =>
      `file-${String(i).padStart(4, '0')}.ts`
    )
    createFiles(files)
    const tool = createGlobTool(tempDir)

    const result = await tool.call({ pattern: '**/*.ts' }, {})

    expect(result.isError).toBe(false)
    const lines = result.output.split('\n')
    // 200 file lines + 1 truncation message
    expect(lines).toHaveLength(201)
    expect(lines[200]).toBe('[...10 more results truncated]')
  })
})
