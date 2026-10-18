import { it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { prepareSharedRequests } from '../shared-requests.mjs'
import { runMigrations } from '../migrate.mjs'
const home = fileURLToPath(new URL('../../../', import.meta.url)), quiet = { info() {}, error() {} }
let root
const key = 'channel::group', file = 'channel%3A%3Agroup.json'
const ledger = () => ({ manager_key: key, workers: [{ worker_id: 'old', manager_key: key, task: { id: 'old', status: 'halted' }, origin: { trigger_type: 'message', creator_friend_id: 'historical-friend' }, incarnations: [] }] })
const ready = () => path.join(root, 'agent', 'shared-request-upgrade.json')
const ledgerPath = () => path.join(root, 'agent', 'worker-ledgers', file)
async function setup() {
  await fs.mkdir(path.join(root, 'agent', 'worker-ledgers'), { recursive: true })
  await fs.mkdir(path.join(root, 'agent', 'workers', 'old'), { recursive: true })
  await fs.mkdir(path.join(root, 'agent', 'managers', 'old'), { recursive: true })
  await fs.mkdir(path.join(root, 'admin'))
  await fs.writeFile(ledgerPath(), JSON.stringify(ledger()))
  await fs.writeFile(path.join(root, 'agent', 'workers', 'old', 'context.json'), JSON.stringify({ creator_friend_id: 'historical-friend' }))
  await fs.writeFile(path.join(root, 'agent', 'managers', 'old', 'checkpoint.json'), 'OLD CHECKPOINT PRIVATE BODY')
  await fs.writeFile(path.join(root, 'agent', 'workers', 'old', 'input.json'), 'OLD INPUT DO NOT REPLAY')
  await fs.writeFile(path.join(root, 'admin', 'friends.json'), '[]')
}
async function devLaunch() {
  const source = await fs.readFile(path.join(home, 'dev.sh'), 'utf8')
  const start = source.indexOf('  # 4. 单实例预检'), end = source.indexOf('\n}\n', start)
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start)
  const fixture = path.join(root, 'dev-mm-fixture.mjs')
  await fs.writeFile(fixture, `import fs from 'node:fs/promises'; import path from 'node:path'; import { pathToFileURL } from 'node:url';
    const [home, data] = process.argv.slice(2);
    for (let count = 0; count < 600; count++) {
      if (await fs.stat(path.join(data, 'mm.pid')).then(() => true, () => false)) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    const { prepareSharedRequests } = await import(pathToFileURL(path.join(home, 'scripts/upgrade-lib/shared-requests.mjs')));
    await prepareSharedRequests(home, data, { info() {}, error() {} });
    console.log('DEV_MM_READY');`)
  const shell = `set -euo pipefail
    log_info() { :; }
    log_error() { echo "$@" >&2; }
    node() {
      case "$1" in
        "$SCRIPT_DIR/crabot-core/dist/orphan-recovery-preflight.js") return 0 ;;
        "$SCRIPT_DIR/scripts/prepare-shared-requests.mjs") "$NODE_BIN" "$@" ;;
        dist/main.js) echo DEV_MM_SPAWN; "$NODE_BIN" "$DEV_MM_FIXTURE" "$SCRIPT_DIR" "$DATA_DIR" ;;
        *) return 99 ;;
      esac
    }
    launch() {
      ${source.slice(start, end)}
    }
    launch
    # The finite MM fixture exited normally; do not signal its already-finished PID.
    trap - EXIT
    rm -f "$DATA_DIR/mm.pid"`
  return spawnSync('bash', ['-c', shell], { env: { ...process.env, SCRIPT_DIR: home, DATA_DIR: root, NODE_BIN: process.execPath, DEV_MM_FIXTURE: fixture }, encoding: 'utf8', timeout: 10000 })
}
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'request-migration-')) })
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })
it('first dev launch prepares before its live MM PID, and the MM fallback sees ready', async () => {
  if (process.platform === 'win32') return
  await setup()
  const result = await devLaunch()
  expect(result.status, result.stdout + result.stderr).toBe(0)
  expect(result.stdout).toContain('DEV_MM_READY')
  expect(JSON.parse(await fs.readFile(ready(), 'utf8')).status).toBe('ready')
  expect(JSON.parse(await fs.readFile(ledgerPath(), 'utf8')).ledger).toEqual(ledger())
})
it('failed dev preparation never launches MM or rewrites the original ledger', async () => {
  if (process.platform === 'win32') return
  await setup(); const invalid = '{"unsupported":true}'; await fs.writeFile(ledgerPath(), invalid)
  const result = await devLaunch()
  expect(result.status).not.toBe(0); expect(result.stdout).not.toContain('DEV_MM_SPAWN')
  expect(await fs.readFile(ledgerPath(), 'utf8')).toBe(invalid)
  expect(result.stdout + result.stderr).not.toContain('Stop Crabot before preparing request upgrade')
  await expect(fs.stat(ready())).rejects.toThrow()
})
it('verified backup precedes conversion; old identity, context, checkpoint and receipts stay unchanged; idempotent ready path', async () => {
  await setup(); const original = await fs.readFile(ledgerPath(), 'utf8')
  const result = await prepareSharedRequests(home, root, quiet)
  expect(result.status).toBe('prepared')
  const converted = JSON.parse(await fs.readFile(ledgerPath(), 'utf8'))
  expect(converted).toEqual({ schema_version: 1, ledger: ledger() })
  expect(converted.manager_key).toBeUndefined(); expect(converted.workers).toBeUndefined() // old strict reader cannot consume this
  expect(await fs.readFile(path.join(root, 'shared-request-upgrade-v1', 'backup', 'agent', 'worker-ledgers', file), 'utf8')).toBe(original)
  expect(await fs.readFile(path.join(root, 'agent', 'workers', 'old', 'context.json'), 'utf8')).toBe(JSON.stringify({ creator_friend_id: 'historical-friend' }))
  expect(await fs.readFile(path.join(root, 'agent', 'managers', 'old', 'checkpoint.json'), 'utf8')).toBe('OLD CHECKPOINT PRIVATE BODY')
  expect(await fs.readFile(path.join(root, 'agent', 'workers', 'old', 'input.json'), 'utf8')).toBe('OLD INPUT DO NOT REPLAY')
  const report = await fs.readFile(result.report, 'utf8'); expect(report).not.toMatch(/PRIVATE BODY|DO NOT REPLAY/)
  if (process.platform !== 'win32') expect((await fs.stat(result.report)).mode & 0o777).toBe(0o600)
  const marker = await fs.readFile(ready(), 'utf8')
  expect((await prepareSharedRequests(home, root, quiet)).status).toBe('ready')
  expect(await fs.readFile(ready(), 'utf8')).toBe(marker)
})
it('conversion failure restores exact original bytes and leaves no readiness; safe retry uses verified original backup', async () => {
  await setup(); const original = await fs.readFile(ledgerPath(), 'utf8')
  await expect(prepareSharedRequests(home, root, quiet, { afterConvert() { throw new Error('injected failure') } })).rejects.toThrow('injected failure')
  expect(await fs.readFile(ledgerPath(), 'utf8')).toBe(original)
  await expect(fs.stat(ready())).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await prepareSharedRequests(home, root, quiet)).status).toBe('prepared')
})
it('refuses corrupt/unknown ledger format without changing it or creating authority', async () => {
  await setup(); const bytes = JSON.stringify({ schema_version: 99, ledger: ledger() }); await fs.writeFile(ledgerPath(), bytes)
  await expect(prepareSharedRequests(home, root, quiet)).rejects.toThrow('Unsupported ledger envelope')
  expect(await fs.readFile(ledgerPath(), 'utf8')).toBe(bytes); await expect(fs.stat(ready())).rejects.toThrow()
})
it.each([['requests.json', { version: 99, requests: [] }], ['request-sources.json', { version: 99, inputs: [] }]])('unknown %s version blocks all new authority and keeps old checkpoint', async (name, value) => {
  await setup(); await fs.writeFile(path.join(root, 'agent', 'managers', 'old', name), JSON.stringify(value))
  await expect(prepareSharedRequests(home, root, quiet)).rejects.toThrow('Unsupported request state')
  expect(JSON.parse(await fs.readFile(ledgerPath(), 'utf8'))).toEqual(ledger()); await expect(fs.stat(ready())).rejects.toThrow()
})
it('backup/report tampering fails closed and rolls converted files back', async () => {
  await setup(); const original = await fs.readFile(ledgerPath(), 'utf8')
  await expect(prepareSharedRequests(home, root, quiet, { async afterConvert() { await fs.writeFile(path.join(root, 'shared-request-upgrade-v1', 'impact.json'), '{}') } })).rejects.toThrow('Impact report')
  expect(await fs.readFile(ledgerPath(), 'utf8')).toBe(original); await expect(fs.stat(ready())).rejects.toThrow()
  await expect(prepareSharedRequests(home, root, quiet)).rejects.toThrow('Impact report')
})
it('existing incomplete backup is preserved; no unverified overwrite or readiness', async () => {
  await setup(); const backup = path.join(root, 'shared-request-upgrade-v1', 'backup'); await fs.mkdir(backup, { recursive: true }); await fs.writeFile(path.join(backup, 'evidence'), 'keep')
  await expect(prepareSharedRequests(home, root, quiet)).rejects.toThrow('Incomplete request backup')
  expect(await fs.readFile(path.join(backup, 'evidence'), 'utf8')).toBe('keep'); await expect(fs.stat(ready())).rejects.toThrow()
})
it('refuses online mutation; unknown readiness cannot become success', async () => {
  await setup(); await fs.writeFile(path.join(root, 'mm.pid'), String(process.pid))
  await expect(prepareSharedRequests(home, root, quiet)).rejects.toThrow('Stop Crabot')
  await fs.rm(path.join(root, 'mm.pid')); await fs.writeFile(ready(), JSON.stringify({ schema_version: 2, status: 'ready' }))
  await expect(prepareSharedRequests(home, root, quiet)).rejects.toThrow('Unsupported request upgrade marker')
})
it('ready-path verifies report and plan; new Worker contents are never restored from the old backup', async () => {
  await setup(); await prepareSharedRequests(home, root, quiet)
  const converted = JSON.parse(await fs.readFile(ledgerPath(), 'utf8')); converted.ledger.workers.push({ worker_id: 'new' }); await fs.writeFile(ledgerPath(), JSON.stringify(converted))
  await prepareSharedRequests(home, root, quiet); expect(JSON.parse(await fs.readFile(ledgerPath(), 'utf8')).ledger.workers).toHaveLength(2)
  await fs.writeFile(path.join(root, 'shared-request-upgrade-v1', 'plan.json'), '{}')
  await expect(prepareSharedRequests(home, root, quiet)).rejects.toThrow('plan changed')
})
it('fresh install and shared runMigrations entry produce the same completed gate', async () => {
  await runMigrations(home, root, async () => ({ exitCode: 0 }), quiet)
  expect(JSON.parse(await fs.readFile(ready(), 'utf8'))).toMatchObject({ schema_version: 1, status: 'ready' })
})

