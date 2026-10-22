// Physical copy into one newly created private staging container. Fixed-job authorization/journals belong to the caller.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { constants } from 'node:fs'
import { createHash } from 'node:crypto'
import native from './process-identity.cjs'
import { runBounded } from './run-bounded.mjs'
import { inspectWorkspaceFileMetadata, verifyWorkspaceRelocationCopy } from './workspace-file-metadata.mjs'
import { inspectWorkspaceRelocationTree } from '../../crabot-shared/dist/workspace-relocation-files.js'

const fail = () => Object.assign(new Error('工作区暂存复制未通过核验；原目录保留，未切换或清理。'), { code: 'WORKSPACE_COPY_UNVERIFIED' })
const within = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) }
const sameRoot = (a, b) => a.isDirectory() && !a.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino && a.uid === b.uid
const checkCancelled = signal => { if (signal?.aborted) throw Object.assign(new Error('工作区复制已取消，原目录保留。'), { code: 'CRABOT_PREPARATION_CANCELLED' }) }

/** Read-only source capability checks, callable before execution is stopped. No target is created. */
export async function inspectWorkspaceFileSource(source, mode, { signal, metadataCompatibility = 'exact' } = {}) {
  if (!['exact', 'windows-owner-inheritance-v1'].includes(metadataCompatibility)
    || metadataCompatibility !== 'exact' && (process.platform !== 'win32' || mode !== 'copy')) throw fail()
  if (mode !== 'copy' && mode !== 'rename') throw fail()
  checkCancelled(signal)
  const original = await fs.lstat(source, { bigint: true })
  const account = mode === 'copy' && process.platform === 'win32' ? { owner: native.inspectProcess(process.pid).owner, group: native.inspectCurrentPrimaryGroup() } : null
  const nativeId = process.platform === 'win32' ? native.inspectDirectoryFileId(source) : undefined
  const tree = await inspectWorkspaceRelocationTree(source, mode, { signal })
  if (tree.issues.length) throw fail()
  const hash = createHash('sha256'); let entries = 0
  async function visit(relative) {
    checkCancelled(signal)
    const file = path.join(source, relative), stat = await fs.lstat(file, { bigint: true })
    if (mode === 'copy' && process.platform === 'win32' && stat.isFile() && stat.nlink > 1n) {
      throw Object.assign(new Error('当前 Windows 跨盘复制不能可靠保留内部硬链接；请保留原位置或选择同卷迁移。'), { code: 'WORKSPACE_COPY_LINK_UNSUPPORTED' })
    }
    if (mode === 'copy' && process.platform !== 'win32' && process.getuid() !== 0
      && (stat.uid !== BigInt(process.getuid()) || ![process.getgid(), ...process.getgroups()].some(gid => BigInt(gid) === stat.gid))) {
      throw Object.assign(new Error('当前系统用户无法保留部分文件的所有者或用户组；未开始复制。'), { code: 'WORKSPACE_COPY_OWNER_UNSUPPORTED' })
    }
    const metadata = await inspectWorkspaceFileMetadata(file, { signal })
    if (metadataCompatibility === 'windows-owner-inheritance-v1' && !native.inspectWorkspaceOwnerAccess(file)) {
      throw Object.assign(new Error('部分工作区文件或目录使用自定义、共享或受限权限，当前无法安全跨盘迁移；未授权复制或切换，原目录保留。'), { code: 'WORKSPACE_COPY_ACL_UNSUPPORTED', path: relative })
    }
    if (mode === 'copy' && process.platform === 'win32' && (entries >= 999999 || metadata.named_streams > 1024)) {
      throw Object.assign(new Error('工作区超过当前 Windows 可靠同步的数量上限；未停止执行或开始复制。'), { code: 'WORKSPACE_COPY_SYNC_UNSUPPORTED', path: relative })
    }
    if (mode === 'copy' && account && (metadata.owner !== account.owner || metadata.group !== account.group)) throw Object.assign(new Error('当前系统用户无法保留部分文件的所有者或用户组；未开始复制。'), { code: 'WORKSPACE_COPY_OWNER_UNSUPPORTED', path: relative })
    if (mode === 'copy' && metadata.copy_blockers.length) throw Object.assign(new Error('工作区含当前跨盘复制不支持的文件属性；原目录保留。'), { code: 'WORKSPACE_COPY_METADATA_UNSUPPORTED', path: relative, blockers: metadata.copy_blockers })
    hash.update(JSON.stringify([relative, metadata.fingerprint]) + '\n'); entries++
    if (stat.isDirectory()) for (const name of (await fs.readdir(file)).sort()) await visit(path.join(relative, name))
  }
  await visit('')
  if ((await inspectWorkspaceRelocationTree(source, mode, { signal })).fingerprint !== tree.fingerprint) throw fail()
  if (!sameRoot(original, await fs.lstat(source, { bigint: true }))) throw fail()
  if (nativeId !== undefined && native.inspectDirectoryFileId(source) !== nativeId) throw fail()
  return { source_identity: { dev: original.dev.toString(), ino: original.ino.toString(), ...(nativeId ? { native_id: nativeId } : {}) }, tree_fingerprint: tree.fingerprint, metadata_fingerprint: hash.digest('hex'), entries }
}

