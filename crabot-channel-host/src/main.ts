/**
 * Channel Host 模块入口
 */

import path from 'node:path'
import fs from 'node:fs'
import { ChannelHost } from './channel-host.js'

// ============================================================================
// 从 OPENCLAW_STATE_DIR 自动探测插件路径和配置
// ============================================================================

interface OpenClawStateConfig {
  pluginPath: string
  pluginConfig: unknown
}

function loadFromStateDir(stateDir: string): OpenClawStateConfig {
  // 策略 1：openclaw.json（@larksuite/openclaw-lark-tools install 写入的格式）
  const openclawJsonPath = path.join(stateDir, 'openclaw.json')
  if (fs.existsSync(openclawJsonPath)) {
    return loadFromOpenclawJson(stateDir, openclawJsonPath)
  }

  // 策略 2：config.json + extensions/（手动安装格式）
  const configPath = path.join(stateDir, 'config.json')
  if (!fs.existsSync(configPath)) {
    throw new Error(`OPENCLAW_STATE_DIR 中找不到 config.json 或 openclaw.json: ${stateDir}`)
  }
  const rawConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>

  // 探测插件入口路径
  // 支持两种安装结构：
  //   A. 直接放 index.ts（手动复制）：extensions/<name>/index.ts
  //   B. npm install 安装（向导默认）：extensions/<name>/node_modules/<pkg>/index.ts
  const extensionsDir = path.join(stateDir, 'extensions')
  let pluginPath: string | null = null

  if (fs.existsSync(extensionsDir)) {
    const pluginDirs = fs.readdirSync(extensionsDir)
    outer: for (const pluginDir of pluginDirs) {
      const base = path.join(extensionsDir, pluginDir)
      if (!fs.statSync(base).isDirectory()) continue

      // 结构 A：直接入口
      for (const entry of ['index.ts', 'src/index.ts', 'dist/index.js', 'index.js']) {
        const candidate = path.join(base, entry)
        if (fs.existsSync(candidate)) {
          pluginPath = candidate
          break outer
        }
      }

      // 结构 B：npm install 生成的 node_modules/<scope>/<pkg>/<entry>
      const nodeModules = path.join(base, 'node_modules')
      if (fs.existsSync(nodeModules)) {
        // 从 package.json 读取声明的依赖包名（向导写入的）
        let hintPackages: string[] | undefined
        const pluginPkgJson = path.join(base, 'package.json')
        if (fs.existsSync(pluginPkgJson)) {
          const pkgData = JSON.parse(fs.readFileSync(pluginPkgJson, 'utf-8')) as {
            dependencies?: Record<string, string>
          }
          hintPackages = Object.keys(pkgData.dependencies ?? {})
        }
        const pkgEntries = findNpmPackageEntry(nodeModules, hintPackages)
        if (pkgEntries) {
          pluginPath = pkgEntries
          break outer
        }
      }
    }
  }

  if (!pluginPath) {
    throw new Error(`OPENCLAW_STATE_DIR 中找不到已安装的 OpenClaw 插件: ${extensionsDir}`)
  }

  return { pluginPath, pluginConfig: rawConfig }
}

/**
 * 从 openclaw.json 加载配置和插件路径
 *
 * 两种安装方式，对应两种插件位置：
 *
 * 1. npm 依赖式（飞书 @larksuite/openclaw-lark-tools install）：
 *    插件是 channel-host 的 npm 依赖，在 node_modules/@openclaw/<platform>
 *    openclaw.json 只有 plugins.entries + channels 配置，没有 plugins.installs
 *
 * 2. shim CLI 安装式（微信 openclaw plugins install）：
 *    插件通过 npm pack 下载到 extensions/<plugin-id>/
 *    openclaw.json 有 plugins.installs[id].installPath 指向具体目录
 */
