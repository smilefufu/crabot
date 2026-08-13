import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Durable atomic replace for coordinator-owned configuration sources. */
export async function durableAtomicWriteFile(filePath: string, content: string | Buffer, mode = 0o600): Promise<void> {
  const directory = path.dirname(filePath)
  await fs.mkdir(directory, { recursive: true })
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  const handle = await fs.open(temporary, 'w', mode)
  try {
    await handle.writeFile(content)
    await handle.chmod(mode)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporary, filePath)
    await syncDirectory(directory)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function durableRename(source: string, target: string): Promise<void> {
  await fs.rename(source, target)
  await syncDirectory(path.dirname(target))
  if (path.dirname(source) !== path.dirname(target)) await syncDirectory(path.dirname(source))
}

export async function durableRemovePath(target: string, options: { recursive?: boolean; force?: boolean } = {}): Promise<void> {
  try {
    await fs.rm(target, options)
    await syncDirectory(path.dirname(target))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function durableRemoveFile(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath)
    await syncDirectory(path.dirname(filePath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}
