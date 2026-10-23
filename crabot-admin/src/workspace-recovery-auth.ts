import fs from 'node:fs'
import path from 'node:path'
import { RpcError, sha256CanonicalJson } from 'crabot-shared'
import type { VerifyWorkspaceRelocationRecoveryRequestParams, VerifyWorkspaceRelocationRecoveryRequestResult } from 'crabot-shared'

const native = require('../../scripts/lib/process-identity.cjs')
const management = require('../../scripts/lib/desktop-management.cjs')
const { readWorkspaceRecoveryAdmissionScope } = require('../../scripts/lib/workspace-recovery-admission.mjs')
const { openPinnedProcessRpc } = require('../../scripts/lib/pinned-process-rpc.cjs')
const unavailable = () => new RpcError('SERVICE_UNAVAILABLE', '当前人类恢复接纳或运行载体无法核实，维护保护已保留。')
const version = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid, stat.nlink].join(':')
interface Options {
  dataDir: string
  moduleManagerPort: number
  modulePort: number
  runtimeIdentity: () => { instance_id?: string; module_id: string; runtime_id?: string }
}

/** Read the current Admin's own durable root; a caller cannot choose the parent PID. */
export function observeCurrentWorkspaceAdmin(options: Options) {
  const data = management.requirePrivateDataRoot(options.dataDir), runtime = { ...options.runtimeIdentity() }, self = native.inspectProcess(process.pid)
  if (!self || runtime.module_id !== 'admin-web' || !runtime.instance_id || !runtime.runtime_id
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(runtime.runtime_id)) throw unavailable()
  const directories = [path.join(data, 'module-runtime-registry'), path.join(data, 'module-runtime-registry/records')]
  const owner = fs.lstatSync(data, { bigint: true }).uid
  const observe = () => directories.map(directory => {
    const stat = fs.lstatSync(directory, { bigint: true })
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory
      || (process.platform === 'win32' ? !native.isOwnerOnlyDirectory(directory) : stat.uid !== owner)) throw unavailable()
    return [directory, String(stat.dev), String(stat.ino)]
  })
  const directoryHash = sha256CanonicalJson(observe()), file = path.join(directories[1], runtime.runtime_id + '.json')
  const read = () => {
    if (sha256CanonicalJson(observe()) !== directoryHash) throw unavailable()
    const stat = fs.lstatSync(file, { bigint: true })
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 65536n
      || (process.platform === 'win32' ? !native.isOwnerOnlyFile(file) : stat.uid !== owner)) throw unavailable()
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    try {
      if (version(fs.fstatSync(fd, { bigint: true })) !== version(stat)) throw unavailable()
      const text = fs.readFileSync(fd, 'utf8')
      if (version(fs.fstatSync(fd, { bigint: true })) !== version(stat) || version(fs.lstatSync(file, { bigint: true })) !== version(stat)
        || sha256CanonicalJson(observe()) !== directoryHash) throw unavailable()
      return JSON.parse(text)
    } finally { fs.closeSync(fd) }
  }
  const row = read(), rowHash = sha256CanonicalJson(row)
  const fields = ['schema_version', 'instance_id', 'runtime_id', 'module_id', 'root_pid', 'process_start_identity', 'module_port', 'created_at']
  if (Object.keys(row).length !== fields.length || !fields.every(key => Object.prototype.hasOwnProperty.call(row, key)) || row.schema_version !== 1
    || row.instance_id !== runtime.instance_id || row.runtime_id !== runtime.runtime_id || row.module_id !== runtime.module_id
    || row.module_port !== options.modulePort || !Number.isSafeInteger(row.root_pid) || row.root_pid < 1) throw unavailable()
  const lineage = [self]
  while (lineage.at(-1).pid !== row.root_pid) {
    const previous = lineage.at(-1), parent = native.inspectProcess(previous.parent)
    if (lineage.length >= 16 || !parent || parent.owner !== self.owner || lineage.some(item => item.pid === parent.pid)) throw unavailable()
    lineage.push(parent)
  }
  const parent = native.inspectProcess(lineage.at(-1).parent)
  if (!parent || parent.owner !== self.owner || lineage.some(item => item.pid === parent.pid)) throw unavailable()
  const verify = () => {
    if (sha256CanonicalJson(options.runtimeIdentity()) !== sha256CanonicalJson(runtime) || sha256CanonicalJson(read()) !== rowHash
      || !native.sameProcess(parent, native.inspectProcess(parent.pid))
      || lineage.some(item => !native.sameProcess(item, native.inspectProcess(item.pid)))) throw unavailable()
  }
  verify()
  return { parent, runtime, verify }
}

/** Called only after the existing Admin human verifier; this grants no business action. */
export async function verifyWorkspaceRecoveryAdmin(options: Options, params: VerifyWorkspaceRelocationRecoveryRequestParams, bearer: string): Promise<VerifyWorkspaceRelocationRecoveryRequestResult> {
  let scope: ReturnType<typeof readWorkspaceRecoveryAdmissionScope>
  try { scope = readWorkspaceRecoveryAdmissionScope(options.dataDir, params) }
  catch (error) { if ((error as { code?: string }).code === 'INVALID_PARAMS') throw new RpcError('INVALID_PARAMS', 'Invalid recovery admission parameters'); throw unavailable() }
  try {
    const actor = observeCurrentWorkspaceAdmin(options)
    const expected = { verified: true as const, ...scope.request, instance_id: actor.runtime.instance_id!, admin_runtime_id: actor.runtime.runtime_id!, mm_sha256: sha256CanonicalJson(actor.parent) }
    if (expected.instance_id !== scope.state.health.root_proof.instance_id) throw unavailable()
    const verify = () => {
      actor.verify()
      if (readWorkspaceRecoveryAdmissionScope(options.dataDir, scope.request).fingerprint !== scope.fingerprint) throw unavailable()
    }
    verify()
    const rpc = await openPinnedProcessRpc(actor.parent, options.moduleManagerPort, { source: 'admin-web', timeoutMs: 5000 })
    try {
      verify()
      const result = await rpc.call('verify_workspace_relocation_recovery_admission', scope.request, { authorizationBearer: bearer })
      verify()
      if (sha256CanonicalJson(result) !== sha256CanonicalJson(expected)) throw unavailable()
      return Object.freeze(expected)
    } finally { rpc.close() }
  } catch { throw unavailable() }
}
