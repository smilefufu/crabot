#!/usr/bin/env node
/**
 * 校验 release staging 目录是否包含全部运行时载荷。
 *
 * 背景：打包脚本用 `--exclude='*.md'` 剔文档，只给 builtin-skills/ 开了 include 白名单，
 * 结果 crabot-admin/builtins/skills/ 下的 SKILL.md 全被剔掉（issue #43）——目录还在、
 * 内容没了，Admin 启动时一个内置 skill 都注册不上。这类"白名单漏一条"人眼 review 挡不住，
 * 打包后直接比对源码与 staging。
 *
 * 用法：node .github/scripts/verify-release-payload.mjs <stagingDir>
 * 退出码：0 = 完整，1 = 有缺失（打印缺失清单）
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const stagingDir = process.argv[2]
if (!stagingDir) {
  console.error('usage: verify-release-payload.mjs <stagingDir>')
  process.exit(2)
}

const repoRoot = process.cwd()

/** 递归列出目录下所有文件（返回相对 repoRoot 的路径，统一用 / 分隔） */
function listFiles(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) out.push(...listFiles(full))
    else out.push(relative(repoRoot, full).split(sep).join('/'))
  }
  return out
}

// 1. 两处 skill 载荷：源码里有多少个文件，包里就得有多少个（含 references/*.md）
const skillPayload = [
  ...listFiles(join(repoRoot, 'crabot-admin', 'builtin-skills')),
  ...listFiles(join(repoRoot, 'crabot-admin', 'builtins')),
]

// 2. 其余运行时必需文件（有过漏打前科或缺了就起不来的）
const required = [
  'cli.mjs',
  'package.json',
  'install.sh',
  'LICENSE',
  'scripts/start.mjs',
  'scripts/lib/registry.mjs',
  'crabot-agent/crabot-module.yaml',
  'crabot-memory/schema_version',
  'crabot-memory/uv.lock',
]

const expected = [...new Set([...skillPayload, ...required])].sort()
const missing = expected.filter((rel) => !existsSync(join(stagingDir, rel)))

if (missing.length > 0) {
  console.error(`[verify-release-payload] 缺少 ${missing.length} 个运行时文件：`)
  for (const m of missing) console.error(`  - ${m}`)
  process.exit(1)
}

console.log(`[verify-release-payload] OK：${expected.length} 个运行时文件齐全（其中 skill 载荷 ${skillPayload.length} 个）`)
