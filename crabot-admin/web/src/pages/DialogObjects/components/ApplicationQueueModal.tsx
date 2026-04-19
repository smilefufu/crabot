import React, { useMemo } from 'react'
import { Button } from '../../../components/Common/Button'
import { Card } from '../../../components/Common/Card'
import type { DialogObjectApplication } from '../../../types'

interface ApplicationQueueModalProps {
  applications: DialogObjectApplication[]
  selectedApplicationId: string | null
  masterFriendCount: number
  actionLoading: boolean
  onSelectApplication: (id: string) => void
  onAssignExistingFriend: (application: DialogObjectApplication) => void
  onCreateFriend: (application: DialogObjectApplication) => void
  onLinkMaster: (application: DialogObjectApplication) => void
  onReject: (application: DialogObjectApplication) => void
}

export const ApplicationQueueModal: React.FC<ApplicationQueueModalProps> = ({
  applications,
  selectedApplicationId,
  masterFriendCount,
  actionLoading,
  onSelectApplication,
  onAssignExistingFriend,
  onCreateFriend,
  onLinkMaster,
  onReject,
}) => {
  const groupedApplications = useMemo(() => ({
    pair: applications.filter((item) => item.intent === 'pair'),
    apply: applications.filter((item) => item.intent === 'apply'),
  }), [applications])

  const selectedApplication = applications.find((item) => item.id === selectedApplicationId) ?? applications[0] ?? null

  return (
    <div style={{ display: 'grid', gap: '1rem' }}>
      <div>
        <h2 style={{ margin: 0 }}>申请队列</h2>
        <p style={{ color: 'var(--text-secondary)', marginTop: '0.5rem' }}>
          这里集中查看 `/认主` 和 `/apply` 事件，并直接按当前对话对象模型完成归属处理。
        </p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: '1rem' }}>
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {([
            ['认主申请', groupedApplications.pair],
            ['普通申请', groupedApplications.apply],
          ] as const).map(([title, items]) => (
            <Card key={title} title={title}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {items.length === 0 ? (
                  <div style={{ color: 'var(--text-secondary)', fontSize: '0.8125rem' }}>暂无</div>
                ) : (
                  items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => onSelectApplication(item.id)}
                      style={{
                        width: '100%',
                        textAlign: 'left',
                        border: item.id === selectedApplication?.id ? '1px solid var(--primary)' : '1px solid var(--border)',
                        background: item.id === selectedApplication?.id ? 'rgba(59, 130, 246, 0.06)' : 'var(--bg-primary)',
                        borderRadius: '10px',
                        padding: '0.625rem 0.75rem',
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{item.platform_display_name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{item.channel_id}</div>
                    </button>
                  ))
                )}
              </div>
            </Card>
          ))}
        </div>

        <Card title="申请详情">
          {selectedApplication ? (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              <div><strong>{selectedApplication.platform_display_name}</strong></div>
              <div>类型：{selectedApplication.intent === 'pair' ? '认主申请' : '普通申请'}</div>
              <div>来源渠道：{selectedApplication.channel_id}</div>
              <div>来源私聊：{selectedApplication.source_session_id}</div>
              <div>内容预览：{selectedApplication.content_preview}</div>
              {selectedApplication.intent === 'pair' ? (
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  <div style={{ color: 'var(--text-secondary)' }}>
                    {masterFriendCount > 0
                      ? `当前已有 ${masterFriendCount} 个 Master，可直接并入现有 Master。`
                      : '当前没有 Master，可直接创建新的 Master。'}
                  </div>
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <Button
                      variant="primary"
                      onClick={() => onLinkMaster(selectedApplication)}
                      disabled={actionLoading}
                    >
                      {masterFriendCount > 0 ? '并入现有 Master' : '新建 Master'}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => onReject(selectedApplication)}
                      disabled={actionLoading}
                    >
                      拒绝申请
                    </Button>
                  </div>
                </div>
              ) : (
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  <div style={{ color: 'var(--text-secondary)' }}>
                    普通申请可以归到已有好友，或按当前申请直接新建好友。
                  </div>
                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                    <Button
                      variant="secondary"
                      onClick={() => onAssignExistingFriend(selectedApplication)}
                    >
                      归到已有好友
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => onCreateFriend(selectedApplication)}
                    >
                      新建好友
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => onReject(selectedApplication)}
                      disabled={actionLoading}
                    >
                      拒绝申请
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div style={{ color: 'var(--text-secondary)' }}>暂无申请</div>
          )}
        </Card>
      </div>
    </div>
  )
}
