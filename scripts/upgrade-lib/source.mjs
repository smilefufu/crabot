import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const SHARED_MODULE = 'crabot-shared'
const JS_MODULES = [
  'crabot-core',
  'crabot-admin',
  'crabot-agent',
  'crabot-channel-host',
  'crabot-channel-wechat',
  'crabot-channel-telegram',
  'crabot-channel-feishu',
  'crabot-mcp-tools',
]
const PY_MODULE = 'crabot-memory'

function runCmd(cmd, args, cwd, logger) {
  return new Promise((resolve, reject) => {
    logger.info(`$ ${cmd} ${args.join(' ')}    (cwd: ${cwd})`)
    const proc = spawn(cmd, args, { cwd, stdio: 'inherit' })
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`))
    })
  })
}

// 所有 pnpm 调用走 corepack，避免被用户机器上抢占 PATH 的全局 pnpm 干扰
// （否则可能用错 major 版本，把 lockfile v9.0 降级成 v5.4）
async function installAndBuild(moduleDir, logger) {
  // --prefer-offline：lock 未变时跳过网络 verify，毫秒级返回
  await runCmd('corepack', ['pnpm', 'install', '--prefer-offline'], moduleDir, logger)
  await runCmd('corepack', ['pnpm', 'run', 'build'], moduleDir, logger)
}

async function ensurePnpm(crabotHome, logger) {
  // 通过 corepack 激活根 package.json packageManager 字段指定的 pnpm 版本
  await runCmd('corepack', ['enable'], crabotHome, logger)
  await runCmd('corepack', ['prepare', '--activate'], crabotHome, logger)
}

export async function runSourceUpgrade(crabotHome, logger) {
  await ensurePnpm(crabotHome, logger)

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

  const memoryDir = join(crabotHome, PY_MODULE)
  if (existsSync(memoryDir)) {
    await runCmd('uv', ['sync'], memoryDir, logger)
  }
}

export async function syncPythonDeps(crabotHome, logger) {
  const memoryDir = join(crabotHome, PY_MODULE)
  if (existsSync(memoryDir)) {
    await runCmd('uv', ['sync'], memoryDir, logger)
  }
}
