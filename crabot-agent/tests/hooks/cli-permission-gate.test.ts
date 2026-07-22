import { describe, it, expect, vi } from 'vitest'
import { getInternalHandler } from '../../src/hooks/internal-handlers.js'
import type { InternalHandlerContext } from '../../src/hooks/types.js'
import type { ResolvedPermissions } from '../../src/types.js'
import type { ReviewResult } from '../../src/agent/cli-content-reviewer.js'

const FULL_TOOL_ACCESS = {
  memory: true, messaging: true, task: true,
  mcp_skill: true, file_io: true, browser: true,
  shell: true, remote_exec: true, desktop: true,
}
const NONE_TOOL_ACCESS = {
  memory: false, messaging: false, task: false,
  mcp_skill: false, file_io: false, browser: false,
  shell: false, remote_exec: false, desktop: false,
}
const NONE_CLI_ACCESS = {
  provider: 'none' as const, agent: 'none' as const, mcp: 'none' as const,
  skill: 'none' as const, schedule: 'none' as const, channel: 'none' as const,
  friend: 'none' as const, permission: 'none' as const, config: 'none' as const,
  undo: 'none' as const,
}
const WRITE_CLI_ACCESS = {
  provider: 'write' as const, agent: 'write' as const, mcp: 'write' as const,
  skill: 'write' as const, schedule: 'write' as const, channel: 'write' as const,
  friend: 'write' as const, permission: 'write' as const, config: 'write' as const,
  undo: 'write' as const,
}

const masterPerms: ResolvedPermissions = {
  tool_access: FULL_TOOL_ACCESS,
  cli_access: WRITE_CLI_ACCESS,
  storage: null,
  memory_scopes: [],
}
const minimalPerms: ResolvedPermissions = {
  tool_access: NONE_TOOL_ACCESS,
  cli_access: NONE_CLI_ACCESS,
  storage: null,
  memory_scopes: [],
}
const groupSchedulerPerms: ResolvedPermissions = {
  tool_access: { ...NONE_TOOL_ACCESS, messaging: true, task: true, memory: true },
  cli_access: { ...NONE_CLI_ACCESS, schedule: 'write' },
  storage: null,
  memory_scopes: [],
}

function makeCtx(overrides: Partial<InternalHandlerContext> = {}): InternalHandlerContext {
  return {
    workingDirectory: '/tmp/test',
    senderIsMaster: false,
    resolvedPermissions: minimalPerms,
    contentReviewer: vi.fn(async () => ({ verdict: 'approve', reason: '' } as ReviewResult)),
    ...overrides,
  }
}

