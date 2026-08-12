/**
 * macOS Full Disk Access (FDA) 探测与引导。
 *
 * 背景：agent 的 glob/grep 工作目录默认是用户家目录（~）。在 macOS 上爬到
 * `~/Library/Containers` 等别的 App 的数据容器时，会触发 TCC「想访问其他 App
 * 的数据」弹窗——不点就把 rg 子进程卡死（实测挂起过 144 分钟），点「不允许」
 * 则 rg 对受保护目录拿到 EPERM、退出码 2。
 *
 * 默认策略：glob/grep 跳过受保护目录（见 ripgrep-helper 的 getProtectedExcludeGlobs）。
 * 高级用户若希望 agent 真去读 App 数据，可设 `CRABOT_ENABLE_FDA=1` 表达意图，
 * 并在系统设置里给宿主进程授予「完全磁盘访问权限」。
 *
 * 关键：`CRABOT_ENABLE_FDA` 只是**意图**，真正决定是否放开扫描的是**实际探针**
 * （shouldScanProtectedDirs = 意图 && 真持有 FDA）。这样即便用户开了意图但还没
 * 真授权，也不会退化回卡死——仍然跳过受保护目录。
 */

import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { buildChildEnv } from '../../core/runtime-env.js'

/** 直达「完全磁盘访问权限」面板的深链（macOS 13+ System Settings 同样支持）。 */
const FDA_SETTINGS_URL =
  'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFilesAccess'

/** 只有持 FDA 的进程读得到的文件；EPERM = 没有 FDA。 */
const TCC_DB = join(homedir(), 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db')

/** 进程级缓存：探针是一次 syscall，但每次 glob 都探一遍没必要；授权后需重启才刷新。 */
let cachedFda: boolean | undefined

/** 当前进程是否持有「完全磁盘访问权限」。非 darwin 恒为 false。 */
export function hasFullDiskAccess(): boolean {
  if (process.platform !== 'darwin') return false
  if (cachedFda !== undefined) return cachedFda
  try {
    accessSync(TCC_DB, constants.R_OK)
    cachedFda = true
  } catch {
    cachedFda = false
  }
  return cachedFda
}

/** 用户是否通过 `CRABOT_ENABLE_FDA` 表达了「放开受保护目录」的意图。 */
export function isFdaEnabled(): boolean {
  const v = process.env.CRABOT_ENABLE_FDA
  return v === '1' || v === 'true' || v === 'yes'
}

/** 是否应该扫描受保护目录：意图开启 **且** 真正持有 FDA，缺一不可。 */
export function shouldScanProtectedDirs(): boolean {
  return isFdaEnabled() && hasFullDiskAccess()
}

/** best-effort 打开系统设置的 FDA 面板；后台/无 GUI 会话下失败靠 CLI 提示兜底。 */
function openFdaSettings(): void {
  try {
    const proc = spawn('open', [FDA_SETTINGS_URL], { stdio: 'ignore', detached: true, env: buildChildEnv() })
    // spawn 失败异步 emit 'error'，必须零 await 立刻 attach，否则漏成 uncaughtException。
    proc.on('error', () => { /* 后台/无 GUI 会话下 open 失败属正常 */ })
    proc.unref()
  } catch {
    /* best-effort：连 spawn 都抛（极少见）也不该挡启动 */
  }
}

/**
 * 启动时调用。用户开了 `CRABOT_ENABLE_FDA` 但实际没授 FDA → CLI 提示 +
 * best-effort 弹设置面板。其余情况静默（非 darwin / 未开意图 / 已授权时仅一行确认）。
 */
export function checkFdaIfEnabled(log: (msg: string) => void): void {
  if (process.platform !== 'darwin') return
  if (!isFdaEnabled()) return
  if (hasFullDiskAccess()) {
    log('[FDA] 已检测到完全磁盘访问权限，glob/grep 将扫描 ~/Library 等受保护目录。')
    return
  }
  log(
    '[FDA] 已设置 CRABOT_ENABLE_FDA，但当前进程没有「完全磁盘访问权限」。\n' +
    '      请在打开的系统设置里，把运行 Crabot 的宿主程序加入「完全磁盘访问权限」：\n' +
    '        · 开发模式：你的终端 App（如 iTerm / Terminal）\n' +
    '        · 生产模式：node 可执行文件（launchd 下的宿主进程）\n' +
    '      授予后重启 Crabot 生效。在此之前 glob/grep 仍会自动跳过受保护目录以防卡死。',
  )
  openFdaSettings()
}

/** 仅供测试：重置探针缓存。 */
export function __resetFdaCacheForTest(): void {
  cachedFda = undefined
}
