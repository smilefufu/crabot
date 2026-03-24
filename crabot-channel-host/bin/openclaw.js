#!/usr/bin/env node
/**
 * openclaw shim — 完全替代 OpenClaw CLI
 *
 * Crabot channel-host 的 Shim 层兼容 OpenClaw channel 插件生态，
 * 但**不依赖 OpenClaw 本身**。本 shim 自主处理所有 CLI 命令。
 *
 * 安装向导（如 @tencent-weixin/openclaw-weixin-cli）的调用序列：
 *   1. which openclaw                               → PATH 上有本文件即可
 *   2. openclaw plugins install "@scope/plugin-pkg"  → npm pack + 解压到 stateDir/extensions/
 *   3. openclaw channels login --channel <id>        → 加载插件 gateway，执行 QR 登录流程
 *   4. openclaw gateway restart                      → no-op（channel-host 热插拔，无需重启）
 *
 * 使用方式：
 *   ln -sf /path/to/crabot-channel-host/bin/openclaw.js ~/.bin/openclaw
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const args = process.argv.slice(2)
const command = args[0]
const subcommand = args[1]

// ── 配置 ──

function resolveStateDir() {
  return process.env.OPENCLAW_STATE_DIR
    || process.env.OPENCLAW_CONFIG_DIR
    || path.join(require('os').homedir(), '.openclaw')
}

function resolveConfigPath() {
  return process.env.OPENCLAW_CONFIG_PATH
    || path.join(resolveStateDir(), 'openclaw.json')
}

// ── 配置读写 ──

function readConfig() {
  const configPath = resolveConfigPath()
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf-8'))
  } catch {
    return {}
  }
}

function writeConfig(cfg) {
  const configPath = resolveConfigPath()
  const dir = path.dirname(configPath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n')
}

function writeInstallMarker() {
  const stateDir = process.env.OPENCLAW_STATE_DIR
  if (!stateDir) return
  try {
    const markerPath = path.join(stateDir, '.install-complete')
    fs.writeFileSync(markerPath, JSON.stringify({ timestamp: new Date().toISOString() }))
  } catch {
    // 写入失败不影响安装结果
  }
}

// ── plugins 命令 ──

/**
 * 从 npm 包中提取 plugin-id
 *
 * 优先读 openclaw.plugin.json 的 id，否则用 package.json 的 name
 */
function resolvePluginId(pluginDir) {
  // 1. openclaw.plugin.json
  const manifestPath = path.join(pluginDir, 'openclaw.plugin.json')
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    if (manifest.id) return manifest.id
  } catch {
    // 没有 manifest
  }
  // 2. package.json name
  const pkgPath = path.join(pluginDir, 'package.json')
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
    if (pkg.name) {
      // @scope/name → 去掉 scope 前缀作为 id
      const name = pkg.name.replace(/^@[^/]+\//, '')
      return name
    }
  } catch {
    // 没有 package.json
  }
  return path.basename(pluginDir)
}

/**
 * openclaw plugins install "<npm-spec>"
 *
 * 用 npm pack 下载包，解压到 stateDir/extensions/<plugin-id>/，
 * 然后更新 openclaw.json
 */