describe('cli-permission-gate hook', () => {
  it('master 全权：cli_access 全 write 时放行任何写命令', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    const ctx = makeCtx({ senderIsMaster: true, resolvedPermissions: masterPerms })
    const r = await handler({ event: 'PreToolUse', toolInput: { command: 'crabot provider delete openai' } }, ctx)
    expect(r.action).toBe('continue')
  })

  it('cli_access[domain] = none → block', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    const r = await handler({ event: 'PreToolUse', toolInput: { command: 'crabot mcp add --name foo' } }, makeCtx())
    expect(r.action).toBe('block')
    expect(r.message).toContain('PERMISSION_DENIED')
    expect(r.message).toContain('mcp')
  })

  it('cli_access[domain] = read 但调用 write 命令 → block', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    const ctx = makeCtx({
      resolvedPermissions: {
        ...minimalPerms,
        cli_access: { ...NONE_CLI_ACCESS, provider: 'read' },
      },
    })
    const r = await handler({ event: 'PreToolUse', toolInput: { command: 'crabot provider add --name x' } }, ctx)
    expect(r.action).toBe('block')
  })

  it('read 命令 + cli_access 至少 read → 放行', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    const ctx = makeCtx({
      resolvedPermissions: {
        ...minimalPerms,
        cli_access: { ...NONE_CLI_ACCESS, provider: 'read' },
      },
    })
    const r = await handler({ event: 'PreToolUse', toolInput: { command: 'crabot provider list' } }, ctx)
    expect(r.action).toBe('continue')
  })

  // 任务权限热刷新（spec 2026-07-20-task-permission-hot-refresh）：
  // getResolvedPermissions 活值优先于静态 resolvedPermissions
  it('getResolvedPermissions 活值优先：静态 none + 活值 read → 放行 read 命令', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    const ctx = makeCtx({
      resolvedPermissions: minimalPerms, // 静态快照仍是 none
      getResolvedPermissions: () => ({
        ...minimalPerms,
        cli_access: { ...NONE_CLI_ACCESS, provider: 'read' },
      }),
    })
    const r = await handler({ event: 'PreToolUse', toolInput: { command: 'crabot provider list' } }, ctx)
    expect(r.action).toBe('continue')
  })

  it('getResolvedPermissions 活值优先：静态 read + 活值 none → block（收紧也即时生效）', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    const ctx = makeCtx({
      resolvedPermissions: {
        ...minimalPerms,
        cli_access: { ...NONE_CLI_ACCESS, provider: 'read' },
      },
      getResolvedPermissions: () => minimalPerms,
    })
    const r = await handler({ event: 'PreToolUse', toolInput: { command: 'crabot provider list' } }, ctx)
    expect(r.action).toBe('block')
  })

  it('getResolvedPermissions 返回 undefined → 回退静态 resolvedPermissions', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    const ctx = makeCtx({
      resolvedPermissions: {
        ...minimalPerms,
        cli_access: { ...NONE_CLI_ACCESS, provider: 'read' },
      },
      getResolvedPermissions: () => undefined,
    })
    const r = await handler({ event: 'PreToolUse', toolInput: { command: 'crabot provider list' } }, ctx)
    expect(r.action).toBe('continue')
  })

  it('getResolvedPermissions 活值每次调用重读（同 ctx 中途变更立即生效）', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    let live = minimalPerms
    const ctx = makeCtx({ getResolvedPermissions: () => live })
    const cmd = { event: 'PreToolUse' as const, toolInput: { command: 'crabot provider list' } }

    expect((await handler(cmd, ctx)).action).toBe('block')
    live = { ...minimalPerms, cli_access: { ...NONE_CLI_ACCESS, provider: 'read' } }
    expect((await handler(cmd, ctx)).action).toBe('continue')
  })

  it('--reveal 永远 block', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    const ctx = makeCtx({ senderIsMaster: true, resolvedPermissions: masterPerms })
    const r = await handler({ event: 'PreToolUse', toolInput: { command: 'crabot provider show openai --reveal' } }, ctx)
    expect(r.action).toBe('block')
    expect(r.message).toContain('--reveal')
  })

  it('schedule add：硬闸通过 + reviewer approve → 放行', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    const reviewer = vi.fn(async () => ({ verdict: 'approve', reason: 'OK' } as ReviewResult))
    const ctx = makeCtx({ resolvedPermissions: groupSchedulerPerms, contentReviewer: reviewer })
    const r = await handler(
      { event: 'PreToolUse', toolInput: { command: 'crabot schedule add --title remind --task-description 提醒张三 --trigger-at 2026-05-06T15:00' } },
      ctx,
    )
    expect(reviewer).toHaveBeenCalledTimes(1)
    expect(r.action).toBe('continue')
  })

  it('schedule add：reviewer deny → block，message 含 reason', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    const reviewer = vi.fn(async () => ({ verdict: 'deny', reason: '需要 shell 工具，超出权限' } as ReviewResult))
    const ctx = makeCtx({ resolvedPermissions: groupSchedulerPerms, contentReviewer: reviewer })
    const r = await handler(
      { event: 'PreToolUse', toolInput: { command: 'crabot schedule add --task-description rm -rf' } },
      ctx,
    )
    expect(r.action).toBe('block')
    expect(r.message).toContain('shell')
  })

  it('schedule add：reviewer throw → block (fail-closed，hook 自己 catch，不依赖 hook-executor)', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    const reviewer = vi.fn(async () => { throw new Error('LLM 503') })
    const ctx = makeCtx({ resolvedPermissions: groupSchedulerPerms, contentReviewer: reviewer })
    const r = await handler(
      { event: 'PreToolUse', toolInput: { command: 'crabot schedule add --task-description test' } },
      ctx,
    )
    expect(r.action).toBe('block')
    expect(r.message).toContain('PERMISSION_DENIED')
    expect(r.message).toContain('LLM 503')
  })

  it('schedule add：master 跳过 reviewer', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    const reviewer = vi.fn()
    const ctx = makeCtx({
      senderIsMaster: true,
      resolvedPermissions: masterPerms,
      contentReviewer: reviewer,
    })
    const r = await handler(
      { event: 'PreToolUse', toolInput: { command: 'crabot schedule add --task-description anything' } },
      ctx,
    )
    expect(reviewer).not.toHaveBeenCalled()
    expect(r.action).toBe('continue')
  })

  it('未识别为 crabot 命令 → continue（不影响其他 Bash）', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    const r = await handler({ event: 'PreToolUse', toolInput: { command: 'ls -la' } }, makeCtx())
    expect(r.action).toBe('continue')
  })

  it('未知 crabot 子命令 → block（fail-closed）', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    const ctx = makeCtx({ senderIsMaster: true, resolvedPermissions: masterPerms })
    const r = await handler({ event: 'PreToolUse', toolInput: { command: 'crabot foo bar' } }, ctx)
    expect(r.action).toBe('block')
    expect(r.message).toContain('PERMISSION_DENIED')
  })

  it('schedule add 但 contentReviewer 未注入 → fail-closed deny', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    const ctx: InternalHandlerContext = {
      workingDirectory: '/tmp/test',
      senderIsMaster: false,
      resolvedPermissions: groupSchedulerPerms,
      // contentReviewer intentionally omitted
    }
    const r = await handler(
      { event: 'PreToolUse', toolInput: { command: 'crabot schedule add --task-description test' } },
      ctx,
    )
    expect(r.action).toBe('block')
    expect(r.message).toContain('PERMISSION_DENIED')
  })

  it('resolvedPermissions 未注入 → fail-closed deny', async () => {
    const handler = getInternalHandler('cli-permission-gate')!
    const ctx: InternalHandlerContext = {
      workingDirectory: '/tmp/test',
      senderIsMaster: false,
      // resolvedPermissions intentionally omitted
    }
    const r = await handler(
      { event: 'PreToolUse', toolInput: { command: 'crabot mcp list' } },
      ctx,
    )
    expect(r.action).toBe('block')
  })

  it('block-cli-write 别名转发到 cli-permission-gate（向后兼容）', async () => {
    const legacy = getInternalHandler('block-cli-write')!
    const ctx = makeCtx()
    const r = await legacy({ event: 'PreToolUse', toolInput: { command: 'crabot mcp add --name foo' } }, ctx)
    expect(r.action).toBe('block')
  })
})

