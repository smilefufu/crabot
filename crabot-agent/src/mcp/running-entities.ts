export interface RunningWaitTarget {
  readonly id: string
  readonly kind: 'subagent' | 'bg_entity'
  readonly runtime_ms: number
  readonly description: string
}

export function formatStillRunningSnapshot(items: ReadonlyArray<RunningWaitTarget>): string {
  if (items.length === 0) return ''
  return `仍在运行：${items.map((item) => `${item.id}（${item.description.slice(0, 80)}）`).join('、')}。`
}
