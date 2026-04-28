import React from 'react'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
const updateFriend = vi.fn()
const getFriendPermissions = vi.fn()
const updateFriendPermissions = vi.fn()
const linkIdentity = vi.fn()
const unlinkIdentity = vi.fn()
const listPermissionTemplates = vi.fn()
const getPermissionTemplate = vi.fn()
const getSessionConfig = vi.fn()
const updateSessionConfig = vi.fn()
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
    updateFriend: (...args: unknown[]) => updateFriend(...args),
    getPermissions: (...args: unknown[]) => getFriendPermissions(...args),
    updatePermissions: (...args: unknown[]) => updateFriendPermissions(...args),
    linkIdentity: (...args: unknown[]) => linkIdentity(...args),
    unlinkIdentity: (...args: unknown[]) => unlinkIdentity(...args),
  },
}))

vi.mock('../../services/permission-template', () => ({
  permissionTemplateService: {
    list: (...args: unknown[]) => listPermissionTemplates(...args),
    get: (...args: unknown[]) => getPermissionTemplate(...args),
  },
}))

vi.mock('../../services/session', () => ({
  sessionService: {
    getConfig: (...args: unknown[]) => getSessionConfig(...args),
    updateConfig: (...args: unknown[]) => updateSessionConfig(...args),
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
    listPermissionTemplates.mockResolvedValue({
      items: [
        {
          id: 'group_default',
          name: 'Group Default',
          is_system: true,
          tool_access: {
            memory: true,
            messaging: true,
            task: true,
            mcp_skill: true,
            file_io: true,
            browser: true,
            shell: true,
            remote_exec: true,
            desktop: false,
          },
          storage: null,
          memory_scopes: [],
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:00:00.000Z',
        },
        {
          id: 'standard',
          name: 'Standard',
          is_system: false,
          tool_access: {},
          storage: null,
          memory_scopes: [],
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:00:00.000Z',
        },
        {
          id: 'custom-template',
          name: 'Custom Template',
          is_system: false,
          tool_access: {},
          storage: null,
          memory_scopes: [],
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:00:00.000Z',
        },
        {
          id: 'master_private',
          name: 'Master Private',
          is_system: true,
          tool_access: {},
          storage: null,
          memory_scopes: [],
          created_at: '2026-04-19T00:00:00.000Z',
          updated_at: '2026-04-19T00:00:00.000Z',
        },
      ],
      pagination: {
        page: 1,
        page_size: 20,
        total_items: 4,
        total_pages: 1,
      },
    })
    getPermissionTemplate.mockResolvedValue({
      template: {
        id: 'group_default',
        name: 'Group Default',
        is_system: true,
        tool_access: {
          memory: true,
          messaging: true,
          task: true,
          mcp_skill: true,
          file_io: true,
          browser: true,
          shell: true,
          remote_exec: true,
          desktop: false,
        },
        storage: null,
        memory_scopes: [],
        created_at: '2026-04-19T00:00:00.000Z',
        updated_at: '2026-04-19T00:00:00.000Z',
      },
    })
    getSessionConfig.mockResolvedValue({
      config: {
        tool_access: {
          memory: true,
          messaging: false,
        },
        storage: {
          workspace_path: '/srv/dialog/group-1',
          access: 'readwrite',
        },
        memory_scopes: ['group-scope-a', 'group-scope-b'],
        updated_at: '2026-04-19T00:00:00.000Z',
      },
    })
    updateSessionConfig.mockResolvedValue({
      config: {
        tool_access: {
          memory: true,
        },
        storage: null,
        memory_scopes: ['group-scope-a'],
        updated_at: '2026-04-19T00:00:00.000Z',
      },
    })
    updateFriend.mockResolvedValue({
      friend: {
        id: 'friend-1',
        display_name: 'Alice Renamed',
      },
    })
    getFriendPermissions.mockResolvedValue({
      config: null,
      resolved: {
        tool_access: {
          memory: true,
          messaging: true,
          task: false,
          mcp_skill: false,
          file_io: true,
          browser: false,
          shell: false,
          remote_exec: false,
          desktop: false,
        },
        storage: {
          workspace_path: '/workspace/friends/alice',
          access: 'read',
        },
        memory_scopes: ['friend:friend-1'],
      },
    })
    updateFriendPermissions.mockResolvedValue({
      config: {
        tool_access: {
          memory: true,
          messaging: false,
          task: false,
          mcp_skill: false,
          file_io: true,
          browser: false,
          shell: false,
          remote_exec: false,
          desktop: false,
        },
        storage: {
          workspace_path: '/data/friend-1',
          access: 'read',
        },
        memory_scopes: ['friend:friend-1', 'friend:shared'],
        updated_at: '2026-04-21T00:00:00.000Z',
      },
    })
    linkIdentity.mockResolvedValue({
      friend: {
        id: 'friend-1',
        display_name: 'Alice',
      },
    })
    unlinkIdentity.mockResolvedValue({
      friend: {
        id: 'friend-1',
        display_name: 'Alice',
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
    expect(screen.getByRole('tab', { name: /好友/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /私聊池/ })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /群聊/ })).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^申请队列，2 条待处理$/ })).toBeInTheDocument()
    })
    expect((await screen.findAllByText('Alice')).length).toBeGreaterThan(0)
  })

  it('opens friend result-first permissions instead of a template selector', async () => {
    render(<DialogObjectsPage />)

    expect(await screen.findByRole('heading', { name: '好友详情' })).toBeInTheDocument()

    await waitFor(() => {
      expect(getFriendPermissions).toHaveBeenCalledWith('friend-1')
    })

    expect(screen.queryByLabelText('权限模板')).not.toBeInTheDocument()
    expect(screen.getByLabelText('记忆读写')).toBeChecked()
    expect(screen.queryByLabelText('桌面控制（仅 Master 私聊）')).not.toBeInTheDocument()
    expect(screen.getByLabelText('启用存储')).toBeChecked()
    expect(screen.getByLabelText('范围标识')).toHaveValue('friend:friend-1')
  })

  it('saves explicit friend permissions from the workbench', async () => {
    render(<DialogObjectsPage />)

    expect(await screen.findByRole('heading', { name: '好友详情' })).toBeInTheDocument()
    await waitFor(() => {
      expect(getFriendPermissions).toHaveBeenCalledWith('friend-1')
    })

    fireEvent.click(screen.getByLabelText('消息操作'))
    fireEvent.change(screen.getByLabelText('工作区路径'), { target: { value: '/data/friend-1' } })
    fireEvent.click(screen.getByLabelText('自定义范围'))
    fireEvent.change(screen.getByLabelText('范围标识'), {
      target: { value: 'friend:friend-1, friend:shared' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存权限' }))

    await waitFor(() => {
      expect(updateFriendPermissions).toHaveBeenCalledWith('friend-1', {
        tool_access: expect.objectContaining({
          messaging: false,
        }),
        storage: {
          workspace_path: '/data/friend-1',
          access: 'read',
        },
        memory_scopes: ['friend:friend-1', 'friend:shared'],
      })
    })
  })

  it('keeps friend permissions read-only when loading the resolved payload fails', async () => {
    getFriendPermissions.mockRejectedValueOnce(new Error('friend permissions down'))

    render(<DialogObjectsPage />)

    expect(await screen.findByRole('heading', { name: '好友详情' })).toBeInTheDocument()

    await waitFor(() => {
      expect(getFriendPermissions).toHaveBeenCalledWith('friend-1')
    })

    expect(await screen.findByText('好友权限暂时不可编辑，请先刷新或修复加载错误。')).toBeInTheDocument()
    expect(screen.queryByLabelText('记忆读写')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存权限' })).not.toBeInTheDocument()
    expect(toastMock.error).toHaveBeenCalledWith('friend permissions down')
  })

  it('keeps friend permissions read-only when no resolved payload is returned', async () => {
    getFriendPermissions.mockResolvedValueOnce({
      config: null,
      resolved: null,
    })

    render(<DialogObjectsPage />)

    expect(await screen.findByRole('heading', { name: '好友详情' })).toBeInTheDocument()

    await waitFor(() => {
      expect(getFriendPermissions).toHaveBeenCalledWith('friend-1')
    })

    expect(await screen.findByText('好友权限暂时不可编辑，请先刷新或修复加载错误。')).toBeInTheDocument()
    expect(screen.queryByLabelText('记忆读写')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '保存权限' })).not.toBeInTheDocument()
    expect(toastMock.error).toHaveBeenCalledWith('好友权限未返回可编辑配置')
  })

  it('switches domains and renders fetched items for each domain', async () => {
    render(<DialogObjectsPage />)

    expect((await screen.findAllByText('Alice')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('tab', { name: /私聊池/ }))
    expect((await screen.findAllByText('Pool User')).length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('tab', { name: /群聊/ }))
    expect((await screen.findAllByText('Master Group')).length).toBeGreaterThan(0)
  })

  it('calls the create-friend private-pool action through the service layer', async () => {
    render(<DialogObjectsPage />)

    fireEvent.click(await screen.findByRole('tab', { name: /私聊池/ }))
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

    fireEvent.click(await screen.findByRole('button', { name: /^申请队列，2 条待处理$/ }))
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

    fireEvent.click(await screen.findByRole('button', { name: /^申请队列，2 条待处理$/ }))
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

    fireEvent.click(await screen.findByRole('button', { name: /^申请队列，2 条待处理$/ }))
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

    fireEvent.click(await screen.findByRole('button', { name: /^申请队列，2 条待处理$/ }))
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

    fireEvent.click(await screen.findByRole('button', { name: /^申请队列，2 条待处理$/ }))
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

  it('edits friend metadata from the dialog objects workbench and refreshes the list', async () => {
    render(<DialogObjectsPage />)

    expect(await screen.findByRole('heading', { name: '好友详情' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('显示名称'), { target: { value: 'Alice Renamed' } })
    fireEvent.click(screen.getByRole('button', { name: '保存基础信息' }))

    await waitFor(() => {
      expect(updateFriend).toHaveBeenCalledWith('friend-1', {
        display_name: 'Alice Renamed',
        permission: 'normal',
      })
    })
    expect(updateFriendPermissions).not.toHaveBeenCalled()
    expect(toastMock.success).toHaveBeenCalledWith('好友基础信息已保存')
    await waitFor(() => {
      expect(listFriends.mock.calls.length).toBeGreaterThan(1)
    })
  })

  it('updates friend permission level without touching the explicit permission API', async () => {
    render(<DialogObjectsPage />)

    expect(await screen.findByRole('heading', { name: '好友详情' })).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('权限'), { target: { value: 'master' } })
    fireEvent.click(screen.getByRole('button', { name: '保存基础信息' }))

    await waitFor(() => {
      expect(updateFriend).toHaveBeenCalledWith('friend-1', {
        display_name: 'Alice',
        permission: 'master',
      })
    })
    expect(updateFriendPermissions).not.toHaveBeenCalled()
  })

  it('binds and unlinks channel identities in the dialog objects workbench', async () => {
    render(<DialogObjectsPage />)

    expect(await screen.findByRole('heading', { name: '好友详情' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '绑定新身份' }))
    fireEvent.change(screen.getByLabelText('Channel ID'), { target: { value: 'wechat-alt' } })
    fireEvent.change(screen.getByLabelText('平台用户 ID'), { target: { value: 'alice-alt' } })
    fireEvent.change(screen.getByLabelText('平台显示名称（可选）'), { target: { value: 'Alice Alt' } })
    fireEvent.click(screen.getByRole('button', { name: '绑定' }))

    await waitFor(() => {
      expect(linkIdentity).toHaveBeenCalledWith('friend-1', {
        channel_id: 'wechat-alt',
        platform_user_id: 'alice-alt',
        platform_display_name: 'Alice Alt',
      })
    })
    expect(toastMock.success).toHaveBeenCalledWith('身份绑定成功')

    fireEvent.click(screen.getByRole('button', { name: '解绑' }))
    fireEvent.click(screen.getByRole('button', { name: '确认解绑' }))

    await waitFor(() => {
      expect(unlinkIdentity).toHaveBeenCalledWith('friend-1', 'wechat-main', 'alice-wx')
    })
    expect(toastMock.success).toHaveBeenCalledWith('身份已解绑')
    await waitFor(() => {
      expect(listFriends.mock.calls.length).toBeGreaterThan(2)
    })
  })

  it('keeps master friends permission locked in the dialog objects workbench', async () => {
    render(<DialogObjectsPage />)

    fireEvent.click(await screen.findByRole('button', { name: 'Master Boss' }))

    expect(screen.getByLabelText('权限')).toBeDisabled()
    expect(screen.queryByLabelText('权限模板')).not.toBeInTheDocument()
  })

  it('exposes friend scene and memory entry points from the friend workbench', async () => {
    render(<DialogObjectsPage />)

    const friendDetail = (await screen.findByRole('heading', { name: '好友详情' })).closest('.card')
    expect(friendDetail).not.toBeNull()
    const scopedFriendDetail = within(friendDetail as HTMLElement)

    const sceneLink = scopedFriendDetail.getByRole('link', { name: '打开私聊场景画像' })
    expect(sceneLink).toHaveAttribute('href', '/memory/scenes/friend%3Afriend-1')

    const memoryLink = scopedFriendDetail.getByRole('link', { name: '查看私聊记忆' })
    expect(memoryLink).toHaveAttribute('href', '/memory/long-term?friend_id=friend-1&context_label=Alice')
  })

  it('shows group session status and opens an editable permission drawer without template id', async () => {
    render(<DialogObjectsPage />)

    fireEvent.click(await screen.findByRole('tab', { name: /群聊/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Master Group' }))

    const groupDetail = screen.getByRole('heading', { name: '群聊详情' }).closest('.card')
    expect(groupDetail).not.toBeNull()
    const scopedGroupDetail = within(groupDetail as HTMLElement)
    expect(scopedGroupDetail.getByText('来源渠道：wechat-main')).toBeInTheDocument()
    expect(scopedGroupDetail.getByText('群成员数量：2')).toBeInTheDocument()
    expect(scopedGroupDetail.getByText('master_in_group：是')).toBeInTheDocument()
    expect(scopedGroupDetail.getByRole('button', { name: '编辑群权限' })).toBeInTheDocument()

    fireEvent.click(scopedGroupDetail.getByRole('button', { name: '编辑群权限' }))

    expect(await screen.findByRole('heading', { name: '群聊权限编辑' })).toBeInTheDocument()
    expect(screen.queryByLabelText('权限模板')).not.toBeInTheDocument()
    expect(screen.getByLabelText('记忆读写')).toBeChecked()
    expect(screen.getByLabelText('消息操作')).not.toBeChecked()
    expect(screen.getByLabelText('启用存储')).toBeChecked()
    expect(screen.getByLabelText('工作区路径')).toHaveValue('/srv/dialog/group-1')
    expect(screen.getByLabelText('访问级别')).toHaveValue('readwrite')
    expect(screen.getByLabelText('自定义范围')).toBeChecked()
    expect(screen.getByLabelText('范围标识')).toHaveValue('group-scope-a, group-scope-b')
    expect(screen.getByRole('button', { name: '保存配置' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重置为继承' })).not.toBeInTheDocument()
  })

  it('exposes group scene and memory entry points from the group workbench', async () => {
    render(<DialogObjectsPage />)

    fireEvent.click(await screen.findByRole('tab', { name: /群聊/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Master Group' }))

    const groupDetail = screen.getByRole('heading', { name: '群聊详情' }).closest('.card')
    expect(groupDetail).not.toBeNull()
    const scopedGroupDetail = within(groupDetail as HTMLElement)

    const sceneLink = scopedGroupDetail.getByRole('link', { name: '打开群聊场景画像' })
    expect(sceneLink).toHaveAttribute('href', '/memory/scenes/group%3Awechat-main%3Agroup-1')

    const memoryLink = scopedGroupDetail.getByRole('link', { name: '查看群聊记忆' })
    expect(memoryLink).toHaveAttribute('href', '/memory/long-term?accessible_scope=group-1&context_label=Master+Group')
  })

  it('saves explicit effective group permissions', async () => {
    render(<DialogObjectsPage />)

    fireEvent.click(await screen.findByRole('tab', { name: /群聊/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Master Group' }))
    fireEvent.click(screen.getByRole('button', { name: '编辑群权限' }))

    expect(await screen.findByRole('heading', { name: '群聊权限编辑' })).toBeInTheDocument()

    const storageToggle = screen.getByLabelText('启用存储')
    expect(storageToggle).toBeChecked()
    const storagePath = screen.getByLabelText('工作区路径')
    fireEvent.click(screen.getByLabelText('消息操作'))
    fireEvent.change(storagePath, { target: { value: '/data/dialog/group-1' } })
    fireEvent.change(screen.getByLabelText('访问级别'), { target: { value: 'read' } })
    fireEvent.click(screen.getByLabelText('自定义范围'))
    fireEvent.change(screen.getByLabelText('范围标识'), { target: { value: 'group-a, group-b' } })
    fireEvent.click(screen.getByRole('button', { name: '保存配置' }))

    await waitFor(() => {
      expect(updateSessionConfig).toHaveBeenCalledWith('group-1', {
        tool_access: {
          memory: true,
          messaging: true,
          task: true,
          mcp_skill: true,
          file_io: true,
          browser: true,
          shell: true,
          remote_exec: true,
          desktop: false,
        },
        storage: {
          workspace_path: '/data/dialog/group-1',
          access: 'read',
        },
        memory_scopes: ['group-a', 'group-b'],
      })
    })
    expect(toastMock.success).toHaveBeenCalledWith('群聊权限配置已保存')
  })
})
