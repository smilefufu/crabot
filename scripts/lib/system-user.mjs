// Fixed UID boundary shared by administrator operations and systemd setup.
// No employee files, shell rc or configuration are loaded in this root process.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { systemError, validateSystemEntries, validateSystemAccount } from './system-registry.mjs'
import { createLegacySystemConversionPermit, validateLegacySystemConversionPermit } from './system-conversion-permit.mjs'

const helperActions = new Set(['prepare', 'verify-provision', 'inspect', 'start', 'stop', 'restart', 'disable', 'configure-service', 'preflight-data', 'verify-snapshot', 'snapshot', 'migrate', 'cancel-preparation', 'check-migration'])
const safePath = '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
export function systemAccountEnvironment(account) {
  validateSystemAccount(account)
  return { HOME: account.home, USER: account.user, LOGNAME: account.user, PATH: safePath, LANG: 'C.UTF-8',
    XDG_RUNTIME_DIR: '/run/user/' + account.uid, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/' + account.uid + '/bus' }
}
export function systemUserEnvironment(entry) {
  validateSystemEntries([entry])
  const { user, uid, gid, home } = entry
  return { ...systemAccountEnvironment({ user, uid, gid, home }), DATA_DIR: entry.data_dir, CRABOT_PORT_OFFSET: String(entry.port_offset) }
}
export function legacySystemAccountCommand(account, { node, helper }) {
  validateSystemAccount(account)
  if (!path.isAbsolute(node) || !path.isAbsolute(helper)) throw systemError('账号发现助手入口不兼容。')
  return { command: '/usr/bin/setpriv', args: ['--reuid=' + account.uid, '--regid=' + account.gid, '--init-groups', '--', node, helper, 'discover-legacy'],
    env: systemAccountEnvironment(account), cwd: '/' }
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
function readRootPermit(fd, ownerUid) {
  const stat = fs.fstatSync(fd)
  if (!stat.isFile() || stat.uid !== ownerUid || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > 65536) throw systemError('管理员委托无法核验。')
  return JSON.parse(fs.readFileSync(fd, 'utf8'))
}
export function readSystemUserPermit(fd = 3, ownerUid = 0) {
  const permit = readRootPermit(fd, ownerUid)
  if (permit.schema_version !== 1 || permit.kind !== undefined || !helperActions.has(permit.action) || !/^[a-f0-9-]{36}$/.test(permit.id)) throw systemError('管理员委托格式不兼容。')
  validateSystemEntries([permit.entry])
  return permit
}

export function readLegacySystemConversionPermit(fd = 3, ownerUid = 0) {
  return validateLegacySystemConversionPermit(readRootPermit(fd, ownerUid))
}

export function runLegacySystemConversionStop(entry, options) {
  return runLegacySystemConversion(entry, { ...options, action: 'stop-legacy' })
}
export async function runLegacySystemConversion(entry, { root, operationId, action, spawnProcess = spawn }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw systemError('跨用户转换仅Linux管理员可执行。', 'CRABOT_SYSTEM_ADMIN_REQUIRED')
  const { SystemOperationStore } = await import('./system-operation.mjs')
  const { LegacySystemEntryFence } = await import('./legacy-system-fence.mjs')
  const { cliLockToken } = await import('./cli-lock.mjs')
  const { readSystemBootId } = await import('./system-context.mjs')
  const store = new SystemOperationStore()
  if (!cliLockToken(path.join(store.directory, 'cli.lock'))) throw systemError('转换动作必须持有当前根作业锁。', 'CRABOT_SYSTEM_CONVERSION_PERMIT')
  const record = store.read(store.file(operationId), true), maintenance = store.maintenance()
  const { validateSystemConversionPlan } = await import('./system-conversion.mjs')
  validateSystemConversionPlan(record?.plan)
  store.registry.verifyAccount(entry)
  const sourceFence = await new LegacySystemEntryFence().inspect(record?.plan?.source?.installRoot)
  const permit = createLegacySystemConversionPermit({ record, maintenance, entry, sourceFence, bootId: readSystemBootId(), action })
  const cliLocation = (await import('./cli-location.cjs')).default
  const target = cliLocation.locateCliInstallation(root)
  if (!target || target.scope !== 'system' || target.coreRoot !== root || target.root !== record.plan.install_root || target.id !== record.plan.target.id) {
    throw systemError('转换助手与固定目标核心不一致。', 'CRABOT_SYSTEM_CONVERSION_PERMIT')
  }
  const { verifyCoreRelease } = await import('./core-release.mjs')
  if ((await verifyCoreRelease(root, { version: record.plan.target.version })).inventory_sha256 !== target.id) {
    throw systemError('转换目标核心已改变。', 'CRABOT_SYSTEM_CONVERSION_PERMIT')
  }
  const node = verifyRootExecutable(path.join(root, '.product-runtime/node/bin/node'))
  const helper = verifyRootExecutable(path.join(root, 'scripts/system-conversion-user-helper.mjs'))
  const request = { command: '/usr/bin/setpriv', args: ['--reuid=' + entry.uid, '--regid=' + entry.gid, '--init-groups', '--', node, helper, permit.action],
    env: systemUserEnvironment(entry), cwd: '/' }
  return delegateUserRequest(request, permit, { input: null, spawnProcess, permits: '/etc/crabot/system/permits', timeout: action === 'stop-legacy' ? 180_000 : 20 * 60_000 })
}

export function validateLegacyAccountRequest({ account, release, port_offset_hint }) {
  validateSystemAccount(account)
  if (!release || Object.keys(release).length !== 3 || typeof release.version !== 'string'
    || !/^v\d{4}\.\d{2}\.\d{2}\.\d+$/.test(release.version) || typeof release.installRoot !== 'string'
    || !path.posix.isAbsolute(release.installRoot) || path.posix.normalize(release.installRoot) !== release.installRoot
    || /[\0\r\n]/.test(release.installRoot) || !/^[a-f0-9]{64}$/.test(release.code_fingerprint ?? '')
    || !Number.isInteger(port_offset_hint) || port_offset_hint < 100 || port_offset_hint > 9900 || port_offset_hint % 100 !== 0) throw systemError('旧账号发现上下文无法核验。')
}
export function readLegacySystemAccountPermit(fd = 3, ownerUid = 0) {
  const permit = readRootPermit(fd, ownerUid)
  if (permit.schema_version !== 1 || permit.kind !== 'legacy-account-discovery' || permit.action !== 'discover-legacy'
    || !/^[a-f0-9-]{36}$/.test(permit.id) || Object.keys(permit).length !== 7) throw systemError('只读账号委托格式不兼容。')
  validateLegacyAccountRequest(permit)
  return permit
}
export async function runLegacySystemAccount(account, { root, release, portOffsetHint, spawnProcess = spawn }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw systemError('跨用户发现仅Linux管理员可执行。', 'CRABOT_SYSTEM_ADMIN_REQUIRED')
  const context = { account, release, port_offset_hint: portOffsetHint }
  validateLegacyAccountRequest(context)
  const node = verifyRootExecutable(path.join(root, '.product-runtime/node/bin/node'))
  const helper = verifyRootExecutable(path.join(root, 'scripts/legacy-system-user-helper.mjs'))
  return delegateUserRequest(legacySystemAccountCommand(account, { node, helper }),
    { schema_version: 1, id: randomUUID(), kind: 'legacy-account-discovery', action: 'discover-legacy', ...context },
    { input: null, spawnProcess, permits: '/run/crabot-system-discovery' })
}

export async function runSystemUser(entry, { root, action, input = null, operationId, previous, deployment, snapshot, spawnProcess = spawn }) {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw systemError('跨用户控制仅Linux管理员可执行。', 'CRABOT_SYSTEM_ADMIN_REQUIRED')
  const node = verifyRootExecutable(path.join(root, '.product-runtime/node/bin/node'))
  const helper = verifyRootExecutable(path.join(root, 'scripts/system-user-helper.mjs'))
  const request = systemUserCommand(entry, { node, helper, action })
  const record = { schema_version: 1, id: randomUUID(), entry, action, operation_id: operationId ?? null, previous: previous ?? null, deployment: deployment ?? null, snapshot: snapshot ?? null }
  return delegateUserRequest(request, record, { input, spawnProcess, permits: '/etc/crabot/system/permits' })
}

// Descriptor transport only: callers above own the identity, fixed executable,
// allowed action, environment and role. This layer never reads employee files.
async function delegateUserRequest(request, record, { input, spawnProcess, permits, timeout = 180_000 }) {
  verifyRootDirectory(path.dirname(permits))
  try { fs.mkdirSync(permits, { mode: 0o700 }) } catch (error) { if (error.code !== 'EEXIST') throw error }
  const directory = fs.lstatSync(permits)
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== 0 || (directory.mode & 0o777) !== 0o700) throw systemError('管理员委托目录无法核验。')
  const file = path.join(permits, record.id + '.json')
  fs.writeFileSync(file, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600, flush: true })
  fs.chmodSync(file, 0o600)
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    return await new Promise((resolve, reject) => {
      const child = spawnProcess(request.command, request.args, { cwd: request.cwd, env: request.env, stdio: ['pipe', 'ignore', 'ignore', fd, 'pipe'] })
      let stdout = '', bytes = 0, failure
      const unknown = () => systemError('该用户操作失败或结果未知，请检查本人状态与日志。', 'CRABOT_SYSTEM_USER_UNKNOWN')
      const timer = setTimeout(() => { failure ??= unknown(); child.kill('SIGTERM') }, timeout)
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