function handlePluginsInstall(spec) {
  const stateDir = resolveStateDir()
  const extensionsDir = path.join(stateDir, 'extensions')
  fs.mkdirSync(extensionsDir, { recursive: true })

  // 1. npm pack 到临时目录
  const tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'openclaw-install-'))
  try {
    const packResult = spawnSync('npm', ['pack', spec, '--pack-destination', tmpDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
    })

    if (packResult.status !== 0) {
      const stderr = (packResult.stderr || '').trim()
      console.error(`[crabot-shim] npm pack failed: ${stderr}`)
      process.exit(1)
    }

    // 找到生成的 tarball
    const tarballs = fs.readdirSync(tmpDir).filter(f => f.endsWith('.tgz'))
    if (tarballs.length === 0) {
      console.error('[crabot-shim] npm pack produced no tarball')
      process.exit(1)
    }
    const tarball = path.join(tmpDir, tarballs[0])

    // 2. 解压到临时子目录
    const extractDir = path.join(tmpDir, 'extracted')
    fs.mkdirSync(extractDir)
    spawnSync('tar', ['xzf', tarball, '-C', extractDir], { stdio: 'pipe' })

    // npm pack 解压后在 extractDir/package/ 下
    const packageDir = path.join(extractDir, 'package')
    if (!fs.existsSync(packageDir)) {
      console.error('[crabot-shim] Unexpected tarball structure')
      process.exit(1)
    }

    // 3. 确定 plugin-id
    const pluginId = resolvePluginId(packageDir)

    // 4. 复制到 extensions/<plugin-id>/
    const targetDir = path.join(extensionsDir, pluginId)
    if (fs.existsSync(targetDir)) {
      fs.rmSync(targetDir, { recursive: true })
    }
    fs.cpSync(packageDir, targetDir, { recursive: true })

    // 5. 安装依赖（如果有 package.json）
    const pkgJsonPath = path.join(targetDir, 'package.json')
    if (fs.existsSync(pkgJsonPath)) {
      const npmInstall = spawnSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], {
        cwd: targetDir,
        stdio: 'pipe',
      })
      if (npmInstall.status !== 0) {
        console.error('[crabot-shim] Warning: npm install in plugin dir failed, plugin may not work')
      }
    }

    // 6. 更新 openclaw.json
    const cfg = readConfig()
    if (!cfg.plugins) cfg.plugins = {}
    if (!cfg.plugins.entries) cfg.plugins.entries = {}
    if (!cfg.plugins.installs) cfg.plugins.installs = {}

    cfg.plugins.entries[pluginId] = { enabled: true }
    cfg.plugins.installs[pluginId] = {
      source: 'npm',
      spec,
      installPath: targetDir,
      installedAt: new Date().toISOString(),
    }

    // 确保 allow 列表包含此插件（如果 allow 数组已存在）
    if (Array.isArray(cfg.plugins.allow) && !cfg.plugins.allow.includes(pluginId)) {
      cfg.plugins.allow.push(pluginId)
    }

    writeConfig(cfg)
    console.log(`Plugin "${pluginId}" installed to ${targetDir}`)

  } finally {
    // 清理临时目录
    try { fs.rmSync(tmpDir, { recursive: true }) } catch { /* ignore */ }
  }
}

function handlePluginsUpdate(channelId) {
  // update = 重新 install
  // 从现有 config 中找到原始 spec
  const cfg = readConfig()
  const install = cfg.plugins?.installs?.[channelId]
  if (install?.spec) {
    handlePluginsInstall(install.spec)
  } else {
    console.log(`Plugin "${channelId}" not found in installs, nothing to update`)
  }
}

function handlePluginsList() {
  const cfg = readConfig()
  const entries = cfg.plugins?.entries || {}
  const ids = Object.keys(entries)
  if (ids.length === 0) {
    console.log('No plugins installed')
    return
  }
  for (const id of ids) {
    const enabled = entries[id]?.enabled ? '✓' : '✗'
    const installInfo = cfg.plugins?.installs?.[id]
    const source = installInfo?.source || 'unknown'
    console.log(`  ${enabled} ${id} (${source})`)
  }
}

// ── 插件加载（用于 channels login） ──

/**
 * 将 openclaw 包的 exports 字段展开为 jiti alias map。
 * CommonJS 版本，从 plugin-loader.ts 提取。
 */
function buildOpenClawAlias(pluginDir) {
  let mainEntry
  try {
    mainEntry = require.resolve('openclaw')
  } catch {
    // openclaw not in shim's node_modules, try plugin's own node_modules
    try {
      mainEntry = require.resolve('openclaw', { paths: [pluginDir || __dirname] })
    } catch {
      // openclaw not available — return empty alias, plugin may still work
      return {}
    }
  }
  const pkgRoot = path.resolve(path.dirname(mainEntry), '..')
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf-8'))
  const alias = { openclaw: mainEntry }
  for (const [key, val] of Object.entries(pkg.exports ?? {})) {
    if (key === '.') continue
    let target = val
    if (target && typeof target === 'object') target = target.default
    if (typeof target !== 'string') continue
    const moduleName = 'openclaw' + key.slice(1)
    const resolvedPath = path.join(pkgRoot, target)
    if (fs.existsSync(resolvedPath)) alias[moduleName] = resolvedPath
  }
  return alias
}

