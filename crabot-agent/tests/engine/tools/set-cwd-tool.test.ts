import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSetCwdTool } from '../../../src/engine/tools/set-cwd-tool'
import type { ToolDefinition } from '../../../src/engine/types'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

describe('createSetCwdTool', () => {
  let tmpDir: string
  let cwd: string
  let tool: ToolDefinition

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'set-cwd-test-'))
    cwd = tmpDir
    tool = createSetCwdTool({
      getCwd: () => cwd,
      setCwd: (next) => { cwd = next },
    })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('switches cwd to an absolute existing directory', async () => {
    const result = await tool.call({ path: tmpDir }, {})
    expect(result.isError).toBe(false)
    expect(cwd).toBe(tmpDir)
  })

  it('resolves a relative path against the current cwd', async () => {
    fs.mkdirSync(path.join(tmpDir, 'sub'), { recursive: true })
    const result = await tool.call({ path: 'sub' }, {})
    expect(result.isError).toBe(false)
    expect(cwd).toBe(path.join(tmpDir, 'sub'))
  })

  // 复现 m2u 现场：agent 传 `~/codes/...`，旧实现把字面量 `~` 拼进 cwd
  // → `/Users/fufu/~/codes/...` → ENOENT。修复后 `~` 应展开到 homedir。
  it('expands a bare ~ to the home directory', async () => {
    const result = await tool.call({ path: '~' }, {})
    expect(result.isError).toBe(false)
    expect(cwd).toBe(os.homedir())
  })

  it('expands a leading ~/ to the home directory (no literal ~ in resolved path)', async () => {
    const result = await tool.call({ path: '~/__definitely_missing_dir__' }, {})
    // 路径不存在会失败，但失败信息里必须是展开后的绝对路径，不能含字面量 `~`
    expect(result.isError).toBe(true)
    expect(result.output).toContain(path.join(os.homedir(), '__definitely_missing_dir__'))
    expect(result.output).not.toContain('/~/')
  })

  it('reports an error for a non-existent path', async () => {
    const missing = path.join(tmpDir, 'nope')
    const result = await tool.call({ path: missing }, {})
    expect(result.isError).toBe(true)
    expect(result.output).toContain('set_cwd failed')
    expect(cwd).toBe(tmpDir) // cwd 不变
  })
})
