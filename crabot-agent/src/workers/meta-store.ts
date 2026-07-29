/**
 * writeMetaAtomic — meta-<seq>.json 原子写(tmp+rename),供 CLI worker adapter(claude-code/codex)
 * 复用。P1 builtin 的 writeMeta 是同款写法的独立实现(见 builtin/adapter.ts),按约定不改 builtin,
 * 这里单独抽一份放在 src/workers/ 根供非 builtin 的 adapter 共享。
 */
import { promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'

export async function writeMetaAtomic(dir: string, seq: number, meta: unknown): Promise<void> {
  const metaPath = join(dir, `meta-${seq}.json`)
  const tmpPath = join(dir, `.meta-${seq}.json.tmp-${randomUUID()}`)
  await fs.writeFile(tmpPath, JSON.stringify(meta), 'utf-8')
  await fs.rename(tmpPath, metaPath)
}

/**
 * 扫 dir 下 meta-<seq>.json 文件名,返回其中最大的 seq(没有任何 meta 文件、或 dir 本身不
 * 存在,都返回 0)。供 nextSeq() 做磁盘感知——五轮 review 修复:重启后新 adapter 实例的
 * 内存态(runtimes/instances)只含按需重建过的化身,不是该 worker 的全部历史,nextSeq 只看
 * 内存会把磁盘上未被重建的旧化身的号位当成"下一个"分配出去,静默覆盖其 meta/output。
 * 坏文件名(不匹配 meta-<数字>.json)一律跳过,不视为错误。
 */
export async function maxSeqOnDisk(dir: string): Promise<number> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return 0
  }
  let max = 0
  for (const name of entries) {
    const m = /^meta-(\d+)\.json$/.exec(name)
    if (!m) continue
    const seq = Number(m[1])
    if (Number.isFinite(seq) && seq > max) max = seq
  }
  return max
}
