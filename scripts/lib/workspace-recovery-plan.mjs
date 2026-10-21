// Technical Agent projection only. This module never grants authority or changes business records.
import fs from 'node:fs'
import path from 'node:path'
import native from './process-identity.cjs'
const fail = () => { throw Object.assign(new Error('原自动恢复责任计划无法核实，已保留数据和维护保护。'), { code: 'WORKSPACE_RELOCATION_INVALID' }) }
const fields = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const text = value => typeof value === 'string' && value.length > 0 && !value.includes('\0')
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const version = value => typeof value === 'string' && /^-?[0-9]+(?::-?[0-9]+){8}$/.test(value)
const statVersion = stat => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].join(':')
const key = value => text(value) && value.indexOf('::') > 0 && value.indexOf('::') + 2 < value.length
const segment = value => encodeURIComponent(value).replace(/[.!~*'()]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'))
function managerSegment(value) { try { const decoded = decodeURIComponent(value); return key(decoded) && segment(decoded) === value } catch { return false } }
function directory(relative) {
  if (relative === '.' || relative === 'agent') return true
  if (!text(relative) || path.normalize(relative) !== relative || path.isAbsolute(relative)) return false
  const parts = relative.split(path.sep)
  if (parts[0] !== 'agent') return false
  if (parts[1] === 'voice-inbox') return parts.length === 2
  if (parts[1] === 'managers') return parts.length === 2 || parts.length === 3 && managerSegment(parts[2])
  if (parts[1] !== 'conversation-requests') return false
  return parts.length === 2 || hash(parts[2]) && (parts.length === 3 || parts[3] === 'session' && (parts.length === 4 || parts.length === 5 && managerSegment(parts[4])))
}
const managerFiles = { manager_checkpoint: 'running.json', requests: 'requests.json', admin_wakes: 'pending-admin-chat-wakes.jsonl', workboard: 'workboard.json' }
function fileLocation(item) {
  const common = ['kind', 'relative', 'version', 'sha256']
  if (Object.hasOwn(managerFiles, item?.kind)) {
    if (!fields(item, [...common, 'manager_key']) || !key(item.manager_key)) fail()
    return path.join('agent', 'managers', segment(item.manager_key), managerFiles[item.kind])
  }
  if (item?.kind === 'request_checkpoint') {
    if (!fields(item, [...common, 'manager_key', 'request_id']) || !key(item.manager_key) || !hash(item.request_id)) fail()
    return path.join('agent', 'conversation-requests', item.request_id, 'session', segment(item.manager_key), 'running.json')
  }
  if (item?.kind === 'request_owner') {
    if (!fields(item, [...common, 'request_id']) || !hash(item.request_id)) fail()
    return path.join('agent', 'conversation-requests', item.request_id, 'owner.json')
  }
  if (item?.kind === 'voice') {
    if (!fields(item, [...common, 'name']) || typeof item.name !== 'string' || !/^[a-f0-9]{64}\.json$/.test(item.name)) fail()
    return path.join('agent', 'voice-inbox', item.name)
  }
  fail()
}
export function validateWorkspaceRecoverySnapshot(snapshot, dataRoot) {
  if (!fields(snapshot, ['data_root', 'directories', 'names', 'missing_directories', 'files', 'records', 'checkpoints']) || snapshot.data_root !== dataRoot
    || !['directories', 'names', 'missing_directories', 'files', 'records', 'checkpoints'].every(field => Array.isArray(snapshot[field]))) fail()
  const dirs = new Set(), names = new Set(), files = new Map(), identities = new Set(), checkpoints = new Set()
  for (const item of snapshot.directories) {
    if (!fields(item, ['relative', 'version', 'native_id']) || !directory(item.relative) || !version(item.version) || dirs.has(item.relative)
      || (process.platform === 'win32' ? typeof item.native_id !== 'string' || !/^[0-9]+:[a-f0-9]{32}$/i.test(item.native_id) : item.native_id !== null)) fail()
    dirs.add(item.relative)
  }
  if (!dirs.has('.') || !dirs.has('agent')) fail()
  for (const item of snapshot.names) {
    if (!fields(item, ['relative', 'names']) || !dirs.has(item.relative) || names.has(item.relative) || !Array.isArray(item.names)
      || item.names.some((name, index) => !text(name) || path.basename(name) !== name || name === '.' || name === '..' || index > 0 && name <= item.names[index - 1])) fail()
    names.add(item.relative)
  }
  const missing = new Set()
  for (const relative of snapshot.missing_directories) { if (!directory(relative) || dirs.has(relative) || missing.has(relative)) fail(); missing.add(relative) }
  for (const item of snapshot.files) {
    if (fileLocation(item) !== item.relative || !version(item.version) || !hash(item.sha256) || files.has(item.relative) || !dirs.has(path.dirname(item.relative))) fail()
    files.set(item.relative, item)
  }
  for (const item of snapshot.records) {
    let identity
    if (item?.kind === 'request' || item?.kind === 'admin_chat') {
      const field = item.kind === 'request' ? 'source_sha256' : 'message_sha256'
      if (!fields(item, ['kind', 'manager_key', 'request_id', field]) || !key(item.manager_key) || !text(item.request_id)
        || item.kind === 'request' && !hash(item.request_id) || !hash(item[field])) fail()
      identity = [item.kind, item.manager_key, item.request_id]
    } else if (item?.kind === 'voice') {
      if (!fields(item, ['kind', 'channel_id', 'turn_id', 'payload_sha256']) || !text(item.channel_id) || !text(item.turn_id) || !hash(item.payload_sha256)) fail()
      identity = [item.kind, item.channel_id, item.turn_id]
    } else if (item?.kind === 'workboard') {
      if (!fields(item, ['kind', 'manager_key', 'revision']) || !key(item.manager_key) || !Number.isSafeInteger(item.revision) || item.revision < 0) fail()
      identity = [item.kind, item.manager_key, item.revision]
    } else fail()
    const encoded = JSON.stringify(identity)
    if (identities.has(encoded)) fail()
    identities.add(encoded)
  }
  for (const item of snapshot.checkpoints) {
    if (!fields(item, ['manager_key', 'source', 'before_version', 'before_sha256', 'episode_id']) || !key(item.manager_key)
      || !version(item.before_version) || !hash(item.before_sha256) || !text(item.episode_id)) fail()
    const source = item.source
    if (!(fields(source, ['kind']) && source.kind === 'manager') && !(fields(source, ['kind', 'requestId']) && source.kind === 'request' && hash(source.requestId))) fail()
    const relative = source.kind === 'manager' ? path.join('agent', 'managers', segment(item.manager_key), 'running.json')
      : path.join('agent', 'conversation-requests', source.requestId, 'session', segment(item.manager_key), 'running.json')
    const file = files.get(relative)
    if (!file || file.version !== item.before_version || file.sha256 !== item.before_sha256 || checkpoints.has(relative)) fail()
    checkpoints.add(relative)
  }
  if ([...files.values()].some(item => ['manager_checkpoint', 'request_checkpoint'].includes(item.kind) && !checkpoints.has(item.relative))) fail()
}
export function verifyWorkspaceRecoverySnapshot(snapshot, dataRoot) {
  validateWorkspaceRecoverySnapshot(snapshot, dataRoot)
  for (const item of snapshot.directories) {
    const file = item.relative === '.' ? dataRoot : path.join(dataRoot, item.relative), stat = fs.lstatSync(file, { bigint: true })
    const owner = process.platform === 'win32' ? native.isOwnedDirectory(file) : stat.uid === BigInt(process.getuid()) && (stat.mode & 0o022n) === 0n
    if (!owner || !stat.isDirectory() || stat.isSymbolicLink() || statVersion(stat) !== item.version || fs.realpathSync(file) !== file
      || process.platform === 'win32' && native.inspectDirectoryFileId(file) !== item.native_id) fail()
  }
  for (const item of snapshot.names) if (JSON.stringify(fs.readdirSync(path.join(dataRoot, item.relative)).sort()) !== JSON.stringify(item.names)) fail()
  for (const relative of snapshot.missing_directories) { try { fs.lstatSync(path.join(dataRoot, relative)); fail() } catch (error) { if (error.code !== 'ENOENT') throw error } }
  for (const item of snapshot.files) {
    const file = path.join(dataRoot, item.relative), stat = fs.lstatSync(file, { bigint: true })
    const owner = process.platform === 'win32' ? native.isOwnedFile(file) : stat.uid === BigInt(process.getuid()) && (stat.mode & 0o022n) === 0n
    if (!owner || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || statVersion(stat) !== item.version) fail()
  }
}