function loadFromOpenclawJson(_stateDir: string, jsonPath: string): OpenClawStateConfig {
  const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8')) as {
    plugins?: {
      entries?: Record<string, { enabled?: boolean }>
      installs?: Record<string, { installPath?: string }>
    }
    channels?: Record<string, Record<string, unknown>>
  }

  const pluginConfig = data
  const entries = data.plugins?.entries ?? {}
  const installs = data.plugins?.installs ?? {}

  // 路径 1：shim CLI 安装的插件，有明确的 installPath
  for (const [pluginId, installInfo] of Object.entries(installs)) {
    if (entries[pluginId]?.enabled === false) continue
    if (!installInfo.installPath) continue

    const pluginPath = findPackageEntry(installInfo.installPath)
    if (pluginPath) {
      console.log(`[ChannelHost] Loaded plugin "${pluginId}" from ${installInfo.installPath}`)
      return { pluginPath, pluginConfig }
    }
  }

  // 路径 2：npm 依赖式插件，从 channel 名推断包名，在 node_modules/@openclaw/<platform>
  const channels = data.channels ?? {}
  const enabledChannelName = Object.keys(channels).find(
    (name) => channels[name].enabled !== false
  )
  if (enabledChannelName) {
    const platform = inferPlatformFromChannel(enabledChannelName)
    const hostNodeModules = path.resolve(__dirname, '..', 'node_modules')
    const pkgDir = path.join(hostNodeModules, '@openclaw', platform)
    if (fs.existsSync(pkgDir)) {
      const pluginPath = findPackageEntry(pkgDir)
      if (pluginPath) {
        console.log(`[ChannelHost] Loaded plugin @openclaw/${platform} from node_modules`)
        return { pluginPath, pluginConfig }
      }
    }
  }

  throw new Error(
    `openclaw.json 中没有可加载的插件: ${jsonPath}`
  )
}

/**
 * 从 channel 名称推断 OpenClaw 插件平台
 */
function inferPlatformFromChannel(channelName: string): string {
  const mapping: Record<string, string> = {
    feishu: 'feishu',
    lark: 'feishu',
    dingtalk: 'dingtalk',
    slack: 'slack',
    wechat: 'wechat',
    wecom: 'wechat',
    telegram: 'telegram',
    discord: 'discord',
  }
  return mapping[channelName.toLowerCase()] ?? channelName
}

/**
 * 在 node_modules 目录中递归查找 OpenClaw 插件入口文件
 * 支持 @scope/pkg 和 pkg 两种包名格式
 * 通过 openclaw.plugin.json 标记识别真正的插件包
 */
function findNpmPackageEntry(nodeModulesDir: string, hintPackages?: string[]): string | null {
  // 如果有从 package.json dependencies 读到的提示包名，优先查找
  if (hintPackages) {
    for (const pkgName of hintPackages) {
      const pkgDir = path.join(nodeModulesDir, pkgName)
      if (fs.existsSync(pkgDir)) {
        const entry = findPackageEntry(pkgDir)
        if (entry) return entry
      }
    }
  }

  // 否则遍历 node_modules，找有 openclaw.plugin.json 标记的包
  const entries = fs.readdirSync(nodeModulesDir)
  for (const entry of entries) {
    const pkgBase = path.join(nodeModulesDir, entry)
    if (!fs.statSync(pkgBase).isDirectory()) continue

    if (entry.startsWith('@')) {
      const scopedPkgs = fs.readdirSync(pkgBase)
      for (const pkg of scopedPkgs) {
        const pkgDir = path.join(pkgBase, pkg)
        // 只认有 openclaw.plugin.json 的包
        if (fs.existsSync(path.join(pkgDir, 'openclaw.plugin.json'))) {
          const result = findPackageEntry(pkgDir)
          if (result) return result
        }
      }
    } else {
      if (fs.existsSync(path.join(pkgBase, 'openclaw.plugin.json'))) {
        const result = findPackageEntry(pkgBase)
        if (result) return result
      }
    }
  }
  return null
}

/**
 * 从单个包目录中读取入口文件（按 package.json 的 main 字段或约定路径）
 */
