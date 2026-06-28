import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequestRestartTool } from '../../src/agent/restart-instance-tool.js'

function tmpAdminDir() {
  const base = mkdtempSync(join(tmpdir(), 'crabot-restart-req-'))
  mkdirSync(join(base, 'data', 'admin'), { recursive: true })
  return join(base, 'data', 'admin')
}

afterEach(() => { vi.restoreAllMocks() })

describe('request_restart 工具', () => {
  it('正常：调用 requestRestart 回调并返回受理文案（非 error）', async () => {
    const adminDataDir = tmpAdminDir()
    const requestRestart = vi.fn()
    const tool = createRequestRestartTool({ adminDataDir, requestRestart })

    const res = await tool.call({ reason: '配置变更' }, {} as never)

    expect(res.isError).toBe(false)
    expect(requestRestart).toHaveBeenCalledTimes(1)
    expect(requestRestart).toHaveBeenCalledWith('配置变更')
    expect(res.output).toContain('重启申请已受理')
  })

  it('无 reason：回调仍被调用（undefined reason）', async () => {
    const adminDataDir = tmpAdminDir()
    const requestRestart = vi.fn()
    const tool = createRequestRestartTool({ adminDataDir, requestRestart })

    const res = await tool.call({}, {} as never)

    expect(res.isError).toBe(false)
    expect(requestRestart).toHaveBeenCalledWith(undefined)
  })

  it('重启进行中：返回 isError，不调 requestRestart', async () => {
    const adminDataDir = tmpAdminDir()
    writeFileSync(
      join(adminDataDir, 'restart-status.json'),
      JSON.stringify({ phase: 'restarting', started_at: new Date().toISOString() }),
    )
    const requestRestart = vi.fn()
    const tool = createRequestRestartTool({ adminDataDir, requestRestart })

    const res = await tool.call({}, {} as never)

    expect(res.isError).toBe(true)
    expect(requestRestart).not.toHaveBeenCalled()
  })

  it('升级进行中：返回 isError，不调 requestRestart', async () => {
    const adminDataDir = tmpAdminDir()
    writeFileSync(
      join(adminDataDir, 'upgrade-status.json'),
      JSON.stringify({ phase: 'upgrading', started_at: new Date().toISOString() }),
    )
    const requestRestart = vi.fn()
    const tool = createRequestRestartTool({ adminDataDir, requestRestart })

    const res = await tool.call({}, {} as never)

    expect(res.isError).toBe(true)
    expect(requestRestart).not.toHaveBeenCalled()
  })

  it('工具名为 request_restart', () => {
    const adminDataDir = tmpAdminDir()
    const tool = createRequestRestartTool({ adminDataDir, requestRestart: vi.fn() })
    expect(tool.name).toBe('request_restart')
  })
})
