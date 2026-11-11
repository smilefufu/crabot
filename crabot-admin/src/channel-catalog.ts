/** Only official, release-pinned packages may be installed by Admin. */
export const CHANNEL_CATALOG = [
  { platform: 'feishu', name: '飞书 / Lark' },
  { platform: 'wechat', name: '微信' },
  { platform: 'telegram', name: 'Telegram' },
  { platform: 'dingtalk', name: '钉钉' },
  { platform: 'slack', name: 'Slack' },
  { platform: 'voice', name: '语音' },
].map(item => ({ ...item, implementation_id: `channel-${item.platform}`,
  package_name: `crabot-channel-${item.platform}`, version: item.platform === 'feishu' ? '0.1.1' : '0.1.3' }))
