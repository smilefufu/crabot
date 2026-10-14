import { ensureCorepack } from '../lib/toolchain.mjs'
import { selectPackageSource, packageEnvironment, withPackageSource } from '../lib/install-network.mjs'
import { prepareMemoryDependencies } from '../lib/memory-deps.mjs'
import { runBounded } from '../lib/scrapling-prepare.mjs'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SHARED_MODULE = 'crabot-shared'
const JS_MODULES = [
  'crabot-core',
  'crabot-admin',
  'crabot-agent',
  'crabot-channel-wechat',
  'crabot-channel-telegram',
  'crabot-channel-feishu',
  'crabot-channel-dingtalk',
  'crabot-mcp-tools',
]
const PY_MODULE = 'crabot-memory'
let privateCorepack

// Windows 的系统 corepack 是 .cmd shim；仅静态 pnpm 参数走 shell。
// Node/uv 的真实 executable 直接传参数，保留空格/中文路径。
const quoteWin = (s) => (/\s/.test(s) ? `"${s}"` : s)

function runCmd(cmd, args, cwd, logger, source) {
  if (cmd === 'corepack' && privateCorepack) { args = [privateCorepack, ...args]; cmd = process.execPath }
  logger.info(`$ ${cmd} ${args.join(' ')}    (cwd: ${cwd})`)
  const run = (env, timeout, captureError = false) => {
    if (process.platform === 'win32' && cmd === 'corepack') return runBounded(`corepack ${args.map(quoteWin).join(' ')}`, [], { cwd, env, timeout, captureError, shell: true })
    return runBounded(cmd, args, { cwd, env, timeout, captureError })
  }
  if (source && args.includes('install')) return withPackageSource(source, (url, env, remaining) => run(env, remaining, true), { logger })
  return run(source ? packageEnvironment('npm', source.url) : process.env)
}

// uv installer（https://astral.sh/uv）默认装到 ~/.local/bin/uv，但 Windows 上
// 写 user PATH 的传播有延迟——刚 install 完新开 cmd 也可能读不到。所以主动按
// 已知安装位置探测，绕开 PATH 不确定性。Windows shim 是 uv.exe，*nix 是 uv。
function findUv() {
  const isWin = process.platform === 'win32'
  const binName = isWin ? 'uv.exe' : 'uv'
  const candidates = [
    join(homedir(), '.local', 'bin', binName),
  ]
  if (isWin) {
    // 备用：旧版 astral installer 可能放过这里
    candidates.push(join(process.env.LOCALAPPDATA || '', 'Programs', 'uv', binName))
  }
  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  return 'uv' // fallback：寄希望于 PATH，找不到再让用户看到清晰错误
}

// 所有 pnpm 调用走 corepack，避免被用户机器上抢占 PATH 的全局 pnpm 干扰
// （否则可能用错 major 版本，把 lockfile v9.0 降级成 v5.4）
async function installAndBuild(moduleDir, logger, source) {
  // --prefer-offline：lock 未变时跳过网络 verify，毫秒级返回
  await runCmd('corepack', ['pnpm', 'install', '--prefer-offline'], moduleDir, logger, source)
  await runCmd('corepack', ['pnpm', 'run', 'build'], moduleDir, logger, source)
}

export async function runSourceUpgrade(crabotHome, logger) {
  const source = await selectPackageSource('npm', { logger })
  privateCorepack = await ensureCorepack(crabotHome, { source, logger })
  // 注意：不调 `corepack enable` —— 它会尝试往 Node 安装目录（Windows 下是
  // Program Files）写 pnpm/yarn 系统 shim，需要管理员权限。我们已经显式用
  // `corepack pnpm ...` 调用，corepack 会按 package.json 的 packageManager
  // 字段按需下载到用户 cache（%LOCALAPPDATA%\node\corepack）执行，不需要 enable。
  await runCmd('corepack', ['pnpm', 'install', '--prefer-offline'], crabotHome, logger, source)

  const sharedDir = join(crabotHome, SHARED_MODULE)
  if (existsSync(sharedDir)) {
    await installAndBuild(sharedDir, logger, source)
  }

  for (const mod of JS_MODULES) {
    const dir = join(crabotHome, mod)
    if (!existsSync(dir)) continue
    await installAndBuild(dir, logger, source)
  }

  // 前端
  const webDir = join(crabotHome, 'crabot-admin', 'web')
  if (existsSync(webDir)) {
    await installAndBuild(webDir, logger, source)
  }

  await runCmd('corepack', ['pnpm', 'run', 'build:cli'], crabotHome, logger, source)

  // scripts/lib 是独立 package（依赖 proper-lockfile 等），不属于 root workspace，要单独 install。
  // 没有 build 步骤，只装 prod deps。
  const scriptsLibDir = join(crabotHome, 'scripts', 'lib')
  if (existsSync(join(scriptsLibDir, 'package.json'))) {
    await runCmd('corepack', ['pnpm', 'install', '--prod', '--prefer-offline'], scriptsLibDir, logger, source)
  }

  const memoryDir = join(crabotHome, PY_MODULE)
  if (existsSync(memoryDir)) {
    await prepareMemoryDependencies(memoryDir, { dev: true, logger, uv: findUv() })
  }
  // 使用磁盘上的新准备入口，避免 UI git pull 后仍复用旧模块函数。
  await runCmd(process.execPath, [join(crabotHome, 'scripts', 'prepare-scrapling.mjs')], crabotHome, logger)
  await runCmd(process.execPath, [join(crabotHome, 'scripts', 'prepare-computer-use.mjs')], crabotHome, logger)
}

export async function syncPythonDeps(crabotHome, logger) {
  const memoryDir = join(crabotHome, PY_MODULE)
  if (existsSync(memoryDir)) {
    await prepareMemoryDependencies(memoryDir, { logger, uv: findUv() })
  }
}
