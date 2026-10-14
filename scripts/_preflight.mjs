// scripts/_preflight.mjs
//
// CLI 在动态加载 bootstrap entry 前先 await 此模块，确保第三方依赖可被链接。
// entry 的 side-effect import 复用已经完成的检查；静态 import 顺序不能修复链接缺依赖。
//
// 用途：兼容老版本升级路径漏装 scripts/lib 依赖的场景。scripts/lib 是独立 npm 包
// （依赖 proper-lockfile 等），不属于 root workspace；老版本 install.sh / upgrade
// 流程没装它，老用户升到新版后第一次 start 时 import lib/registry.mjs 会崩。
//
// 这里 detect 缺失 → 自动跑一次 corepack pnpm install --prod；失败给出明确指引。

import { existsSync, accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { ensureCorepack } from './lib/toolchain.mjs'
import { runBounded } from './lib/scrapling-prepare.mjs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const scriptsLibDir = resolve(__dirname, 'lib')
const pkg = resolve(scriptsLibDir, 'package.json')
let missing = false
if (existsSync(pkg)) {
  try { createRequire(pkg).resolve('proper-lockfile') } catch { missing = true }
}

if (missing) {
  if (process.getuid?.() !== 0 && existsSync('/etc/crabot/cluster.version')) throw new Error('Shared dependencies are missing; ask the administrator to repair the system installation')
  accessSync(scriptsLibDir, constants.W_OK)
  console.log('[crabot] scripts/lib deps missing, auto-installing once...')
  try {
    const corepack = await ensureCorepack(resolve(__dirname, '..'))
    const args = ['pnpm', 'install', '--prod', '--prefer-offline']
    if (corepack) await runBounded(process.execPath, [corepack, ...args], { cwd: scriptsLibDir })
    else if (process.platform === 'win32') await runBounded('cmd.exe', ['/d', '/s', '/c', `corepack ${args.join(' ')}`], { cwd: scriptsLibDir })
    else await runBounded('corepack', args, { cwd: scriptsLibDir })
  } catch (error) {
    console.error(`[crabot] scripts/lib dependency repair failed: ${error.message}`)
    process.exit(1)
  }
}
