import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  DialogObjectApplication,
  DialogObjectFriend,
  DialogObjectGroupEntry,
  DialogObjectPrivatePoolEntry,
} from '../../../types'
import { ApplicationQueueModal } from './ApplicationQueueModal'
import { DomainNav } from './DomainNav'
import { FriendWorkbench } from './FriendWorkbench'
import { GroupWorkbench } from './GroupWorkbench'
import { ObjectList } from './ObjectList'
import { PrivatePoolWorkbench } from './PrivatePoolWorkbench'

vi.mock('../../../components/Common/Card', () => ({
  Card: ({ children, title }: { children: React.ReactNode; title?: string }) => (
    <div className="card">
      {title ? <h3>{title}</h3> : null}
      {children}
    </div>
  ),
}))

vi.mock('../../../components/Common/Button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    variant,
  }: {
    children: React.ReactNode
    onClick?: () => void
    disabled?: boolean
    variant?: string
  }) => (
    <button type="button" data-variant={variant} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}))

vi.mock('../../../components/Common/Input', () => ({
  Input: ({
    label,
    value,
    onChange,
    ...rest
  }: {
    label: string
    value?: string
    onChange?: React.ChangeEventHandler<HTMLInputElement>
  }) => (
    <label>
      <span>{label}</span>
      <input aria-label={label} value={value ?? ''} onChange={onChange} {...rest} />
    </label>
  ),
}))

describe('DialogObjects components', () => {
  it('renders domain navigation and reports selection changes', () => {
    const onChange = vi.fn()
    render(<DomainNav activeDomain="friends" onChange={onChange} />)

    fireEvent.click(screen.getByRole('button', { name: '私聊池' }))

    expect(onChange).toHaveBeenCalledWith('privatePool')
  })

  it('renders domain-specific rows and handles item selection', () => {
    const onSelect = vi.fn()
    const item: DialogObjectPrivatePoolEntry = {
      id: 'private-1',
      channel_id: 'wechat-main',
      type: 'private',
      platform_session_id: 'wxid-1',
      title: 'Pool User',
      participants: [{ platform_user_id: 'wxid-1', role: 'member' }],
      has_session_config: false,
      matching_pending_application_ids: [],
      created_at: '2026-04-19T00:00:00.000Z',
      updated_at: '2026-04-19T00:00:00.000Z',
    }

    render(
      <ObjectList
        domain="privatePool"
        items={[item]}
        selectedId={null}
        onSelect={onSelect}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Pool User' }))

    expect(onSelect).toHaveBeenCalledWith('private-1')
  })

  it('renders friend, private-pool, group and queue workbenches with their key actions', () => {
    const friend: DialogObjectFriend = {
      id: 'friend-1',
      display_name: 'Alice',
      permission: 'normal',
      permission_template_id: 'standard',
      identities: [
        {
          channel_id: 'wechat-main',
          platform_user_id: 'alice-wx',
          platform_display_name: 'Alice WX',
        },
      ],
      status: 'active',
      created_at: '2026-04-19T00:00:00.000Z',
      updated_at: '2026-04-19T00:00:00.000Z',
    }
    const privatePool: DialogObjectPrivatePoolEntry = {
      id: 'private-1',
      channel_id: 'wechat-main',
      type: 'private',
      platform_session_id: 'wxid-1',
      title: 'Pool User',
      participants: [{ platform_user_id: 'wxid-1', role: 'member' }],
      has_session_config: false,
      matching_pending_application_ids: ['app-1'],
      created_at: '2026-04-19T00:00:00.000Z',
      updated_at: '2026-04-19T00:00:00.000Z',
    }
    const group: DialogObjectGroupEntry = {
      id: 'group-1',
      channel_id: 'wechat-main',
      type: 'group',
      platform_session_id: 'group-platform-1',
      title: 'Master Group',
      participants: [{ platform_user_id: 'master', role: 'owner' }],
      participant_count: 1,
      has_session_config: true,
      master_in_group: true,
      created_at: '2026-04-19T00:00:00.000Z',
      updated_at: '2026-04-19T00:00:00.000Z',
    }
    const application: DialogObjectApplication = {
      id: 'app-1',
      intent: 'apply',
      channel_id: 'wechat-main',
      platform_user_id: 'wxid-1',
      platform_display_name: 'Pool User',
      content_preview: '/apply',
      source_session_id: 'private-1',
      received_at: '2026-04-19T00:00:00.000Z',
      expires_at: '2026-04-20T00:00:00.000Z',
    }

    const { rerender } = render(
      <FriendWorkbench
        friend={friend}
        editName="Alice"
        editPerm="normal"
        editTemplateId="standard"
        permissionTemplates={[]}
        savingFriend={false}
        confirmUnlinkKey={null}
        unlinkingIdentity={false}
        onEditNameChange={() => {}}
        onEditPermChange={() => {}}
        onEditTemplateChange={() => {}}
        onSave={() => {}}
        onOpenBindDrawer={() => {}}
        onRequestUnlink={() => {}}
        onCancelUnlink={() => {}}
        onConfirmUnlink={() => {}}
      />
    )
    expect(screen.getByRole('link', { name: '打开私聊场景画像' })).toHaveAttribute('href', '/memory/scenes/friend%3Afriend-1')

    rerender(
      <PrivatePoolWorkbench
        entry={privatePool}
        onAssignToFriend={() => {}}
        onCreateFriend={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: '归到已有好友' })).toBeInTheDocument()

    rerender(
      <GroupWorkbench
        group={group}
        onEditPermission={() => {}}
      />
    )
    expect(screen.getByRole('button', { name: '编辑群权限' })).toBeInTheDocument()

    rerender(
      <ApplicationQueueModal
        applications={[application]}
        selectedApplicationId="app-1"
        masterFriendCount={0}
        actionLoading={false}
        onSelectApplication={() => {}}
        onAssignExistingFriend={() => {}}
        onCreateFriend={() => {}}
        onLinkMaster={() => {}}
        onReject={() => {}}
      />
    )
    expect(screen.getByText('普通申请')).toBeInTheDocument()
  })
})