it('a process crash after first conversion resumes only the verified file transaction, never checkpoint work', async () => {
  await setup()
  const helper = pathToFileURL(path.join(home, 'scripts', 'upgrade-lib', 'shared-requests.mjs')).href
  const code = `import { prepareSharedRequests } from ${JSON.stringify(helper)}; await prepareSharedRequests(${JSON.stringify(home)}, ${JSON.stringify(root)}, console, { afterConvert() { process.exit(41) } })`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' })
  expect(child.status, child.stderr).toBe(41)
  await expect(fs.stat(ready())).rejects.toThrow()
  expect(JSON.parse(await fs.readFile(ledgerPath(), 'utf8'))).toHaveProperty('schema_version', 1)
  expect((await prepareSharedRequests(home, root, quiet)).status).toBe('prepared')
  expect(await fs.readFile(path.join(root, 'agent', 'workers', 'old', 'input.json'), 'utf8')).toBe('OLD INPUT DO NOT REPLAY')
})
it('valid-version but invalid identity/context still blocks preparation through production readers', async () => {
  await setup()
  await fs.writeFile(path.join(root, 'agent', 'workers', 'old', 'context.json'), JSON.stringify({ schema_version: 2, request: { schema_version: 1, request_id: 'forged' } }))
  await expect(prepareSharedRequests(home, root, quiet)).rejects.toThrow()
  expect(JSON.parse(await fs.readFile(ledgerPath(), 'utf8'))).toEqual(ledger())
  await expect(fs.stat(ready())).rejects.toThrow()
})

