import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { VersionUpgradeCard } from './VersionUpgradeCard'
import type { VersionState } from '../../services/version'
vi.mock('../../services/desktop-host', () => ({ isDesktop: false }))

// Shared mutable state — tests update this before rendering
const __state: { current: VersionState } = {
  current: {
    current_version: 'v1.0.0', latest_version: 'v1.1.0', upgrade_available: true,
    upgrade_capability: 'release', deploy_mode: 'user', install_kind: 'release',
    last_checked: null, checking: false,
  },
}

// Mock the hook module so its module-level cache never pollutes between tests.
// useSystemVersion always returns __state.current so each test can override it.
vi.mock('../../hooks/useSystemVersion', () => ({
  useSystemVersion: () => ({
    state: __state.current,
    refresh: vi.fn(async () => {}),
    setCache: vi.fn(),
  }),
  pollVersion: vi.fn(async () => __state.current),
}))

vi.mock('../../services/version', () => ({
  versionService: {
    get: vi.fn(async () => __state.current),
    check: vi.fn(async () => __state.current),
    startUpgrade: vi.fn(async () => ({ status: 'started' })),
  },
}))

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  // Reset to default release state before each test
  __state.current = {
    current_version: 'v1.0.0', latest_version: 'v1.1.0', upgrade_available: true,
    upgrade_capability: 'release', deploy_mode: 'user', install_kind: 'release',
    last_checked: null, checking: false,
  }
})

describe('VersionUpgradeCard', () => {
  it('release 有更新 → 升级按钮可用，显示个人模式标注', async () => {
    render(<VersionUpgradeCard />)
    await waitFor(() => expect(screen.getByText('v1.1.0')).toBeInTheDocument())
    expect(screen.getByText('个人模式')).toBeInTheDocument()
    expect(screen.getByText('release 安装')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /升级到最新版本/ })).toBeEnabled()
  })

  it('source 有 blockers → 升级按钮禁用并提示', async () => {
    __state.current = {
      ...__state.current, upgrade_capability: 'source', install_kind: 'source',
      source_blockers: ['工作区有未提交改动'],
    }
    render(<VersionUpgradeCard />)
    await waitFor(() => expect(screen.getByText(/工作区有未提交改动/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /升级到最新版本/ })).toBeDisabled()
  })

  it('system mode → 渲染只读卡片（团队模式标注 + 无升级按钮 + 提示联系管理员）', async () => {
    __state.current = { ...__state.current, upgrade_capability: 'system', deploy_mode: 'system' }
    render(<VersionUpgradeCard />)
    await waitFor(() => expect(screen.getByText('团队模式')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: /升级到最新版本/ })).not.toBeInTheDocument()
    expect(screen.getByText(/sudo crabot upgrade/)).toBeInTheDocument()
  })

  it('source 有更新且无 blockers → 显示 git pull 提示', async () => {
    __state.current = {
      ...__state.current,
      upgrade_capability: 'source',
      install_kind: 'source',
      source_blockers: [],
    }
    render(<VersionUpgradeCard />)
    await waitFor(() =>
      expect(screen.getByText(/git pull 拉取最新代码并重新构建/)).toBeInTheDocument()
    )
  })

  it('source 有更新但有 blockers → 不显示 git pull 提示', async () => {
    __state.current = {
      ...__state.current,
      upgrade_capability: 'source',
      install_kind: 'source',
      source_blockers: ['工作区有未提交改动'],
    }
    render(<VersionUpgradeCard />)
    await waitFor(() => expect(screen.getByText(/工作区有未提交改动/)).toBeInTheDocument())
    expect(screen.queryByText(/git pull 拉取最新代码并重新构建/)).not.toBeInTheDocument()
  })
})
