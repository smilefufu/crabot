import { describe, expect, it } from 'vitest'
import { getInternalHandler } from '../../src/hooks/internal-handlers.js'
import { createGitWriteFenceHook, createSubAgentHookRegistry } from '../../src/hooks/defaults.js'
import type { InternalHandlerContext } from '../../src/hooks/types.js'

function makeCtx(): InternalHandlerContext {
  return { workingDirectory: '/tmp/test' }
}

describe('git-write-fence handler', () => {
  // handler 命中即 block——「哪些工具命中」由 matcher 单点决定（见下方 createGitWriteFenceHook 测试），
  // handler 不再自己枚举工具名。
  it('被调用即 block 并给出提示', async () => {
    const handler = getInternalHandler('git-write-fence')!
    const result = await handler({ event: 'PreToolUse', toolName: 'mcp__git__git_commit' }, makeCtx())
    expect(result.action).toBe('block')
    expect(result.message).toBeTruthy()
  })
})

describe('createGitWriteFenceHook', () => {
  it('matcher 命中三个写工具、不命中只读工具', () => {
    const hook = createGitWriteFenceHook()
    const re = new RegExp(`^(?:${hook.matcher})$`)
    expect(re.test('mcp__git__git_commit')).toBe(true)
    expect(re.test('mcp__git__git_branch')).toBe(true)
    expect(re.test('mcp__git__git_stash')).toBe(true)
    expect(re.test('mcp__git__git_status')).toBe(false)
    expect(re.test('mcp__git__git_diff')).toBe(false)
    expect(re.test('mcp__git__git_log')).toBe(false)
  })

  it('是 PreToolUse + 指向 __internal:git-write-fence', () => {
    const hook = createGitWriteFenceHook()
    expect(hook.event).toBe('PreToolUse')
    expect(hook.command).toBe('__internal:git-write-fence')
  })
})

describe('createSubAgentHookRegistry', () => {
  it('都不开 → undefined', () => {
    expect(createSubAgentHookRegistry({ lspDiagnostics: false, gitWriteFence: false })).toBeUndefined()
  })

  it('仅 gitWriteFence → registry 含 git 写工具的 PreToolUse 拦截，不含 post-edit 钩子', () => {
    const reg = createSubAgentHookRegistry({ lspDiagnostics: false, gitWriteFence: true })
    expect(reg).toBeDefined()
    expect(
      reg!.getMatching('PreToolUse', { event: 'PreToolUse', toolName: 'mcp__git__git_commit' }).length,
    ).toBe(1)
    expect(
      reg!.getMatching('PostToolUse', { event: 'PostToolUse', toolName: 'Edit' }).length,
    ).toBe(0)
  })

  it('仅 lspDiagnostics → registry 含 Write/Edit 的 PostToolUse 诊断钩子，但不拦 git 写', () => {
    const reg = createSubAgentHookRegistry({ lspDiagnostics: true, gitWriteFence: false })
    expect(reg).toBeDefined()
    const gitMatch = reg!.getMatching('PreToolUse', {
      event: 'PreToolUse',
      toolName: 'mcp__git__git_commit',
    })
    expect(gitMatch.length).toBe(0)
    const editMatch = reg!.getMatching('PostToolUse', { event: 'PostToolUse', toolName: 'Edit' })
    expect(editMatch.length).toBe(1)
  })

  it('没有 Stop 钩子（compile-check / 测试 prompt 已随 coding_expert 一并移除）', () => {
    const reg = createSubAgentHookRegistry({ lspDiagnostics: true, gitWriteFence: true })
    expect(reg!.getMatching('Stop', { event: 'Stop' }).length).toBe(0)
  })

  it('两者都开 → git 拦截与 lsp-diagnostics 钩子并存', () => {
    const reg = createSubAgentHookRegistry({ lspDiagnostics: true, gitWriteFence: true })
    expect(reg).toBeDefined()
    expect(
      reg!.getMatching('PreToolUse', { event: 'PreToolUse', toolName: 'mcp__git__git_branch' }).length,
    ).toBe(1)
    expect(
      reg!.getMatching('PostToolUse', { event: 'PostToolUse', toolName: 'Write' }).length,
    ).toBe(1)
  })
})
