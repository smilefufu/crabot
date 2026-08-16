#!/usr/bin/env node

// crabot import —— 导入备份归档（bootstrap 命令，离线按 id 合并）

import './_preflight.mjs'

import { resolve, join, dirname, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
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
  const out = { archivePath: null, categories: null, overwrite: false, yes: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--include') out.categories = requireValue(argv, ++i, '--include').split(',').filter(Boolean)
    else if (a === '--overwrite') out.overwrite = true
    else if (a === '--yes' || a === '-y') out.yes = true
    else if (!a.startsWith('-') && out.archivePath === null) out.archivePath = a
  }
  return out
}

/** 读取 DATA_DIR/admin/<file>，不存在返回 []；解析失败返回 []。 */
function loadArray(adminDir, file) {
  const p = join(adminDir, file)
  if (!existsSync(p)) return []
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function main() {
  // process.argv = [node, cli.mjs, 'import', ...flags]
  const args = parseArgs(process.argv.slice(3))

  if (!args.archivePath) {
    console.error('[crabot] 用法：crabot import <归档路径> [--include <类别>] [--overwrite] [--yes]')
    console.error('[crabot] 缺少归档路径参数')
    process.exit(1)
  }

  const archivePath = resolve(process.cwd(), args.archivePath)
  if (!existsSync(archivePath)) {
    console.error(`[crabot] 归档文件不存在：${archivePath}`)
    process.exit(1)
  }

  const DATA_DIR = resolveCliDataDir({ homeDir: HOME_DIR, repoRoot: ROOT })

  if (!existsSync(DATA_DIR)) {
    console.error(`[crabot] 数据目录不存在：${DATA_DIR}`)
    console.error('[crabot] 请先运行 `crabot start` 初始化实例后再导入。')
    process.exit(1)
  }

  const adminDataDir = join(DATA_DIR, 'admin')
  const memoryDataDir = join(DATA_DIR, 'memory')

  // 检查必要的 dist 产物
  const runImportEntry = resolve(ROOT, 'crabot-admin/dist/backup/import/run-import.js')
  if (!existsSync(runImportEntry)) {
    console.error('[crabot] 未构建，请先运行 `crabot start` 或 `./dev.sh build`')
    process.exit(1)
  }

  // 加载 dist 产物
  const { runCrabotImport } = await importPath(runImportEntry)
  const { validateBackupManifest } = await importPath(
    resolve(ROOT, 'crabot-admin/dist/backup/manifest.js')
  )
  const { shouldDisableOnImport } = await importPath(
    resolve(ROOT, 'crabot-admin/dist/backup/import/schedule-arm.js')
  )
  const { readArchiveTextFile, listArchiveEntries } = await importPath(
    resolve(ROOT, 'crabot-admin/dist/openclaw-import/archive-reader.js')
  )
  const { extractArchiveSubtree } = await importPath(
    resolve(ROOT, 'crabot-admin/dist/openclaw-import/extract-subtree.js')
  )

  // 1. 读取并校验 manifest
  const manifestText = await readArchiveTextFile(archivePath, 'manifest.json')
  if (!manifestText) {
    console.error('[crabot] 无法读取 manifest.json，可能不是有效的 Crabot 备份归档')
    process.exit(1)
  }

  let rawManifest
  try {
    rawManifest = JSON.parse(manifestText)
  } catch {
    console.error('[crabot] manifest.json 解析失败')
    process.exit(1)
  }

  const validation = validateBackupManifest(rawManifest)
  if (!validation.ok) {
    console.error(`[crabot] 归档校验失败：${validation.error}`)
    process.exit(1)
  }

  const categories = args.categories ?? validation.categories
  const onConflict = args.overwrite ? 'overwrite' : 'skip'

  if (args.overwrite) {
    console.log('[crabot] 提示：--overwrite 模式，将按 id 覆盖已有记录')
  }

  console.log(`[crabot] 开始导入：${archivePath}`)
  console.log(`[crabot] 类别：${categories.join(', ')}，冲突策略：${onConflict}`)

  // 2. 构造离线 deps

  // 内存数组 Map：文件名 -> { arr: [], keys: Set<string> }
  // 用于在内存中归并，finalize 时一次写回
  const stores = {}

  function getStore(file, keyField = 'id') {
    if (!stores[file]) {
      const arr = loadArray(adminDataDir, file)
      const keys = new Set(arr.map((r) => r[keyField]).filter(Boolean))
      stores[file] = { arr, keys, keyField, dirty: false }
    }
    return stores[file]
  }

  // 通用 upsert 逻辑（按 id 归并）
  function makeUpsert(file, keyField = 'id') {
    return (record) => {
      const store = getStore(file, keyField)
      const key = record[keyField]
      if (typeof key !== 'string' || key.length === 0) return 'failed'
      if (store.keys.has(key)) {
        if (onConflict === 'overwrite') {
          const idx = store.arr.findIndex((r) => r[keyField] === key)
          if (idx >= 0) store.arr[idx] = record
          else store.arr.push(record)
          store.dirty = true
          return 'overwritten'
        }
        return 'skipped'
      }
      store.arr.push(record)
      store.keys.add(key)
      store.dirty = true
      return 'imported'
    }
  }

  // channel configs 待写入（id -> text）
  const pendingChannelConfigs = {}

  const deps = {
    upsertProvider: makeUpsert('model_providers.json'),
    upsertSubagent: makeUpsert('subagents.json'),
    upsertTemplate: makeUpsert('templates.json'),
    upsertSessionConfig: makeUpsert('session-configs.json', 'session_id'),
    upsertMcp: makeUpsert('mcp-servers.json'),
    upsertFriend: makeUpsert('friends.json'),
    upsertTask: makeUpsert('tasks.json'),

    upsertSchedule: (sched) => {
      if (shouldDisableOnImport(sched, Date.now())) {
        sched = { ...sched, enabled: false }
      }
      return makeUpsert('schedules.json')(sched)
    },

    // P6-D §3.18.1：validate 纯读+校验（零写入），apply 在 preflight 通过后才执行。
    validateAgentPayload: async (archive) => {
      const implsText = await readArchiveTextFile(archive, 'payload/config/agent-implementations.json')
      const instText = await readArchiveTextFile(archive, 'payload/config/agent-instances.json')
      const impls = implsText ? JSON.parse(implsText) : []
      const insts = instText ? JSON.parse(instText) : []
      const nonCore = (Array.isArray(insts) ? insts : []).filter((i) => i && i.id !== 'crabot-agent')
      if ((Array.isArray(impls) && impls.length > 0) || nonCore.length > 0) {
        throw Object.assign(new Error(`旧 live Agent payload 不再支持导入（implementations=${impls.length}, non-core instances=${nonCore.length}）`), { code: 'ADMIN_BACKUP_NON_CORE_AGENT_UNSUPPORTED' })
      }
      let coreConfigRaw = null
      const coreText = await readArchiveTextFile(archive, 'payload/config/agent-configs/crabot-agent.json')
      if (coreText) {
        const raw = JSON.parse(coreText)
        if (raw.instance_id !== 'crabot-agent') {
          throw Object.assign(new Error('agent-configs/crabot-agent.json 的 instance_id 不是 crabot-agent'), { code: 'ADMIN_BACKUP_NON_CORE_AGENT_UNSUPPORTED' })
        }
        const allowed = new Set(['powerful', 'cost_effective', 'vision', 'manager'])
        const badKey = Object.keys(raw.model_config ?? {}).find((k) => !allowed.has(k))
        if (badKey) {
          throw Object.assign(new Error(`core config 含未知 model slot key: ${badKey}`), { code: 'ADMIN_BACKUP_NON_CORE_AGENT_UNSUPPORTED' })
        }
        coreConfigRaw = raw
      }
      let archiveRows = []
      const archiveListText = await readArchiveTextFile(archive, 'payload/config/legacy-agent-archive.json')
      if (archiveListText) {
        archiveRows = JSON.parse(archiveListText)
        if (!Array.isArray(archiveRows)) throw Object.assign(new Error('legacy-agent-archive.json 不是数组'), { code: 'ADMIN_BACKUP_LEGACY_ARCHIVE_CONFLICT' })
        const file = join(adminDataDir, 'legacy-agent-archive.json')
        let existing = []
        try { existing = JSON.parse(readFileSync(file, 'utf8')) } catch {}
        const byId = new Map(existing.map((r) => [r.archive_id, r]))
        for (const row of archiveRows) {
          const old = byId.get(row.archive_id)
          if (old && JSON.stringify(old.raw ?? null) !== JSON.stringify(row.raw ?? null)) {
            throw Object.assign(new Error(`archive payload 冲突: ${row.archive_id}`), { code: 'ADMIN_BACKUP_LEGACY_ARCHIVE_CONFLICT' })
          }
        }
      }
      return { coreConfigRaw, archiveRows }
    },

    applyCoreAgentConfig: async (raw, conflict) => {
      const dest = join(adminDataDir, 'agent-configs')
      await mkdir(dest, { recursive: true })
      const file = join(dest, 'crabot-agent.json')
      const existed = existsSync(file)
      if (existed && conflict === 'skip') {
        return [{ kind: 'agent-config', id: 'crabot-agent', status: 'skipped' }]
      }
      await writeFile(file, JSON.stringify(raw, null, 2))
      return [{ kind: 'agent-config', id: 'crabot-agent', status: existed ? 'overwritten' : 'imported' }]
    },

    applyLegacyArchiveRows: async (rows) => {
      const file = join(adminDataDir, 'legacy-agent-archive.json')
      let existing = []
      try { existing = JSON.parse(readFileSync(file, 'utf8')) } catch {}
      const byId = new Map(existing.map((r) => [r.archive_id, r]))
      const results = []
      for (const row of rows) {
        if (byId.has(row.archive_id)) { results.push({ kind: 'legacy-agent-archive', id: row.archive_id, status: 'overwritten' }); continue }
        byId.set(row.archive_id, row)
        results.push({ kind: 'legacy-agent-archive', id: row.archive_id, status: 'imported' })
      }
      await writeFile(file, JSON.stringify([...byId.values()], null, 2))
      return results
    },

    upsertChannel: async (channelInstance) => {
      const status = makeUpsert('channel-instances.json')(channelInstance)
      const id = channelInstance.id
      if (id && (status === 'imported' || status === 'overwritten')) {
        const configText = await readArchiveTextFile(
          archivePath,
          `payload/channels/channel-configs/${id}.json`
        )
        if (configText) {
          pendingChannelConfigs[id] = configText
        }
      }
      return status
    },

    importSkills: async (archive, conflict) => {
      const results = []
      // 先归并 skills.json 元数据
      const skillsJsonText = await readArchiveTextFile(archive, 'payload/skills/skills.json')
      let skillRecords = []
      if (skillsJsonText) {
        try {
          const parsed = JSON.parse(skillsJsonText)
          if (Array.isArray(parsed)) skillRecords = parsed
        } catch {}
      }

      const store = getStore('skills.json')
      const destSkillsDir = join(adminDataDir, 'skills')

      for (const record of skillRecords) {
        const name = record.name
        const id = record.id ?? name
        if (!name) {
          results.push({ kind: 'skill', id: '', status: 'failed', reason: 'missing-name' })
          continue
        }

        const alreadyExists = store.keys.has(id)
        if (alreadyExists && conflict === 'skip') {
          results.push({ kind: 'skill', id, status: 'skipped' })
          continue
        }

        // 提取 skills/<name>/ 子目录
        const skillDestDir = join(destSkillsDir, name)
        try {
          await extractArchiveSubtree(archive, `payload/skills/skills/${name}`, skillDestDir)
        } catch (err) {
          results.push({ kind: 'skill', id, status: 'failed', reason: String(err) })
          continue
        }

        // 归并 skills.json 记录：skill_dir 改成目标机器的落地路径，
        // 否则会残留源机器的绝对路径，跨机器导入后 SkillManager 找不到目录
        const destRecord = { ...record, skill_dir: skillDestDir }
        if (alreadyExists) {
          const idx = store.arr.findIndex((r) => (r.id ?? r.name) === id)
          if (idx >= 0) store.arr[idx] = destRecord
          else store.arr.push(destRecord)
          results.push({ kind: 'skill', id, status: 'overwritten' })
        } else {
          store.arr.push(destRecord)
          store.keys.add(id)
          results.push({ kind: 'skill', id, status: 'imported' })
        }
        store.dirty = true
      }

      return results
    },

    importMemory: async (archive, _conflict) => {
      const results = []
      const allEntries = await listArchiveEntries(archive)
      const ltPrefix = 'payload/memory/long_term/'
      const ltEntries = allEntries.filter(
        (e) => e.startsWith(ltPrefix) && !e.includes('/.versions/') && !e.endsWith('/')
      )

      const memoryRoot = resolve(memoryDataDir)
      for (const entry of ltEntries) {
        const relPath = entry.slice('payload/memory/'.length) // long_term/<status>/<type>/<id>.md
        const destPath = join(memoryDataDir, relPath)
        // zip-slip 防护：归档条目可能含 ../，确保落点在 memoryDataDir 内
        if (resolve(destPath) !== memoryRoot && !resolve(destPath).startsWith(memoryRoot + sep)) {
          results.push({ kind: 'memory', id: relPath, status: 'failed', reason: 'unsafe-path' })
          continue
        }
        try {
          const text = await readArchiveTextFile(archive, entry)
          if (text === null) continue
          await mkdir(dirname(destPath), { recursive: true })
          await writeFile(destPath, text, 'utf-8')
          results.push({ kind: 'memory', id: relPath, status: 'imported' })
        } catch (err) {
          results.push({ kind: 'memory', id: relPath, status: 'failed', reason: String(err) })
        }
      }

      return results
    },

    finalize: async () => {
      // 写回所有改过的内存数组
      for (const [file, store] of Object.entries(stores)) {
        if (!store.dirty) continue
        mkdirSync(adminDataDir, { recursive: true })
        writeFileSync(join(adminDataDir, file), JSON.stringify(store.arr, null, 2))
      }

      // 写 pending channel configs
      for (const [id, text] of Object.entries(pendingChannelConfigs)) {
        const dir = join(adminDataDir, 'channel-configs')
        mkdirSync(dir, { recursive: true })
        writeFileSync(join(dir, `${id}.json`), text)
      }
    },
  }

  // 3. 运行导入
  const { results, errors } = await runCrabotImport({
    archivePath,
    categories,
    onConflict,
    deps,
  })

  // 4. 打印 summary
  const counts = { imported: 0, overwritten: 0, skipped: 0, failed: 0 }
  for (const r of results) {
    counts[r.status] = (counts[r.status] ?? 0) + 1
  }

  console.log('')
  console.log('[crabot] 导入完成')
  console.log(
    `[crabot]   导入: ${counts.imported}  覆盖: ${counts.overwritten}  跳过: ${counts.skipped}  失败: ${counts.failed}`
  )

  if (errors.length > 0) {
    console.log('[crabot] 错误：')
    for (const e of errors) console.log(`[crabot]   - ${e}`)
  }

  const failedItems = results.filter((r) => r.status === 'failed')
  if (failedItems.length > 0) {
    console.log('[crabot] 失败条目：')
    for (const r of failedItems) {
      console.log(`[crabot]   - [${r.kind}] ${r.id}: ${r.reason ?? ''}`)
    }
  }

  if (counts.failed > 0 || errors.length > 0) {
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('[crabot] 导入失败:', e?.message ?? e)
  process.exit(1)
})