function findPackageEntry(pkgDir: string): string | null {
  const pkgJson = path.join(pkgDir, 'package.json')
  if (!fs.existsSync(pkgJson)) return null

  const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf-8')) as Record<string, unknown>

  // 优先 TypeScript 源码（jiti 可直接加载）
  for (const tsEntry of ['index.ts', 'src/index.ts']) {
    const candidate = path.join(pkgDir, tsEntry)
    if (fs.existsSync(candidate)) return candidate
  }

  // 退回 main 字段
  if (typeof pkg.main === 'string') {
    const candidate = path.join(pkgDir, pkg.main)
    if (fs.existsSync(candidate)) return candidate
  }

  // 约定路径
  for (const fallback of ['dist/index.js', 'index.js']) {
    const candidate = path.join(pkgDir, fallback)
    if (fs.existsSync(candidate)) return candidate
  }

  return null
}

// ============================================================================
// 入口
// ============================================================================

async function main(): Promise<void> {
  const moduleId = process.env.Crabot_MODULE_ID ?? 'channel-host'
  const port = parseInt(process.env.Crabot_PORT ?? '19010', 10)
  const dataDir = process.env.DATA_DIR ?? path.join(process.cwd(), 'data')

  let pluginPath: string
  let pluginConfig: unknown

  const stateDir = process.env.OPENCLAW_STATE_DIR

  if (stateDir) {
    // 从 OPENCLAW_STATE_DIR 自动探测（@larksuite/openclaw-lark-tools install 写入的目录）
    const resolved = path.isAbsolute(stateDir) ? stateDir : path.resolve(process.cwd(), stateDir)
    const loaded = loadFromStateDir(resolved)
    pluginPath = loaded.pluginPath
    pluginConfig = loaded.pluginConfig
    console.log(`[ChannelHost] Loading from OPENCLAW_STATE_DIR: ${resolved}`)
  } else {
    // 传统模式：直接传入 OPENCLAW_PLUGIN_PATH + OPENCLAW_CONFIG
    const rawPluginPath = process.env.OPENCLAW_PLUGIN_PATH
    if (!rawPluginPath) {
      console.error('必须设置 OPENCLAW_PLUGIN_PATH 或 OPENCLAW_STATE_DIR')
      process.exit(1)
    }

    const pluginConfigRaw = process.env.OPENCLAW_CONFIG ?? '{}'
    try {
      pluginConfig = JSON.parse(pluginConfigRaw)
    } catch {
      console.error('OPENCLAW_CONFIG 必须是合法 JSON')
      process.exit(1)
    }

    pluginPath = path.isAbsolute(rawPluginPath)
      ? rawPluginPath
      : path.resolve(process.cwd(), rawPluginPath)
  }

  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true })
  }

  const channel = new ChannelHost({
    module_id: moduleId,
    module_type: 'channel',
    version: '0.1.0',
    protocol_version: '0.1.0',
    port,
    data_dir: dataDir,
    state_dir: stateDir ? (path.isAbsolute(stateDir) ? stateDir : path.resolve(process.cwd(), stateDir)) : undefined,
    plugin_path: pluginPath,
    plugin_config: pluginConfig,
  })

  process.on('SIGINT', () => {
    console.log('\nReceived SIGINT, shutting down...')
    channel.stop().then(() => process.exit(0)).catch(() => process.exit(1))
  })

  process.on('SIGTERM', () => {
    console.log('\nReceived SIGTERM, shutting down...')
    channel.stop().then(() => process.exit(0)).catch(() => process.exit(1))
  })

  try {
    await channel.start()
    await channel.register()
    console.log('Channel Host module started successfully')
    console.log(`- Module ID: ${moduleId}`)
    console.log(`- Port: ${port}`)
    console.log(`- Data Dir: ${dataDir}`)
    console.log(`- Plugin: ${pluginPath}`)
  } catch (error) {
    console.error('Failed to start Channel Host module:', error)
    process.exit(1)
  }
}

main().catch(console.error)
