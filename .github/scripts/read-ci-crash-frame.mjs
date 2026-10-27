// CI-only fixed metadata. Never upload a dump, stack memory, environment or full module paths.
// MINIDUMP structures: https://learn.microsoft.com/windows/win32/api/minidumpapiset/
import fs from 'node:fs/promises'
import path from 'node:path'
export async function readCiCrashFrames(root) {
  let entries
  try { entries = await fs.readdir(root, { recursive: true, withFileTypes: true }) }
  catch (error) { if (error.code === 'ENOENT') return []; throw error }
  const results = []
  for (const entry of entries.filter(item => item.isFile() && item.name.endsWith('.dmp')).slice(0, 3)) {
    let handle
    try {
      handle = await fs.open(path.join(entry.parentPath, entry.name), 'r')
      const stat = await handle.stat(), streams = new Map(), modules = []
      let readBytes = 0
      const read = async (at, length) => {
        if (!Number.isSafeInteger(at) || !Number.isSafeInteger(length) || at < 0 || length < 0 || at + length > stat.size
          || (readBytes += length) > 16 * 1024 * 1024) throw new Error('Invalid bounded metadata')
        const bytes = Buffer.alloc(length)
        if ((await handle.read(bytes, 0, length, at)).bytesRead !== length) throw new Error('Incomplete metadata')
        return bytes
      }
      const header = await read(0, 32), count = header.readUInt32LE(8)
      if (header.readUInt32LE(0) !== 0x504d444d || count > 256) throw new Error('Invalid dump')
      const directory = await read(header.readUInt32LE(12), count * 12)
      for (let index = 0; index < count; index++) {
        const at = index * 12, size = directory.readUInt32LE(at + 4), rva = directory.readUInt32LE(at + 8)
        if (rva + size > stat.size) throw new Error('Invalid stream')
        streams.set(directory.readUInt32LE(at), { rva, size })
      }
      const list = streams.get(4), exception = streams.get(6)
      if (!list || !exception || list.size < 4 || exception.size < 168) throw new Error('No fixed exception')
      const moduleCount = (await read(list.rva, 4)).readUInt32LE(0)
      if (moduleCount > 4096 || 4 + moduleCount * 108 > list.size) throw new Error('Invalid module list')
      const moduleBytes = await read(list.rva + 4, moduleCount * 108), exceptionBytes = await read(exception.rva, 168)
      for (let index = 0; index < moduleCount; index++) {
        const at = index * 108, name = moduleBytes.readUInt32LE(at + 20), length = (await read(name, 4)).readUInt32LE(0)
        if (length > 32768 || length % 2) throw new Error('Invalid module')
        const text = (await read(name + 4, length)).toString('utf16le')
        modules.push({ base: moduleBytes.readBigUInt64LE(at), size: BigInt(moduleBytes.readUInt32LE(at + 8)), name: path.win32.basename(text) })
      }
      const after = await handle.stat()
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error('Dump changed')
      const address = exceptionBytes.readBigUInt64LE(24), module = modules.find(item => address >= item.base && address < item.base + item.size)
      results.push({ exception_code: '0x' + exceptionBytes.readUInt32LE(8).toString(16),
        module: module?.name ?? null, module_offset: module ? '0x' + (address - module.base).toString(16) : null,
        module_names: modules.map(item => item.name) })
    } catch { results.push({ unavailable: 'fixed-exception-unreadable' }) }
    finally { await handle?.close() }
  }
  return results
}
