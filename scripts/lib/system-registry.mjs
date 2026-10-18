// Administrator-owned system inventory. Employee files are never read here.
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { acquireCliLock, releaseCliLock } from './cli-lock.mjs'

export const systemDirectory = '/etc/crabot/system'
export const systemError = (message, code = 'CRABOT_SYSTEM_UNVERIFIED') => Object.assign(new Error(message), { code })
const fail = message => { throw systemError(message) }
const fields = ['uid', 'gid', 'user', 'home', 'data_dir', 'port_offset', 'enabled', 'autostart']
const absolute = value => typeof value === 'string' && path.posix.isAbsolute(value) && path.posix.normalize(value) === value && !/[\0\r\n]/.test(value)
const username = value => typeof value === 'string' && value.length <= 256 && /^[^\s\x00-\x1f\x7f/:.-][^\s\x00-\x1f\x7f/:]*$/.test(value)

export function validateSystemEntries(entries) {
  if (!Array.isArray(entries) || entries.length > 99) fail('共享实例注册表格式不兼容，未执行任何操作。')
  const users = new Set(), uids = new Set(), offsets = new Set(), directories = new Set()
  for (const entry of entries) {
    if (!entry || Object.keys(entry).length !== fields.length || fields.some(key => !Object.hasOwn(entry, key))
      || !Number.isInteger(entry.uid) || entry.uid < 1 || entry.uid > 0xfffffffe
      || !Number.isInteger(entry.gid) || entry.gid < 0 || entry.gid > 0xfffffffe || !username(entry.user)
      || !absolute(entry.home) || entry.home === '/' || !absolute(entry.data_dir) || entry.data_dir === '/'
      || !Number.isInteger(entry.port_offset) || entry.port_offset < 100 || entry.port_offset > 9900 || entry.port_offset % 100 !== 0
      || typeof entry.enabled !== 'boolean' || typeof entry.autostart !== 'boolean'
      || users.has(entry.user) || uids.has(entry.uid) || offsets.has(entry.port_offset) || directories.has(entry.data_dir)) {
      fail('共享实例身份、目录或端口重复/不兼容，未执行任何操作。')
    }
    users.add(entry.user); uids.add(entry.uid); offsets.add(entry.port_offset); directories.add(entry.data_dir)
  }
  return entries
}

