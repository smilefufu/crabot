/**
 * 已知工具二进制路径解析
 *
 * 某些工具（如 uv）通过用户级 installer 装到 ~/.local/bin/，installer 会写 user
 * 环境变量但 Windows 上传播延迟——刚装完新开 cmd 也可能读不到，导致 MM spawn
 * 子进程 ENOENT。主动按 installer 默认位置探测，绕开 PATH 不确定性。
 *
 * 不替代 PATH——找不到已知位置就 fallback 到原命令名，让 PATH 解析报清晰错。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const IS_WIN = process.platform === 'win32'

function knownLocations(cmd: string): string[] {
  switch (cmd) {
    case 'uv': {
      const binName = IS_WIN ? 'uv.exe' : 'uv'
      const candidates = [path.join(os.homedir(), '.local', 'bin', binName)]
      if (IS_WIN) {
        candidates.push(
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'uv', binName)
        )
      }
      return candidates.filter(Boolean)
    }
    default:
      return []
  }
}

/**
 * 把命令名解析成可直接 spawn 的绝对路径（如果能找到的话）。
 *
 * - 已经是绝对路径 → 原样返回
 * - 已知工具（uv）→ 按 installer 默认位置查找
 * - 找不到 → 返回原命令名，让 spawn 自己走 PATH（失败时报清晰 ENOENT）
 */
export function resolveExecutable(cmd: string): string {
  if (path.isAbsolute(cmd)) return cmd
  if (process.env.CRABOT_PRODUCT_ROOT) {
    const { loadProductRuntime } = require('../../scripts/lib/product-runtime.cjs')
    const runtime = loadProductRuntime(process.env.CRABOT_PRODUCT_ROOT, { required: true })
    const name = cmd === 'python3' ? 'python' : cmd
    if (Object.prototype.hasOwnProperty.call(runtime.executables, name)) return runtime.executables[name]
  }
  for (const candidate of knownLocations(cmd)) {
    if (fs.existsSync(candidate)) return candidate
  }
  return cmd
}
