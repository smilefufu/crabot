// Fixed UID boundary shared by administrator operations and systemd setup.
// No employee files, shell rc or configuration are loaded in this root process.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { systemError, validateSystemEntries } from './system-registry.mjs'

const helperActions = new Set(['prepare', 'inspect', 'start', 'stop', 'restart', 'disable', 'configure-service', 'snapshot', 'migrate', 'cancel-preparation'])
const safePath = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
export function systemUserEnvironment(entry) {
  validateSystemEntries([entry])
  return { HOME: entry.home, USER: entry.user, LOGNAME: entry.user, PATH: safePath,
    LANG: 'C.UTF-8', DATA_DIR: entry.data_dir, CRABOT_PORT_OFFSET: String(entry.port_offset),
    XDG_RUNTIME_DIR: '/run/user/' + entry.uid, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/' + entry.uid + '/bus' }
}

export function systemUserCommand(entry, { node, helper, action }) {
  validateSystemEntries([entry])
  if (!helperActions.has(action) || !path.isAbsolute(node) || !path.isAbsolute(helper)) throw systemError('UID助手入口不兼容。')
  return { command: '/usr/bin/setpriv', args: ['--reuid=' + entry.uid, '--regid=' + entry.gid, '--init-groups', '--', node, helper, action],
    env: systemUserEnvironment(entry), cwd: '/' }
}

function verifyRootPath(file, directory) {
  file = path.resolve(file)
  for (let current = file;; current = path.dirname(current)) {
    const stat = fs.lstatSync(current)
    if (stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & 0o022 || current === file && !(directory ? stat.isDirectory() : stat.isFile())
      || current !== file && !stat.isDirectory()) throw systemError('共享安装路径并非管理员只读：' + current + '（uid=' + stat.uid + '，mode=' + (stat.mode & 0o7777).toString(8) + '）；未执行。')
    if (current === '/') break
  }
  return file
}

export function verifyRootExecutable(file) { return verifyRootPath(file, false) }
export function verifyRootDirectory(file) { return verifyRootPath(file, true) }

// A root-owned private descriptor proves delegation even on /proc mounts that
// prevent an employee UID from inspecting its root parent. No root API is opened.
export function readSystemUserPermit(fd = 3, ownerUid = 0) {
  const stat = fs.fstatSync(fd)
  if (!stat.isFile() || stat.uid !== ownerUid || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > 65536) throw systemError('管理员委托无法核验。')
  const permit = JSON.parse(fs.readFileSync(fd, 'utf8'))
  if (permit.schema_version !== 1 || !helperActions.has(permit.action) || !/^[a-f0-9-]{36}$/.test(permit.id)) throw systemError('管理员委托格式不兼容。')
  validateSystemEntries([permit.entry])
  return permit
}

export async function runSystemUser(entry, { root, action, input = null, operationId, previous, deployment, snapshot, spawnProcess = spawn }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw systemError('跨用户控制仅Linux管理员可执行。', 'CRABOT_SYSTEM_ADMIN_REQUIRED')
  const node = verifyRootExecutable(path.join(root, '.product-runtime/node/bin/node'))
  const helper = verifyRootExecutable(path.join(root, 'scripts/system-user-helper.mjs'))
  const request = systemUserCommand(entry, { node, helper, action })
  const permits = '/etc/crabot/system/permits'
  try { fs.mkdirSync(permits, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const directory = fs.lstatSync(permits)
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o777) !== 0o700) throw systemError('管理员委托目录无法核验。')
  const id = randomUUID(), file = path.join(permits, id + '.json')
  const record = { schema_version: 1, id, entry, action, operation_id: operationId ?? null, previous: previous ?? null, deployment: deployment ?? null, snapshot: snapshot ?? null }
  fs.writeFileSync(file, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600, flush: true })
  fs.chmodSync(file, 0o600)
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    return await new Promise((resolve, reject) => {
      const child = spawnProcess(request.command, request.args, { cwd: request.cwd, env: request.env, stdio: ['pipe', 'ignore', 'ignore', fd, 'pipe'] })
      let stdout = '', bytes = 0, failure
      const unknown = () => systemError('该用户操作失败或结果未知，请检查本人状态与日志。', 'CRABOT_SYSTEM_USER_UNKNOWN')
      const timer = setTimeout(() => { failure ??= unknown(); child.kill('SIGTERM') }, 180_000)
      const replies = child.stdio[4]
      replies.setEncoding('utf8')
      replies.on('data', data => {
        bytes += Buffer.byteLength(data)
        if (bytes > 1024 * 1024) { failure ??= unknown(); child.kill('SIGTERM') }
        else stdout += data
      })
      // Ordinary stdout/stderr are not a control channel and never enter root logs.
      child.stdin.on('error', () => { failure ??= unknown() })
      child.on('error', () => { failure ??= unknown() })
      child.on('close', () => {
        clearTimeout(timer)
        if (failure) { reject(failure); return }
        let frame
        try { frame = JSON.parse(stdout) } catch { reject(unknown()); return }
        if (frame?.ok !== true) reject(systemError(frame?.message || '该用户操作未完成。', frame?.code || 'CRABOT_SYSTEM_USER_FAILED'))
        else resolve(frame.result)
      })
      // A new password is carried only over stdin, not a plan, argv or persisted file.
      child.stdin.end(JSON.stringify({ input }) + '\n')
    })
  } finally { if (fd !== undefined) fs.closeSync(fd); fs.rmSync(file, { force: true }) }
}
