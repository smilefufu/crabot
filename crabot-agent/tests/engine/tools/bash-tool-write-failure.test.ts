/**
 * Bash 截断落盘失败回退测试（spec 2026-07-21-agent-token-efficiency-design §7 点名）：
 * tmp/tool-outputs/ 写盘失败（磁盘满/权限）时回退为纯截断返回——
 * 无路径 hint、不抛错、不阻断工具执行。
 *
 * 独立文件：vi.mock('fs/promises') 是文件级 hoist，不能放进 bash-tool.test.ts
 * （会打断该文件其他用例的真实落盘断言）。仅拦截 tool-outputs 路径的 writeFile，
 * 其余 fs 调用走真实实现。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    writeFile: vi.fn(async (file: unknown, ...rest: unknown[]) => {
      if (String(file).includes(`${path.sep}tool-outputs${path.sep}`)) {
        throw new Error('ENOSPC: no space left on device')
      }
      return (actual.writeFile as (...args: unknown[]) => Promise<unknown>)(file, ...rest)
    }),
  }
})

import { createBashTool } from '../../../src/engine/tools/bash-tool'
import type { ToolCallContext } from '../../../src/engine/types'

describe('createBashTool — 截断落盘失败回退', () => {
  let tmpDataDir: string
  const cwd = os.tmpdir()

  beforeEach(() => {
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-writefail-test-'))
    process.env.CRABOT_AGENT_DATA_DIR = tmpDataDir
  })

  afterEach(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true })
    delete process.env.CRABOT_AGENT_DATA_DIR
  })

  it('落盘失败：返回纯截断文本，无 Full output 路径 hint，不抛错', async () => {
    const tool = createBashTool(() => cwd)
    const result = await tool.call(
      { command: `printf 'x%.0s' {1..60000}; echo; echo TAIL_MARKER` },
      {} as ToolCallContext,
    )
    // 不抛错、不作为 tool error
    expect(result.isError).toBe(false)
    // 纯截断：尾部保留 + 截断标记，但无落盘路径
    expect(result.output).toContain('TAIL_MARKER')
    expect(result.output).toContain('[Showing last')
    expect(result.output).toContain('bytes of')
    expect(result.output).not.toContain('Full output:')
  })
})
