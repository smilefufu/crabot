export function formatModelContext(value: number): string {
  if (value >= 1000000) return `${Number((value / 1000000).toFixed(3))}M`
  if (value >= 1000) return `${Number((value / 1000).toFixed(3))}K`
  return String(value)
}

export function ModelCapabilities({ model }: { model: { supports_vision?: boolean; context_window?: number } }) {
  return <div className="model-capabilities" aria-label="模型能力">
    <span>{model.supports_vision === undefined ? '看图能力待确认' : model.supports_vision ? '文字 + 图片' : '文字'}</span>
    <span>{model.context_window ? `上下文 ${formatModelContext(model.context_window)}` : '上下文待确认'}</span>
  </div>
}