export function resolveLinuxAccount(user, execute = execFileSync) {
  if (!username(user)) fail('请指定已有Linux用户名。')
  let raw
  try { raw = execute('/usr/bin/getent', ['passwd', user], { encoding: 'utf8', timeout: 5000, maxBuffer: 16384,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8' } }) }
  catch { fail('无法核实Linux用户，请先由管理员检查账号。') }
  const lines = raw.trimEnd().split('\n'), columns = lines[0].split(':')
  const [name, , uid, gid, , home] = columns
  if (lines.length !== 1 || columns.length !== 7 || name !== user || !/^[1-9][0-9]*$/.test(uid)
    || !/^[0-9]+$/.test(gid) || !absolute(home) || home === '/') fail('Linux账号身份不兼容，未开通实例。')
  const account = { user: name, uid: Number(uid), gid: Number(gid), home }
  if (!Number.isSafeInteger(account.uid) || account.uid > 0xfffffffe || !Number.isSafeInteger(account.gid) || account.gid > 0xfffffffe) fail('Linux账号编号不兼容。')
  return account
}

function trustedDirectory(directory, ownerUid) {
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== ownerUid || stat.mode & 0o022) fail('共享管理目录的归属或权限无法核验。')
}

function readDocument(file, ownerUid) {
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.uid !== ownerUid || stat.mode & 0o022 || stat.nlink !== 1 || stat.size > 1024 * 1024) fail('共享注册文件的归属、权限或大小无法核验。')
    return JSON.parse(fs.readFileSync(fd, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw systemError('共享注册文件无法核验，未执行任何操作。')
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}

// ownerUid/directory/accountLookup are internal fixture seams, never CLI options.
export class SystemRegistry {
  constructor({ directory = systemDirectory, ownerUid = 0, accountLookup = resolveLinuxAccount } = {}) {
    this.directory = path.resolve(directory); this.ownerUid = ownerUid; this.accountLookup = accountLookup
  }
  authority() {
    if (process.platform === 'win32' || this.ownerUid === 0 && process.platform !== 'linux' || process.getuid?.() !== this.ownerUid) throw systemError('共享实例仅系统管理员可管理。', 'CRABOT_SYSTEM_ADMIN_REQUIRED')
  }
  initialize() {
    this.authority()
    const parent = path.dirname(this.directory)
    trustedDirectory(parent, this.ownerUid)
    try { fs.mkdirSync(this.directory, { mode: 0o755 }); fs.chmodSync(this.directory, 0o755) } catch (error) { if (error.code !== 'EEXIST') throw error }
    trustedDirectory(this.directory, this.ownerUid)
  }
  read() {
    trustedDirectory(path.dirname(this.directory), this.ownerUid)
    trustedDirectory(this.directory, this.ownerUid)
    const value = readDocument(path.join(this.directory, 'instances.json'), this.ownerUid)
    if (!value || value.schema_version !== 1 || Object.keys(value).length !== 2) fail('共享实例注册表缺失或不兼容，请联系管理员检查安装。')
    return validateSystemEntries(value.instances)
  }
  async update(change, { create = false } = {}) {
    this.authority(); this.initialize()
    const lock = await acquireCliLock(this.directory, 'system-register')
    let temporary
    try {
      const file = path.join(this.directory, 'instances.json')
      const exists = fs.existsSync(file)
      const entries = exists ? this.read() : create ? [] : fail('共享实例注册表缺失，未修改。')
      const updated = validateSystemEntries(await change(structuredClone(entries)))
      temporary = file + '.tmp-' + randomUUID()
      fs.writeFileSync(temporary, JSON.stringify({ schema_version: 1, instances: updated }) + '\n', { flag: 'wx', mode: 0o644, flush: true })
      fs.chmodSync(temporary, 0o644)
      fs.renameSync(temporary, file); temporary = undefined
      const fd = fs.openSync(this.directory, fs.constants.O_RDONLY)
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      return updated
    } finally { if (temporary) fs.rmSync(temporary, { force: true }); releaseCliLock(lock) }
  }
  verifyAccount(entry) {
    const actual = this.accountLookup(entry.user)
    if (actual.uid !== entry.uid || actual.gid !== entry.gid || actual.home !== entry.home || actual.user !== entry.user) fail('Linux用户身份已变化，保留原绑定，请管理员检查。')
    return actual
  }
  async register(user, { autostart, prepare = async () => {}, configure = async () => {}, assertAvailable = () => {} } = {}) {
    this.authority()
    this.accountLookup(user)
    if (autostart !== undefined && typeof autostart !== 'boolean') fail('自启动选项不兼容。')
    let selected
    await this.update(async entries => {
      assertAvailable()
      const account = this.accountLookup(user)
      selected = entries.find(entry => entry.user === user)
      if (selected) {
        this.verifyAccount(selected)
        const reopening = !selected.enabled
        selected.enabled = true
        if (autostart !== undefined) selected.autostart = autostart
        if (reopening || autostart !== undefined) await configure(selected, { reopening })
        return entries
      }
      const used = new Set(entries.map(entry => entry.port_offset))
      let port_offset = 100
      while (used.has(port_offset)) port_offset += 100
      if (port_offset > 9900) fail('没有可用端口偏移，未开通用户。')
      selected = { ...account, data_dir: path.join(account.home, '.crabot', 'data-' + port_offset), port_offset, enabled: true, autostart: autostart ?? false }
      validateSystemEntries([...entries, selected])
      await prepare(selected)
      await configure(selected, { reopening: false })
      entries.push(selected)
      return entries
    })
    return selected
  }
}
