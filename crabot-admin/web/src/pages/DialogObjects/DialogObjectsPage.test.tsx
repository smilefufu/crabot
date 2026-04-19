import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DialogObjectsPage } from './index'

const listFriends = vi.fn()
const listPrivatePool = vi.fn()
const listGroups = vi.fn()
const listApplications = vi.fn()
const createFriendFromPrivatePool = vi.fn()
const assignPrivatePoolToFriend = vi.fn()
const assignApplicationFriend = vi.fn()
const createApplicationFriend = vi.fn()
const linkApplicationMaster = vi.fn()
const rejectApplication = vi.fn()
const listLegacyFriends = vi.fn()
const toastMock = {
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}

vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => toastMock,
}))

vi.mock('../../services/dialog-objects', () => ({
  dialogObjectsService: {
    listFriends: (...args: unknown[]) => listFriends(...args),
    listPrivatePool: (...args: unknown[]) => listPrivatePool(...args),
    listGroups: (...args: unknown[]) => listGroups(...args),
    listApplications: (...args: unknown[]) => listApplications(...args),
    createFriendFromPrivatePool: (...args: unknown[]) => createFriendFromPrivatePool(...args),
    assignPrivatePoolToFriend: (...args: unknown[]) => assignPrivatePoolToFriend(...args),
    assignApplicationFriend: (...args: unknown[]) => assignApplicationFriend(...args),
    createApplicationFriend: (...args: unknown[]) => createApplicationFriend(...args),
    linkApplicationMaster: (...args: unknown[]) => linkApplicationMaster(...args),
    rejectApplication: (...args: unknown[]) => rejectApplication(...args),
  },
}))

vi.mock('../../services/friend', () => ({
  friendService: {
    listFriends: (...args: unknown[]) => listLegacyFriends(...args),
  },
}))

