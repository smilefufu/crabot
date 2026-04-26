import React from 'react'

export interface TrashRowActionsProps {
  ingestionTime: string
  retentionDays?: number
  now?: () => Date
  onRestore: () => void | Promise<void>
}

const DEFAULT_RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

function isExpired(ingestionTime: string, retentionDays: number, now: Date): boolean {
  const ingestion = new Date(ingestionTime).getTime()
  if (Number.isNaN(ingestion)) return true
  const ageMs = now.getTime() - ingestion
  return ageMs >= retentionDays * DAY_MS
}

export const TrashRowActions: React.FC<TrashRowActionsProps> = ({
  ingestionTime, retentionDays = DEFAULT_RETENTION_DAYS, now, onRestore,
}) => {
  const expired = isExpired(ingestionTime, retentionDays, now ? now() : new Date())
  const tooltip = expired
    ? `已过 ${retentionDays} 天保留期，无法恢复（spec §6.5）`
    : `恢复到 inbox`

  return (
    <button
      type="button"
      data-role="trash-restore"
      data-expired={expired ? 'true' : 'false'}
      title={tooltip}
      disabled={expired}
      onClick={() => { if (!expired) void onRestore() }}
      className={'mem-trash-restore' + (expired ? ' mem-trash-restore--expired' : '')}
    >
      Restore
    </button>
  )
}
