// Only the startup orphan check. Never starts a business MM or runs migrations.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { cliLockToken, hasInheritedCliLock } from './cli-lock.mjs'
import state from './preflight-state.cjs'
import identity from './process-identity.cjs'

export async function runCorePreflight({ root, dataDir, node, env, stdio = ['ignore', 'pipe', 'pipe'], timeoutMs }) {
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw state.failure()
  const ownedToken = cliLockToken(path.resolve(dataDir, 'cli.lock'))
  const token = ownedToken ?? env.CRABOT_CLI_LOCK_HELD
  if (!token || !ownedToken && !hasInheritedCliLock(dataDir, token)) throw state.failure()
  const previous = state.read(dataDir)
  if (previous) state.assertSettled(dataDir, previous.id)
  const record = { schema_version: 1, kind: 'orphan_preflight', id: randomUUID(), lock_token: token,
    owner: identity.inspectProcess(process.pid), child: null, ...(previous ? { previous_id: previous.id } : {}) }
  state.publish(dataDir, record, previous?.id ?? null)
  let child, timer, stdout = '', stderr = ''
  try {
    child = spawn(node, ['--import', fileURLToPath(new URL('./preflight-child.mjs', import.meta.url)),
      path.join(root, 'crabot-core/dist/orphan-recovery-preflight.js')], {
      cwd: path.join(root, 'crabot-core'), stdio, env: { ...env, CRABOT_PREFLIGHT_DATA_DIR: dataDir, CRABOT_PREFLIGHT_ID: record.id },
    })
    child.stdout?.on('data', bytes => { stdout = (stdout + bytes.toString()).slice(-1024 * 1024) })
    child.stderr?.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-1024 * 1024) })
    const exited = once(child, 'exit')
    void exited.catch(() => {})
    await once(child, 'spawn')
    record.child = identity.inspectProcess(child.pid)
    if (!record.child || record.child.parent !== record.owner.pid) throw state.failure()
    state.publish(dataDir, record, record.id)
    const completion = [exited]
    if (timeoutMs !== undefined) completion.push(new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(state.failure(), { code: 'CRABOT_PREFLIGHT_TIMEOUT' })), timeoutMs)
    }))
    const [code, signal] = await Promise.race(completion)
    if (signal) throw state.failure()
    state.acknowledge(dataDir, record.id)
    return { exitCode: code ?? 1, stdout, stderr }
  } catch (error) {
    // An unregistered child cannot pass its preload. Leave registered/unknown
    // work recorded, rather than clearing a receipt based on parent failure.
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try {
        const ended = once(child, 'exit', { signal: AbortSignal.timeout(6000) })
        try { if (record.child && identity.sameProcess(record.child, identity.inspectProcess(child.pid))) child.kill('SIGKILL') }
        catch { /* Preserve uncertainty and wait for this concrete child only. */ }
        await ended
      } catch (cleanup) { throw new AggregateError([error, cleanup], '启动检查失败，未能确认子进程结束；原检查记录已保留。', { cause: error }) }
    }
    if (!record.child && !child?.pid) state.acknowledge(dataDir, record.id)
    throw error
  } finally { clearTimeout(timer) }
}
