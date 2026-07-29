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
