/**
 * 渠道认主指令 + admin 自动发出的固定提示话术。
 *
 * 这些指令在 admin 的 handleChannelMessage 里被拦截，不会经过 channel.message_authorized
 * 进入 agent。提示话术由 admin 直接通过 channel send_message 回出，channel 会按正常 outbound
 * 写入 message store，所以 agent 拉 history 时需要把 inbound 命令本身和 outbound 提示话术一并
 * 过滤掉，否则 LLM 会照着 history 的格式鹦鹉学舌、误以为还要让用户去后台审批。
 */

export const CLAIM_PAIR_COMMANDS: ReadonlySet<string> = new Set(['/pair', '/认主'])
export const CLAIM_COMMANDS: ReadonlySet<string> = new Set(['/pair', '/认主', '/apply'])

/** 未认主 channel 收到陌生人私聊时回的引导话术 */
export const UNCLAIMED_HINT_TEXT =
  '渠道未认主，请输入"/认主"，然后到 crabot 后台 对话对象->申请队列 中进行审批创建 Master 后方可正常对话。'

/** 已认主 channel 上已知 friend 重复发命令时回的固定话术 */
export const ALREADY_CLAIMED_HINT_TEXT =
  '当前渠道已认主，无需重复发送 /认主、/pair、/apply。'

const SYSTEM_HINT_TEXTS: ReadonlySet<string> = new Set([
  UNCLAIMED_HINT_TEXT,
  ALREADY_CLAIMED_HINT_TEXT,
])

export function isClaimCommand(text: string | undefined | null): boolean {
  if (typeof text !== 'string') return false
  return CLAIM_COMMANDS.has(text.trim())
}

export function isClaimSystemHint(text: string | undefined | null): boolean {
  if (typeof text !== 'string') return false
  return SYSTEM_HINT_TEXTS.has(text)
}
