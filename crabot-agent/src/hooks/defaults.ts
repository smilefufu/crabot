import type { HookDefinition } from './types'
import { HookRegistry } from './hook-registry'

export function createCodingExpertHookRegistry(): HookRegistry {
  const registry = new HookRegistry()
  registry.registerAll(getCodingExpertHooks())
  return registry
}

function getCodingExpertHooks(): ReadonlyArray<HookDefinition> {
  return [
    // 1. LSP diagnostics — type/syntax errors after file edits
    {
      event: 'PostToolUse',
      matcher: 'Write|Edit',
      type: 'command',
      command: '__internal:lsp-diagnostics',
    },
    // 2. Compile check — verify build before sub-agent finishes
    {
      event: 'Stop',
      type: 'command',
      command: '__internal:compile-check',
      timeout: 60,
    },
    // 3. Test evaluation — LLM judges if tests need running
    {
      event: 'Stop',
      type: 'prompt',
      prompt: [
        '分析以下代码变更上下文，判断是否需要运行测试。',
        '如果需要，返回 {"action":"block","message":"建议运行以下测试：<具体测试文件或命令>"}',
        '如果不需要，返回 {"action":"continue"}',
        '',
        '上下文：$INPUT',
      ].join('\n'),
    },
  ]
}