export const inspectWorkspaceCopySource = (source, options) => inspectWorkspaceFileSource(source, 'copy', options)

export async function copyWorkspaceToStaging(source, container, { signal } = {}) {
  checkCancelled(signal)
  if (!path.isAbsolute(source) || !path.isAbsolute(container) || source.includes('\0') || container.includes('\0')
    || path.normalize(source) !== source || path.normalize(container) !== container
    || within(source, container) || within(container, source)
    || await fs.realpath(path.dirname(container)) !== path.dirname(container)) throw fail()
  const before = await inspectWorkspaceCopySource(source, { signal })
  checkCancelled(signal)
  let sourcePin, containerPin, treePin
  try {
    if (process.platform === 'win32') {
      sourcePin = native.pinDirectory(source)
      if (sourcePin.identity !== before.source_identity.native_id) throw fail()
    }
    // mkdir is exclusive; even an existing empty directory is never adopted or overwritten.
    let created
    if (process.platform === 'win32') native.createPrivateDirectory(container)
    else created = native.createPrivateStagingDirectory(container)
    const identity = await fs.lstat(container, { bigint: true }), target = path.join(container, 'tree')
    if (!identity.ino || created && (created.dev !== identity.dev.toString() || created.ino !== identity.ino.toString())
      || await fs.realpath(container) !== container
      || process.platform === 'win32' && !native.isPrivateDirectory(container)
      || process.platform !== 'win32' && (identity.mode & 0o777n) !== 0o700n) throw fail()
    if (process.platform === 'win32') {
      containerPin = native.pinDirectory(container)
      if ((await fs.readdir(container)).length) throw fail()
    }
    const checkContainer = async () => {
      const current = await fs.lstat(container, { bigint: true })
      if (!sameRoot(identity, current) || await fs.realpath(container) !== container
        || process.platform === 'win32' && !native.isPrivateDirectory(container)
        || process.platform !== 'win32' && (current.mode & 0o777n) !== 0o700n) throw fail()
    }
    checkCancelled(signal); await checkContainer()
    const allowed = new Set(['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR'])
    const env = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && allowed.has(key.toUpperCase())))
    const options = { cwd: path.dirname(fileURLToPath(import.meta.url)), env, signal, captureError: true }
    if (process.platform === 'darwin' || process.platform === 'linux') {
      const sourceFd = await fs.open(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      let targetFd
      try {
        targetFd = await fs.open(container, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
        const opened = await sourceFd.stat({ bigint: true }), staged = await targetFd.stat({ bigint: true })
        if (!opened.isDirectory() || opened.dev.toString() !== before.source_identity.dev || opened.ino.toString() !== before.source_identity.ino
          || !sameRoot(identity, staged)) throw fail()
        await runBounded(process.execPath, [fileURLToPath(new URL('../workspace-copy-host.mjs', import.meta.url)),
          opened.dev.toString(), opened.ino.toString(), staged.dev.toString(), staged.ino.toString()],
        { ...options, extraFileDescriptors: [sourceFd.fd, targetFd.fd] })
      } finally { try { await targetFd?.close() } finally { await sourceFd.close() } }
    } else if (process.platform === 'win32') {
      native.createPrivateDirectory(target); treePin = native.pinDirectory(target)
      await runBounded(path.join(process.env.SystemRoot, 'System32/robocopy.exe'), [source, target, '/E', '/COPY:DATS', '/DCOPY:DATE',
        '/SL', '/SJ', '/R:0', '/W:0', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { ...options, successCodes: [0, 1, 2, 3, 4, 5, 6, 7] })
      checkCancelled(signal)
      native.copyPinnedWorkspaceMetadata(sourcePin, treePin)
      if (native.inspectDirectoryFileId(source) !== sourcePin.identity || native.inspectDirectoryFileId(target) !== treePin.identity
        || native.inspectDirectoryFileId(container) !== containerPin.identity) throw fail()
    } else throw fail()
    checkCancelled(signal); await checkContainer()
    const currentSource = await fs.lstat(source, { bigint: true })
    if (!currentSource.isDirectory() || currentSource.isSymbolicLink() || currentSource.dev.toString() !== before.source_identity.dev
      || currentSource.ino.toString() !== before.source_identity.ino || await fs.realpath(source) !== source) throw fail()
    const proof = await verifyWorkspaceRelocationCopy(source, target, { signal })
    if (proof.source_fingerprint !== before.tree_fingerprint || proof.metadata_fingerprint !== before.metadata_fingerprint
      || proof.metadata_entries !== before.entries) throw fail()
    await checkContainer(); checkCancelled(signal)
    return { target, container_identity: { dev: identity.dev.toString(), ino: identity.ino.toString() }, ...proof }
  } finally {
    for (const pin of [treePin, containerPin, sourcePin]) if (pin) native.releaseDirectoryPin(pin)
  }
}
