import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'fs'
import { dirname, join } from 'path'
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
      const dir = dirname(fullPath)
      mkdirSync(dir, { recursive: true })
      writeFileSync(fullPath, '')
    }
  }

  it('returns correct ToolDefinition metadata', () => {
    const tool = createGlobTool(() => tempDir)

    expect(tool.name).toBe('Glob')
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
    const tool = createGlobTool(() => tempDir)

    const result = await tool.call({ pattern: '**/*.ts' }, {})

    expect(result.isError).toBe(false)
    const lines = result.output.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines).toContain(join('src', 'a.ts'))
    expect(lines).toContain(join('src', 'b.ts'))
  })

  it('respects base path', async () => {
    createFiles(['src/a.ts', 'lib/b.ts'])
    const tool = createGlobTool(() => tempDir)

    const result = await tool.call({ pattern: '**/*.ts', path: join(tempDir, 'src') }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toBe('a.ts')
  })

  it('resolves relative path against cwd', async () => {
    createFiles(['sub/dir/file.ts'])
    const tool = createGlobTool(() => tempDir)

    const result = await tool.call({ pattern: '*.ts', path: 'sub/dir' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toBe('file.ts')
  })

  it.each(['src/*.ts', 'src/**/*.ts'])('anchors directory-qualified pattern %s to the search base', async (pattern) => {
    createFiles(['src/a.ts', 'src/b.ts', 'other/src/unrelated.ts'])
    const tool = createGlobTool(() => tempDir)

    const result = await tool.call({ pattern }, {})

    expect(result.isError).toBe(false)
    expect(result.output.split('\n')).toEqual([join('src', 'a.ts'), join('src', 'b.ts')])
  })

  it('anchors a pattern to an explicit base outside the worker cwd', async () => {
    createFiles(['project/logs/authorized/result.json', 'worker/placeholder.txt'])
    const tool = createGlobTool(() => join(tempDir, 'worker'))

    const result = await tool.call({ pattern: 'authorized/*', path: '../project/logs' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toBe(join('authorized', 'result.json'))
  })

  it('ignores node_modules and .git', async () => {
    createFiles([
      'src/a.ts',
      'node_modules/pkg/index.ts',
      '.git/objects/abc',
    ])
    const tool = createGlobTool(() => tempDir)

    const result = await tool.call({ pattern: '**/*' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toBe(join('src', 'a.ts'))
  })

  it('returns "No files found" for no matches', async () => {
    const tool = createGlobTool(() => tempDir)

    const result = await tool.call({ pattern: '**/*.xyz' }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toBe('No files found matching pattern: **/*.xyz')
  })

  it('sorts results alphabetically', async () => {
    createFiles(['z.ts', 'a.ts', 'm.ts', 'b.ts'])
    const tool = createGlobTool(() => tempDir)

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
    const tool = createGlobTool(() => tempDir)

    const result = await tool.call({ pattern: '**/*.ts' }, {})

    expect(result.isError).toBe(false)
    const lines = result.output.split('\n')
    // 200 file lines + 1 truncation message
    expect(lines).toHaveLength(201)
    expect(lines[200]).toBe('[...10 more results truncated]')
  })

  it.skipIf(process.platform === 'win32')('某子目录权限被拒（rg 退出码 2）但有结果时，返回 partial 而非整体报错', async () => {
    // root 绕过权限位，无法构造 EACCES，跳过。
    if (typeof process.getuid === 'function' && process.getuid() === 0) return

    createFiles(['src/a.ts', 'src/b.ts'])
    // 0o000 目录：owner 也无法 traverse → rg 对它 EACCES → 退出码 2，
    // 但 src/*.ts 已经在 stdout 里列出。
    const locked = join(tempDir, 'locked')
    mkdirSync(locked, { recursive: true })
    chmodSync(locked, 0o000)

    try {
      const tool = createGlobTool(() => tempDir)
      const result = await tool.call({ pattern: '**/*.ts' }, {})

      // 关键：不因 locked 目录的 EACCES 整体判错，已搜到的文件照常返回。
      expect(result.isError).toBe(false)
      const lines = result.output.split('\n')
      expect(lines).toContain(join('src', 'a.ts'))
      expect(lines).toContain(join('src', 'b.ts'))
    } finally {
      // 还原权限，否则 afterEach 的 rmSync 删不掉。
      chmodSync(locked, 0o755)
    }
  })
})
