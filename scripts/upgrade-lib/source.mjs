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

async function installAndBuild(moduleDir, logger) {
  await runCmd('npm', ['install'], moduleDir, logger)
  await runCmd('npm', ['run', 'build'], moduleDir, logger)
}

export async function runSourceUpgrade(crabotHome, logger) {
  await runCmd('npm', ['install'], crabotHome, logger)

  const sharedDir = join(crabotHome, SHARED_MODULE)
  if (existsSync(sharedDir)) {
    await installAndBuild(sharedDir, logger)
  }

  for (const mod of JS_MODULES) {
    const dir = join(crabotHome, mod)
    if (!existsSync(dir)) continue
    await installAndBuild(dir, logger)
  }

  await runCmd('npm', ['run', 'build:cli'], crabotHome, logger)

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
