// Offline installer admission for an existing destructive job only. Incoming
// GUI bytes never replace the historical proof or enlarge its deletion scope.
import path from 'node:path'
import { createHash } from 'node:crypto'
import physical from './physical-fs.cjs'
import identity from './process-identity.cjs'
import management from './desktop-management.cjs'
import installation from './desktop-installation.cjs'
import { processBirthAtLeast } from './owned-process-tree.cjs'
import { readDesktopRemovalProof } from './desktop-removal-proof.mjs'
import { verifyDesktopGui, verifyDesktopPayload } from './desktop-payload.mjs'
import { assertReinstallVersion } from './desktop-reinstall.mjs'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const generation = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid].join(':')
const fileGeneration = stat => [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(':')
const inside = (parent, child) => { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) }
const fail = () => { throw Object.assign(new Error('离线安装器与卸载维护程序交接无法核验，剩余程序和数据已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
export async function captureInstallerRemovalGuiHost({ installRoot, operationId, installerPayload, signal }) {
  if (!['darwin', 'win32'].includes(process.platform) || !process.connected || typeof process.send !== 'function') fail()
  signal?.throwIfAborted()
  const own = installation.readDesktopInstallation(installRoot), { record, proof } = await readDesktopRemovalProof(own.root)
  if (record.operation_id !== operationId || !['removing', 'completed'].includes(record.phase)
    || !same(installation.readDesktopPairReference(own.root).selection, record.source_selection)) fail()
  const payload = await physical.promises.realpath(installerPayload)
  if (payload !== installerPayload || path.basename(payload) !== 'offline') fail()
  const resources = path.dirname(payload)
  const installer = process.platform === 'darwin' ? path.resolve(resources, '../MacOS/Crabot Installer') : path.resolve(resources, '../CrabotInstaller.exe')
  if (path.basename(resources) !== (process.platform === 'darwin' ? 'Resources' : 'resources')) fail()
  const self = identity.inspectProcess(process.pid), parent = self && identity.inspectProcess(self.parent)
  const parentCurrent = () => {
    const actual = identity.inspectProcess(parent?.pid), current = identity.inspectProcess(process.pid)
    if (!self || !parent || !actual || !current || parent.owner !== own.record.owner || self.owner !== parent.owner
      || !identity.sameProcess(self, current) || !identity.sameProcess(parent, actual) || current.parent !== parent.pid
      || !processBirthAtLeast(self.started, parent.started) || !process.connected
      || physical.realpathSync(actual.executable) !== physical.realpathSync(installer)) fail()
    const args = identity.inspectProcessArguments(parent.pid).slice(1)
    if (args.some(value => value !== '--install-root=' + own.root && !(process.platform === 'darwin' && /^-psn_[0-9_]+$/.test(value)))) fail()
  }
  parentCurrent()
  const executable = physical.realpathSync(process.execPath)
  if (physical.realpathSync(self.executable) !== executable) fail()
  const guiRoot = process.platform === 'darwin' ? path.resolve(path.dirname(executable), '../../..') : path.dirname(executable)
  const directory = management.requirePrivateDataRoot(path.dirname(guiRoot))
  if (path.basename(guiRoot) !== 'gui' || !/^crabot-removal-host-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(path.basename(directory))
    || inside(own.root, directory) || inside(directory, own.root) || physical.realpathSync(process.cwd()) !== directory) fail()
  const hostIdentity = generation(physical.lstatSync(directory, { bigint: true })), dataIdentity = generation(physical.lstatSync(own.dataDir, { bigint: true }))
  const incoming = await verifyDesktopPayload(payload, { signal })
  assertReinstallVersion(record.source_selection.version, incoming.record.selection.version)
  await verifyDesktopGui(guiRoot, incoming.record, { signal })
  const actual = await readDesktopRemovalProof(own.root)
  parentCurrent()
  if (!same(actual.record, record) || !same(actual.proof, proof) || !same(installation.readDesktopInstallation(own.root).record, own.record)
    || !same(installation.readDesktopPairReference(own.root).selection, record.source_selection)
    || management.requirePrivateDataRoot(directory) !== directory || generation(physical.lstatSync(directory, { bigint: true })) !== hostIdentity
    || generation(physical.lstatSync(own.dataDir, { bigint: true })) !== dataIdentity) fail()
  signal?.throwIfAborted()
  return { record, proof, hostPayload: incoming.record, facts: { installation_id: own.record.installation_id, operation_id: operationId,
    source_selection: record.source_selection, source_installer: parent, host_gui: self,
    proof_sha256: createHash('sha256').update(JSON.stringify(proof) + '\n').digest('hex') } }
}

// Ubuntu's trusted offline installer already runs an independent bundled Node
// outside the original program scope. No temporary runtime copy is necessary.
export async function captureInstallerRemovalNodeHost({ installRoot, operationId, installerPayload, signal }) {
  if (process.platform !== 'linux' || process.getuid() === 0 || process.getuid() !== process.geteuid()) fail()
  signal?.throwIfAborted()
  const own = installation.readDesktopInstallation(installRoot), { record, proof } = await readDesktopRemovalProof(own.root)
  if (record.operation_id !== operationId || !['removing', 'completed'].includes(record.phase)
    || !same(installation.readDesktopPairReference(own.root).selection, record.source_selection)) fail()
  const incoming = await verifyDesktopPayload(installerPayload, { signal }), bundle = path.dirname(incoming.directory)
  if (incoming.directory !== installerPayload || path.basename(incoming.directory) !== 'offline') fail()
  assertReinstallVersion(record.source_selection.version, incoming.record.selection.version)
  const self = identity.inspectProcess(process.pid), parent = self && identity.inspectProcess(self.parent)
  const node = path.join(incoming.coreRoot, '.product-runtime/node/bin/node'), installer = path.join(bundle, 'crabot-installer')
  if (!self || !parent || self.owner !== own.record.owner || parent.owner !== self.owner || !processBirthAtLeast(self.started, parent.started)
    || physical.realpathSync(process.execPath) !== node || physical.realpathSync(self.executable) !== node
    || physical.realpathSync(parent.executable) !== installer || physical.realpathSync(process.cwd()) !== bundle) fail()
  const manifestFile = path.join(bundle, 'native-bootstrap.json'), manifestStat = physical.lstatSync(manifestFile)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 65536) fail()
  const manifest = JSON.parse(physical.readFileSync(manifestFile, 'utf8'))
  const release = JSON.parse(physical.readFileSync(path.join(incoming.coreRoot, 'core-release.json'), 'utf8'))
  if (manifest.schema_version !== 1 || manifest.platform !== 'linux' || manifest.arch !== 'x64' || manifest.source_dirty !== false
    || manifest.build_os !== 'ubuntu-24.04' || manifest.commit !== release.commit) fail()
  const native = ['crabot-installer', 'crabot-sandbox-helper'].map(name => {
    const file = path.join(bundle, name), stat = physical.lstatSync(file, { bigint: true }), expected = manifest.files?.[name]
    if (!stat.isFile() || stat.isSymbolicLink() || !expected || !Number.isSafeInteger(expected.size) || expected.size < 20
      || stat.size !== BigInt(expected.size) || stat.size > 10n * 1024n * 1024n || !(stat.mode & 0o111n)
      || createHash('sha256').update(physical.readFileSync(file)).digest('hex') !== expected.sha256
      || name === 'crabot-sandbox-helper' && expected.sha256 !== incoming.record.gui['resources/crabot-sandbox-helper']?.sha256) fail()
    return [file, fileGeneration(stat)]
  })
  const programs = [[node, fileGeneration(physical.lstatSync(node, { bigint: true }))], ...native]
  const directories = [bundle, path.dirname(node)].map(file => [file, generation(physical.lstatSync(file, { bigint: true }))])
  const assertHostCurrent = () => {
    if (!identity.sameProcess(self, identity.inspectProcess(process.pid)) || physical.realpathSync(process.cwd()) !== bundle) fail()
    for (const [file, original] of directories) if (physical.realpathSync(file) !== file || generation(physical.lstatSync(file, { bigint: true })) !== original) fail()
    for (const [file, original] of programs) {
      const stat = physical.lstatSync(file, { bigint: true })
      if (!stat.isFile() || stat.isSymbolicLink() || fileGeneration(stat) !== original) fail()
    }
  }
  const actual = await readDesktopRemovalProof(own.root)
  if (!same(actual.record, record) || !same(actual.proof, proof) || !same(installation.readDesktopInstallation(own.root).record, own.record)
    || !same(installation.readDesktopPairReference(own.root).selection, record.source_selection)
    || !identity.sameProcess(parent, identity.inspectProcess(parent.pid))) fail()
  assertHostCurrent(); signal?.throwIfAborted()
  return { record, proof, hostPayload: incoming.record, hostDirectory: bundle, assertHostCurrent,
    verifyHost: async () => assertHostCurrent(),
    facts: { installation_id: own.record.installation_id, operation_id: operationId, source_selection: record.source_selection,
      source_installer: parent, host_node: self, proof_sha256: createHash('sha256').update(JSON.stringify(proof) + '\n').digest('hex') } }
}
