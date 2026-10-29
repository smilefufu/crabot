import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Onboarder, OnboarderBeginResult, OnboarderFinishResult, FriendId, ModuleId } from 'crabot-shared'
import type { ChannelManager } from './channel-manager.js'
import { buildOnboardFinishResponse } from './onboard-finish-response.js'
interface OnboardingMaster { friend_id: FriendId; display_name: string }
type EnsureMaster = (channelId: ModuleId, identity: NonNullable<OnboarderFinishResult['authorized_identity']>) => Promise<OnboardingMaster | undefined>
interface Receipt {
  owner: string
  name: string
  config_hash: string
  authorized_identity?: OnboarderFinishResult['authorized_identity']
  master?: OnboardingMaster
  completed?: boolean
  cleanup_confirmed?: boolean
}
export class SlackOnboardingHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
export const isSlackLocalOnboarding = (implementation?: string | null, method?: string | null) => implementation === 'channel-slack' && method === 'local-cli'
const hash = (env: Record<string, string>) => createHash('sha256').update(JSON.stringify([env.SLACK_BOT_TOKEN, env.SLACK_APP_TOKEN])).digest('hex')
export class SlackOnboardingSessions {
  private owners = new Map<string, string>()
  private finishes = new Map<string, { name: string; result: Promise<unknown> }>()
  constructor(private readonly dataDir: string, private readonly ensureMaster: EnsureMaster) {}
  private file(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new SlackOnboardingHttpError(404, 'session_not_found', '授权会话不存在')
    return path.join(this.dataDir, 'slack-onboarding-receipts', `${id}.json`)
  }
  private requireHuman(owner: string | undefined): string {
    if (!owner) throw new SlackOnboardingHttpError(403, 'forbidden', '此操作需要已登录的人类 Admin')
    return owner
  }
  async begin(owner: string | undefined, onboarder: Onboarder, params?: Record<string, unknown>, channels?: ChannelManager): Promise<OnboarderBeginResult> {
    const human = this.requireHuman(owner)
    if (channels && typeof params?.instance_name === 'string' && this.nameExists(channels, params.instance_name)) throw new SlackOnboardingHttpError(409, 'session_completed', '实例名已存在，请更换名称')
    const result = await onboarder.begin(params)
    this.owners.set(result.session_id, human)
    return result
  }
  private async receipt(id: string): Promise<Receipt | undefined> {
    try { return JSON.parse(await fs.readFile(this.file(id), 'utf8')) as Receipt }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  async assertOwner(owner: string | undefined, id: string): Promise<void> {
    const human = this.requireHuman(owner)
    const expected = this.owners.get(id) ?? (await this.receipt(id))?.owner
    if (!expected) throw new SlackOnboardingHttpError(404, 'session_not_found', '授权会话不存在或已过期')
    if (expected !== human) throw new SlackOnboardingHttpError(403, 'forbidden', '不能访问其它 Admin 的授权会话')
  }
  async cancel(owner: string | undefined, id: string, onboarder: Onboarder): Promise<void> {
    await this.assertOwner(owner, id)
    try { await this.finishes.get(id)?.result } catch { /* failed creation remains cancellable */ }
    if (!(await this.receipt(id))?.completed) onboarder.cancel(id)
  }
  private async save(id: string, value: Receipt): Promise<void> {
    const file = this.file(id)
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${randomUUID()}.tmp`
    await fs.writeFile(tmp, JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    await fs.rename(tmp, file)
  }
  async finish(owner: string | undefined, id: string, name: string, onboarder: Onboarder, channels: ChannelManager): Promise<unknown> {
    await this.assertOwner(owner, id)
    const existing = this.finishes.get(id)
    if (existing) {
      if (existing.name !== name) throw new SlackOnboardingHttpError(409, 'session_completed', '此授权正在用于另一个实例名')
      return existing.result
    }
    const pending = this.complete(owner!, id, name, onboarder, channels)
    this.finishes.set(id, { name, result: pending })
    try { return await pending } finally { this.finishes.delete(id) }
  }
  private nameExists(channels: ChannelManager, name: string): boolean {
    const key = name.normalize('NFC').toLowerCase()
    return channels.listInstances({ page_size: Number.MAX_SAFE_INTEGER }).items.some(item => item.id.normalize('NFC').toLowerCase() === key)
  }
  private async complete(owner: string, id: string, name: string, onboarder: Onboarder, channels: ChannelManager): Promise<unknown> {
    let receipt = await this.receipt(id)
    if (receipt && receipt.name !== name) throw new SlackOnboardingHttpError(409, 'session_completed', '此授权已用于另一个实例名')
    let result: OnboarderFinishResult | undefined
    let instance = receipt ? channels.getInstance(receipt.name) : undefined
    if (receipt?.completed && !instance) throw new SlackOnboardingHttpError(409, 'session_completed', '此前创建的实例已移除，请勿使用旧授权重建')
    if (receipt && instance) {
      const config = await channels.loadLocalConfig(instance.id)
      if (instance.implementation_id !== 'channel-slack' || !config || hash(config) !== receipt.config_hash) throw new SlackOnboardingHttpError(409, 'session_completed', '同名实例与授权记录不一致，请在渠道设置中核对')
    } else {
      result = await onboarder.finish(id)
      if (!receipt) {
        if (this.nameExists(channels, name)) throw new SlackOnboardingHttpError(409, 'session_completed', '实例名已存在，请更换名称')
        receipt = { owner, name, config_hash: hash(result.env), authorized_identity: result.authorized_identity }
        await this.save(id, receipt)
      }
      // The ordinary ChannelManager remains the only creator and conflict gate.
      instance = await channels.createInstance({ implementation_id: 'channel-slack', name, auto_start: true, env: result.env })
    }
    receipt!.completed = true
    await this.save(id, receipt!)
    // Internal acknowledgement: never forward browser finish_params to this method.
    try { if (!receipt!.cleanup_confirmed) await onboarder.finish(id, { created_instance_id: instance.id }) }
    catch { throw new SlackOnboardingHttpError(500, 'unknown', '实例已创建；本地授权材料清理未确认完成，请重试完成，勿重新授权') }
    receipt!.cleanup_confirmed = true
    await this.save(id, receipt!)
    // Store a successful claim in the existing receipt: replay must not undo later manual identity changes.
    if (!receipt!.master && receipt!.authorized_identity) {
      const master = await this.ensureMaster(instance.id, receipt!.authorized_identity).catch(error => {
        console.warn('[Admin] Slack onboarding auto-master failed:', error)
        return undefined
      })
      if (master) { receipt!.master = { friend_id: master.friend_id, display_name: master.display_name }; await this.save(id, receipt!) }
    }
    return buildOnboardFinishResponse({ finishResult: { env: {}, authorized_identity: receipt!.authorized_identity }, instance: instance as never, masterFriendId: receipt!.master?.friend_id, masterDisplayName: receipt!.master?.display_name, pushSent: false })
  }
}
