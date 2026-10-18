// crabot CLI 操作互斥锁（实例级）。
//
// 背景：restart/stop/start 交叠时会互踩——后来的 stop 按 mm.pid 把先前 start 刚拉起的
// supervisor SIGTERM 掉（2026-08-28 生产实例连续两次重启失败的根因：另一操作者的 stop
// 与用户串行执行的 restart 撞窗）。此锁让并发的 CLI 操作明确失败或短暂等待，而不是
// 静默互杀。
//
// 语义：
//   - 锁文件 $DATA_DIR/cli.lock，O_EXCL('wx') 原子创建，内容 { pid, command, started_at }。
//   - 持有者已死（process.exit 未走 release、SIGKILL）→ 陈旧锁，在短生命周期修复互斥内重读属主后 rename 接管。
//   - 被占且持有者存活：默认等待 5s 后报错退出，报错携带持有者 pid/命令/起始时间，
//     便于定位"谁在操作实例"。
//   - restart 经 env CRABOT_CLI_LOCK_HELD=1 调用子 stop/start：子命令跳过抢锁，
//     锁由 restart 外层持有全程。
import { readFileSync, writeFileSync, unlinkSync, renameSync, mkdirSync, rmdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { if (error.code === 'ESRCH') return false; throw error }
}
function readHolder(lockPath) {
  try { return JSON.parse(readFileSync(lockPath, 'utf8')) } catch { return null }
}
function validHolder(holder) { return holder && Number.isSafeInteger(holder.pid) && holder.pid > 0 }

// Serialize only stale-lock repair, then re-read ownership. A cached dead PID cannot authorize
// renaming a newer live lock. An interrupted repair is retained and fails within the deadline.
function recoverStaleLock(lockPath) {
  const recovery = `${lockPath}.recovery`, owner = resolve(recovery, 'owner.json')
  try { mkdirSync(recovery, { mode: 0o700 }) }
  catch (error) { if (error.code === 'EEXIST') return false; throw error }
  try {
    writeFileSync(owner, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 })
    const current = readHolder(lockPath)
    if (!validHolder(current) || isPidAlive(current.pid)) return false
    const stale = `${lockPath}.stale.${process.pid}`
    try { renameSync(lockPath, stale) } catch (error) { if (error.code === 'ENOENT') return true; throw error }
    unlinkSync(stale)
    return true
  } finally {
    try { unlinkSync(owner) } catch (error) { if (error.code !== 'ENOENT') throw error }
    rmdirSync(recovery)
  }
}

export async function acquireCliLock(dataDir, command, waitMs = 5000) {
  const lockPath = resolve(dataDir, 'cli.lock')
  const directory = statSync(dataDir)
  if (process.getuid && process.getuid() !== 0 && directory.uid !== process.getuid()) throw new Error('CLI instance directory belongs to another user')
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, command, started_at: new Date().toISOString() }), { flag: 'wx' })
      return lockPath
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    const holder = readHolder(lockPath)
    if (!validHolder(holder)) {
      if (Date.now() >= deadline) throw new Error('invalid CLI lock; preserve ownership evidence before recovery')
      await sleep(200)
      continue
    }
    if (!isPidAlive(holder.pid)) {
      if (recoverStaleLock(lockPath)) continue
      if (Date.now() >= deadline) throw new Error('stale CLI lock recovery is incomplete or busy; preserve recovery evidence')
      await sleep(200)
      continue
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `another crabot CLI operation is in progress `
        + `(pid=${holder.pid}, cmd=${holder.command ?? '?'}, since=${holder.started_at ?? '?'}) — `
        + `wait for it to finish, then retry`,
      )
    }
    await sleep(200)
  }
}

export function releaseCliLock(lockPath) {
  if (!lockPath) return
  try {
    if (readHolder(lockPath)?.pid === process.pid) unlinkSync(lockPath)
  } catch { /* Missing or unknown ownership must not remove another operation's lock. */ }
}

/** An inherited flag alone is not a lock: bind it to the live parent's actual lock record. */
export function inheritedCliLock(dataDir, env = process.env) {
  const pid = Number(env.CRABOT_CLI_LOCK_OWNER)
  if (env.CRABOT_CLI_LOCK_HELD !== '1' || !Number.isSafeInteger(pid) || pid < 1) return false
  try {
    const holder = JSON.parse(readFileSync(resolve(dataDir, 'cli.lock'), 'utf8'))
    return holder.pid === pid && isPidAlive(pid)
  } catch { return false }
}
