/**
 * PluginLoader - 动态加载 OpenClaw 插件
 *
 * 支持两种格式：
 *
 * 1. OpenClawPluginDefinition（真实 OpenClaw 格式）：
 *    export default { id, register(api: OpenClawPluginApi) }
 *    register 会调用 api.registerChannel({ plugin: ChannelPlugin })
 *
 * 2. 简化格式（向后兼容）：
 *    module.exports = { gateway: { startAccount }, config: { resolveAccount } }
 *
 * loadPlugin 接受 channelRuntime 参数，在 register(api) 时注入 api.runtime，
 * 使插件的 getFeishuRuntime() 等单例指向我们的 channelRuntime。
 */

import path from 'node:path'
import fs from 'node:fs'

// ============================================================================
// 对外接口
// ============================================================================

export interface LoadedPlugin {
  /** 启动单个账号（长期运行）。account 由调用者通过 resolveAccount 解析后传入 */
  startAccount(params: { cfg: unknown; abortSignal: AbortSignal; account: unknown }): Promise<void>
  /** 列出所有已注册的账号 ID */
  listAccountIds(cfg: unknown): string[]
  /** 解析账号（从 cfg 中读取凭证信息） */
  resolveAccount(cfg: unknown, accountId?: string | null): unknown
  /** 插件的出站适配器（可选，用于主动发送消息） */
  outbound?: OutboundAdapter
}

/**
 * Shim 层使用的 outbound 适配器精简接口。
 * 对齐 OpenClaw ChannelOutboundAdapter 的 sendText/sendMedia 签名。
 */
export interface OutboundAdapter {
  sendText?: (ctx: OutboundContext) => Promise<unknown>
  sendMedia?: (ctx: OutboundContext & { mediaUrl: string }) => Promise<unknown>
}

export interface OutboundContext {
  cfg: unknown
  to: string
  text: string
  accountId?: string | null
}

// ============================================================================
// 构建 openclaw 的 jiti alias map
// ============================================================================

/**
 * 将 openclaw 包的 exports 字段展开为 jiti alias map。
 *
 * 当插件从 OPENCLAW_STATE_DIR 加载时（plugin 不在 channel-host/node_modules/ 内），
 * jiti 默认无法找到 openclaw 的 peer dep。通过显式 alias 将每个子路径指向本模块
 * 已安装的 openclaw dist 文件，绕过 exports 字段解析问题。
 *
 * 当 openclaw 包不可用时（部署环境），fallback 到 openclaw-stubs/ 的轻量 stub。
 *
 * 例：
 *   openclaw/plugin-sdk/feishu → /path/to/node_modules/openclaw/dist/plugin-sdk/feishu.js
 */
const OPENCLAW_STUB_DIR = path.join(__dirname, '..', 'openclaw-stubs')
const OPENCLAW_STUB_PATH = path.join(OPENCLAW_STUB_DIR, 'plugin-sdk.cjs')

/**
 * openclaw 包是否可用。
 * - true：openclaw 已安装，alias 从 package.json exports 精确映射
 * - false：openclaw 不可用（Shim 部署），所有 openclaw/* 导入前缀匹配到 stub
 */
let openclawAvailable: boolean | null = null
let openclawAlias: Record<string, string> | null = null

function resolveOpenClawState(pluginDir?: string): void {
  if (openclawAvailable !== null) return

  let mainEntry: string | undefined
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mainEntry = require.resolve('openclaw')
  } catch {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mainEntry = require.resolve('openclaw', { paths: [pluginDir || __dirname] })
    } catch {
      // openclaw not available — will use prefix-based stub resolution
      openclawAvailable = false
      openclawAlias = {}
      return
    }
  }

  // openclaw available — build exact alias from package.json exports
  openclawAvailable = true
  const pkgRoot = path.resolve(path.dirname(mainEntry), '..')
  const pkgJsonPath = path.join(pkgRoot, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as {
    exports?: Record<string, unknown>
  }

  const alias: Record<string, string> = {
    openclaw: mainEntry,
  }

  for (const [key, val] of Object.entries(pkg.exports ?? {})) {
    if (key === '.') continue
    let target: unknown = val
    if (target && typeof target === 'object') {
      target = (target as Record<string, unknown>).default
    }
    if (typeof target !== 'string') continue
    const moduleName = 'openclaw' + key.slice(1)
    const resolvedPath = path.join(pkgRoot, target)
    if (fs.existsSync(resolvedPath)) {
      alias[moduleName] = resolvedPath
    }
  }
  openclawAlias = alias
}

