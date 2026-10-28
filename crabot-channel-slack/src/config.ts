import fs from 'node:fs'
import path from 'node:path'
import { RpcError } from 'crabot-shared'
import type { SlackConfig } from './types.js'

const fields: Record<string, string[]> = {
  SLACK_BOT_TOKEN: ['credentials', 'bot_token'], SLACK_APP_TOKEN: ['credentials', 'app_token'],
  SLACK_ONLY_RESPOND_TO_MENTIONS: ['group', 'only_respond_to_mentions'],
  SLACK_CACHE_MAX_DAYS: ['cache', 'max_days'], SLACK_CACHE_MAX_MESSAGES: ['cache', 'max_messages_per_session'],
}
export class ConfigStore {
  value: SlackConfig
  private bootstrap: Record<string, string>
  private readonly file: string
  constructor(dir: string, env: Record<string, string | undefined>) {
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'config.json')
    this.bootstrap = Object.fromEntries(Object.keys(fields).map(k => [k, env[k] ?? '']))
    let value: SlackConfig = { platform: 'slack', credentials: { bot_token: '', app_token: '' },
      group: { only_respond_to_mentions: true }, cache: { max_days: 30, max_messages_per_session: 1000 }, crab_platform_user_id: '' }
    const saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : undefined
    if (saved) value = this.validate(value, saved.config)
    // Admin's stopped-instance form is a bootstrap override. Unchanged env must not undo runtime saves.
    for (const [key, keys] of Object.entries(fields)) {
      const raw = this.bootstrap[key]
      if (raw === '' || (saved && raw === saved.bootstrap?.[key])) continue
      value = this.validate(value, { [keys[0]]: { [keys[1]]: raw } })
    }
    if (!value.credentials.bot_token.startsWith('xoxb-') || !value.credentials.app_token.startsWith('xapp-')) throw new RpcError('INVALID_PARAMS', 'Slack Bot Token 和 App Token 必填且类型须正确')
    this.value = value
    this.save(value)
  }
  private validate(current: SlackConfig, patch: unknown): SlackConfig {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new RpcError('INVALID_PARAMS', '配置必须为对象')
    const p = patch as Record<string, unknown>, next = structuredClone(current)
    for (const key of Object.keys(p)) if (!['platform', 'credentials', 'cache', 'group', 'crab_platform_user_id'].includes(key)) throw new RpcError('INVALID_PARAMS', '未知配置字段')
    if (p.platform !== undefined && p.platform !== 'slack') throw new RpcError('INVALID_PARAMS', 'platform 不可更改')
    if (p.crab_platform_user_id !== undefined && p.crab_platform_user_id !== current.crab_platform_user_id && p.crab_platform_user_id !== '') throw new RpcError('INVALID_PARAMS', '机器人身份由 Slack 核验，不可手填')
    for (const section of ['credentials', 'cache', 'group'] as const) {
      if (p[section] === undefined) continue
      const part = p[section]
      if (!part || typeof part !== 'object' || Array.isArray(part)) throw new RpcError('INVALID_PARAMS', '配置分组必须为对象')
      for (const [key, raw] of Object.entries(part)) {
        if (!Object.hasOwn(next[section], key)) throw new RpcError('INVALID_PARAMS', '未知配置字段')
        if (section === 'credentials') {
          if (raw === '***') continue
          const prefix = key === 'bot_token' ? 'xoxb-' : 'xapp-'
          if (typeof raw !== 'string' || !raw.startsWith(prefix)) throw new RpcError('INVALID_PARAMS', 'Slack Token 类型错误')
          next.credentials[key as 'bot_token' | 'app_token'] = raw
        } else if (section === 'group') {
          if (![true, false, 'true', 'false'].includes(raw as boolean)) throw new RpcError('INVALID_PARAMS', 'only_respond_to_mentions 必须为布尔值')
          next.group.only_respond_to_mentions = raw === true || raw === 'true'
        } else {
          const n = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : raw
          if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new RpcError('INVALID_PARAMS', '缓存参数必须为正整数')
          next.cache[key as 'max_days' | 'max_messages_per_session'] = n
        }
      }
    }
    return next
  }
  update(patch: unknown) {
    const next = this.validate(this.value, patch)
    const requires_restart = JSON.stringify(next.credentials) !== JSON.stringify(this.value.credentials)
    this.save(next) // Persist before changing any live field.
    this.value = next
    return { config: this.public(), requires_restart }
  }
  private save(config: SlackConfig) {
    const tmp = this.file + '.tmp'
    try {
      fs.writeFileSync(tmp, JSON.stringify({ config, bootstrap: this.bootstrap }), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }
  public() {
    return { ...structuredClone(this.value), credentials: { bot_token: '***', app_token: '***' } }
  }
}
