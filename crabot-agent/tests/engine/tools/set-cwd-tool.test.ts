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

  it('returns a Chinese workspace orientation notice with scanned context candidates', async () => {
    fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Agent rules\n')
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Project\n')
    fs.mkdirSync(path.join(tmpDir, 'docs', 'plans'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'docs', 'CURRENT_CONTEXT.md'), '# Current\n')

    const result = await tool.call({ path: tmpDir }, {})

    expect(result.isError).toBe(false)
    expect(result.output).toContain('工作区上下文提示')
    expect(result.output).toContain('按 Crabot 默认标准扫描到以下疑似上下文候选')
    expect(result.output).toContain('[Agent 规则入口]')
    expect(result.output).toContain('- AGENTS.md')
    expect(result.output).toContain('[当前状态/交接上下文]')
    expect(result.output).toContain('- docs/CURRENT_CONTEXT.md')
    expect(result.output).toContain('[项目总览]')
    expect(result.output).toContain('- README.md')
    expect(result.output).toContain('[计划/规格]')
    expect(result.output).toContain('- docs/plans/')
    expect(result.output).toContain('未扫描到的默认候选')
    expect(result.output).toContain('workspace-context-maintenance')
    expect(result.output).toContain('不得编造项目状态')
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
    expect(result.output).not.toContain('工作区上下文提示')
    expect(cwd).toBe(tmpDir) // cwd 不变
  })
})