/**
 * 解析 openclaw 模块请求。
 * - openclaw 可用时：精确 alias 查找
 * - openclaw 不可用时：所有 openclaw/* 前缀匹配到 stub
 */
function resolveOpenClawModule(request: string): string | undefined {
  if (openclawAlias && openclawAlias[request]) {
    return openclawAlias[request]
  }
  if (!openclawAvailable && request.startsWith('openclaw/')) {
    return OPENCLAW_STUB_PATH
  }
  return undefined
}

// ============================================================================
// 加载函数
// ============================================================================

export async function loadPlugin(
  pluginPath: string,
  channelRuntime: unknown
): Promise<LoadedPlugin> {
  let mod: Record<string, unknown>

  const ext = path.extname(pluginPath).toLowerCase()
  const isTs = ext === '.ts' || ext === '.mts' || ext === '.cts'

  // 确保 openclaw 解析状态已初始化
  resolveOpenClawState(path.dirname(pluginPath))

  // 安装 Module._resolveFilename hook：拦截所有 openclaw/* 导入
  // TS 和 JS 插件都需要（jiti 内部也走 require.resolve，alias 只支持精确匹配）
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const NodeModule = require('node:module') as {
    _resolveFilename: (...args: unknown[]) => string
    prototype: { _compile: (content: string, filename: string) => unknown }
  }
  const origResolve = NodeModule._resolveFilename
  NodeModule._resolveFilename = function (request: unknown, ...rest: unknown[]) {
    if (typeof request === 'string') {
      const resolved = resolveOpenClawModule(request)
      if (resolved) return resolved
    }
    return origResolve.call(this, request, ...rest)
  }

  try {
    if (isTs) {
      // TypeScript 插件（如 node_modules/@openclaw/feishu）：用 jiti 运行时转译
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { createJiti } = require('jiti') as {
        createJiti: (root: string, opts?: Record<string, unknown>) => (id: string) => unknown
      }
      const jitiLoad = createJiti(pluginPath, {
        interopDefault: true,
        moduleCache: false,
      })
      mod = jitiLoad(pluginPath) as Record<string, unknown>
    } else {
      // JavaScript 插件（shim CLI 安装到 extensions/ 的预编译包）
      // 额外问题：部分文件混用 CJS exports + ESM import.meta.url（TypeScript 编译产物）
      //   → Node.js 检测到 import.meta 后切换 ESM 加载，但 exports 在 ESM 中未定义
      //   → 用 Module._compile hook 把 import.meta.url 替换为 CJS 等价物
      const origCompile = NodeModule.prototype._compile
      NodeModule.prototype._compile = function (content: string, filename: string) {
        if (content.includes('import.meta.url')) {
          content = content.replace(
            /import\.meta\.url/g,
            'require("node:url").pathToFileURL(__filename).href'
          )
        }
        return origCompile.call(this, content, filename)
      }

      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        mod = require(pluginPath) as Record<string, unknown>
      } finally {
        NodeModule.prototype._compile = origCompile
      }
    }
  } finally {
    NodeModule._resolveFilename = origResolve
  }

  const rawPlugin = mod.default ?? mod.plugin ?? mod

  if (!rawPlugin || typeof rawPlugin !== 'object') {
    throw new Error(`Invalid OpenClaw plugin at ${pluginPath}: cannot find plugin export`)
  }

  const p = rawPlugin as Record<string, unknown>

  // ── 格式 1：OpenClawPluginDefinition { register(api) } ──────────────────
  if (typeof p.register === 'function') {
    return loadRegisterFormat(pluginPath, p, channelRuntime)
  }

  // ── 格式 2：简化格式 { gateway, config } ────────────────────────────────
  if (p.gateway && p.config) {
    return loadSimpleFormat(pluginPath, p, channelRuntime)
  }

  throw new Error(
    `Invalid OpenClaw plugin at ${pluginPath}: ` +
    `cannot find plugin interface (expected .register(api) or .gateway/.config)`
  )
}

