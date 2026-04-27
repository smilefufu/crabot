import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWrite } from './run-write.js'
import { UndoLog } from './undo-log.js'

// Mock human-confirm module for human mode tests
vi.mock('./human-confirm.js', () => ({
  promptYesNo: vi.fn(),
}))

let tmpDir: string
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'crabot-rw-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

describe('runWrite', () => {
  it('非 confirm 命令直接执行 + 写 undo（静态 reverse）', async () => {
    const exec = vi.fn(async () => ({ id: 'a3c1', name: 'foo' }))
    const result = await runWrite({
      subcommand: 'mcp toggle',
      args: { '_positional': 'foo' },
      command_text: 'mcp toggle foo',
      execute: exec,
      reverse: { command: 'mcp toggle foo --off', preview_description: 'toggle off' },
      dataDir: tmpDir,
      actor: 'agent-1',
    })
    expect(exec).toHaveBeenCalledOnce()
    if (!('ok' in result)) throw new Error('expected ok response')
    expect(result.ok).toBe(true)
    expect(result.undo?.id).toMatch(/^undo-/)
    expect(result.undo?.command).toMatch(/^crabot undo undo-/)
    const items = await new UndoLog(tmpDir).list()
    expect(items).toHaveLength(1)
  })

  it('reverseFromResult 收到 execute 结果后才构造 reverse', async () => {
    const exec = vi.fn(async () => ({ id: 'new-id-7777', name: 'foo' }))
    const result = await runWrite({
      subcommand: 'provider add',
      args: { '--name': 'foo' },
      command_text: 'provider add --name foo',
      execute: exec,
      reverseFromResult: (r) => ({
        command: `provider delete ${(r as any).id}`,
        preview_description: `delete provider foo (${(r as any).id})`,
      }),
      dataDir: tmpDir,
    })
    if (!('ok' in result)) throw new Error('expected ok')
    const items = await new UndoLog(tmpDir).list()
    expect(items[0]!.reverse.command).toBe('provider delete new-id-7777')
  })

  it('必须 confirm 的命令首次返回 confirmation_required，不调 execute', async () => {
    const exec = vi.fn()
    const collectPreview = vi.fn(async () => ({ side_effects: [{ type: 'agent_unset', count: 2 }], rollback_difficulty: 'apikey lost' }))
    const result = await runWrite({
      subcommand: 'provider delete',
      args: { '_positional': 'gpt' },
      command_text: 'provider delete gpt',
      execute: exec,
      collectPreview,
      dataDir: tmpDir,
    })
    expect(exec).not.toHaveBeenCalled()
    expect(collectPreview).toHaveBeenCalledOnce()
    if (!('confirmation_required' in result)) throw new Error('expected confirmation_required')
    expect(result.confirmation_required).toBe(true)
    expect(result.confirmation_token).toMatch(/^[a-z0-9]{12}-\d+$/)
    expect(result.command_to_confirm).toContain('--confirm')
    expect(result.preview.action).toBe('delete')
    expect(result.preview.rollback_difficulty).toBe('apikey lost')
  })

  it('带匹配 token 的 confirm 命令真执行，不进 undo log', async () => {
    const exec = vi.fn(async () => ({ deleted_at: 'now' }))
    const first = await runWrite({
      subcommand: 'provider delete',
      args: { '_positional': 'gpt' },
      command_text: 'provider delete gpt',
      execute: vi.fn(),
      collectPreview: async () => ({ side_effects: [] }),
      dataDir: tmpDir,
    })
    if (!('confirmation_token' in first)) throw new Error('expected token')
    const token = first.confirmation_token
    const second = await runWrite({
      subcommand: 'provider delete',
      args: { '_positional': 'gpt', '--confirm': token },
      command_text: `provider delete gpt --confirm ${token}`,
      execute: exec,
      dataDir: tmpDir,
    })
    expect(exec).toHaveBeenCalledOnce()
    if (!('ok' in second)) throw new Error('expected ok')
    expect(second.ok).toBe(true)
    expect((second as any).undo).toBeUndefined()  // confirm 类不进 undo log
    expect(await new UndoLog(tmpDir).list()).toHaveLength(0)
  })

  it('confirm 命令带错 token 抛 CONFIRMATION_INVALID', async () => {
    await expect(runWrite({
      subcommand: 'provider delete',
      args: { '_positional': 'gpt', '--confirm': 'badhash99999-9999999999' },
      command_text: '',
      execute: vi.fn(),
      collectPreview: async () => ({ side_effects: [] }),
      dataDir: tmpDir,
    })).rejects.toMatchObject({ code: 'CONFIRMATION_INVALID' })
  })

  it('confirm 命令缺 collectPreview 抛 INTERNAL_ERROR', async () => {
    await expect(runWrite({
      subcommand: 'provider delete',
      args: { '_positional': 'gpt' },
      command_text: 'provider delete gpt',
      execute: vi.fn(),
      dataDir: tmpDir,
    })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' })
  })

  it('command_to_confirm 字段去掉旧 --confirm 参数', async () => {
    const result = await runWrite({
      subcommand: 'provider delete',
      args: { '_positional': 'gpt' },
      command_text: 'crabot provider delete gpt --confirm old-token-1234',
      execute: vi.fn(),
      collectPreview: async () => ({ side_effects: [] }),
      dataDir: tmpDir,
    })
    if (!('command_to_confirm' in result)) throw new Error('expected confirmation')
    // 不应该出现两个 --confirm
    expect(result.command_to_confirm.match(/--confirm/g)?.length).toBe(1)
  })

  it('human 模式 + 用户输入 YES → 直接执行，不返回 confirmation_required', async () => {
    const { promptYesNo } = await import('./human-confirm.js')
    vi.mocked(promptYesNo).mockResolvedValue(true)

    const exec = vi.fn(async () => ({ deleted: true }))
    const collectPreview = vi.fn(async () => ({ side_effects: [{ type: 'data_loss' }] }))

    const result = await runWrite({
      subcommand: 'provider delete',
      args: { '_positional': 'gpt' },
      command_text: 'provider delete gpt',
      execute: exec,
      collectPreview,
      dataDir: tmpDir,
      mode: 'human',
    })

    expect(exec).toHaveBeenCalledOnce()
    expect(collectPreview).toHaveBeenCalledOnce()
    expect(promptYesNo).toHaveBeenCalledOnce()
    if (!('ok' in result)) throw new Error('expected ok response')
    expect(result.ok).toBe(true)
  })

  it('human 模式 + 用户输入 NO → process.exit(0)', async () => {
    const { promptYesNo } = await import('./human-confirm.js')
    vi.mocked(promptYesNo).mockResolvedValue(false)

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called')
    }) as never)

    const exec = vi.fn()

    await expect(runWrite({
      subcommand: 'provider delete',
      args: { '_positional': 'gpt' },
      command_text: 'provider delete gpt',
      execute: exec,
      collectPreview: async () => ({ side_effects: [] }),
      dataDir: tmpDir,
      mode: 'human',
    })).rejects.toThrow('process.exit called')

    expect(exec).not.toHaveBeenCalled()
    expect(exitSpy).toHaveBeenCalledWith(0)
    exitSpy.mockRestore()
  })
})
