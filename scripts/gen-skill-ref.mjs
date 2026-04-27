#!/usr/bin/env node
import { execSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const cliEntry = join(root, 'cli.mjs')
const refPath = join(root, 'crabot-admin/builtins/skills/crabot-cli/references/command-ref.md')

const json = execSync(`node ${cliEntry} --schema`, { encoding: 'utf-8', cwd: root })
const schema = JSON.parse(json)

const lines = [
  '# Crabot CLI 命令参考',
  '',
  '> 此文件由 `scripts/gen-skill-ref.mjs` 自动生成（基于 `crabot --schema` 输出）。请勿手动编辑。',
  '',
  `生成时间：${new Date().toISOString()}  CLI 版本：${schema.version}`,
  '',
  '## 命令清单',
  '',
  '| 命令 | 说明 | 权限 | 需 confirm |',
  '|---|---|---|---|',
]
for (const c of schema.commands) {
  const desc = (c.description || '').replace(/\|/g, '\\|')
  lines.push(`| \`crabot ${c.name}\` | ${desc} | ${c.permission} | ${c.must_confirm ? '✅' : '❌'} |`)
}

lines.push(
  '',
  '## 通用选项',
  '',
  '| 选项 | 说明 |',
  '|---|---|',
  '| `--human` | 人类可读输出（表格 + 彩色错误） |',
  '| `--json` | JSON 输出（默认；AI 模式 alias） |',
  '| `-e, --endpoint <url>` | 指定 Admin 地址（覆盖 CRABOT_ENDPOINT） |',
  '| `-t, --token <token>` | 指定认证 token（覆盖 CRABOT_TOKEN） |',
  '| `--schema` | 输出机器可读的命令 schema 并退出 |',
)

writeFileSync(refPath, lines.join('\n') + '\n', 'utf-8')
console.log(`Generated ${refPath} (${schema.commands.length} commands)`)
