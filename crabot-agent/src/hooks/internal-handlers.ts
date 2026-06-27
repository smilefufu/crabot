import type { InternalHandler, FormattedDiagnostic } from './types'
import { extractFilePaths } from '../engine/tool-orchestration'
import * as fsp from 'fs/promises'
import * as path from 'path'
import { classifyCliSubcommand, REQUIRES_CONTENT_REVIEW } from 'crabot-shared'
import { parseCrabotInvocation } from './crabot-cmd-parser.js'
import { getAdminDataDir } from '../core/data-paths.js'

const handlers = new Map<string, InternalHandler>()

export function registerInternalHandler(name: string, handler: InternalHandler): void {
  handlers.set(name, handler)
}

export function getInternalHandler(name: string): InternalHandler | undefined {
  return handlers.get(name)
}

// --- Built-in: lsp-diagnostics ---

registerInternalHandler('lsp-diagnostics', async (input, context) => {
  if (!context.lspManager) {
    return { action: 'continue' }
  }

  const filePath = input.toolInput ? extractFilePaths(input.toolInput)[0] : undefined
  if (!filePath) {
    return { action: 'continue' }
  }

  try {
    const content = await fsp.readFile(filePath, 'utf-8')
    context.lspManager.notifyFileChanged(filePath, content)
    const diagnostics = await context.lspManager.getDiagnostics(filePath)

    if (diagnostics.length === 0) {
      return { action: 'continue' }
    }

    const message = formatDiagnosticsMessage(diagnostics)
    const hasErrors = diagnostics.some((d) => d.severity === 'error')

    return {
      action: hasErrors ? 'block' : 'continue',
      message,
    }
  } catch {
    return { action: 'continue' }
  }
})

