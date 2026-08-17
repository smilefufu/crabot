import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { dirname, join } from 'path'

interface ReceiptFile<T> {
  version: 1
  receipts: T[]
}

export function normalizeReceiptPreview(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 200)
}

export function receiptFilePath(workersDir: string, workerId: string, filename: string): string {
  if (!workerId || workerId.includes('/') || workerId.includes('\\')) {
    throw new Error(`invalid worker_id for receipt path: ${workerId}`)
  }
  return join(workersDir, workerId, filename)
}

export async function readReceiptFile<T>(path: string): Promise<T[]> {
  let raw: string
  try {
    raw = await fs.readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ReceiptFile<T>>
    if (parsed.version !== 1 || !Array.isArray(parsed.receipts)) throw new Error('invalid receipt file shape')
    return parsed.receipts
  } catch (error) {
    throw new Error(`invalid receipt file ${path}: ${(error as Error).message}`)
  }
}

export async function writeReceiptFile<T>(path: string, receipts: T[]): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const tmpPath = join(dirname(path), `.${randomUUID()}.tmp.json`)
  try {
    await fs.writeFile(tmpPath, JSON.stringify({ version: 1, receipts }, null, 2), 'utf8')
    await fs.rename(tmpPath, path)
  } catch (error) {
    await fs.unlink(tmpPath).catch(() => undefined)
    throw error
  }
}