describe('cli-permission-gate 拒绝指引', () => {
  const handler = getInternalHandler('cli-permission-gate')!

  const scheduleInput = { event: 'PreToolUse' as const, toolInput: { command: 'crabot schedule add --interval-seconds 3600 --task "watch dhl"' } }

  const baseContext: InternalHandlerContext = {
    workingDirectory: '/tmp',
    senderIsMaster: false,
    resolvedPermissions: {
      tool_access: {
        memory: false, messaging: false, task: false,
        mcp_skill: false, file_io: false, browser: false,
        shell: false, remote_exec: false, desktop: false,
      },
      cli_access: {
        provider: 'none', agent: 'none', mcp: 'none',
        skill: 'none', schedule: 'none', channel: 'none',
        friend: 'none', permission: 'none', config: 'none', undo: 'none',
      },
      storage: null,
      memory_scopes: [],
    },
  }

  it('群聊场景：拒绝文案点名「群聊」+ 指引去 Admin Web', async () => {
    const result = await handler(scheduleInput, { ...baseContext, sessionType: 'group' })
    expect(result.action).toBe('block')
    expect(result.message).toContain('cli_access.schedule=none')
    expect(result.message).toContain('群聊')
    expect(result.message).toContain('Admin Web')
    expect(result.message).toContain('对话对象')
    expect(result.message).toContain('group_scheduler')
  })

  it('私聊场景：拒绝文案点名「好友」', async () => {
    const result = await handler(scheduleInput, { ...baseContext, sessionType: 'private' })
    expect(result.action).toBe('block')
    expect(result.message).toContain('好友')
  })

  it('sessionType 缺失：fallback 通用文案「会话对象」', async () => {
    const result = await handler(scheduleInput, baseContext)
    expect(result.action).toBe('block')
    expect(result.message).toContain('会话对象')
  })
})
