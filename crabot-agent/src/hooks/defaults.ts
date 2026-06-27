import type { HookDefinition } from './types'
import { HookRegistry } from './hook-registry'

export function createCliPermissionHook(): HookDefinition {
  return {
    event: 'PreToolUse',
    matcher: 'Bash',
    if: 'Bash(crabot *)',
    type: 'command',
    command: '__internal:cli-permission-gate',
  }
}

// Backward-compat alias for existing references in agent-handler
export const createCliBlockHook = createCliPermissionHook

// Skill 目录写入 fence —— 详见 internal-handlers.ts `skill-dir-fence` 注释
export function createSkillDirFenceHook(): HookDefinition {
  return {
    event: 'PreToolUse',
    matcher: 'Write|Edit',
    type: 'command',
    command: '__internal:skill-dir-fence',
  }
}

// git 写操作 fence —— 详见 internal-handlers.ts `git-write-fence` 注释。
// matcher 精确到三个写工具，只读（status/diff/log）不命中、不受影响。
export function createGitWriteFenceHook(): HookDefinition {
  return {
    event: 'PreToolUse',
    matcher: 'mcp__git__(git_commit|git_branch|git_stash)',
    type: 'command',
    command: '__internal:git-write-fence',
  }
}

// post-edit LSP 诊断 push —— 每次 Write/Edit 后自动跑诊断，有 error 级则 block 让 agent 当场修。
// 详见 internal-handlers.ts `lsp-diagnostics` 注释。需要 lspManager（agent-handler 据 hook_preset 注入）。
export function createLspDiagnosticsHook(): HookDefinition {
  return {
    event: 'PostToolUse',
    matcher: 'Write|Edit',
    type: 'command',
    command: '__internal:lsp-diagnostics',
  }
}

/**
 * 按 subagent 的能力组合装配 hook registry。
 * - lspDiagnostics：注入 post-edit LSP 诊断 push（按 hook_preset==='lsp_diagnostics' 决定），需 lspManager
 * - gitWriteFence：注入 git 写操作拦截（按 'git' ∈ allowed_mcp_server_ids 决定）
 * 两者可叠加；都不开返回 undefined（engine 据此跳过 hook 装配）。
 */
export function createSubAgentHookRegistry(opts: {
  lspDiagnostics: boolean
  gitWriteFence: boolean
}): HookRegistry | undefined {
  const hooks: HookDefinition[] = []
  if (opts.lspDiagnostics) hooks.push(createLspDiagnosticsHook())
  if (opts.gitWriteFence) hooks.push(createGitWriteFenceHook())
  if (hooks.length === 0) return undefined
  const registry = new HookRegistry()
  registry.registerAll(hooks)
  return registry
}
