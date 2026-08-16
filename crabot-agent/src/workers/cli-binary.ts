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

export async function resolveUserLevelBinary(name: string, dataRoot: string): Promise<CliBinaryResolution> {
  // 枚举 PATH 全部候选（command -v 只给首命中——全局排在前面时会把已存在的用户级
  // 安装整段漏掉并误报 global；必须看全）。
  const pathEnv = buildScrubbedChildEnv().PATH ?? process.env.PATH ?? ''
  const home = path.resolve(os.homedir())
  const data = path.resolve(dataRoot)
  let globalFound = false
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue
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
