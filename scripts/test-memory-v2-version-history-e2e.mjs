#!/usr/bin/env node
/**
 * E2E test: Memory v2 版本历史（spec §9.2 / N7）跨进程验证。
 *
 * 走真实 admin REST → MM → memory 子进程 RPC 全链路：
 *   1. POST   /api/memory/v2/entries           创建 v1
 *   2. PATCH  /api/memory/v2/entries/:id       升 v2
 *   3. PATCH  /api/memory/v2/entries/:id       升 v3
 *   4. GET    /api/memory/v2/entries/:id       校验当前是 v3，prev_version_ids 完整
 *   5. GET    /api/memory/v2/entries/:id/versions/2  校验旧 body
 *   6. GET    /api/memory/v2/entries/:id/versions/1  校验更早 body
 *   7. GET    /api/memory/v2/entries/:id/versions/99 校验 error
 *   8. DELETE /api/memory/v2/entries/:id       清理
 *
 * 前置条件：./dev.sh 已在跑（默认 port 3000；CRABOT_PORT_OFFSET 可调）。
 * 脚本不自管启停 stack。
 *
 * Run: node scripts/test-memory-v2-version-history-e2e.mjs
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT_DIR = resolve(__dirname, '..')

const OFFSET = parseInt(process.env.CRABOT_PORT_OFFSET || '0', 10)
const PORT = 3000 + OFFSET
const ROOT = `http://localhost:${PORT}/api`
const BASE = `${ROOT}/memory/v2`

// 与 dev.sh / start.mjs 对齐：优先环境变量，否则读 data{,-N}/admin/.env
function loadAdminPassword() {
  if (process.env.CRABOT_ADMIN_PASSWORD) return process.env.CRABOT_ADMIN_PASSWORD
  const dataDir = process.env.DATA_DIR
    || (OFFSET > 0 ? resolve(ROOT_DIR, `data-${OFFSET}`) : resolve(ROOT_DIR, 'data'))
  const envPath = resolve(dataDir, 'admin/.env')
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const m = line.match(/^CRABOT_ADMIN_PASSWORD=(.+)$/)
      if (m) return m[1].trim()
    }
  }
  return 'admin123'
}
const PASSWORD = loadAdminPassword()

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}
function ok(msg) {
  console.log(`✅ ${msg}`)
}

let TOKEN = ''
async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try { json = text ? JSON.parse(text) : null } catch { json = text }
  return { status: res.status, body: json }
}

// 0. login
console.log(`Logging in to admin at ${ROOT} ...`)
let loginRes
try {
  loginRes = await fetch(`${ROOT}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  })
} catch (e) {
  fail(`cannot reach ${ROOT}: ${e.message}\n请先 ./dev.sh 启动开发环境（或设置 CRABOT_PORT_OFFSET）。`)
}
if (loginRes.status !== 200) {
  const t = await loginRes.text()
  fail(`login failed status=${loginRes.status}: ${t}\n如非默认 admin123，请用 CRABOT_ADMIN_PASSWORD=xxx 跑。`)
}
const loginBody = await loginRes.json()
TOKEN = loginBody.token
ok(`admin login OK (port ${PORT})`)

// 0.5. health
const probe = await call('GET', '/entries?limit=1')
if (probe.status !== 200) fail(`probe status=${probe.status}, body=${JSON.stringify(probe.body)}`)
ok(`memory v2 REST reachable`)

// 1. create v1
const brief1 = `e2e-n7-${Date.now()}`
const created = await call('POST', '/entries', {
  type: 'fact',
  brief: brief1,
  content: 'v1 body',
  source_ref: { type: 'manual' },
  source_trust: 3,
  content_confidence: 3,
  importance_factors: { proximity: 0.5, surprisal: 0.5, entity_priority: 0.5, unambiguity: 0.5 },
  entities: [],
  tags: ['e2e', 'n7'],
  event_time: new Date().toISOString(),
})
if (created.status !== 201 || !created.body?.id) {
  fail(`create failed: status=${created.status}, body=${JSON.stringify(created.body)}`)
}
const id = created.body.id
ok(`created entry id=${id}`)

let exitCode = 0
try {
  // 2. patch → v2
  const p2 = await call('PATCH', `/entries/${encodeURIComponent(id)}`, {
    patch: { brief: `${brief1}-v2`, body: 'v2 body' },
  })
  if (p2.status !== 200 || p2.body?.version !== 2) {
    fail(`patch v2 failed: ${JSON.stringify(p2)}`)
  }
  ok(`patched to v2`)

  // 3. patch → v3
  const p3 = await call('PATCH', `/entries/${encodeURIComponent(id)}`, {
    patch: { brief: `${brief1}-v3`, body: 'v3 body' },
  })
  if (p3.status !== 200 || p3.body?.version !== 3) {
    fail(`patch v3 failed: ${JSON.stringify(p3)}`)
  }
  ok(`patched to v3`)

  // 4. get current
  const cur = await call('GET', `/entries/${encodeURIComponent(id)}?include=full`)
  if (cur.status !== 200) fail(`get current failed: ${JSON.stringify(cur)}`)
  const fm = cur.body?.frontmatter
  if (fm?.version !== 3) fail(`current version=${fm?.version}, want 3`)
  if (cur.body?.body !== 'v3 body') fail(`current body="${cur.body?.body}", want "v3 body"`)
  const prev = fm.prev_version_ids ?? []
  if (JSON.stringify(prev) !== JSON.stringify([`${id}#v2`, `${id}#v1`])) {
    fail(`prev_version_ids=${JSON.stringify(prev)}, want [${id}#v2, ${id}#v1]`)
  }
  ok(`current = v3, prev_version_ids = [v2, v1]`)

  // 5. get v2
  const v2 = await call('GET', `/entries/${encodeURIComponent(id)}/versions/2`)
  if (v2.status !== 200) fail(`get v2 failed: ${JSON.stringify(v2)}`)
  if (v2.body?.body !== 'v2 body') fail(`v2 body="${v2.body?.body}", want "v2 body"`)
  if (v2.body?.frontmatter?.version !== 2) fail(`v2 frontmatter.version=${v2.body?.frontmatter?.version}, want 2`)
  ok(`get versions/2 → "v2 body"`)

  // 6. get v1
  const v1 = await call('GET', `/entries/${encodeURIComponent(id)}/versions/1`)
  if (v1.status !== 200) fail(`get v1 failed: ${JSON.stringify(v1)}`)
  if (v1.body?.body !== 'v1 body') fail(`v1 body="${v1.body?.body}", want "v1 body"`)
  ok(`get versions/1 → "v1 body"`)

  // 7. missing version
  const v99 = await call('GET', `/entries/${encodeURIComponent(id)}/versions/99`)
  if (v99.status !== 200) fail(`get v99 should be 200 with error body, got ${v99.status}`)
  if (v99.body?.error !== 'version not found') {
    fail(`v99 error="${v99.body?.error}", want "version not found"`)
  }
  ok(`get versions/99 → error "version not found"`)

  // 8. unknown id
  const unknown = await call('GET', `/entries/no-such-id-${Date.now()}/versions/1`)
  if (unknown.body?.error !== 'not found') {
    fail(`unknown id error="${unknown.body?.error}", want "not found"`)
  }
  ok(`get versions for unknown id → error "not found"`)
} catch (e) {
  console.error(e)
  exitCode = 1
} finally {
  // cleanup
  const del = await call('DELETE', `/entries/${encodeURIComponent(id)}`)
  if (del.status !== 204) {
    console.warn(`⚠ cleanup DELETE returned status=${del.status}, body=${JSON.stringify(del.body)}`)
  } else {
    ok(`cleaned up: deleted ${id}`)
  }
}

if (exitCode === 0) {
  console.log('\n🎉 N7 E2E (cross-process, real HTTP) passed.')
}
process.exit(exitCode)
