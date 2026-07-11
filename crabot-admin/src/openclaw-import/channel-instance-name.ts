/**
 * OpenClaw 账号 → crabot 渠道实例名的唯一派生入口。
 *
 * 预览（analyze-channels）与执行（import-channels）必须用同一派生 + 校验，
 * 否则会出现“预览标可迁移、执行却因实例名非法跳过”的不一致。
 */
import { validateInstanceId } from 'crabot-shared'

export function channelInstanceName(source_channel: string, account_id: string): string {
  return `${source_channel}-${account_id}`
}

/** 派生名是否是合法的渠道实例 id（走与 createInstance 相同的白名单校验）。 */
export function isValidChannelInstanceName(source_channel: string, account_id: string): boolean {
  return validateInstanceId(channelInstanceName(source_channel, account_id)).ok
}
