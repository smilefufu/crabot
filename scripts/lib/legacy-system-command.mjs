// Root-owned command-link mechanics only. The conversion coordinator supplies
// the verified plan and all-backups intent; this is never conversion authority.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { validateSystemConversionPlan } from './system-conversion.mjs'
import { systemError } from './system-registry.mjs'
import { verifyRootDirectory } from './system-user.mjs'
import { cliLockToken } from './cli-lock.mjs'
import { verifyCoreRelease } from './core-release.mjs'
import cliLocation from './cli-location.cjs'
const fail = () => { throw systemError('共享命令入口或目标核心已改变，未覆盖；保留本次维护保护。', 'CRABOT_LEGACY_SYSTEM_COMMAND') }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')

// These filesystem-fixture seams are never accepted from CLI/env/UID permits.
export class LegacySystemCommandLink {
  constructor({ command = '/usr/local/bin/crabot', directory = '/etc/crabot/system', ownerUid = 0, checkRoot = verifyRootDirectory } = {}) {
    this.command = command; this.directory = directory; this.ownerUid = ownerUid; this.checkRoot = checkRoot
  }
  authority() {
    if (process.platform === 'win32' || process.getuid?.() !== this.ownerUid || this.ownerUid === 0 && process.platform !== 'linux') {
      throw systemError('共享命令入口仅Linux管理员可核验或交接。', 'CRABOT_SYSTEM_ADMIN_REQUIRED')
    }
  }
  async ownFile(file) {
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== this.ownerUid || stat.mode & 0o7022 || stat.nlink !== 1 || stat.size > 1024 * 1024) fail()
  }
  async target(plan) {
    const core = path.join(plan.install_root, 'releases', plan.target.id), command = path.join(plan.install_root, 'bin/crabot')
    await this.checkRoot(core); await this.checkRoot(path.dirname(command))
    for (const name of ['cli-installation.json', 'current-core']) await this.ownFile(path.join(plan.install_root, name))
    await this.ownFile(command)
    const install = cliLocation.assertSelectedCli(core), metadata = cliLocation.readCliMetadata(plan.install_root)
    if (!install || install.scope !== 'system' || install.id !== plan.target.id || install.root !== plan.install_root
      || hash(await fs.readFile(command)) !== metadata.launcher_sha256
      || (await verifyCoreRelease(core, { version: plan.target.version })).inventory_sha256 !== plan.target.id) fail()
    return command
  }
  async binding(plan) {
    this.authority(); validateSystemConversionPlan(plan)
    await this.checkRoot(path.dirname(this.command))
    const stat = await fs.lstat(this.command, { bigint: true })
    if (!stat.isSymbolicLink() || stat.uid !== BigInt(this.ownerUid) || stat.nlink !== 1n) fail()
    const raw = await fs.readlink(this.command), current = path.resolve(path.dirname(this.command), raw)
    const source = path.join(plan.source.installRoot, 'cli.mjs'), target = path.join(plan.install_root, 'bin/crabot')
    if (current === source) {
      await this.checkRoot(plan.source.installRoot); await this.ownFile(source)
      return { state: 'legacy', stat, raw }
    }
    if (current === target) { await this.target(plan); return { state: 'target', stat, raw } }
    fail()
  }
  async selected(plan) { return (await this.binding(plan)).state }
  async select(plan) {
    this.authority()
    if (!cliLockToken(path.join(this.directory, 'cli.lock'))) fail()
    const previous = await this.binding(plan)
    if (previous.state !== 'legacy') fail()
    const target = await this.target(plan), temporary = this.command + '.conversion-' + randomUUID()
    try {
      await fs.symlink(target, temporary)
      const current = await this.binding(plan)
      if (current.state !== 'legacy' || current.raw !== previous.raw || current.stat.dev !== previous.stat.dev || current.stat.ino !== previous.stat.ino || current.stat.ctimeNs !== previous.stat.ctimeNs) fail()
      await fs.rename(temporary, this.command)
      const parent = await fs.open(path.dirname(this.command), 'r')
      try { await parent.sync() } finally { await parent.close() }
      if (await this.selected(plan) !== 'target') fail()
      return { selected: true }
    } finally { await fs.rm(temporary, { force: true }) }
  }
}
