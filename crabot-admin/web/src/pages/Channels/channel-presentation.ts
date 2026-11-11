export const isExperimentalChannel = (id: string) => id === 'channel-wechat' || id === 'channel-voice'

export function collaborationDescription(platform: string): string {
  switch (platform) {
    case 'feishu': return '在飞书的私聊和群聊中，与 CRABOT 交流、处理任务。'
    case 'slack': return '在工作区的私聊和频道中与 CRABOT 协作。'
    case 'telegram': return '在 Telegram 的私聊和群聊中随时与 CRABOT 沟通。'
    case 'dingtalk': return '在钉钉的日常沟通中与 CRABOT 交流、处理事务。'
    case 'wechat': return '通过连接服务，在微信中与 CRABOT 协作。'
    case 'voice': return '通过手机，用语音与 CRABOT 交流。'
    default: return '连接此平台，与 CRABOT 交流、处理任务。'
  }
}
