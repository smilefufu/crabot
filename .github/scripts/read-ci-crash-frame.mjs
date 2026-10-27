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
    try {
      const file = path.join(entry.parentPath, entry.name), stat = await fs.stat(file)
      if (stat.size > 16 * 1024 * 1024) { results.push({ unavailable: 'dump-too-large' }); continue }
      const bytes = await fs.readFile(file), streams = new Map(), modules = []
      if (bytes.readUInt32LE(0) !== 0x504d444d || bytes.readUInt32LE(8) > 256) throw new Error('Invalid dump')
      for (let index = 0; index < bytes.readUInt32LE(8); index++) {
        const at = bytes.readUInt32LE(12) + index * 12, size = bytes.readUInt32LE(at + 4), rva = bytes.readUInt32LE(at + 8)
        if (rva + size > bytes.length) throw new Error('Invalid stream')
        streams.set(bytes.readUInt32LE(at), { rva, size })
      }
      const list = streams.get(4), exception = streams.get(6)
      if (!list || !exception || exception.size < 168 || bytes.readUInt32LE(list.rva) > 4096) throw new Error('No fixed exception')
      for (let index = 0; index < bytes.readUInt32LE(list.rva); index++) {
        const at = list.rva + 4 + index * 108, name = bytes.readUInt32LE(at + 20), length = bytes.readUInt32LE(name)
        if (length > 32768 || name + 4 + length > bytes.length) throw new Error('Invalid module')
        modules.push({ base: bytes.readBigUInt64LE(at), size: BigInt(bytes.readUInt32LE(at + 8)), name: path.win32.basename(bytes.toString('utf16le', name + 4, name + 4 + length)) })
      }
      const address = bytes.readBigUInt64LE(exception.rva + 24), module = modules.find(item => address >= item.base && address < item.base + item.size)
      results.push({ exception_code: '0x' + bytes.readUInt32LE(exception.rva + 8).toString(16),
        module: module?.name ?? null, module_offset: module ? '0x' + (address - module.base).toString(16) : null,
        module_names: modules.map(item => item.name) })
    } catch { results.push({ unavailable: 'fixed-exception-unreadable' }) }
  }
  return results
}
