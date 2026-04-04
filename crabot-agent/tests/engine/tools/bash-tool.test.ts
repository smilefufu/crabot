import { describe, it, expect } from 'vitest'
import { createBashTool } from '../../../src/engine/tools/bash-tool'
import * as os from 'os'
import * as fs from 'fs'
import * as path from 'path'
import type { ToolCallContext } from '../../../src/engine/types'

describe('createBashTool', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-tool-test-'))
  const tool = createBashTool(tmpDir)

  it('returns ToolDefinition with correct name and schema', () => {
    expect(tool.name).toBe('Bash')
    expect(tool.isReadOnly).toBe(false)
    expect(tool.permissionLevel).toBe('dangerous')
    expect(tool.inputSchema).toEqual({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute' },
        timeout: { type: 'number', description: 'Timeout in milliseconds (default 120000)' },
      },
      required: ['command'],
    })
  })

  it('executes simple command', async () => {
    const result = await tool.call({ command: 'echo hello' }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('hello')
  })

  it('captures stderr', async () => {
    const result = await tool.call({ command: 'echo err >&2' }, {})
    expect(result.isError).toBe(false)
    expect(result.output).toContain('err')
  })

  it('returns error for failing command', async () => {
    const result = await tool.call({ command: 'exit 1' }, {})
    expect(result.isError).toBe(true)
  })

  it('respects cwd', async () => {
    const result = await tool.call({ command: 'pwd' }, {})
    expect(result.isError).toBe(false)
    // Resolve symlinks (macOS /tmp -> /private/tmp)
    const resolvedTmpDir = fs.realpathSync(tmpDir)
    expect(result.output.trim()).toBe(resolvedTmpDir)
  })

  it('truncates large output', async () => {
    // Generate output > 100000 chars
    const result = await tool.call(
      { command: 'python3 -c "print(\'x\' * 120000)"' },
      {},
    )
    expect(result.isError).toBe(false)
    expect(result.output).toContain('[...truncated...]')
    expect(result.output.length).toBeLessThanOrEqual(100000 + 100) // some margin for the truncation marker
  })

  it('respects abort signal', async () => {
    const controller = new AbortController()
    // Abort immediately
    controller.abort()

    const context: ToolCallContext = { abortSignal: controller.signal }
    const result = await tool.call({ command: 'sleep 10' }, context)
    expect(result.isError).toBe(true)
  })
})
