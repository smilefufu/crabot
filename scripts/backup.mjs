#!/usr/bin/env node

// crabot backup —— 导出备份归档（bootstrap 命令，离线可用）

import './_preflight.mjs'

import { resolve, join, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolveCliDataDir } from './lib/instance.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const HOME_DIR = resolve(homedir(), '.crabot')
const importPath = (p) => import(pathToFileURL(p).href)

function requireValue(argv, i, flag) {
  const v = argv[i]
  if (v === undefined) {
    console.error(`[crabot] ${flag} 需要一个参数`)
    process.exit(1)
  }
  return v
}

function parseArgs(argv) {
  const out = { categories: null, includeSecrets: false, yes: false, outPath: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--include') out.categories = requireValue(argv, ++i, '--include').split(',').filter(Boolean)
    else if (a === '--include-secrets') out.includeSecrets = true
    else if (a === '--yes' || a === '-y') out.yes = true
    else if (a === '--out') out.outPath = requireValue(argv, ++i, '--out')
  }
  return out
}

async function main() {
  // process.argv = [node, cli.mjs, 'backup', ...flags]
  const args = parseArgs(process.argv.slice(3))

  const DATA_DIR = resolveCliDataDir({ homeDir: HOME_DIR })

  if (!existsSync(DATA_DIR)) {
    console.error(`[crabot] 数据目录不存在：${DATA_DIR}`)
    console.error('[crabot] 请先运行 `crabot start` 初始化实例后再备份。')
    process.exit(1)
  }

  const adminDataDir = join(DATA_DIR, 'admin')
  const memoryDataDir = join(DATA_DIR, 'memory')

  const exportEntry = resolve(ROOT, 'crabot-admin/dist/backup/export-archive.js')
  if (!existsSync(exportEntry)) {
    console.error('[crabot] 未构建，请先运行 `crabot start` 或 `./dev.sh build`')
    process.exit(1)
  }

  const { exportArchive } = await importPath(exportEntry)
  const { DEFAULT_CATEGORIES } = await importPath(resolve(ROOT, 'crabot-admin/dist/backup/categories.js'))

  const categories = args.categories ?? DEFAULT_CATEGORIES

  if (args.includeSecrets && !args.yes) {
    console.error('[crabot] ⚠️  --include-secrets 会把明文密钥写入归档，请确认后加 --yes 重试')
    process.exit(1)
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const outPath = args.outPath ?? resolve(process.cwd(), `crabot-backup-${ts}.tar.gz`)
  const stagingRoot = join(DATA_DIR, 'temp', `backup-staging-${ts}`)

  await exportArchive({
    selection: { categories, includeSecrets: args.includeSecrets },
    outPath,
    stagingRoot,
    runtimeVersion: process.env.CRABOT_VERSION ?? 'dev',
    createdAt: new Date().toISOString(),
    deps: { adminDataDir, memoryDataDir }, // CLI 离线：短期记忆走文件，不调 RPC
  })

  console.log(`[crabot] ✅ 已导出: ${outPath}`)
  console.log(`[crabot]    类别: ${categories.join(', ')}${args.includeSecrets ? ' (含明文密钥)' : ''}`)
}

main().catch((e) => {
  console.error('[crabot] 备份失败:', e?.message ?? e)
  process.exit(1)
})