// ============================================================================
// 提取 outbound adapter
// ============================================================================

/**
 * 从插件的 outbound 对象中提取 sendText/sendMedia 函数。
 *
 * OpenClaw 插件通过 createRuntimeOutboundDelegates 生成的 outbound 对象，
 * 其 sendText/sendMedia 已经是标准 async 函数（内部封装了 getRuntime → resolve → call 链）。
 */
function extractOutboundAdapter(
  rawOutbound: Record<string, unknown> | undefined
): OutboundAdapter | undefined {
  if (!rawOutbound) return undefined
  const sendText = typeof rawOutbound.sendText === 'function'
    ? rawOutbound.sendText as OutboundAdapter['sendText']
    : undefined
  const sendMedia = typeof rawOutbound.sendMedia === 'function'
    ? rawOutbound.sendMedia as OutboundAdapter['sendMedia']
    : undefined
  if (!sendText) return undefined
  return { sendText, sendMedia }
}

// ============================================================================
// 格式 1：OpenClawPluginDefinition { register(api) }
// ============================================================================

function loadRegisterFormat(
  pluginPath: string,
  pluginDef: Record<string, unknown>,
  channelRuntime: unknown
): LoadedPlugin {
  let capturedChannelPlugin: Record<string, unknown> | null = null

  // 构造假的 OpenClawPluginApi
  const fakeApi: Record<string, unknown> = {
    // ★ 核心：将 channelRuntime 注入为 api.runtime
    // 插件会将其存入模块单例（如 setFeishuRuntime(api.runtime)），
    // 后续所有 getFeishuRuntime().channel.reply.dispatchReplyFromConfig 等都指向我们的实现
    runtime: channelRuntime,

    // 捕获插件通过 api.registerChannel({ plugin }) 注册的 ChannelPlugin
    registerChannel(opts: unknown) {
      const o = opts as Record<string, unknown>
      if (o?.plugin && typeof o.plugin === 'object') {
        capturedChannelPlugin = o.plugin as Record<string, unknown>
      }
    },

    // 其他 api 方法的 no-op stub
    registerCli: () => {},
    registerTool: () => {},
    registerConfig: () => {},
    registerCommand: () => {},
    registerApp: () => {},
    registerAgent: () => {},
    registerSubagent: () => {},
    setStatus: () => {},
    on: () => {},
    config: {},
    logger: {
      debug: (msg: string) => console.debug('[Plugin]', msg),
      info: (msg: string) => console.log('[Plugin]', msg),
      warn: (msg: string) => console.warn('[Plugin]', msg),
      error: (msg: string) => console.error('[Plugin]', msg),
    },
  }

  // 调用 register —— 这会把 channelRuntime 存入插件单例，并捕获 ChannelPlugin
  ;(pluginDef.register as (api: unknown) => void)(fakeApi)

  if (!capturedChannelPlugin) {
    throw new Error(
      `Invalid OpenClaw plugin at ${pluginPath}: ` +
      `register(api) did not call api.registerChannel({ plugin })`
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const innerPlugin = capturedChannelPlugin as Record<string, unknown>

  // 验证 gateway.startAccount
  const gateway = innerPlugin.gateway as Record<string, unknown> | undefined
  if (!gateway || typeof gateway.startAccount !== 'function') {
    throw new Error(`Invalid OpenClaw plugin at ${pluginPath}: missing gateway.startAccount`)
  }

  // 验证 config.resolveAccount
  const config = innerPlugin.config as Record<string, unknown> | undefined
  if (!config || typeof config.resolveAccount !== 'function') {
    throw new Error(`Invalid OpenClaw plugin at ${pluginPath}: missing config.resolveAccount`)
  }

  // 验证 config.listAccountIds
  const listAccountIdsFn = typeof config.listAccountIds === 'function'
    ? config.listAccountIds as (cfg: unknown) => string[]
    : null

  // 捕获 outbound adapter（由 createRuntimeOutboundDelegates 生成的已解析函数）
  const rawOutbound = innerPlugin.outbound as Record<string, unknown> | undefined
  const outboundAdapter = extractOutboundAdapter(rawOutbound)

  return {
    startAccount({ cfg, abortSignal, account }) {
      // 为真实 OpenClaw 插件提供 ChannelGatewayContext
      const ctx = {
        cfg,
        runtime: {
          // RuntimeEnv：仅用于日志，不包含 channel.*（那些在 register 时已注入）
          log: (msg: string) => console.log('[Plugin]', msg),
          error: (msg: string) => console.error('[Plugin]', msg),
        },
        abortSignal,
        account,
        accountId: (account as Record<string, unknown> | null)?.accountId ?? null,
        setStatus: (status: unknown) => {
          console.log('[ChannelHost] Plugin status:', JSON.stringify(status))
        },
        log: {
          info: (msg: string) => console.log('[Plugin]', msg),
          warn: (msg: string) => console.warn('[Plugin]', msg),
          error: (msg: string) => console.error('[Plugin]', msg),
          debug: (msg: string) => console.debug('[Plugin]', msg),
        },
      }
      return (gateway.startAccount as (ctx: unknown) => Promise<void>)(ctx)
    },

    listAccountIds(cfg) {
      if (listAccountIdsFn) {
        return listAccountIdsFn(cfg)
      }
      return []
    },

    resolveAccount(cfg, accountId) {
      return (config.resolveAccount as (cfg: unknown, id?: string | null) => unknown)(
        cfg,
        accountId ?? null
      )
    },

    outbound: outboundAdapter,
  }
}

// ============================================================================
// 格式 2：简化格式 { gateway, config }
// ============================================================================

function loadSimpleFormat(
  pluginPath: string,
  plugin: Record<string, unknown>,
  channelRuntime: unknown
): LoadedPlugin {
  const gateway = plugin.gateway as Record<string, unknown>
  const config = plugin.config as Record<string, unknown>

  if (typeof gateway.startAccount !== 'function') {
    throw new Error(`Invalid OpenClaw plugin at ${pluginPath}: missing gateway.startAccount`)
  }
  if (typeof config.resolveAccount !== 'function') {
    throw new Error(`Invalid OpenClaw plugin at ${pluginPath}: missing config.resolveAccount`)
  }

  const listAccountIdsFn = typeof config.listAccountIds === 'function'
    ? config.listAccountIds as (cfg: unknown) => string[]
    : null

  // 捕获 outbound adapter
  const rawOutbound = plugin.outbound as Record<string, unknown> | undefined
  const outboundAdapter = extractOutboundAdapter(rawOutbound)

  return {
    startAccount({ cfg, abortSignal, account }) {
      // 简化格式：将 channelRuntime 作为 ctx.runtime 传入
      // 如果调用者传了 account 就用传入的，否则 fallback 调 resolveAccount（向后兼容）
      const resolvedAccount = account
        ?? (config.resolveAccount as (cfg: unknown) => unknown)(cfg)
      return (gateway.startAccount as (ctx: unknown) => Promise<void>)({
        cfg,
        runtime: channelRuntime,
        abortSignal,
        account: resolvedAccount,
      })
    },

    listAccountIds(cfg) {
      if (listAccountIdsFn) {
        return listAccountIdsFn(cfg)
      }
      return []
    },

    resolveAccount(cfg, accountId) {
      return (config.resolveAccount as (cfg: unknown, id?: string | null) => unknown)(
        cfg,
        accountId ?? null
      )
    },

    outbound: outboundAdapter,
  }
}
