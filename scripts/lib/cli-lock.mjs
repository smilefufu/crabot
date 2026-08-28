// crabot CLI 操作互斥锁（实例级）。
//
// 背景：restart/stop/start 交叠时会互踩——后来的 stop 按 mm.pid 把先前 start 刚拉起的
// supervisor SIGTERM 掉（2026-08-28 生产实例连续两次重启失败的根因：另一操作者的 stop
// 与用户串行执行的 restart 撞窗）。此锁让并发的 CLI 操作明确失败或短暂等待，而不是
// 静默互杀。
//
// 语义：
//   - 锁文件 $DATA_DIR/cli.lock，O_EXCL('wx') 原子创建，内容 { pid, command, started_at }。
//   - 持有者已死（process.exit 未走 release、SIGKILL）→ 陈旧锁，经原子 rename 接管。
//   - 被占且持有者存活：默认等待 5s 后报错退出，报错携带持有者 pid/命令/起始时间，
//     便于定位"谁在操作实例"。
//   - restart 经 env CRABOT_CLI_LOCK_HELD=1 调用子 stop/start：子命令跳过抢锁，
//     锁由 restart 外层持有全程。
import { readFileSync, writeFileSync, unlinkSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import { isPidAlive } from './pid.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export async function acquireCliLock(dataDir, command, waitMs = 5000) {
  const lockPath = resolve(dataDir, 'cli.lock')
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      writeFileSync(lockPath, JSON.stringify({ pid: process.pid, command, started_at: new Date().toISOString() }), { flag: 'wx' })
      return lockPath
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
    }
    let holder = null
    try { holder = JSON.parse(readFileSync(lockPath, 'utf-8')) } catch { holder = null }
    if (!holder || typeof holder.pid !== 'number' || !isPidAlive(holder.pid)) {
      if (holder) {
        // 原子接管：rename 只有一个竞争者会成功，失败者重读现状态。
        // 不用 unlink——它可能误删另一接管者刚建好的新锁，破坏互斥。
        const stalePath = `${lockPath}.stale.${process.pid}`
        try {
          renameSync(lockPath, stalePath)
          try { unlinkSync(stalePath) } catch { /* 残留无害：不被当作锁 */ }
        } catch { /* 已被其它接管者移走：重读 */ }
      }
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
  try { unlinkSync(lockPath) } catch { /* 已被接管者移走：无需处理 */ }
}
