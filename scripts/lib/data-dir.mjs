import { resolve } from 'node:path'
import { homedir } from 'node:os'

/**
 * 解析 DATA_DIR。优先级：
 *  1. env.DATA_DIR（显式指定，最高）
 *  2. 默认：offset=0 → ~/.crabot/data；offset>0 → ~/.crabot/data-<OFF>
 *
 * dev.sh 在 bash 里有独立的 DATA_DIR 计算（写死 $SCRIPT_DIR/data），不走此函数。
 */
export function resolveDataDir({ envValue, offset = 0 } = {}) {
  if (envValue) return envValue
  const sub = offset > 0 ? `data-${offset}` : 'data'
  return resolve(homedir(), '.crabot', sub)
}
