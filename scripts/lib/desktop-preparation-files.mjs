// Filesystem primitives only. Callers own installation selection, actual stop
// proof and the preparation fence; these helpers never initialize business data.
import physicalFs from './physical-fs.cjs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import identity from './process-identity.cjs'
const { promises: fs } = physicalFs
const fail = (message, code = 'CRABOT_DESKTOP_INSTALLATION') => { throw Object.assign(new Error(message), { code }) }
async function present(file) { try { return await fs.lstat(file) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
export const pendingName = '.desktop-installing.json', payloadName = '.desktop-install-payload.json'
export async function privateJson(file, value, replace = false) {
  const temporary = file + '.tmp-' + randomUUID(), text = JSON.stringify(value) + '\n'
  try {
    if (process.platform === 'win32') {
      identity.writePrivateFile(temporary, '')
      await fs.writeFile(temporary, text, { flag: 'r+', flush: true })
    }
    else await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600, flush: true })
    if (replace) await fs.rename(temporary, file); else await fs.link(temporary, file)
    if (process.platform !== 'win32') { const directory = await fs.open(path.dirname(file), 'r'); try { await directory.sync() } finally { await directory.close() } }
  } finally { await fs.rm(temporary, { force: true }) }
}
export async function readPending(root) {
  const file = path.join(root, pendingName), stat = await present(file)
  if (!stat) return null
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096
    || (process.platform === 'win32' ? !identity.isPrivateFile(file) : stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600)) fail('安装准备记录无法核验，原目录已保留。')
  const state = JSON.parse(await fs.readFile(file, 'utf8'))
  if (state.schema_version !== 1 || !['preparing', 'prepared'].includes(state.phase)
    || typeof state.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(state.id) || typeof state.installation_id !== 'string'
    || !/^[a-f0-9]{64}$/.test(state.payload_sha256)
    || Object.keys(state).some(key => !['schema_version', 'id', 'installation_id', 'selection', 'phase', 'payload_sha256'].includes(key))) fail('安装准备记录损坏，原目录已保留。')
  return state
}
export async function publishPreparedProgram(source, target, signal, verify) {
  if (!await present(target)) { await fs.rename(source, target); return }
  const stat = await fs.lstat(target)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('准备版本目录已被重定向。')
  try { await verify(); return }
  catch { signal?.throwIfAborted() }
  const retained = path.join(path.dirname(target), '.damaged-' + path.basename(target) + '-' + randomUUID())
  await fs.rename(target, retained)
  try { await fs.rename(source, target) }
  catch (publishError) {
    try {
      if (await present(target)) throw publishError
      await fs.rename(retained, target)
    } catch (restoreError) { throw new AggregateError([publishError, restoreError], '安装准备与原位恢复未完成；原程序已保留。') }
    throw publishError
  }
}
