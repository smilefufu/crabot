#!/usr/bin/env node

import './_preflight.mjs'

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'
import yaml from 'js-yaml'
import { detectMode } from './lib/mode.mjs'
import { resolveCliDataDir } from './lib/instance.mjs'
import { addVendor, removeVendor, setMode, validateEntry } from './lib/vendor-doc.mjs'

const ETC_DIR = '/etc/crabot'
const HOME_DIR = resolve(homedir(), '.crabot')
// 四种格式都可配；ChatGPT 订阅那种 auth_type=oauth 的固定流程不在此（向导只产 apikey vendor）。
const FORMATS = ['openai', 'anthropic', 'gemini', 'openai-responses']

/** 决定 vendor.yaml 落点：system mode → /etc/crabot/defaults；user mode → DATA_DIR/admin。 */
function resolveTarget() {
  if (detectMode(ETC_DIR) === 'system') {
    return { mode: 'system', file: join(ETC_DIR, 'defaults', 'vendor.yaml') }
  }
  const dataDir = resolveCliDataDir({ homeDir: HOME_DIR })
  return { mode: 'user', file: resolve(dataDir, 'admin', 'vendor.yaml') }
}

function loadDoc(file) {
  if (!existsSync(file)) return { mode: 'merge', vendors: [] }
  const raw = readFileSync(file, 'utf-8').trim()
  if (!raw) return { mode: 'merge', vendors: [] }
  const doc = yaml.load(raw) ?? {}
  return {
    mode: doc.mode === 'replace' ? 'replace' : 'merge',
    vendors: Array.isArray(doc.vendors) ? doc.vendors : [],
  }
}

function saveDoc(file, doc) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, yaml.dump(doc))
  } catch (e) {
    if (e.code === 'EACCES') {
      console.error(`[vendor] 写 ${file} 权限拒绝。system mode 下请用 \`sudo crabot vendor ...\`。`)
      process.exit(1)
    }
    throw e
  }
}

function printList(doc, file) {
  console.log(`\n供应商目录文件：${file}`)
  console.log(`mode: ${doc.mode}（merge=在内置基础上增改；replace=完全接管隐藏内置）`)
  if (!doc.vendors.length) {
    console.log('（暂无自定义供应商）\n')
    return
  }
  console.log('')
  for (const v of doc.vendors) {
    console.log(`  - ${v.id}  [${v.format}]  ${v.name}`)
    console.log(`      endpoint: ${v.endpoint}${v.models_api ? `  models_api: ${v.models_api}` : ''}${v.recommended ? '  ★推荐' : ''}`)
  }
  console.log('')
}

// vendor 目录完全以 root 为准、不走 sync（admin system mode 直读 /etc/crabot/defaults/vendor.yaml）。
// 所以写完无需递增 cluster.version，只提示生效方式。
function reportSaved(target) {
  if (target.mode === 'system') {
    console.log('[vendor] 已写入 /etc/crabot/defaults/vendor.yaml。各员工 admin 下次重启后自动生效（无需 sync）。')
  } else {
    console.log('[vendor] 已写入。下次 `crabot start` 生效。')
  }
}

async function cmdAdd(rl, target) {
  let doc = loadDoc(target.file)

  const id = (await rl.question('id（唯一标识，如 company-proxy）: ')).trim()
  const name = (await rl.question('显示名称（如 公司内部代理）: ')).trim()
  console.log('协议格式：' + FORMATS.map((f, i) => `${i + 1}) ${f}`).join('  '))
  const fmtIdx = parseInt((await rl.question(`选择格式 [1-${FORMATS.length}]: `)).trim(), 10)
  const format = FORMATS[fmtIdx - 1]
  const epHint = format === 'anthropic'
    ? '裸 host 不带 /v1，如 https://claude.corp.internal'
    : '带 /v1，如 https://api.openai.com/v1'
  const endpoint = (await rl.question(`endpoint（${epHint}）: `)).trim()
  // models_api 是「拉取模型列表的路径」，会拼到上面的 endpoint 后面：列模型地址 = endpoint + models_api。
  // 只填路径后缀（不要再写一遍 base_url）。回车留空则自动猜一个（猜错最多拉不到，可后续手动改）。
  const guessedModelsApi = format === 'anthropic' ? '/v1/models' : '/models'
  const modelsApiAns = (await rl.question(`models_api（拼在 endpoint 后面，只填路径；回车用默认 "${guessedModelsApi}"）: `)).trim()
  const models_api = modelsApiAns || guessedModelsApi
  // 多数 /models 响应不暴露 vision 字段，需靠 id 前缀把这些模型族标成 VLM。
  const visionAns = (await rl.question('视觉模型 id 前缀（命中则导入时自动标 VLM，逗号分隔，如 claude-,gpt-,gemini-,kimi-；回车跳过）: ')).trim()
  const vision_id_prefixes = visionAns ? visionAns.split(',').map(s => s.trim()).filter(Boolean) : []
  const recommended = (await rl.question('设为推荐（前端置顶）？[y/N] ')).trim().toLowerCase().startsWith('y')

  const entry = { id, name, format, endpoint }
  if (models_api) entry.models_api = models_api
  if (vision_id_prefixes.length) entry.vision_id_prefixes = vision_id_prefixes
  if (recommended) entry.recommended = true

  const errors = validateEntry(entry)
  if (errors.length) {
    console.error('[vendor] 校验失败：\n  - ' + errors.join('\n  - '))
    process.exit(1)
  }

  try {
    doc = addVendor(doc, entry)
  } catch (e) {
    console.error(`[vendor] ${e.message}`)
    process.exit(1)
  }

  console.log('\n将写入：')
  console.log(yaml.dump({ vendors: [entry] }).replace(/^/gm, '  '))
  console.log('提示：如需静态模型列表（default_models），请直接编辑文件或参考 vendor.yaml.example。')

  saveDoc(target.file, doc)
  reportSaved(target)
}

async function cmdRemove(target, id) {
  if (!id) {
    console.error('[vendor] 用法：crabot vendor remove <id>')
    process.exit(1)
  }
  const doc = loadDoc(target.file)
  const existed = doc.vendors.some(v => v.id === id)
  const next = removeVendor(doc, id)
  saveDoc(target.file, next)
  if (!existed) {
    console.log(`[vendor] override 文件中无 id=${id}，未改动。`)
    return
  }
  console.log(`[vendor] 已从 override 文件移除 ${id}。`)
  console.log('[vendor] 注意：这只动 override 文件。merge 模式下若该 id 是内置供应商，会重新显形；要隐藏内置请用 `crabot vendor mode replace`。')
  reportSaved(target)
}

async function cmdMode(target, mode) {
  const doc = loadDoc(target.file)
  let next
  try {
    next = setMode(doc, mode)
  } catch (e) {
    console.error(`[vendor] ${e.message}`)
    process.exit(1)
  }
  saveDoc(target.file, next)
  console.log(`[vendor] mode → ${mode}`)
  reportSaved(target)
}

async function main() {
  const sub = process.argv[3]
  const arg = process.argv[4]
  const target = resolveTarget()
  const rl = createInterface({ input, output })
  try {
    switch (sub) {
      case 'list':
        printList(loadDoc(target.file), target.file)
        break
      case 'add':
        await cmdAdd(rl, target)
        break
      case 'remove':
        await cmdRemove(target, arg)
        break
      case 'mode':
        await cmdMode(target, arg)
        break
      default:
        console.log('用法：crabot vendor <list|add|remove <id>|mode <merge|replace>>')
        console.log(`当前落点：${target.file}（${target.mode} mode）`)
    }
  } finally {
    rl.close()
  }
}

await main()