// --- Built-in: cli-permission-gate ---
// 解析 Bash 命令中的 crabot 调用，按 effective permissions 决策：
//   1. --reveal → 永远 block（master 也不行）
//   2. 未识别子命令 → fail-closed block（master 也拦，避免新命令未入表前默认放行）
//   3. master → 短路放行
//   4. 硬闸：cli_access[domain] 与 (read/write) 不匹配 → block
//   5. 软闸：REQUIRES_CONTENT_REVIEW（仅 schedule add）→ 调 contentReviewer，deny → block
registerInternalHandler('cli-permission-gate', async (input, context) => {
  const cmdStr = String(input.toolInput?.['command'] ?? '')
  const parsed = parseCrabotInvocation(cmdStr)
  if (!parsed) return { action: 'continue' }

  // 1. --reveal 永不放行（master 也不行，by design）
  if (parsed.hasReveal) {
    return {
      action: 'block',
      message: 'PERMISSION_DENIED: `--reveal` 永不暴露给 agent。',
    }
  }

  // 2. 解析 (domain, kind) —— 未识别 fail-closed，即便 master 也拦
  const cls = classifyCliSubcommand(parsed.subcommand)
  if (!cls) {
    return {
      action: 'block',
      message: `PERMISSION_DENIED: 未识别的 crabot 子命令 \`${parsed.subcommand}\`（fail-closed）。`,
    }
  }

  // 3. master 短路（master 身份特权，不依赖 cli_access 配置）
  if (context.senderIsMaster) {
    return { action: 'continue' }
  }

  // 4. 硬闸：cli_access[domain]
  const cliAccess = context.resolvedPermissions?.cli_access
  if (!cliAccess) {
    return {
      action: 'block',
      message: 'PERMISSION_DENIED: 当前权限上下文缺失，无法放行 CLI 命令（fail-closed）。',
    }
  }
  const allowed = cliAccess[cls.domain]
  const passes =
    (cls.kind === 'read' && (allowed === 'read' || allowed === 'write')) ||
    (cls.kind === 'write' && allowed === 'write')
  if (!passes) {
    const sceneLabel = context.sessionType === 'group'
      ? '群聊'
      : context.sessionType === 'private'
        ? '好友'
        : '会话对象'
    return {
      action: 'block',
      message:
        `PERMISSION_DENIED: cli_access.${cls.domain}=${allowed}，无法执行 ${cls.kind} 命令 \`${parsed.subcommand}\`。\n` +
        `如需开通：master 可在 Admin Web 「对话对象」里选中当前${sceneLabel}，` +
        `在权限编辑里把 \`cli_access.${cls.domain}\` 调成 \`${cls.kind === 'write' ? 'write' : 'read'}\`，` +
        `或用「用模板初始化」选 \`group_scheduler\` 等含此权限的模板。`,
    }
  }

  // 5. 软闸：内容审核（仅 schedule add）
  if (REQUIRES_CONTENT_REVIEW.has(parsed.subcommand)) {
    if (!context.contentReviewer || !context.resolvedPermissions) {
      return {
        action: 'block',
        message: 'PERMISSION_DENIED: 内容审核器未配置（fail-closed）。',
      }
    }
    // 显式 try/catch：reviewer 抛错时本 handler 必须 fail-closed deny。
    // 不能依赖 hook-executor 的 catch（它会把 error 转成 action:'continue'，等于 fail-OPEN，
    // 完全破坏内容审核的安全语义）。
    let review
    try {
      review = await context.contentReviewer({
        effectivePermissions: context.resolvedPermissions,
        commandText: cmdStr,
      })
    } catch (err) {
      return {
        action: 'block',
        message: `PERMISSION_DENIED: 内容审核器异常（fail-closed） — ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    if (review.verdict === 'deny') {
      return {
        action: 'block',
        message: `PERMISSION_DENIED: 该请求未通过内容审核 — ${review.reason}`,
      }
    }
  }

  return { action: 'continue' }
})

// --- Built-in: skill-dir-fence ---
// 拦截 Write/Edit 直接写 admin skills 目录的尝试。
// agent 通过 Skill 工具被告知 skill_dir 绝对路径（skill-tool.ts:121），所以确实有能力直接写；
// 但直接写会绕过 admin 的 N=1 previous_snapshot + Admin UI diff + crabot skill restore。
// 不区分身份——master 改也得走 update，否则版本管理形同虚设。
// 注意：agent 子进程的 DATA_DIR 是 <root>/data/agent，admin skills 在 <root>/data/admin/skills；
// 必须走 getAdminDataDir() 而不是 path.join(DATA_DIR, 'admin', ...)，后者会算成
// <root>/data/agent/admin/skills（不存在），fence 失效。
registerInternalHandler('skill-dir-fence', async (input, _context) => {
  const filePath = input.toolInput ? extractFilePaths(input.toolInput)[0] : undefined
  if (!filePath) return { action: 'continue' }

  const skillsRootAbs = path.join(getAdminDataDir(), 'skills')
  const rel = path.relative(skillsRootAbs, path.resolve(filePath))
  // 命中 root 自身（rel === ''）或 root 之下子路径（rel 不以 .. 开头且非绝对）→ block
  const inSkillsRoot = rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel))
  if (!inSkillsRoot) return { action: 'continue' }

  return {
    action: 'block',
    message:
      '禁止直接 Write/Edit admin skills 目录下的文件——会绕过 N=1 版本管理（previous_snapshot）和 Admin UI diff。' +
      '请改用 `crabot skill update <ref> --file <new-SKILL.md>` 提交修改，admin 会自动打快照并支持 `crabot skill restore` 回退。',
  }
})

// --- Built-in: git-write-fence ---
// 拦截 subagent 通过 git MCP 发起的写操作（commit / branch / stash）。
// 背景：lsp/git 等内置 MCP 现按 allowed_mcp_server_ids 开放给 subagent（如 code_writer / reviewer）；
// git server 把只读（status/diff/log）和写（commit/branch/stash）捆在同一个 server，白名单粒度到 server 级，
// 一旦开 git 就连写工具一起开。subagent 是受限执行体/审查体，提交归 main worker / CLI，不该自己 commit。
// 该 fence 只在 subagent hook 装配里按 'git' ∈ allowed_mcp_server_ids 注入（见 defaults.createSubAgentHookRegistry），
// 不影响 main worker 的 git 全权限。
// 哪些工具被拦由 matcher 单点决定（见 defaults.createGitWriteFenceHook 的 mcp__git__(commit|branch|stash) 正则）：
// 命中即调本 handler、即 block；handler 不再重复枚举工具名，避免两处清单漂移。
registerInternalHandler('git-write-fence', async () => ({
  action: 'block',
  message:
    'subagent 不允许 git 写操作（commit / branch / stash）——提交归 main worker / CLI 处理。' +
    'git 只读操作（status / diff / log）可正常使用。',
}))

// --- Legacy alias: block-cli-write → cli-permission-gate ---
registerInternalHandler('block-cli-write', async (input, context) => {
  const fwd = getInternalHandler('cli-permission-gate')
  if (!fwd) {
    return { action: 'block', message: 'PERMISSION_DENIED: cli-permission-gate handler 未注册。' }
  }
  return fwd(input, context)
})

// --- Legacy alias: block-cli → cli-permission-gate ---
registerInternalHandler('block-cli', async (input, context) => {
  const fwd = getInternalHandler('cli-permission-gate')
  if (!fwd) {
    return { action: 'block', message: 'PERMISSION_DENIED: cli-permission-gate handler 未注册。' }
  }
  return fwd(input, context)
})

// --- Helpers ---

function formatDiagnosticsMessage(diagnostics: ReadonlyArray<FormattedDiagnostic>): string {
  const lines = diagnostics.map((d) =>
    `${d.filePath}:${d.line}:${d.column} [${d.severity.toUpperCase()}] ${d.message} (${d.source})`
  )
  return `LSP Diagnostics:\n${lines.join('\n')}`
}
