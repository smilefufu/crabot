import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { WorkersPage } from './index'
import { workerManagementService } from '../../services/worker-management'

vi.mock('../../services/worker-management', () => ({
  workerManagementService: {
    getAll: vi.fn(),
    putConfig: vi.fn(),
    startOperation: vi.fn(),
  },
}))
vi.mock('../../services/provider', () => ({
  providerService: { createProvider: vi.fn(async () => ({ id: 'prov-1' })) },
}))

const svc = workerManagementService as unknown as {
  getAll: ReturnType<typeof vi.fn>
  putConfig: ReturnType<typeof vi.fn>
  startOperation: ReturnType<typeof vi.fn>
}

function mergedResult(config: unknown, statuses: unknown[] = []) {
  return { config, agent_status: 'available' as const, statuses }
}

const baseConfig = {
  revision: 1,
  default_impl: 'builtin' as const,
  implementations: {
    builtin: { enabled: true },
    'claude-code': { enabled: false },
    codex: { enabled: false },
  },
}

const readyStatus = {
  impl: 'claude-code', installed: true, version: '2.1.232', install_source: 'managed' as const,
  configured: true, policy_revision: 1, verification: 'passed' as const, ready: true,
  capabilities: { fork: true, revive: true, goalMode: false, subagent: false, structuredTrace: false },
  connection_capabilities: [], observed_at: '2026-08-14T00:00:00Z',
}

describe('WorkersPage（P6-B §13）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('渲染三张卡片并展示 registry 状态', async () => {
    svc.getAll.mockResolvedValue(mergedResult(baseConfig, [readyStatus]))
    render(<WorkersPage />)
    await waitFor(() => screen.getByText('Claude Code'))
    expect(screen.getByText('Builtin（内置）')).toBeTruthy()
    expect(screen.getByText('Codex')).toBeTruthy()
    expect(screen.getByText('● ready')).toBeTruthy()
  })

  it('配置连接对话框：claude-code 有 setup-token 选项，codex 没有', async () => {
    svc.getAll.mockResolvedValue(mergedResult(baseConfig, []))
    render(<WorkersPage />)
    await waitFor(() => screen.getByText('Claude Code'))
    const buttons = screen.getAllByText('配置连接')
    fireEvent.click(buttons[0]) // claude-code
    await waitFor(() => screen.getByText('粘贴 setup-token（Claude 订阅签发）'))
    fireEvent.click(screen.getByText('取消'))
    await waitFor(() => screen.getByText('Codex'))
    fireEvent.click(screen.getAllByText('配置连接')[1]) // codex
    await waitFor(() => screen.getByText('自定义 BASE_URL + KEY'))
    expect(screen.queryByText('粘贴 setup-token（Claude 订阅签发）')).toBeNull()
  })

  it('选择 existing_host 保存 → PUT enabled + existing_host connection', async () => {
    svc.getAll.mockResolvedValue(mergedResult(baseConfig, []))
    svc.putConfig.mockResolvedValue({ ...baseConfig, revision: 2 })
    render(<WorkersPage />)
    await waitFor(() => screen.getByText('Codex'))
    fireEvent.click(screen.getAllByText('配置连接')[1])
    await waitFor(() => screen.getByText('保存'))
    fireEvent.click(screen.getByText('保存'))
    await waitFor(() => expect(svc.putConfig).toHaveBeenCalled())
    const [revision, cfg] = svc.putConfig.mock.calls[0]
    expect(revision).toBe(1)
    expect(cfg.implementations.codex).toEqual({ enabled: true, connection: { mode: 'existing_host' } })
    expect(cfg.default_impl).toBe('builtin')
  })

  it('verify 需要确认才发起', async () => {
    const enabled = {
      ...baseConfig,
      implementations: {
        ...baseConfig.implementations,
        codex: { enabled: true, connection: { mode: 'existing_host' as const } },
      },
    }
    svc.getAll.mockResolvedValue(mergedResult(enabled, []))
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    render(<WorkersPage />)
    await waitFor(() => screen.getByText('验证'))
    fireEvent.click(screen.getByText('验证'))
    expect(confirmSpy).toHaveBeenCalled()
    expect(svc.startOperation).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })
})
