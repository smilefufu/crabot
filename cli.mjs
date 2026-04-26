#!/usr/bin/env node

// cli.mjs — Crabot CLI 入口
// 纯 JS，不依赖任何第三方包，跨平台（macOS/Linux/Windows）

import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const command = args[0] ?? 'help'

const bootstrapCommands = new Set(['start', 'stop', 'check', 'help', 'upgrade'])

if (command === 'password') {
  await import(resolve(__dirname, 'scripts/password.mjs'))
} else if (bootstrapCommands.has(command)) {
  const scriptPath = resolve(__dirname, `scripts/${command}.mjs`)
  if (existsSync(scriptPath)) {
    await import(scriptPath)
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
  const { run } = await import(cliEntry)
  run(process.argv)
}
