// Prepare private maintenance programs without a removal job or service action.
// Only Ubuntu runs its finite copied-Node self-check; lifecycle hosts own removal.
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { desktopMaintenanceNodeFiles } from './desktop-maintenance-bootstrap.mjs'
import physicalFs from './physical-fs.cjs'
import management from './desktop-management.cjs'
import installation from './desktop-installation.cjs'
import { captureDesktopRemovalProof, readDesktopRemovalProof } from './desktop-removal-proof.mjs'
import { readOriginalDesktopPayload } from './desktop-program-proof.mjs'
import { verifyDesktopGui } from './desktop-payload.mjs'
import { acquireExistingCliLock, releaseCliLock, cliLockToken } from './cli-lock.mjs'
import { workspaceMaintenancePending } from './workspace-maintenance.cjs'
const { promises: fs, constants } = physicalFs
const fail = () => { throw Object.assign(new Error('卸载维护程序尚未准备完成，原应用与用户数据已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const directoryIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
async function versionMaintenancePending(dataDir) {
  try { await fs.lstat(path.join(dataDir, 'desktop-maintenance.json')); return true }
  catch (error) { return error.code !== 'ENOENT' }
}
export async function prepareDesktopRemovalGui({ installRoot, operationId, signal, progress = () => {} }) {
  if (process.platform !== 'darwin' && process.platform !== 'win32') fail()
  const own = installation.readDesktopSelection(installRoot), lock = await acquireExistingCliLock(own.root, 'prepare-removal-host'), token = cliLockToken(lock)
  try {
    const proof = await captureDesktopRemovalProof(own.root, operationId, { signal })
    const original = await readOriginalDesktopPayload(own.root, own.selection)
    const dataIdentity = directoryIdentity(await fs.lstat(own.dataDir, { bigint: true }))
    const current = async () => {
      if (!token || cliLockToken(lock) !== token) fail()
      const actual = installation.readDesktopSelection(own.root), source = await readOriginalDesktopPayload(own.root, own.selection)
      if (!same(actual.record, own.record) || !same(actual.selection, proof.source_selection) || !same(own.selection, proof.source_selection)
        || source.file !== original.file || source.text !== original.text || !same(source.record, proof.payload)
        || directoryIdentity(await fs.lstat(own.dataDir, { bigint: true })) !== dataIdentity
        || await versionMaintenancePending(own.dataDir) || workspaceMaintenancePending(own.dataDir) || cliLockToken(lock) !== token) fail()
    }
    await current(); signal?.throwIfAborted()
    return await copyRemovalGui(own, proof, current, signal, progress)
  } finally { if (token && cliLockToken(lock) === token) releaseCliLock(lock) }
}

// Same neutral byte-copy operation for independently verified role contexts.
async function copyRemovalGui(own, proof, current, signal, progress) {
  let directory, createdIdentity
  try {
    const bytes = Object.values(proof.payload.gui).reduce((sum, file) => sum + BigInt(file.size ?? 0), 0n)
    const parent = await fs.realpath(tmpdir()), space = await fs.statfs(parent, { bigint: true })
    if (space.bavail * space.bsize < bytes + 512n * 1024n * 1024n) throw Object.assign(new Error('临时维护程序空间不足，原应用和数据已保留。'), { code: 'CRABOT_UPDATE_SPACE' })
    directory = management.ensurePrivateDataRoot(path.join(parent, 'crabot-removal-host-' + randomUUID()))
    createdIdentity = directoryIdentity(await fs.lstat(directory, { bigint: true }))
    const guiRoot = path.join(directory, 'gui')
    progress('copying'); signal?.throwIfAborted(); await current()
    await fs.cp(own.guiRoot, guiRoot, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
      filter: () => { signal?.throwIfAborted(); return true } })
    await current(); progress('prepared'); signal?.throwIfAborted()
    await verifyDesktopGui(guiRoot, proof.payload, { signal }); await current()
    if (management.requirePrivateDataRoot(directory) !== directory || directoryIdentity(await fs.lstat(directory, { bigint: true })) !== createdIdentity) fail()
    signal?.throwIfAborted()
    return { directory, guiRoot, executable: path.join(guiRoot, process.platform === 'darwin' ? 'Crabot.app/Contents/MacOS/Crabot' : 'Crabot.exe'), proof }
  } catch (error) {
    if (directory) {
      try {
        if (!createdIdentity || management.requirePrivateDataRoot(directory) !== directory || directoryIdentity(await fs.lstat(directory, { bigint: true })) !== createdIdentity) fail()
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch (cleanup) { throw new AggregateError([error, cleanup], '维护副本准备与清理未完成，保留原应用、数据和诊断。') }
    }
    throw error
  }
}

// Continue only an already published job. Its proof describes old bytes; this
// prepares a GUI copy and never loads the missing/partially removed Core.
export async function prepareExistingDesktopRemovalGui({ installRoot, operationId, signal, progress = () => {} }) {
  if (!['darwin', 'win32'].includes(process.platform)) fail()
  const installationRoot = installation.readDesktopInstallation(installRoot)
  const own = { ...installationRoot, guiRoot: path.join(installationRoot.root, 'app/releases', installation.readDesktopPairReference(installRoot).selection.gui_id) }
  const lock = await acquireExistingCliLock(own.root, 'prepare-existing-removal-host'), token = cliLockToken(lock)
  try {
    const original = await readDesktopRemovalProof(own.root), { record, proof } = original
    if (record.operation_id !== operationId || !same(installation.readDesktopPairReference(own.root).selection, record.source_selection)) fail()
    const dataIdentity = directoryIdentity(await fs.lstat(own.dataDir, { bigint: true }))
    const current = async () => {
      if (!token || cliLockToken(lock) !== token) fail()
      const actual = await readDesktopRemovalProof(own.root)
      if (!same(actual.record, record) || !same(actual.proof, proof)
        || !same(installation.readDesktopInstallation(own.root).record, own.record)
        || !same(installation.readDesktopPairReference(own.root).selection, record.source_selection)
        || directoryIdentity(await fs.lstat(own.dataDir, { bigint: true })) !== dataIdentity
        || await versionMaintenancePending(own.dataDir) || workspaceMaintenancePending(own.dataDir)
        || cliLockToken(lock) !== token) fail()
    }
    await current(); signal?.throwIfAborted()
    await verifyDesktopGui(own.guiRoot, proof.payload, { signal }); await current()
    return { ...await copyRemovalGui(own, proof, current, signal, progress), record }
  } finally { if (token && cliLockToken(lock) === token) releaseCliLock(lock) }
}

// Ubuntu's display runs separately from this plain Node copy. This prepares no
// job or service action and never executes the source Core or the GTK frontend.
export async function prepareDesktopRemovalNode({ installRoot, operationId, signal, progress = () => {} }) {
  if (process.platform !== 'linux') fail()
  const own = installation.readDesktopSelection(installRoot)
  const lock = await acquireExistingCliLock(own.root, 'prepare-removal-node'), token = cliLockToken(lock)
  let directory, createdIdentity
  try {
    const proof = await captureDesktopRemovalProof(own.root, operationId, { signal })
    const original = await readOriginalDesktopPayload(own.root, own.selection)
    const dataIdentity = directoryIdentity(await fs.lstat(own.dataDir, { bigint: true }))
    const current = async () => {
      signal?.throwIfAborted()
      if (!token || cliLockToken(lock) !== token) fail()
      const actual = installation.readDesktopSelection(own.root), source = await readOriginalDesktopPayload(own.root, own.selection)
      if (!same(actual.record, own.record) || !same(actual.selection, proof.source_selection) || source.file !== original.file || source.text !== original.text
        || !same(source.record, proof.payload) || directoryIdentity(await fs.lstat(own.dataDir, { bigint: true })) !== dataIdentity
        || await versionMaintenancePending(own.dataDir) || workspaceMaintenancePending(own.dataDir) || cliLockToken(lock) !== token) fail()
    }
    await current()
    const inventory = JSON.parse(proof.core.inventory).files, nodePath = '.product-runtime/node/bin/node'
    const runtimeEntry = inventory['product-runtime.json']
    if (runtimeEntry?.type !== 'file' || runtimeEntry.size > 65536) fail()
    const runtimeBytes = await fs.readFile(path.join(own.coreRoot, 'product-runtime.json'))
    if (runtimeBytes.length !== runtimeEntry.size || createHash('sha256').update(runtimeBytes).digest('hex') !== runtimeEntry.sha256) fail()
    const version = JSON.parse(runtimeBytes).versions?.node
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) fail()
    const files = [
      { source: path.join(own.coreRoot, nodePath), target: 'node', entry: inventory[nodePath] },
      { source: path.join(own.guiRoot, 'resources/crabot-maintenance'), target: 'crabot-maintenance', entry: proof.payload.gui['resources/crabot-maintenance'] },
      { source: path.join(own.guiRoot, 'resources/crabot-sandbox-helper'), target: 'crabot-sandbox-helper', entry: proof.payload.gui['resources/crabot-sandbox-helper'] },
      ...desktopMaintenanceNodeFiles.map(name => ({ source: path.join(own.guiRoot, 'resources/crabot-maintenance-backend', name), target: 'backend/' + name,
        entry: proof.payload.gui['resources/crabot-maintenance-backend/' + name] })),
    ]
    if (files.some(file => file.entry?.type !== 'file' || !Number.isSafeInteger(file.entry.size) || file.entry.size < 1 || file.entry.size > 128 * 1024 * 1024
      || file.entry.mode & 0o022 || ['node', 'crabot-maintenance', 'crabot-sandbox-helper'].includes(file.target) && !(file.entry.mode & 0o111))) fail()
    const parent = await fs.realpath(tmpdir()), space = await fs.statfs(parent, { bigint: true })
    if (space.bavail * space.bsize < files.reduce((sum, file) => sum + BigInt(file.entry.size), 0n) + 512n * 1024n * 1024n) {
      throw Object.assign(new Error('临时维护程序空间不足，原应用和数据已保留。'), { code: 'CRABOT_UPDATE_SPACE' })
    }
    directory = management.ensurePrivateDataRoot(path.join(parent, 'crabot-removal-host-' + randomUUID()))
    createdIdentity = directoryIdentity(await fs.lstat(directory, { bigint: true }))
    const privateCurrent = async () => {
      await current()
      if (management.requirePrivateDataRoot(directory) !== directory || directoryIdentity(await fs.lstat(directory, { bigint: true })) !== createdIdentity) fail()
    }
    await progress('copying'); await privateCurrent()
    const generation = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':')
    for (const file of files) {
      await privateCurrent()
      const destination = path.join(directory, file.target)
      await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 })
      if (await fs.realpath(path.dirname(destination)) !== path.dirname(destination)) fail()
      const before = await fs.lstat(file.source, { bigint: true })
      if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid()) || before.size !== BigInt(file.entry.size)
        || Number(before.mode & 0o777n) !== file.entry.mode || await fs.realpath(file.source) !== file.source) fail()
      const source = await fs.open(file.source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      let target
      try {
        if (generation(await source.stat({ bigint: true })) !== generation(before)) fail()
        target = await fs.open(destination, 'wx', file.entry.mode)
        const hash = createHash('sha256'), bytes = Buffer.alloc(65536)
        let position = 0
        for (;;) {
          signal?.throwIfAborted()
          const { bytesRead } = await source.read(bytes, 0, bytes.length, position)
          if (!bytesRead) break
          if (position + bytesRead > file.entry.size) fail()
          hash.update(bytes.subarray(0, bytesRead))
          let written = 0
          while (written < bytesRead) {
            const result = await target.write(bytes, written, bytesRead - written, position + written)
            if (!result.bytesWritten) fail()
            written += result.bytesWritten
          }
          position += bytesRead
        }
        await target.chmod(file.entry.mode)
        if (position !== file.entry.size || hash.digest('hex') !== file.entry.sha256
          || generation(await source.stat({ bigint: true })) !== generation(before) || generation(await fs.lstat(file.source, { bigint: true })) !== generation(before)) fail()
      } finally { await source.close(); await target?.close() }
    }
    // Re-read all private bytes before executing even the finite self-check.
    const verifyCopy = async () => {
      await privateCurrent()
      await verifyUbuntuRemovalNodeCopy(directory, proof, { signal })
      await privateCurrent()
    }
    await verifyCopy()
    const executable = path.join(directory, 'node')
    const script = `import fs from 'node:fs';import path from 'node:path';import {createRequire} from 'node:module';import {pathToFileURL} from 'node:url';
      const root=process.argv[1],require=createRequire(pathToFileURL(path.join(root,'backend/probe.mjs')));
      const identity=require('./bootstrap/scripts/lib/process-identity.cjs');
      if(fs.realpathSync(identity.inspectProcess(process.pid).executable)!==fs.realpathSync(process.execPath))throw new Error('private interpreter mismatch');
      const job=await import(pathToFileURL(path.join(root,'backend/bootstrap/scripts/lib/desktop-removal-job.mjs')));
      const progress=await import(pathToFileURL(path.join(root,'backend/progress.mjs')));
      const rules=await import(pathToFileURL(path.join(root,'backend/rules.mjs')));
      if(typeof job.beginInitialDesktopRemoval!=='function'||typeof progress.createUbuntuRemovalProgressWindow!=='function'||typeof rules.prepareUbuntuRemovalRules!=='function')throw new Error('fixed backend incomplete');
      process.stdout.write(JSON.stringify({node_version:process.versions.node,self_verified:true})+'\\n');`
    const result = await promisify(execFile)(executable, ['--input-type=module', '--eval', script, directory], {
      cwd: directory, env: { PATH: '', LANG: 'C.UTF-8' }, timeout: 15000, maxBuffer: 4096, signal,
    })
    if (result.stderr || result.stdout !== JSON.stringify({ node_version: version, self_verified: true }) + '\n') fail()
    await progress('prepared'); await verifyCopy()
    return { directory, executable, frontend: path.join(directory, 'crabot-maintenance'), proof, self_verified: true }
  } catch (error) {
    if (directory) {
      try {
        if (!createdIdentity || management.requirePrivateDataRoot(directory) !== directory || directoryIdentity(await fs.lstat(directory, { bigint: true })) !== createdIdentity) fail()
        await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      } catch (cleanup) { throw new AggregateError([error, cleanup], '维护副本准备与清理未完成，原应用、数据和诊断已保留。') }
    }
    throw error
  } finally { if (token && cliLockToken(lock) === token) releaseCliLock(lock) }
}

