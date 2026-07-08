import { spawn } from 'node:child_process'
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

// Windows 上 corepack/pnpm/uv/npx 是 .cmd shim：
// - 不开 shell → ENOENT（找不到 .cmd 后缀）；显式拼 .cmd 后缀 → Node 21+ 因
//   CVE-2024-27980 强制要求 .cmd 必须走 shell，否则 EINVAL。
// - 开 shell:true + args 数组 → 触发 Node 24 的 DEP0190 警告。
// 所以走「拼成单字符串 + shell:true + args 空数组」：args 不是数组就不触发警告，
// 单字符串也让 shell 自动按 PATHEXT 找 .cmd shim。
// 安全：本文件所有 cmd/args 都是源码硬编码字符串，无用户输入，无注入风险。
const quoteWin = (s) => (/\s/.test(s) ? `"${s}"` : s)

function runCmd(cmd, args, cwd, logger) {
  return new Promise((resolve, reject) => {
    const display = `${cmd} ${args.join(' ')}`
    logger.info(`$ ${display}    (cwd: ${cwd})`)
    const isWin = process.platform === 'win32'
    // cmd 可能是绝对路径（如 findUv() 返回 C:\Users\Foo Bar\.local\bin\uv.exe），含空格要 quote
    const winCmdLine = `${quoteWin(cmd)} ${args.map(quoteWin).join(' ')}`
    const proc = isWin
      ? spawn(winCmdLine, [], { cwd, stdio: 'inherit', shell: true })
      : spawn(cmd, args, { cwd, stdio: 'inherit' })
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${display} exited with code ${code}`))
    })
  })
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
async function installAndBuild(moduleDir, logger) {
  // --prefer-offline：lock 未变时跳过网络 verify，毫秒级返回
  await runCmd('corepack', ['pnpm', 'install', '--prefer-offline'], moduleDir, logger)
  await runCmd('corepack', ['pnpm', 'run', 'build'], moduleDir, logger)
}

export async function runSourceUpgrade(crabotHome, logger) {
  // 注意：不调 `corepack enable` —— 它会尝试往 Node 安装目录（Windows 下是
  // Program Files）写 pnpm/yarn 系统 shim，需要管理员权限。我们已经显式用
  // `corepack pnpm ...` 调用，corepack 会按 package.json 的 packageManager
  // 字段按需下载到用户 cache（%LOCALAPPDATA%\node\corepack）执行，不需要 enable。
  await runCmd('corepack', ['pnpm', 'install', '--prefer-offline'], crabotHome, logger)

  const sharedDir = join(crabotHome, SHARED_MODULE)
  if (existsSync(sharedDir)) {
    await installAndBuild(sharedDir, logger)
  }

  for (const mod of JS_MODULES) {
    const dir = join(crabotHome, mod)
    if (!existsSync(dir)) continue
    await installAndBuild(dir, logger)
  }

  // 前端
  const webDir = join(crabotHome, 'crabot-admin', 'web')
  if (existsSync(webDir)) {
    await installAndBuild(webDir, logger)
  }

  await runCmd('corepack', ['pnpm', 'run', 'build:cli'], crabotHome, logger)

  // scripts/lib 是独立 package（依赖 proper-lockfile 等），不属于 root workspace，要单独 install。
  // 没有 build 步骤，只装 prod deps。
  const scriptsLibDir = join(crabotHome, 'scripts', 'lib')
  if (existsSync(join(scriptsLibDir, 'package.json'))) {
    await runCmd('corepack', ['pnpm', 'install', '--prod', '--prefer-offline'], scriptsLibDir, logger)
  }

  const memoryDir = join(crabotHome, PY_MODULE)
  if (existsSync(memoryDir)) {
    await runCmd(findUv(), ['sync'], memoryDir, logger)
  }
}

export async function syncPythonDeps(crabotHome, logger) {
  const memoryDir = join(crabotHome, PY_MODULE)
  if (existsSync(memoryDir)) {
    await runCmd(findUv(), ['sync'], memoryDir, logger)
  }
}