/**
 * 加载插件并返回 gateway 对象。
 * 复用 plugin-loader.ts 的 register 模式，但只需要 gateway（不需要 startAccount/resolveAccount）。
 */
function loadPluginGateway(pluginDir) {
  // 找插件入口文件
  let entryPath = null
  const indexTs = path.join(pluginDir, 'index.ts')
  const indexJs = path.join(pluginDir, 'index.js')
  if (fs.existsSync(indexTs)) {
    entryPath = indexTs
  } else if (fs.existsSync(indexJs)) {
    entryPath = indexJs
  } else {
    const pkgPath = path.join(pluginDir, 'package.json')
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'))
      const main = pkg.main || pkg.module
      if (main) entryPath = path.join(pluginDir, main)
    }
  }
  if (!entryPath || !fs.existsSync(entryPath)) {
    throw new Error(`Cannot find plugin entry in ${pluginDir}`)
  }

  // 加载模块（TypeScript 用 jiti，JS 用 require）
  const ext = path.extname(entryPath).toLowerCase()
  const isTs = ext === '.ts' || ext === '.mts' || ext === '.cts'
  let mod

  if (isTs) {
    const { createJiti } = require('jiti')
    const jitiLoad = createJiti(entryPath, {
      interopDefault: true,
      moduleCache: false,
      alias: buildOpenClawAlias(pluginDir),
    })
    mod = jitiLoad(entryPath)
  } else {
    mod = require(entryPath)
  }

  const rawPlugin = mod.default ?? mod.plugin ?? mod
  if (!rawPlugin || typeof rawPlugin !== 'object') {
    throw new Error(`Invalid plugin at ${entryPath}`)
  }

  // 格式 1：register(api) — 捕获 gateway
  if (typeof rawPlugin.register === 'function') {
    let capturedGateway = null
    const fakeApi = {
      runtime: {},  // login 不依赖 channelRuntime
      registerChannel(opts) {
        if (opts?.plugin?.gateway) capturedGateway = opts.plugin.gateway
      },
      registerCli: () => {},
      registerTool: () => {},
      registerConfig: () => {},
      registerApp: () => {},
      registerAgent: () => {},
      registerSubagent: () => {},
      setStatus: () => {},
      logger: {
        debug: () => {},
        info: (...a) => console.log('[Plugin]', ...a),
        warn: (...a) => console.warn('[Plugin]', ...a),
        error: (...a) => console.error('[Plugin]', ...a),
      },
    }
    rawPlugin.register(fakeApi)
    if (!capturedGateway) {
      throw new Error(`Plugin register(api) did not provide gateway`)
    }
    return capturedGateway
  }

  // 格式 2：简化格式 { gateway }
  if (rawPlugin.gateway) {
    return rawPlugin.gateway
  }

  throw new Error(`Cannot find gateway in plugin at ${entryPath}`)
}

// ── channels 命令 ──

async function handleChannelsLogin(channelId) {
  const cfg = readConfig()
  const installInfo = cfg.plugins?.installs?.[channelId]

  if (!installInfo?.installPath) {
    console.log(`[crabot-shim] Plugin "${channelId}" not installed, skipping login.`)
    console.log(`  请先安装插件，或在 Crabot Admin UI 中配置 channel 凭据。`)
    return
  }

  const pluginDir = installInfo.installPath

  // 加载插件 gateway
  let gateway
  try {
    gateway = loadPluginGateway(pluginDir)
  } catch (err) {
    console.log(`[crabot-shim] Cannot load plugin for login: ${err.message}`)
    console.log(`  请在 Crabot Admin UI 中手动配置 channel 凭据。`)
    return
  }

  // 检查插件是否支持 QR 登录
  if (typeof gateway.loginWithQrStart !== 'function') {
    console.log(`[crabot-shim] Plugin "${channelId}" does not support QR login.`)
    console.log(`  请在 Crabot Admin UI 中配置 channel 凭据。`)
    return
  }

  // 执行 QR 登录流程
  try {
    console.log(`[crabot-shim] Starting login for "${channelId}"...`)
    const startResult = await Promise.race([
      gateway.loginWithQrStart({ verbose: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('QR start timed out (30s)')), 30000)),
    ])
    const { qrDataUrl, message, sessionKey } = startResult || {}

    // 显示 QR 码
    if (qrDataUrl) {
      let qrterm = null
      try {
        qrterm = require(path.join(pluginDir, 'node_modules', 'qrcode-terminal'))
      } catch {
        // qrcode-terminal 不在插件目录，尝试全局
        try { qrterm = require('qrcode-terminal') } catch { /* not available */ }
      }

      if (qrterm) {
        await new Promise((resolve) => {
          qrterm.generate(qrDataUrl, { small: true }, (qr) => {
            console.log(qr)
            resolve()
          })
        })
      } else {
        console.log(`二维码链接: ${qrDataUrl}`)
      }
    }

    if (message) console.log(message)

    // 等待扫码完成
    const waitResult = await gateway.loginWithQrWait({
      sessionKey,
      timeoutMs: 480000,
    })

    if (waitResult?.connected) {
      console.log(waitResult.message || '✅ 登录成功！')

      // 更新 openclaw.json 添加 channels 段
      const updatedCfg = readConfig()
      const newChannels = { ...(updatedCfg.channels || {}), [channelId]: { enabled: true } }
      writeConfig({ ...updatedCfg, channels: newChannels })
    } else {
      console.log(waitResult?.message || '登录未完成，请稍后重试。')
    }
  } catch (err) {
    console.log(`[crabot-shim] Login failed: ${err.message}`)
    console.log(`  登录未完成，不影响后续安装步骤。`)
  }
}

