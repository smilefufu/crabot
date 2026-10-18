import React, { useState } from 'react'
import { Button } from '../../../components/Common/Button'
import { Card } from '../../../components/Common/Card'
import { useToast } from '../../../contexts/ToastContext'
import { dialogObjectsService } from '../../../services/dialog-objects'
import { buildMemoryEntriesHref } from '../../Memory/memoryContextQuery'
import type { DialogObjectGroupEntry } from '../../../types'

const workbenchLinkStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '0.625rem 0.875rem',
  borderRadius: '10px',
  border: '1px solid var(--border)',
  background: 'var(--bg-secondary)',
  color: 'var(--text-primary)',
  textDecoration: 'none',
  fontSize: '0.875rem',
  fontWeight: 500,
}

const buildSceneProfileHref = (sceneKey: string): string => `/memory/scenes/${encodeURIComponent(sceneKey)}`

interface GroupWorkbenchProps {
  group: DialogObjectGroupEntry | null
  onEditPermission: () => void
}

const BACKFILL_DEFAULT_MAX = 500
const BACKFILL_HARD_CAP = 500

export const GroupWorkbench: React.FC<GroupWorkbenchProps> = ({
  group,
  onEditPermission,
}) => {
  const toast = useToast()
  const [backfilling, setBackfilling] = useState(false)
  const [backfillMax, setBackfillMax] = useState<string>(String(BACKFILL_DEFAULT_MAX))

  if (!group) {
    return (
      <Card title="群聊详情">
        <div style={{ color: 'var(--text-secondary)' }}>请选择一个对象</div>
      </Card>
    )
  }

  const groupSceneHref = buildSceneProfileHref(`group:${group.channel_id}:${group.id}`)
  const groupMemoryHref = buildMemoryEntriesHref({
    accessibleScopes: [group.id],
    contextLabel: group.title,
  })

  const handleBackfillHistory = async () => {
    if (backfilling) return
    const parsed = Number.parseInt(backfillMax, 10)
    if (!Number.isFinite(parsed) || parsed < 1) {
      toast.error('请输入大于 0 的回填条数')
      return
    }
    const maxCount = Math.min(parsed, BACKFILL_HARD_CAP)
    setBackfilling(true)
    try {
      const result = await dialogObjectsService.backfillGroupHistory(group.id, {
        channel_id: group.channel_id,
        max_count: maxCount,
      })
      const parts = [`已回填 ${result.backfilled_count} 条`]
      if (result.skipped_count > 0) parts.push(`跳过 ${result.skipped_count} 条（已存在）`)
      if (result.backfilled_count === 0) {
        if (result.skipped_count === 0) {
          toast.info('飞书未返回任何消息，可能：(1) 群里没有更早的消息了；(2) bot 不在群里；(3) 应用缺少 im:message.group_msg 权限。请查 channel 日志确认')
        } else {
          toast.info(`${parts.join('，')}；本地已是最新（再点也拿不到新数据了）`)
        }
      } else {
        parts.push('再次点击继续往更早回溯')
        toast.success(parts.join('，'))
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(`回填历史失败：${message}`)
    } finally {
      setBackfilling(false)
    }
  }

  return (
    <Card title="群聊详情">
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        <div><strong>{group.title}</strong></div>
        <div>来源渠道：{group.channel_id}</div>
        <div>群成员数量：{group.participant_count}</div>
        <p>群权限是所有成员（含陌生人）的公共授权。已核验好友的本人请求还可使用其个人授权；不会提升共享主控或其他人的权限。</p>
        <div>master_in_group：{group.master_in_group ? '是' : '否'}</div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={onEditPermission}>
            编辑群权限
          </Button>
          {group.supports_backfill ? (
            <div style={{ display: 'flex', gap: '0.4rem', alignItems: 'center' }}>
              <Button variant="secondary" onClick={handleBackfillHistory} disabled={backfilling}>
                {backfilling ? '正在回填历史…' : '回填历史消息'}
              </Button>
              <label style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
                最多
                <input
                  type="number"
                  min={1}
                  max={BACKFILL_HARD_CAP}
                  value={backfillMax}
                  onChange={(e) => setBackfillMax(e.target.value)}
                  disabled={backfilling}
                  style={{
                    width: '5.5rem',
                    margin: '0 0.4rem',
                    padding: '0.25rem 0.4rem',
                    border: '1px solid var(--border)',
                    borderRadius: '6px',
                    background: 'var(--bg-secondary)',
                    color: 'var(--text-primary)',
                  }}
                />
                条（上限 {BACKFILL_HARD_CAP}）
              </label>
            </div>
          ) : null}
        </div>
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          <strong>群场景与记忆</strong>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <a
              href={groupSceneHref}
              aria-label="打开群聊场景画像"
              style={workbenchLinkStyle}
            >
              打开群聊场景画像
            </a>
            <a
              href={groupMemoryHref}
              aria-label="查看群聊记忆"
              style={workbenchLinkStyle}
            >
              查看群聊记忆
            </a>
          </div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>
            当前群聊记忆入口默认按 session scope 过滤，和 `master_in_group` 可处理规则保持一致。
          </div>
        </div>
        <div style={{ color: 'var(--text-secondary)' }}>
          当前列表已和运行时 `master_in_group` 规则保持一致。
        </div>
      </div>
    </Card>
  )
}
