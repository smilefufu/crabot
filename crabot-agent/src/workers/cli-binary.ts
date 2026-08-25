/**
 * CLI binary 解析（2026-08-16 修订：v1 无 managed install，只认用户级安装）。
 *
 * 规则：realpath 必须位于当前用户 $HOME 之下、且不在 Crabot 数据目录内——
 * /usr/local、/usr/lib、/opt/homebrew 等全局位置一律忽略（Crabot 对全局安装
 * 没有升级权限，用它会造成「升了级却不生效」的错位）。全局存在但用户级缺失时
 * 只报告 global_detected，不静默使用。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildScrubbedChildEnv } from './connections/secret-env.js'

export interface CliBinaryResolution {
  /** 用户级绝对路径（realpath 后）；无则 undefined。 */
  binary?: string
  /** 全局安装被检测到但被忽略。 */
  global_detected: boolean
}

export interface ResolveUserLevelBinaryOptions {
  /** 测试可注入；生产始终使用当前运行用户 home。 */
  homeDir?: string
  /** 测试可注入；生产从 scrubbed child env 读取。 */
  pathEnv?: string
}

export async function resolveUserLevelBinary(
  name: string,
  dataRoot: string,
  options: ResolveUserLevelBinaryOptions = {},
): Promise<CliBinaryResolution> {
  // 枚举 PATH 全部候选（command -v 只给首命中——全局排在前面时会把已存在的用户级
  // 安装整段漏掉并误报 global；必须看全）。
  const pathEnv = options.pathEnv ?? buildScrubbedChildEnv().PATH ?? process.env.PATH ?? ''
  const resolvedHome = path.resolve(options.homeDir ?? os.homedir())
  const resolvedData = path.resolve(dataRoot)
  // macOS 的 /var -> /private/var alias 会让 realpath(candidate) 与 path.resolve($HOME)
  // 前缀不同；比较时两端都尽量 realpath，缺失 data root 则保留解析后的目标。
  const home = await fs.realpath(resolvedHome).catch(() => resolvedHome)
  const data = await fs.realpath(resolvedData).catch(() => resolvedData)
  let globalFound = false
  // Crabot 页面安装固定使用 npm 的标准用户级 prefix，但不得持久修改 PATH；把该 bin
  // 目录作为显式候选，保证安装后 Worker 能解析到同一 binary。
  const directories = [path.join(home, '.local', 'bin'), ...pathEnv.split(path.delimiter)]
  const visited = new Set<string>()
  for (const dir of directories) {
    if (!dir) continue
    const normalizedDir = path.resolve(dir)
    if (visited.has(normalizedDir)) continue
    visited.add(normalizedDir)
    const candidate = path.join(dir, name)
    let real: string
    try {
      const stat = await fs.stat(candidate)
      if (!stat.isFile()) continue
      await fs.access(candidate, fs.constants.X_OK)
      real = await fs.realpath(candidate)
    } catch {
      continue
    }
    if (real.startsWith(home + path.sep) && !real.startsWith(data + path.sep)) {
      return { binary: real, global_detected: false }
    }
    globalFound = true
  }
  return { global_detected: globalFound }
}
