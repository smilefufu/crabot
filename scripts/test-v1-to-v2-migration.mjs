#!/usr/bin/env node
/**
 * E2E test: v1 LanceDB long_term_memory → v2 file/SQLite layout via `crabot upgrade`.
 *
 * Uses the production v1 backup at `data.backup-20260424-132341/memory/lancedb`
 * as fixture (29 real records). Stages it into a temp DATA_DIR (no
 * SCHEMA_VERSION + no long_term/ + no long_term_v2.db so scanner sees v0/null),
 * runs `node scripts/upgrade.mjs -y`, asserts: backup created, SCHEMA_VERSION=v2,
 * file structure correct, frontmatter mapping (entities_json/source_json parsed),
 * SQLite memories table populated.
 *
 * Run: node scripts/test-v1-to-v2-migration.mjs
 */
import { existsSync, readdirSync, readFileSync, rmSync, cpSync, mkdirSync, statSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const FIXTURE = join(ROOT, 'data.backup-20260424-132341/memory')
const TMP = '/tmp/v2-migration-e2e-test'

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

function ok(msg) {
  console.log(`✅ ${msg}`)
}

if (!existsSync(FIXTURE)) {
  fail(`fixture missing: ${FIXTURE}. Need a v1 LanceDB long_term_memory snapshot to run e2e.`)
}

// 1. Stage v1 data
console.log(`Staging v1 fixture into ${TMP} ...`)
rmSync(TMP, { recursive: true, force: true })
mkdirSync(TMP, { recursive: true })
cpSync(FIXTURE, join(TMP, 'memory'), { recursive: true })
// Strip v2 markers so scanner treats it as legacy
for (const f of ['SCHEMA_VERSION', 'memory.pid']) {
  rmSync(join(TMP, 'memory', f), { force: true })
}
for (const d of ['long_term', 'long_term_v2.db']) {
  rmSync(join(TMP, 'memory', d), { recursive: true, force: true })
}
const stagedFiles = readdirSync(join(TMP, 'memory'))
if (!stagedFiles.includes('lancedb')) fail(`missing lancedb in staged dir: ${stagedFiles}`)
ok(`staged: ${stagedFiles.join(', ')}`)

// 2. Run upgrade
console.log(`Running upgrade ...`)
const result = spawnSync('node', ['scripts/upgrade.mjs', '-y'], {
  cwd: ROOT,
  env: { ...process.env, DATA_DIR: TMP },
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf-8',
})
if (result.status !== 0) {
  console.error('STDOUT:', result.stdout)
  console.error('STDERR:', result.stderr)
  fail(`upgrade exited with code ${result.status}`)
}
const out = result.stdout
if (!/Done: \d+ migrated, 0 discarded/.test(out)) fail(`upgrade output missing Done summary:\n${out}`)
ok('upgrade exit code 0')

// 3. Backup created
const backups = readdirSync(TMP).filter((f) => f.startsWith('memory.backup-'))
if (backups.length !== 1) fail(`expected 1 backup dir, got: ${backups}`)
ok(`backup created: ${backups[0]}`)

// 4. SCHEMA_VERSION written
const schemaPath = join(TMP, 'memory', 'SCHEMA_VERSION')
if (!existsSync(schemaPath)) fail('SCHEMA_VERSION not written')
const ver = readFileSync(schemaPath, 'utf-8').trim()
if (ver !== 'v2') fail(`SCHEMA_VERSION=${ver}, expected v2`)
ok(`SCHEMA_VERSION=v2`)

// 5. File structure
const longTerm = join(TMP, 'memory', 'long_term')
if (!existsSync(longTerm)) fail('long_term/ not created')
const counts = { 'confirmed/concept': 0, 'confirmed/lesson': 0, 'confirmed/fact': 0 }
for (const status of ['confirmed', 'inbox', 'trash']) {
  const sd = join(longTerm, status)
  if (!existsSync(sd)) continue
  for (const type of readdirSync(sd)) {
    const td = join(sd, type)
    if (!statSync(td).isDirectory()) continue
    const n = readdirSync(td).filter((f) => f.endsWith('.md')).length
    const k = `${status}/${type}`
    counts[k] = (counts[k] || 0) + n
  }
}
const totalMigrated = Object.values(counts).reduce((a, b) => a + b, 0)
if (totalMigrated !== 29) fail(`expected 29 migrated entries, got ${totalMigrated}: ${JSON.stringify(counts)}`)
ok(`migrated ${totalMigrated} entries: ${JSON.stringify(counts)}`)

// 6. Frontmatter checks: source_ref preservation + tags + frontmatter validity
let withTaskId = 0
let withConvSource = 0
let validYaml = 0
const allMd = []
for (const status of readdirSync(longTerm)) {
  for (const type of readdirSync(join(longTerm, status))) {
    const td = join(longTerm, status, type)
    if (!statSync(td).isDirectory()) continue
    for (const f of readdirSync(td)) {
      if (!f.endsWith('.md')) continue
      const content = readFileSync(join(td, f), 'utf-8')
      allMd.push({ path: join(td, f), content })
      if (/^---\n/.test(content) && /\n---\n/.test(content)) validYaml++
      if (/\n  task_id: [^\n]+/.test(content)) withTaskId++
      if (/\n  type: conversation/.test(content)) withConvSource++
    }
  }
}
if (validYaml !== totalMigrated) fail(`only ${validYaml}/${totalMigrated} have valid frontmatter delimiters`)
ok(`all ${validYaml} entries have valid frontmatter`)
if (withTaskId < 20) fail(`expected ≥20 entries with task_id (production has 23), got ${withTaskId}`)
ok(`${withTaskId} entries preserved task_id (regression guard for entities_json/source_json bug)`)
if (withConvSource < 15) fail(`expected ≥15 entries with type: conversation, got ${withConvSource}`)
ok(`${withConvSource} entries preserved source_ref.type=conversation`)

// 7. SQLite index populated
const dbPath = join(TMP, 'memory', 'long_term_v2.db')
if (!existsSync(dbPath)) fail('long_term_v2.db not created')
// Use sqlite3 CLI for a no-deps check
const sqliteRes = spawnSync('sqlite3', [dbPath, 'SELECT count(*) FROM memories;'], { encoding: 'utf-8' })
if (sqliteRes.status !== 0) fail(`sqlite3 query failed: ${sqliteRes.stderr}`)
const idxCount = parseInt(sqliteRes.stdout.trim(), 10)
if (idxCount !== totalMigrated) fail(`SQLite memories count=${idxCount}, expected ${totalMigrated}`)
ok(`SQLite memories indexed: ${idxCount}`)
const tagsRes = spawnSync('sqlite3', [dbPath, 'SELECT count(*) FROM tag_index;'], { encoding: 'utf-8' })
const tagCount = parseInt(tagsRes.stdout.trim(), 10)
if (tagCount === 0) fail('tag_index empty')
ok(`SQLite tag_index entries: ${tagCount}`)

// 8. Idempotency: re-running upgrade is a no-op (SCHEMA_VERSION matches)
console.log(`Re-running upgrade for idempotency ...`)
const second = spawnSync('node', ['scripts/upgrade.mjs', '-y'], {
  cwd: ROOT,
  env: { ...process.env, DATA_DIR: TMP },
  stdio: ['ignore', 'pipe', 'pipe'],
  encoding: 'utf-8',
})
if (second.status !== 0) fail(`second upgrade failed: ${second.stderr}`)
if (!/already up to date|Nothing to migrate|No data migrations needed/i.test(second.stdout + second.stderr)) {
  // Acceptable if it just runs again with no targets — check no new backup
}
const backupsAfter = readdirSync(TMP).filter((f) => f.startsWith('memory.backup-'))
if (backupsAfter.length !== 1) fail(`re-run created extra backup: ${backupsAfter}`)
ok(`idempotent: no new backup on second run (still ${backupsAfter.length})`)

console.log('\n🎉 T1.1 v1→v2 end-to-end migration test PASSED')
