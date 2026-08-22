import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDataDir } from './data-dir.mjs'

const FILENAME = 'instance.json'

export function hasInstance(homeDir) {
  return existsSync(join(homeDir, FILENAME))
}

export function readInstance(homeDir) {
  const path = join(homeDir, FILENAME)
  const raw = readFileSync(path, 'utf-8')
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`instance.json 损坏（${path}：${err.message}）；请删除后重新运行 \`crabot init\``)
  }
}

export function writeInstance(homeDir, manifest) {
  writeFileSync(join(homeDir, FILENAME), JSON.stringify(manifest, null, 2) + '\n')
}

/**
 * 解析 OFFSET 的统一优先级：env > instance.json > 0
 *
 * 为什么：start/status/upgrade 都需要拿到正确 OFFSET 才能算 DATA_DIR 和端口。
 * 之前各处只看 env CRABOT_PORT_OFFSET，shell rc 没 source 时（比如 sudo 跑或新会话）
 * 就回退到 0，但 instance.json 里实际是 100 —— 内部状态分裂。
 *
 * 顺手把解析到的 OFFSET 写回 process.env（如果原本为空），让下游子进程也拿到。
 */
export function resolveOffset(homeDir, env = process.env) {
  if (env.CRABOT_PORT_OFFSET) {
    return parseInt(env.CRABOT_PORT_OFFSET, 10) || 0
  }
  if (hasInstance(homeDir)) {
    try {
      const inst = readInstance(homeDir)
      if (inst.port_offset) {
        env.CRABOT_PORT_OFFSET = String(inst.port_offset)
        return parseInt(inst.port_offset, 10) || 0
      }
    } catch { /* corrupted instance.json — fall through to 0 */ }
  }
  return 0
}

/**
 * CLI 命令（start/stop/status/upgrade）统一的 DATA_DIR 解析入口。
 *
 * 设计契约：**不读 instance.json 的 data_dir 字段**——resolveDataDir 是单点真相，
 * instance.json 里的 data_dir 仅供 informational 展示（status 显示 / sync 写回）。
 *
 * 为什么不信 instance.json.data_dir：它仅是 init 时写入的展示信息，环境变量和 offset
 * 才是运行时目录解析的输入。把解析口子收敛到这里，避免读取过期路径。
 *
 * 解析优先级：env.DATA_DIR > ~/.crabot/data{-OFFSET}。
 */
export function resolveCliDataDir({ homeDir, env = process.env } = {}) {
  const offset = resolveOffset(homeDir, env)
  return resolveDataDir({ envValue: env.DATA_DIR, offset })
}
