import React from 'react'
import { Button } from '../../../components/Common/Button'
import { Card } from '../../../components/Common/Card'
import type { DialogObjectPrivatePoolEntry } from '../../../types'

interface PrivatePoolWorkbenchProps {
  entry: DialogObjectPrivatePoolEntry | null
  onAssignToFriend: () => void
  onCreateFriend: () => void
}

export const PrivatePoolWorkbench: React.FC<PrivatePoolWorkbenchProps> = ({
  entry,
  onAssignToFriend,
  onCreateFriend,
}) => {
  if (!entry) {
    return (
      <Card title="私聊池详情">
        <div style={{ color: 'var(--text-secondary)' }}>请选择一个对象</div>
      </Card>
    )
  }

  return (
    <Card title="私聊池详情">
      <div style={{ display: 'grid', gap: '0.75rem' }}>
        <div><strong>{entry.title}</strong></div>
        <div>来源渠道：{entry.channel_id}</div>
        <div>Session ID：{entry.id}</div>
        <div>参与者：{entry.participants.map((participant) => participant.platform_user_id).join(', ')}</div>
        <div>关联申请：{entry.matching_pending_application_ids.length}</div>
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <Button variant="secondary" onClick={onAssignToFriend}>
            归到已有好友
          </Button>
          <Button variant="primary" onClick={onCreateFriend}>
            从私聊新建好友
          </Button>
        </div>
      </div>
    </Card>
  )
}