// Neutral byte facts shared by preparation and the separate Linux host role.
// Reading a valid copy does not authorize a job, service action or deletion.
export async function verifyUbuntuRemovalNodeCopy(directory, proof, { signal } = {}) {
  if (process.platform !== 'linux') fail()
  if (management.requirePrivateDataRoot(directory) !== directory) fail()
  const original = directoryIdentity(await fs.lstat(directory, { bigint: true }))
  const inventory = JSON.parse(proof.core.inventory).files
  const files = [
    { target: 'node', entry: inventory['.product-runtime/node/bin/node'] },
    { target: 'crabot-maintenance', entry: proof.payload.gui['resources/crabot-maintenance'] },
    { target: 'crabot-sandbox-helper', entry: proof.payload.gui['resources/crabot-sandbox-helper'] },
    ...desktopMaintenanceNodeFiles.map(name => ({ target: 'backend/' + name, entry: proof.payload.gui['resources/crabot-maintenance-backend/' + name] })),
  ]
  const generation = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.size, stat.nlink, stat.mtimeNs, stat.ctimeNs].join(':')
  for (const file of files) {
    signal?.throwIfAborted()
    const expected = file.entry
    if (expected?.type !== 'file' || !Number.isSafeInteger(expected.size) || expected.size < 1 || expected.size > 128 * 1024 * 1024
      || expected.mode & 0o022 || ['node', 'crabot-maintenance', 'crabot-sandbox-helper'].includes(file.target) && !(expected.mode & 0o111)) fail()
    const target = path.join(directory, file.target), before = await fs.lstat(target, { bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid()) || (before.mode & 0o777n) !== BigInt(expected.mode)
      || before.size !== BigInt(expected.size) || await fs.realpath(target) !== target) fail()
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      if (generation(await handle.stat({ bigint: true })) !== generation(before)) fail()
      const hash = createHash('sha256'), bytes = Buffer.alloc(65536)
      let position = 0
      while (position < expected.size) {
        const { bytesRead } = await handle.read(bytes, 0, Math.min(bytes.length, expected.size - position), position)
        if (!bytesRead) fail()
        hash.update(bytes.subarray(0, bytesRead)); position += bytesRead
      }
      if ((await handle.read(Buffer.alloc(1), 0, 1, position)).bytesRead || hash.digest('hex') !== expected.sha256
        || generation(await handle.stat({ bigint: true })) !== generation(before) || generation(await fs.lstat(target, { bigint: true })) !== generation(before)) fail()
    } finally { await handle.close() }
  }
  signal?.throwIfAborted()
  if (management.requirePrivateDataRoot(directory) !== directory || directoryIdentity(await fs.lstat(directory, { bigint: true })) !== original) fail()
}