describe('DialogObjectsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listFriends.mockResolvedValue({
      items: [
        {
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
        },
        {
          id: 'friend-master',
          display_name: 'Master Boss',
          permission: 'master',
          permission_template_id: 'master',
          identities: [],
          status: 'active',
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:00:00.000Z',
        },
      ],
    })
    listPrivatePool.mockResolvedValue({
      items: [
        {
          id: 'private-1',
          channel_id: 'wechat-main',
          type: 'private',
          platform_session_id: 'pool-user',
          title: 'Pool User',
          participants: [
            { platform_user_id: 'pool-user', role: 'member' },
          ],
          has_session_config: false,
          matching_pending_application_ids: ['app-1'],
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:00:00.000Z',
        },
      ],
    })
    listGroups.mockResolvedValue({
      items: [
        {
          id: 'group-1',
          channel_id: 'wechat-main',
          type: 'group',
          platform_session_id: 'group-platform-1',
          title: 'Master Group',
          participants: [
            { platform_user_id: 'master-user', role: 'owner' },
            { platform_user_id: 'group-user', role: 'member' },
          ],
          participant_count: 2,
          has_session_config: true,
          master_in_group: true,
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:00:00.000Z',
        },
      ],
    })
    listApplications.mockResolvedValue({
      items: [
        {
          id: 'app-1',
          intent: 'apply',
          channel_id: 'wechat-main',
          platform_user_id: 'pool-user',
          platform_display_name: 'Pool User',
          content_preview: '/apply',
          source_session_id: 'private-1',
          received_at: '2026-04-19T00:00:00.000Z',
          expires_at: '2026-04-20T00:00:00.000Z',
        },
        {
          id: 'app-2',
          intent: 'pair',
          channel_id: 'wechat-main',
          platform_user_id: 'master-user',
          platform_display_name: 'Master User',
          content_preview: '/pair',
          source_session_id: 'private-2',
          received_at: '2026-04-19T00:00:00.000Z',
          expires_at: '2026-04-20T00:00:00.000Z',
        },
      ],
    })
    listLegacyFriends.mockResolvedValue({
      items: [
        {
          id: 'friend-1',
          display_name: 'Alice',
          permission: 'normal',
          permission_template_id: 'standard',
          channel_identities: [],
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:00:00.000Z',
        },
      ],
      pagination: {
        page: 1,
        page_size: 20,
        total_items: 1,
        total_pages: 1,
      },
    })
    createFriendFromPrivatePool.mockResolvedValue({
      friend: {
        id: 'friend-new',
        display_name: 'Pool User',
      },
    })
    assignPrivatePoolToFriend.mockResolvedValue({
      friend: {
        id: 'friend-1',
        display_name: 'Alice',
      },
    })
    assignApplicationFriend.mockResolvedValue({
      friend: {
        id: 'friend-1',
        display_name: 'Alice',
      },
    })
    createApplicationFriend.mockResolvedValue({
      friend: {
        id: 'friend-new',
        display_name: 'Master User',
      },
    })
    linkApplicationMaster.mockResolvedValue({
      friend: {
        id: 'friend-1',
        display_name: 'Alice',
      },
      created: false,
    })
    rejectApplication.mockResolvedValue({
      deleted: true,
    })
  })

  it('renders domain navigation and the application queue badge from service data', async () => {
    render(<DialogObjectsPage />)

    expect(await screen.findByRole('heading', { name: '对话对象管理' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '好友' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '私聊池' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '群聊' })).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /申请队列 2/ })).toBeInTheDocument()
    })
    expect((await screen.findAllByText('Alice')).length).toBeGreaterThan(0)
  })

  it('switches domains and renders fetched items for each domain', async () => {
    render(<DialogObjectsPage />)

    expect((await screen.findAllByText('Alice')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '私聊池' }))
    expect((await screen.findAllByText('Pool User')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '群聊' }))
    expect((await screen.findAllByText('Master Group')).length).toBeGreaterThan(0)
  })

  it('calls the create-friend private-pool action through the service layer', async () => {
    render(<DialogObjectsPage />)

    fireEvent.click(await screen.findByRole('button', { name: '私聊池' }))
    expect((await screen.findAllByText('Pool User')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '从私聊新建好友' }))
    const nameInput = await screen.findByLabelText('好友名称')
    fireEvent.change(nameInput, { target: { value: 'Pool User' } })
    fireEvent.click(screen.getByRole('button', { name: '确认新建' }))

    await waitFor(() => {
      expect(createFriendFromPrivatePool).toHaveBeenCalledWith('private-1', {
        channel_id: 'wechat-main',
        display_name: 'Pool User',
        permission_template_id: undefined,
      })
    })
  })

  it('assigns an apply application to an existing friend and refreshes the queue', async () => {
    render(<DialogObjectsPage />)

    fireEvent.click(await screen.findByRole('button', { name: '申请队列 2' }))
    expect((await screen.findAllByText('Pool User')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '归到已有好友' }))
    expect(await screen.findByLabelText('选择好友')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认归属' }))

    await waitFor(() => {
      expect(assignApplicationFriend).toHaveBeenCalledWith('app-1', {
        friend_id: 'friend-1',
      })
    })
    expect(toastMock.success).toHaveBeenCalledWith('已归属到已有好友')
    await waitFor(() => {
      expect(listApplications.mock.calls.length).toBeGreaterThan(1)
    })
  })

  it('creates a friend from an apply application through the new route', async () => {
    render(<DialogObjectsPage />)

    fireEvent.click(await screen.findByRole('button', { name: '申请队列 2' }))
    expect((await screen.findAllByText('Pool User')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '新建好友' }))
    const nameInput = await screen.findByLabelText('好友名称')
    fireEvent.change(nameInput, { target: { value: 'Created Friend' } })
    fireEvent.click(screen.getByRole('button', { name: '确认新建' }))

    await waitFor(() => {
      expect(createApplicationFriend).toHaveBeenCalledWith('app-1', {
        display_name: 'Created Friend',
      })
    })
    expect(toastMock.success).toHaveBeenCalledWith('已新建好友')
    await waitFor(() => {
      expect(listApplications.mock.calls.length).toBeGreaterThan(1)
    })
  })

  it('links a pair application to the existing master friend when one exists', async () => {
    render(<DialogObjectsPage />)

    fireEvent.click(await screen.findByRole('button', { name: '申请队列 2' }))
    expect((await screen.findAllByText('Master User')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /Master User/ }))

    fireEvent.click(screen.getByRole('button', { name: '并入现有 Master' }))

    await waitFor(() => {
      expect(linkApplicationMaster).toHaveBeenCalledWith('app-2')
    })
    expect(toastMock.success).toHaveBeenCalledWith('已并入现有 Master')
    await waitFor(() => {
      expect(listApplications.mock.calls.length).toBeGreaterThan(1)
    })
  })

  it('creates a master from a pair application when no master exists yet', async () => {
    listFriends.mockResolvedValueOnce({
      items: [
        {
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
        },
      ],
    })
    linkApplicationMaster.mockResolvedValueOnce({
      friend: {
        id: 'friend-master-new',
        display_name: 'Master User',
      },
      created: true,
    })

    render(<DialogObjectsPage />)

    fireEvent.click(await screen.findByRole('button', { name: '申请队列 2' }))
    expect((await screen.findAllByText('Master User')).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: /Master User/ }))

    fireEvent.click(screen.getByRole('button', { name: '新建 Master' }))

    await waitFor(() => {
      expect(linkApplicationMaster).toHaveBeenCalledWith('app-2')
    })
    expect(toastMock.success).toHaveBeenCalledWith('已新建 Master')
    await waitFor(() => {
      expect(listApplications.mock.calls.length).toBeGreaterThan(1)
    })
  })

  it('rejects an application from the queue', async () => {
    render(<DialogObjectsPage />)

    fireEvent.click(await screen.findByRole('button', { name: '申请队列 2' }))
    expect((await screen.findAllByText('Pool User')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: '拒绝申请' }))

    await waitFor(() => {
      expect(rejectApplication).toHaveBeenCalledWith('app-1')
    })
    expect(toastMock.success).toHaveBeenCalledWith('已拒绝申请')
    await waitFor(() => {
      expect(listApplications.mock.calls.length).toBeGreaterThan(1)
    })
  })

  it('keeps successful domains visible when one dialog-object endpoint fails', async () => {
    listGroups.mockRejectedValueOnce(new Error('groups down'))

    render(<DialogObjectsPage />)

    expect(await screen.findByRole('heading', { name: '对话对象管理' })).toBeInTheDocument()
    expect((await screen.findAllByText('Alice')).length).toBeGreaterThan(0)
    expect(toastMock.error).toHaveBeenCalled()
  })
})
