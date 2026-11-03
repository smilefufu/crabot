const logos: Record<string, string> = {
  openai: 'openai', 'chatgpt-subscription': 'openai', dashscope: 'bailian-color', 'dashscope-coding': 'bailian-color',
  'zhipu-coding': 'zhipu-color', 'kimi-coding': 'kimi-color', deepseek: 'deepseek-color',
  siliconflow: 'siliconcloud-color', openrouter: 'openrouter', ollama: 'ollama',
}

export function VendorLogo({ vendorId, name }: { vendorId?: string; name: string }) {
  const logo = vendorId && logos[vendorId]
  return logo ? <img className="vendor-logo" src={`/assets/vendors/${logo}.svg`} alt={`${name} Logo`} width="40" height="40" />
    : <span className="vendor-logo vendor-wordmark" role="img" aria-label={`${name} 标识`}>{vendorId?.startsWith('xinshu-') ? 'xinshu' : name.slice(0, 4)}</span>
}
