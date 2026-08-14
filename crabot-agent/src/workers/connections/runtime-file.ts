/**
 * operation-time runtime file（P6-B plan §7 Agent 步骤 5）。
 *
 * translator 产出的 runtime file（如 codex config.toml）写入 Agent-owned 临时目录：
 * - 目录 0700、文件 0600、原子 rename；
 * - 调用结束 finally 删除（含目录）；
 * - 绝不写 task workspace。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export class RuntimeFileSet implements AsyncDisposable {
  private constructor(private readonly dir: string) {}

  /** 在 agent-owned runtime 根下建一次性目录并写入全部文件（0600/原子）。 */
  static async create(runtimeRoot: string, files: Record<string, string>): Promise<RuntimeFileSet> {
    const dir = path.join(runtimeRoot, `op-${randomUUID()}`)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const set = new RuntimeFileSet(dir)
    try {
      for (const [relative, content] of Object.entries(files)) {
        const target = set.resolve(relative)
        await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 })
        const tmpPath = `${target}.tmp-${randomUUID()}`
        await fs.writeFile(tmpPath, content, { mode: 0o600 })
        await fs.rename(tmpPath, target)
      }
    } catch (error) {
      await set.dispose()
      throw error
    }
    return set
  }

  /** 绝对路径（只读给 spawn env 用，如 CODEX_HOME）。 */
  get root(): string {
    return this.dir
  }

  resolve(relative: string): string {
    const resolved = path.resolve(this.dir, relative)
    if (!resolved.startsWith(this.dir + path.sep)) throw new Error(`runtime file escapes dir: ${relative}`)
    return resolved
  }

  async dispose(): Promise<void> {
    await fs.rm(this.dir, { recursive: true, force: true }).catch(() => {})
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose()
  }
}
