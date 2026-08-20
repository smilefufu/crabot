import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import { basename, join } from 'node:path'

export interface FinalTerminalSnapshot {
  text: string
  captured_at: string
}

export function terminalSnapshotPath(dir: string, seq: number): string {
  return join(dir, `terminal-final-${seq}.json`)
}

export function normalizeTerminalText(text: string): string {
  return text.trimEnd()
}

/**
 * The snapshot is one overwrite-only slot. Empty captures intentionally leave
 * the prior nonempty screen intact.
 */
export async function writeFinalTerminalSnapshot(
  dir: string,
  seq: number,
  text: string,
  capturedAt = new Date().toISOString(),
): Promise<FinalTerminalSnapshot | undefined> {
  const normalized = normalizeTerminalText(text)
  if (!normalized) return undefined
  await fs.mkdir(dir, { recursive: true })
  const target = terminalSnapshotPath(dir, seq)
  const temporary = join(dir, `.${basename(target)}.${randomUUID()}.tmp`)
  const handle = await fs.open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify({ text: normalized, captured_at: capturedAt }) + '\n', 'utf-8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.rename(temporary, target)
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return { text: normalized, captured_at: capturedAt }
}

export async function readFinalTerminalSnapshot(dir: string, seq: number): Promise<FinalTerminalSnapshot | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(terminalSnapshotPath(dir, seq), 'utf-8')) as Partial<FinalTerminalSnapshot>
    if (typeof value.text !== 'string' || !normalizeTerminalText(value.text) || typeof value.captured_at !== 'string') return undefined
    return { text: normalizeTerminalText(value.text), captured_at: value.captured_at }
  } catch {
    return undefined
  }
}