it('configuration changes during conversion invalidate the impact report and never enable authority', async () => {
  await setup(); const original = await fs.readFile(ledgerPath(), 'utf8')
  await expect(prepareSharedRequests(home, root, quiet, { async afterConvert() { await fs.writeFile(path.join(root, 'admin', 'friends.json'), '[{}]') } })).rejects.toThrow('Data changed')
  expect(await fs.readFile(ledgerPath(), 'utf8')).toBe(original); await expect(fs.stat(ready())).rejects.toThrow()
  await expect(prepareSharedRequests(home, root, quiet)).rejects.toThrow('Data changed')
})
it('authority symlinks cannot turn a link-only backup into verified source data', async () => {
  if (process.platform === 'win32') return
  await setup(); const elsewhere = path.join(root, 'external-friends.json'); await fs.writeFile(elsewhere, '[]')
  await fs.rm(path.join(root, 'admin', 'friends.json')); await fs.symlink(elsewhere, path.join(root, 'admin', 'friends.json'))
  await expect(prepareSharedRequests(home, root, quiet)).rejects.toThrow('Authority data symlink')
  await expect(fs.stat(ready())).rejects.toThrow()
})

it.each([false, true])('valid request-bound data uses real original/hash/double-binding readers; corrupted=%s', async corrupted => {
  await setup()
  const load = filename => import(pathToFileURL(path.join(home, filename)).href)
  const [{ TrustedHumanInputStore }, { ConversationRequestStore }, { WorkerContextStore }, { PermissionTemplateManager }] = await Promise.all([
    load('crabot-agent/dist/manager/trusted-human-input-store.js'), load('crabot-agent/dist/manager/conversation-request-store.js'),
    load('crabot-agent/dist/workers/harness/context-store.js'), load('crabot-admin/dist/permission-template-manager.js'),
  ])
  const templates = new PermissionTemplateManager(); templates.initSystemTemplates()
  const timestamp = '2026-10-16T00:00:00Z', managers = path.join(root, 'agent', 'managers')
  const sources = new TrustedHumanInputStore(managers, { now: () => timestamp, resolveSender: async () => ({ id: 'friend', channel_identities: [{ channel_id: 'channel', platform_user_id: 'person' }] }) })
  const inputs = await sources.capture(key, [{ platform_message_id: 'new-input', platform_timestamp: timestamp,
    session: { channel_id: 'channel', session_id: 'group', type: 'group' }, sender: { platform_user_id: 'person', platform_display_name: 'Person' },
    content: { type: 'text', text: 'SYNTHETIC ORIGINAL REQUEST BODY' }, features: { is_mention_crab: true } }])
  const requests = new ConversationRequestStore(managers, sources, { now: () => timestamp, resolveSources: async () => ({
    group: { kind: 'group', subject_id: key, is_master: false, resolved: templates.resolvePermissions('group_default') },
    friend: { kind: 'friend', subject_id: 'friend', is_master: false, resolved: templates.resolvePermissions('standard') },
  }) })
  const request = await requests.forInputs(key, inputs).create({ source_id: inputs[0].source_id, delivery: 'requester_private' })
  await requests.attachWorker(key, request.request_id, 'bound')
  const binding = { schema_version: 1, request_id: request.request_id, source_sha256: corrupted ? 'a'.repeat(64) : request.source_sha256, execution_scope: 'request' }
  const context = new WorkerContextStore(path.join(root, 'agent', 'workers'))
  await context.write('bound', { schema_version: 2, request: binding, manager_key: key, creator_friend_id: 'friend', target_session: { channel_id: 'channel', session_id: 'group', type: 'group' } })
  const value = ledger(); value.workers.push({ ...value.workers[0], worker_id: 'bound', origin: { trigger_type: 'message', creator_friend_id: 'friend', request: binding }, report_to: { channel_id: 'channel', session_id: 'group' } })
  await fs.writeFile(ledgerPath(), JSON.stringify({ schema_version: 1, ledger: value }))
  if (corrupted) { await expect(prepareSharedRequests(home, root, quiet)).rejects.toThrow('binding/context unavailable'); await expect(fs.stat(ready())).rejects.toThrow() }
  else {
    const result = await prepareSharedRequests(home, root, quiet)
    expect(result.status).toBe('prepared'); expect(await fs.readFile(result.report, 'utf8')).not.toContain('SYNTHETIC ORIGINAL REQUEST BODY')
    expect(JSON.parse(await fs.readFile(ledgerPath(), 'utf8'))).toEqual({ schema_version: 1, ledger: value })
  }
})