function handleChannelsList() {
  const cfg = readConfig()
  const channels = cfg.channels || {}
  const ids = Object.keys(channels)
  if (ids.length === 0) {
    console.log('No channels configured')
    return
  }
  for (const id of ids) {
    const enabled = channels[id]?.enabled !== false ? '✓' : '✗'
    console.log(`  ${enabled} ${id}`)
  }
}

// ── gateway 命令 ──

/**
 * gateway restart 在 OpenClaw 中的目的是让 gateway 重新加载新安装的插件。
 * 在 Crabot 中，channel-host 实例是热插拔的——每个实例按需由 Admin 通过 MM 创建，
 * 不存在需要"重启 gateway 以加载插件"的场景。所以这里是纯 no-op。
 */
function handleGatewayRestart() {
  writeInstallMarker()
  console.log('[crabot-shim] Gateway restart acknowledged')
  process.exit(0)
}

// ── 主路由 ──

// openclaw --version / -v
if (command === '--version' || command === '-v' || command === 'version') {
  console.log('openclaw/2026.3.13 crabot-shim node-' + process.version)
  process.exit(0)
}

// openclaw plugins <subcommand>
if (command === 'plugins') {
  if (subcommand === 'install') {
    const spec = args[2]
    if (!spec) {
      console.error('Usage: openclaw plugins install "<npm-package-spec>"')
      process.exit(1)
    }
    handlePluginsInstall(spec)
    process.exit(0)
  }
  if (subcommand === 'update') {
    handlePluginsUpdate(args[2])
    process.exit(0)
  }
  if (subcommand === 'list' || subcommand === 'ls') {
    handlePluginsList()
    process.exit(0)
  }
  // 其他 plugins 子命令，静默成功
  process.exit(0)
}

// openclaw channels <subcommand>
if (command === 'channels') {
  if (subcommand === 'login') {
    // 解析 --channel <id>
    const channelIdx = args.indexOf('--channel')
    const channelId = channelIdx >= 0 ? args[channelIdx + 1] : args[2]
    if (!channelId) {
      console.error('Usage: openclaw channels login --channel <channel-id>')
      process.exit(1)
    }
    handleChannelsLogin(channelId).then(() => {
      process.exit(0)
    }).catch((err) => {
      console.error(`[crabot-shim] Login error: ${err.message}`)
      process.exit(1)
    })
    return  // 不继续执行后面的同步 exit
  }
  if (subcommand === 'list' || subcommand === 'ls') {
    handleChannelsList()
    process.exit(0)
  }
  process.exit(0)
}

// openclaw gateway <subcommand>
if (command === 'gateway') {
  if (subcommand === 'restart' || subcommand === 'start') {
    handleGatewayRestart()
  }
  if (subcommand === 'stop') {
    console.log('[crabot-shim] Gateway stopped')
  }
  process.exit(0)
}

// 其他 / 未知命令 —— 静默成功
process.exit(0)
