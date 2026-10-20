import fs from 'node:fs/promises'
import { constants, type BigIntStats } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { WorkspaceRelocationIncarnation } from 'crabot-shared'
import type { IncarnationHandle, WorkerProcessIdentity } from './types.js'
import type { TmuxProcessCarrier } from './tmux/driver.js'

const invalid = () => Object.assign(new Error('冷执行器元数据与原生载体无法核验，已保留维护保护。'), { code: 'WORKER_CARRIER_UNVERIFIED' })
const identity = (value: BigIntStats) => [value.dev, value.ino].map(item => item.toString()).join(':')
const version = (value: BigIntStats) => [value.dev, value.ino, value.size, value.mode, value.uid, value.gid, value.nlink, value.mtimeNs, value.ctimeNs].map(item => item.toString()).join(':')

async function readMetadata(dataDir: string, workerId: string, seq: number) {
  const root = await fs.realpath(dataDir), directory = path.join(root, workerId), file = path.join(directory, `meta-${seq}.json`)
  const parent = await fs.lstat(root, { bigint: true }), worker = await fs.lstat(directory, { bigint: true }), selected = await fs.lstat(file, { bigint: true })
  if (!parent.isDirectory() || !worker.isDirectory() || worker.isSymbolicLink() || !selected.isFile() || selected.isSymbolicLink()
    || selected.nlink !== 1n || selected.size < 0n || selected.size > 65536n) throw invalid()
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    if (version(await handle.stat({ bigint: true })) !== version(selected)) throw invalid()
    const buffer = Buffer.alloc(Number(selected.size) + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== Number(selected.size) || version(await handle.stat({ bigint: true })) !== version(selected)
      || version(await fs.lstat(file, { bigint: true })) !== version(selected)
      || identity(await fs.lstat(root, { bigint: true })) !== identity(parent)
      || identity(await fs.lstat(directory, { bigint: true })) !== identity(worker)
      || await fs.realpath(dataDir) !== root || await fs.realpath(directory) !== directory) throw invalid()
    const bytes = buffer.subarray(0, offset), value: unknown = JSON.parse(bytes.toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
    return { value: value as Record<string, unknown>, version: [root, identity(parent), identity(worker), version(selected), createHash('sha256').update(bytes).digest('hex')].join(':') }
  } finally { await handle.close() }
}

/** Exact live cold mainline only; absence/dead/headless remain unknown, with no runtime rebuild. */
export async function captureColdNativeProcesses(dataDir: string, h: IncarnationHandle, fixed: WorkspaceRelocationIncarnation,
  readCarrier: () => Promise<TmuxProcessCarrier>, isCurrent: () => boolean): Promise<ReadonlyArray<WorkerProcessIdentity>> {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(h.worker_id) || !Number.isSafeInteger(h.seq) || h.seq < 1
      || fixed.forked_from !== undefined || fixed.query_id !== undefined || h.query_id !== undefined) throw invalid()
    const first = await readMetadata(dataDir, h.worker_id, h.seq)
    if (first.value.seq !== h.seq || first.value.workspace_root !== fixed.workspace
      || h.session_ref && first.value.session_id !== h.session_ref || !isCurrent()) throw invalid()
    const { captureTmuxProcessTree } = require(path.join(__dirname, '../../../scripts/lib/tmux-process-tree.cjs'))
    const processes = await captureTmuxProcessTree(async () => {
      const carrier = await readCarrier()
      if (carrier.session_name !== `crabot-w-${h.worker_id}-${h.seq}` || !isCurrent()) throw invalid()
      return carrier
    })
    const last = await readMetadata(dataDir, h.worker_id, h.seq)
    if (first.version !== last.version || !isCurrent()) throw invalid()
    return processes
  } catch { throw invalid() }
}
