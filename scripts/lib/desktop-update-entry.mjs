import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import desktop from './desktop-entry.cjs'

// A sealed app's CLI only presents its native update channel. It never downloads
// an archive over signed resources, assumes --yes approval, or claims completion.
export async function openDesktopUpdate(root, { launch = spawn } = {}) {
  if (!existsSync(join(root, 'desktop-host.json'))) return false
  const entry = desktop.loadDesktopEntry(root)
  if (!entry || entry.development) throw new Error('桌面入口无法验证，请修复 Crabot 安装。')
  const child = launch(entry.executable, ['--check-updates'], { detached: true, stdio: 'ignore', windowsHide: false })
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('spawn', resolve) })
  child.unref()
  return true
}
