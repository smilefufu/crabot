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

function buildOpenClawAlias(pluginDir?: string): Record<string, string> {
  let mainEntry: string
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mainEntry = require.resolve('openclaw')
  } catch {
    // openclaw not in channel-host's node_modules, try plugin's own node_modules
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      mainEntry = require.resolve('openclaw', { paths: [pluginDir || __dirname] })
    } catch {
      // openclaw not available — use lightweight stubs
      const stubPath = path.join(OPENCLAW_STUB_DIR, 'plugin-sdk.cjs')
      return {
        'openclaw/plugin-sdk': stubPath,
        'openclaw/plugin-sdk/core': stubPath,
        'openclaw/plugin-sdk/compat': stubPath,
      }
    }
  }
  const pkgRoot = path.resolve(path.dirname(mainEntry), '..')  // .../openclaw/

  const pkgJsonPath = path.join(pkgRoot, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8')) as {
    exports?: Record<string, unknown>
  }

  const alias: Record<string, string> = {
    openclaw: mainEntry,  // 主入口
  }

  for (const [key, val] of Object.entries(pkg.exports ?? {})) {
    if (key === '.') continue  // 已通过 mainEntry 处理

    // 取 default 导出（优先），或直接字符串值
    let target: unknown = val
    if (target && typeof target === 'object') {
      target = (target as Record<string, unknown>).default
    }
    if (typeof target !== 'string') continue

    // key 形如 './plugin-sdk/feishu'，去掉开头的 './'
    const moduleName = 'openclaw' + key.slice(1)                    // openclaw/plugin-sdk/feishu
    const resolvedPath = path.join(pkgRoot, target)                 // .../dist/plugin-sdk/feishu.js

    if (fs.existsSync(resolvedPath)) {
      alias[moduleName] = resolvedPath
    }
  }

  return alias
}

// 模块加载时构建一次，复用（pluginDir 在此时未知，运行时按需重建）
let OPENCLAW_ALIAS: Record<string, string> | null = null
function getOpenClawAlias(pluginDir?: string): Record<string, string> {
  if (OPENCLAW_ALIAS === null) {
    OPENCLAW_ALIAS = buildOpenClawAlias(pluginDir)
  }
  return OPENCLAW_ALIAS
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

  if (isTs) {
    // TypeScript 插件（如 node_modules/@openclaw/feishu）：用 jiti 运行时转译
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createJiti } = require('jiti') as {
      createJiti: (root: string, opts?: Record<string, unknown>) => (id: string) => unknown
    }
    const jitiLoad = createJiti(pluginPath, {
      interopDefault: true,
      moduleCache: false,
      alias: getOpenClawAlias(path.dirname(pluginPath)),
    })
    mod = jitiLoad(pluginPath) as Record<string, unknown>
  } else {
    // JavaScript 插件（shim CLI 安装到 extensions/ 的预编译包）
    // 两个问题需要解决：
    // 1. 插件 require("openclaw/plugin-sdk") 但 openclaw 不在其 node_modules 里
    //    → 用 Module._resolveFilename hook 重定向到 stubs
    // 2. 部分文件混用 CJS exports + ESM import.meta.url（TypeScript 编译产物）
    //    → Node.js 检测到 import.meta 后切换 ESM 加载，但 exports 在 ESM 中未定义
    //    → 用 Module._compile hook 把 import.meta.url 替换为 CJS 等价物
    const alias = getOpenClawAlias(path.dirname(pluginPath))
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const NodeModule = require('node:module') as {
      _resolveFilename: (...args: unknown[]) => string
      prototype: { _compile: (content: string, filename: string) => unknown }
    }
    const origResolve = NodeModule._resolveFilename
    const origCompile = NodeModule.prototype._compile

    // Hook 1: openclaw/* → stubs
    NodeModule._resolveFilename = function (request: unknown, ...rest: unknown[]) {
      if (typeof request === 'string' && alias[request]) {
        return alias[request]
      }
      return origResolve.call(this, request, ...rest)
    }

    // Hook 2: import.meta.url → CJS __filename 等价物
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
      NodeModule._resolveFilename = origResolve
      NodeModule.prototype._compile = origCompile
    }
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
    registerApp: () => {},
    registerAgent: () => {},
    registerSubagent: () => {},
    setStatus: () => {},
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
  }
}
