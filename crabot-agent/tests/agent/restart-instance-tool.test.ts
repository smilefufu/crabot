import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as cp from 'node:child_process'
import { createRestartInstanceTool } from '../../src/agent/restart-instance-tool.js'

// vi.mock makes node:child_process properties writable so vi.spyOn can intercept
vi.mock('node:child_process', async (importOriginal) => {
  const mod = await importOriginal<typeof import('node:child_process')>()
  return { ...mod }
})

function tmpHome() {
  const home = mkdtempSync(join(tmpdir(), 'crabot-restart-'))
  mkdirSync(join(home, 'data', 'admin'), { recursive: true })
  mkdirSync(join(home, 'scripts'), { recursive: true })
  writeFileSync(join(home, 'scripts', 'restart.mjs'), '// stub')
  return home
}

afterEach(() => { vi.restoreAllMocks() })

describe('restart_instance 工具', () => {
  it('正常：detached spawn restart.mjs 并立即返回（不报错）', async () => {
    const home = tmpHome()
    const fakeChild = { on: vi.fn(), unref: vi.fn() }
    const spy = vi.spyOn(cp, 'spawn').mockReturnValue(fakeChild as never)
    const tool = createRestartInstanceTool({ crabotHome: home, adminDataDir: join(home, 'data', 'admin') })

    const res = await tool.call({ reason: '配置变更' }, {} as never)

    expect(res.isError).toBe(false)
    expect(spy).toHaveBeenCalledTimes(1)
    const [, args, opts] = spy.mock.calls[0]
    expect(args[0]).toBe(join(home, 'scripts', 'restart.mjs'))
    expect((opts as { detached: boolean }).detached).toBe(true)
    expect(fakeChild.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(fakeChild.unref).toHaveBeenCalled()
  })

  it('重启进行中：拒绝并返回 isError', async () => {
    const home = tmpHome()
    writeFileSync(
      join(home, 'data', 'admin', 'restart-status.json'),
      JSON.stringify({ phase: 'restarting', started_at: new Date().toISOString() }),
    )
    const spy = vi.spyOn(cp, 'spawn')
    const tool = createRestartInstanceTool({ crabotHome: home, adminDataDir: join(home, 'data', 'admin') })

    const res = await tool.call({}, {} as never)

    expect(res.isError).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })

  it('升级进行中：拒绝并返回 isError', async () => {
    const home = tmpHome()
    writeFileSync(
      join(home, 'data', 'admin', 'upgrade-status.json'),
      JSON.stringify({ phase: 'upgrading', started_at: new Date().toISOString() }),
    )
    const spy = vi.spyOn(cp, 'spawn')
    const tool = createRestartInstanceTool({ crabotHome: home, adminDataDir: join(home, 'data', 'admin') })

    const res = await tool.call({}, {} as never)

    expect(res.isError).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })
})
