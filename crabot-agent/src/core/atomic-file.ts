// Windows 上 rename 覆盖目标时，目标被任一句柄占用（杀软/索引器/并发读）会返回
// EPERM/EBUSY/EACCES；POSIX 下 rename 覆盖是原子的，不会这样。重试是本项目既有
// 做法（bg registry 已内置），这里抽成共用实现给其它原子写复用。
import fs from 'node:fs/promises'

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES'])

export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? ''
      if (process.platform !== 'win32' || !RETRY_CODES.has(code) || attempt >= 8) throw error
      await new Promise<void>(resolve => setTimeout(resolve, Math.min(500, 25 * 2 ** attempt) + Math.random() * 25))
    }
  }
}
