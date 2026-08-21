import React from 'react'
import { Tooltip } from '../../../../components/Common/Tooltip'

export interface TrashRowActionsProps {
  trashedAt: string
  retentionDays?: number
  now?: () => Date
  onRestore: () => void | Promise<void>
}

const DEFAULT_RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

function isExpired(trashedAt: string, retentionDays: number, now: Date): boolean {
  const trashed = new Date(trashedAt).getTime()
  if (Number.isNaN(trashed)) return true
  const ageMs = now.getTime() - trashed
  return ageMs >= retentionDays * DAY_MS
}

export const TrashRowActions: React.FC<TrashRowActionsProps> = ({
  trashedAt, retentionDays = DEFAULT_RETENTION_DAYS, now, onRestore,
}) => {
  const expired = isExpired(trashedAt, retentionDays, now ? now() : new Date())
  const tooltip = expired
    ? `已过 ${retentionDays} 天保留期，无法恢复（spec §6.5）`
    : `恢复并确认`

  return (
    <Tooltip content={tooltip}>
    <button
      type="button"
      data-role="trash-restore"
      data-expired={expired ? 'true' : 'false'}
      disabled={expired}
      onClick={() => { if (!expired) void onRestore() }}
      className={'mem-trash-restore' + (expired ? ' mem-trash-restore--expired' : '')}
    >
      Restore
    </button>
    </Tooltip>
  )
}
