// Private update intent only; it cannot authorize code, selection or service startup.
import { constants, promises as fs, type BigIntStats } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { DesktopReleaseSelectionSchema } from 'crabot-client/contracts'
import type { PreparedInstallation } from './installation-entries.js'
const require = createRequire(import.meta.url)
const installation = require('./bootstrap/scripts/lib/desktop-installation.cjs')
const management = require('./bootstrap/scripts/lib/desktop-management.cjs')
const native = require('./bootstrap/scripts/lib/process-identity.cjs')
type Pair = PreparedInstallation['selection']
export type LoginStartupIntent = 'off' | 'on' | 'approval_required'
export type LoginStartupUpdateContext = { installRoot: string; installation_id: string; maintenance_id: string; source: Pair; target: Pair }
type Record = { schema_version: 1; installation_id: string; maintenance_id: string; source: Pair; target: Pair;
  intent: LoginStartupIntent; phase: 'pending' | 'consumed' }
const uuid = (value: string) => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
function fail(): never { throw Object.assign(new Error('登录启动恢复记录无法核验，原记录和系统设置已保留。'), { code: 'CRABOT_LOGIN_STARTUP_UPDATE' }) }
const sameFile = (a: BigIntStats, b: BigIntStats) => (['dev', 'ino', 'mode', 'uid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'] as const).every(key => a[key] === b[key])

export class LoginStartupUpdateStore {
  private readonly context: LoginStartupUpdateContext
  private readonly file: string
  private readonly proofs = new WeakMap<Record, { text: string; stat: BigIntStats }>()
  constructor(context: LoginStartupUpdateContext, private readonly assertCurrent: () => void) {
    try {
      if (typeof assertCurrent !== 'function' || !path.isAbsolute(context.installRoot) || !uuid(context.installation_id) || !uuid(context.maintenance_id)) fail()
      this.context = { installRoot: context.installRoot, installation_id: context.installation_id, maintenance_id: context.maintenance_id,
        source: DesktopReleaseSelectionSchema.parse(context.source), target: DesktopReleaseSelectionSchema.parse(context.target) }
      if (same(this.context.source, this.context.target)) fail()
      this.file = path.join(this.context.installRoot, 'app/updates', this.context.maintenance_id, 'login-startup.json')
    } catch { fail() }
  }
  private guard(role: 'source' | 'target') {
    const result = this.assertCurrent()
    if (result !== undefined) { void Promise.resolve(result).catch(() => {}); fail() }
    const current = installation.readDesktopSelection(this.context.installRoot)
    if (current.root !== this.context.installRoot || current.record.installation_id !== this.context.installation_id
      || !same(current.selection, this.context[role])) fail()
  }
  private parse(text: string): Record {
    try {
      const value = JSON.parse(text)
      const record: Record = { schema_version: 1, installation_id: value.installation_id, maintenance_id: value.maintenance_id,
        source: DesktopReleaseSelectionSchema.parse(value.source), target: DesktopReleaseSelectionSchema.parse(value.target), intent: value.intent, phase: value.phase }
      if (value.schema_version !== 1 || record.installation_id !== this.context.installation_id || record.maintenance_id !== this.context.maintenance_id
        || !same(record.source, this.context.source) || !same(record.target, this.context.target)
        || !['off', 'on', 'approval_required'].includes(record.intent) || !['pending', 'consumed'].includes(record.phase)
        || JSON.stringify(record) + '\n' !== text) fail()
      Object.freeze(record.source); Object.freeze(record.target)
      return Object.freeze(record)
    } catch { fail() }
  }
  private async snapshot(): Promise<{ text: string; stat: BigIntStats } | null> {
    let handle
    try {
      const stat = await fs.lstat(this.file, { bigint: true })
      management.requirePrivateDataRoot(path.dirname(this.file)); management.requirePrivateDataRoot(path.dirname(path.dirname(this.file)))
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.size > 4096n
        || (process.platform === 'win32' ? !native.isPrivateFile(this.file) : stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o777n) !== 0o600n)) fail()
      handle = await fs.open(this.file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      if (!sameFile(stat, await handle.stat({ bigint: true }))) fail()
      const text = await handle.readFile('utf8')
      if (Buffer.byteLength(text) > 4096 || !sameFile(stat, await handle.stat({ bigint: true })) || !sameFile(stat, await fs.lstat(this.file, { bigint: true }))) fail()
      return { text, stat }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
    finally { await handle?.close() }
  }
  private async sync(directory: string) {
    if (process.platform === 'win32') return
    const handle = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
  }
  private async publish(text: string, previous?: { text: string; stat: BigIntStats }) {
    const directory = path.dirname(this.file), temporary = path.join(directory, '.login-startup-' + randomUUID())
    try {
      if (process.platform === 'win32') native.writePrivateFile(temporary, text)
      else await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o600, flush: true })
      this.guard(previous ? 'target' : 'source')
      if (previous) {
        const current = await this.snapshot()
        if (!current || current.text !== previous.text || !sameFile(current.stat, previous.stat)) fail()
        this.guard('target'); await fs.rename(temporary, this.file)
      } else await fs.link(temporary, this.file)
      await this.sync(directory)
    } finally { await fs.rm(temporary, { force: true }); await this.sync(directory) }
  }
  async capture(intent: LoginStartupIntent): Promise<void> {
    this.guard('source')
    if (!['off', 'on', 'approval_required'].includes(intent)) fail()
    const record: Record = { schema_version: 1, installation_id: this.context.installation_id, maintenance_id: this.context.maintenance_id,
      source: this.context.source, target: this.context.target, intent, phase: 'pending' }
    const text = JSON.stringify(record) + '\n', existing = await this.snapshot()
    if (existing) { if (existing.text !== text) fail(); this.guard('source'); return }
    for (const directory of [path.dirname(path.dirname(this.file)), path.dirname(this.file)]) management.ensurePrivateDataRoot(directory)
    await this.publish(text)
    await this.sync(path.dirname(path.dirname(this.file)))
    await this.sync(path.dirname(path.dirname(path.dirname(this.file))))
    this.guard('source')
    if ((await this.snapshot())?.text !== text) fail()
  }
  async read(): Promise<Record | null> {
    this.guard('target')
    const stored = await this.snapshot()
    this.guard('target')
    if (!stored) return null
    const record = this.parse(stored.text)
    this.proofs.set(record, stored)
    return record
  }
  async consume(record: Record): Promise<void> {
    this.guard('target')
    const proof = this.proofs.get(record)
    if (!proof) fail()
    if (record.phase === 'consumed') return
    const text = JSON.stringify({ ...record, phase: 'consumed' }) + '\n'
    await this.publish(text, proof)
    this.proofs.delete(record)
    this.guard('target')
    if ((await this.snapshot())?.text !== text) fail()
  }
}
