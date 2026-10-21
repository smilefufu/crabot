import { promises as fs, constants, realpathSync, type BigIntStats } from 'node:fs'
import path from 'node:path'
import { TextDecoder } from 'node:util'
import { ATOMIC_TEMP_FILE, filenameToManagerKey } from '../workers/harness/ledger-store.js'
import type { ManagerKey } from '../workers/harness/ledger-types.js'

const native = require('../../../scripts/lib/process-identity.cjs')
const management = require('../../../scripts/lib/desktop-management.cjs')
const MAX_BYTES = 64 * 1024 * 1024
const failure = (stage = 'capture') => Object.assign(new Error('无法核实原执行器台账，已保留数据和迁移维护保护。'), { code: 'CRABOT_WORKSPACE_LEDGER_CAPTURE', stage })
const version = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].join(':')
interface DirectoryObservation { readonly path: string; readonly version: string; readonly native_id: string | null }
export interface WorkspaceRelocationLedgerFile {
  readonly name: string
  readonly manager_key: ManagerKey
  readonly version: string
  readonly contents: string
}
export interface WorkspaceRelocationLedgerSnapshot {
  readonly data_root: string
  readonly directories: ReadonlyArray<DirectoryObservation>
  readonly names: ReadonlyArray<string>
  readonly files: ReadonlyArray<WorkspaceRelocationLedgerFile>
}

/** Read-only input capture. The fixed offline caller must independently verify authority and global exit. */
export async function captureWorkspaceRelocationLedgers(dataDir: string, { signal }: { signal?: AbortSignal } = {}): Promise<WorkspaceRelocationLedgerSnapshot> {
  const check = () => { if (signal?.aborted) throw failure() }
  check()
  const root = management.requirePrivateDataRoot(dataDir) as string
  const directory = path.join(root, 'agent', 'worker-ledgers')
  const directories: DirectoryObservation[] = [], pins: unknown[] = []
  const owned = (stat: BigIntStats, file: string, isDirectory: boolean) => {
    if (stat.isSymbolicLink() || !(isDirectory ? stat.isDirectory() : stat.isFile()) || !stat.ino || !isDirectory && stat.nlink !== 1n) throw failure(isDirectory ? 'directory-type' : 'file-type')
    const valid = process.platform === 'win32' ? (isDirectory ? native.isOwnedDirectory(file) : native.isOwnedFile(file))
      : stat.uid === BigInt(process.getuid!()) && (stat.mode & 0o022n) === 0n
    if (!valid) throw failure(isDirectory ? 'directory-owner' : 'file-owner')
  }
  const verifyDirectories = async () => {
    check()
    for (const [index, item] of directories.entries()) {
      const stat = await fs.lstat(item.path, { bigint: true }); owned(stat, item.path, true)
      if (version(stat) !== item.version) throw failure('directory-version-' + index)
      const canonical = realpathSync(item.path)
      if (canonical !== item.path) {
        const sameNative = process.platform === 'win32' && native.inspectDirectoryFileId(canonical) === native.inspectDirectoryFileId(item.path)
        throw failure('directory-canonical-' + (sameNative ? 'same-id-' : '') + index)
      }
      if (process.platform === 'win32' && native.inspectDirectoryFileId(item.path) !== item.native_id) throw failure('directory-native-id-' + index)
    }
  }
  try {
    for (const file of [root, path.join(root, 'agent'), directory]) {
      const before = await fs.lstat(file, { bigint: true }); owned(before, file, true)
      const canonical = realpathSync(file)
      if (canonical !== file) {
        const sameNative = process.platform === 'win32' && native.inspectDirectoryFileId(canonical) === native.inspectDirectoryFileId(file)
        throw failure('initial-directory-canonical' + (sameNative ? '-same-id' : ''))
      }
      let nativeId: string | null = null
      if (process.platform === 'win32') { const pin = native.pinDirectory(file); pins.push(pin); nativeId = pin.identity }
      directories.push(Object.freeze({ path: file, version: version(before), native_id: nativeId }))
    }
    await verifyDirectories()
    const names = (await fs.readdir(directory)).sort(), planned: Array<{ name: string; manager_key: ManagerKey; stat: BigIntStats }> = []
    let bytes = 0
    for (const name of names) {
      check()
      if (ATOMIC_TEMP_FILE.test(name) || !name.endsWith('.json')) continue
      const key = filenameToManagerKey(name)
      if (!key) throw failure()
      const file = path.join(directory, name), stat = await fs.lstat(file, { bigint: true }); owned(stat, file, false)
      if (stat.size > BigInt(MAX_BYTES - bytes)) throw new Error('执行器台账超过离线捕获的 64 MiB 内存预算；未读取正文或修改数据。')
      bytes += Number(stat.size); planned.push({ name, manager_key: key, stat })
    }
    const files: WorkspaceRelocationLedgerFile[] = []
    for (const item of planned) {
      await verifyDirectories()
      const file = path.join(directory, item.name), handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      try {
        const opened = await handle.stat({ bigint: true }); owned(opened, file, false)
        if (version(opened) !== version(item.stat)) throw failure('file-opened-version')
        const size = Number(opened.size), body = Buffer.alloc(size)
        let offset = 0
        while (offset < size) {
          check()
          const { bytesRead } = await handle.read(body, offset, Math.min(128 * 1024, size - offset), null)
          if (!bytesRead) throw failure()
          offset += bytesRead
        }
        check()
        if ((await handle.read(Buffer.alloc(1), 0, 1, null)).bytesRead !== 0) throw failure()
        const after = await handle.stat({ bigint: true }), current = await fs.lstat(file, { bigint: true })
        owned(after, file, false); owned(current, file, false)
        if (version(after) !== version(item.stat) || version(current) !== version(item.stat)) throw failure('file-read-version')
        files.push(Object.freeze({ name: item.name, manager_key: item.manager_key, version: version(after), contents: new TextDecoder('utf-8', { fatal: true }).decode(body) }))
      } finally { await handle.close() }
    }
    await verifyDirectories()
    if (JSON.stringify((await fs.readdir(directory)).sort()) !== JSON.stringify(names)) throw failure('directory-names')
    for (const item of planned) {
      check()
      if (version(await fs.lstat(path.join(directory, item.name), { bigint: true })) !== version(item.stat)) throw failure('file-final-version')
    }
    check()
    return Object.freeze({ data_root: root, directories: Object.freeze(directories), names: Object.freeze(names), files: Object.freeze(files) })
  } finally { for (const pin of pins.reverse()) native.releaseDirectoryPin(pin) }
}
