#!/usr/bin/env node

// cli.mjs — Crabot CLI 入口
// 纯 JS，不依赖任何第三方包，跨平台（macOS/Linux/Windows）

// Node 版本自检：crabot-shared 是 ESM、其他模块是 CJS，require() ESM 在 Node <22 不支持
// shebang `#!/usr/bin/env node` 接管 PATH 第一个 node，install.sh 里的 `nvm use` 出脚本就失效
// 所以这里必须在进程内拦截一遍，否则用户会看到一坨 ERR_REQUIRE_ESM 栈
const REQUIRED_NODE_MAJOR = 22
const currentMajor = parseInt(process.versions.node.split('.')[0], 10)
if (currentMajor < REQUIRED_NODE_MAJOR) {
  console.error(`\n[crabot] Node.js ${process.versions.node} 太旧，crabot 需要 Node >= ${REQUIRED_NODE_MAJOR}.x\n`)
  console.error(`当前 node 路径: ${process.execPath}`)
  console.error(`\n修复方法（任选其一）:`)
  console.error(`  1. 已装 nvm 的话: \`nvm use default\` 或 \`nvm use 22\` 后重试`)
  console.error(`  2. 新开一个 terminal 重试（让 shell 重新加载 nvm 默认版本）`)
  console.error(`  3. 重新跑 install.sh，它会通过 nvm 装 Node 22\n`)
  process.exit(1)
}

import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Windows 上 ESM dynamic import 不接受 C:\... 绝对路径，必须转 file:///C:/...
const importPath = (p) => import(pathToFileURL(p).href)

// 让下游（auth.ts、scripts/*）能在任意 cwd 下找到安装根目录
if (!process.env.CRABOT_HOME) {
  process.env.CRABOT_HOME = __dirname
}

const args = process.argv.slice(2)
const command = args[0] ?? 'help'

const bootstrapCommands = new Set(['start', 'stop', 'check', 'help', 'upgrade', 'status', 'init', 'sync', 'vendor', 'backup', 'import', 'restart'])

if (command === 'password') {
  await importPath(resolve(__dirname, 'scripts/password.mjs'))
} else if (bootstrapCommands.has(command)) {
  const scriptPath = resolve(__dirname, `scripts/${command}.mjs`)
  if (existsSync(scriptPath)) {
    await importPath(scriptPath)
  } else {
    console.error(`Bootstrap command "${command}" not yet available in cli.mjs.`)
    process.exit(1)
  }
} else {
  const cliEntry = resolve(__dirname, 'dist/cli/main.js')
  if (!existsSync(cliEntry)) {
    console.error('CLI not built. Run "crabot start" first or build with "pnpm run build:cli".')
    process.exit(1)
  }
  const { run } = await importPath(cliEntry)
  run(process.argv)
}
