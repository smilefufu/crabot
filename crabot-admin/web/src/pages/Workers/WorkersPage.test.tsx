import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { WorkersPage } from './index'
import { workerManagementService } from '../../services/worker-management'

vi.mock('../../services/worker-management', () => ({
  workerManagementService: {
    getAll: vi.fn(),
    putConfig: vi.fn(),
    startInstall: vi.fn(),
    startVerify: vi.fn(),
  },
}))
vi.mock('../../services/provider', () => ({
  providerService: { createProvider: vi.fn(async () => ({ id: 'prov-1' })) },
}))
vi.mock('../../components/Layout/MainLayout', () => ({
  MainLayout: ({ children }: { children: import('react').ReactNode }) => <>{children}</>,
}))

const svc = workerManagementService as unknown as {
  getAll: ReturnType<typeof vi.fn>
  putConfig: ReturnType<typeof vi.fn>
  startInstall: ReturnType<typeof vi.fn>
  startVerify: ReturnType<typeof vi.fn>
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
  impl: 'claude-code', installed: true, version: '2.1.232', install_source: 'user' as const,
  configured: true, policy_revision: 1, verification: 'passed' as const, ready: true,
  capabilities: { fork: true, revive: true, goalMode: false, subagent: false, structuredTrace: false },
  connection_capabilities: [], observed_at: '2026-08-14T00:00:00Z',
}

describe('WorkersPage（P6-B §13）', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('以状态表展示固定实现和 activation registry 状态', async () => {
    svc.getAll.mockResolvedValue(mergedResult(baseConfig, [readyStatus]))
    render(<WorkersPage />)
    await waitFor(() => screen.getByText('Claude Code'))
    expect(screen.getByRole('heading', { name: 'Worker 配置', level: 1 })).toBeTruthy()
    expect(screen.getByRole('heading', { name: '内置执行器', level: 2 })).toBeTruthy()
    expect(screen.getByText('Codex')).toBeTruthy()
    expect(screen.getAllByText('已停用')).toHaveLength(2)
  })

  it('配置连接对话框：claude-code 有 setup-token 选项，codex 没有', async () => {
    svc.getAll.mockResolvedValue(mergedResult(baseConfig, []))
    render(<WorkersPage />)
    await waitFor(() => screen.getByText('Claude Code'))
    const buttons = screen.getAllByText('配置连接')
    fireEvent.click(buttons[0]) // claude-code
    await waitFor(() => screen.getByText('粘贴 Setup Token'))
    fireEvent.click(screen.getByText('取消'))
    await waitFor(() => screen.getByText('Codex'))
    fireEvent.click(screen.getAllByText('配置连接')[1]) // codex
    await waitFor(() => screen.getByText('自定义服务地址与密钥'))
    expect(screen.queryByText('粘贴 Setup Token')).toBeNull()
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

  it('已启用实现的验证在站内确认后才发起', async () => {
    const enabled = {
      ...baseConfig,
      implementations: {
        ...baseConfig.implementations,
        codex: { enabled: true, connection: { mode: 'existing_host' as const } },
      },
    }
    svc.getAll.mockResolvedValue(mergedResult(enabled, []))
    svc.startVerify.mockResolvedValue({ passed: true })
    render(<WorkersPage />)
    await waitFor(() => screen.getByRole('button', { name: '验证' }))
    fireEvent.click(screen.getByRole('button', { name: '验证' }))
    expect(screen.getByText(/可能消耗额度或产生费用/)).toBeTruthy()
    expect(svc.startVerify).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('开始验证'))
    await waitFor(() => expect(svc.startVerify).toHaveBeenCalledWith('codex', 1))
  })

  it('用户级 CLI 缺失时 Claude Code 与 Codex 都在确认后发起 latest 安装', async () => {
    const missing = {
      ...readyStatus,
      installed: false,
      ready: false,
      verification: 'never',
    }
    svc.getAll.mockResolvedValue(mergedResult(baseConfig, [
      { ...missing, impl: 'claude-code' },
      { ...missing, impl: 'codex' },
    ]))
    svc.startInstall.mockResolvedValue({ state: 'completed', version: '0.1.2' })
    render(<WorkersPage />)
    await waitFor(() => expect(screen.getAllByRole('button', { name: '安装最新版本' })).toHaveLength(2))
    const codexCard = screen.getByRole('heading', { name: 'Codex', level: 2 }).closest('article')
    expect(codexCard).not.toBeNull()
    fireEvent.click(within(codexCard!).getByRole('button', { name: '安装最新版本' }))
    expect(svc.startInstall).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '开始安装' }))
    await waitFor(() => expect(svc.startInstall).toHaveBeenCalledWith('codex', 1, 'latest'))
  })

  it('已安装的 CLI 可显式重装 latest 或切换固定 fallback', async () => {
    const installed = { ...readyStatus, impl: 'codex', verification: 'never', ready: false }
    svc.getAll.mockResolvedValue(mergedResult(baseConfig, [installed]))
    svc.startInstall.mockResolvedValue({ state: 'completed', version: '0.146.0' })
    render(<WorkersPage />)
    await waitFor(() => screen.getByRole('button', { name: '重装最新版本' }))
    expect(screen.getByRole('button', { name: '切换到已验证回退版本' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '切换到已验证回退版本' }))
    expect(screen.getByText(/不会修改宿主登录或配置/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '开始安装' }))
    await waitFor(() => expect(svc.startInstall).toHaveBeenCalledWith('codex', 1, 'fallback'))
  })

  it('安装失败后保留脱敏错误与重试入口', async () => {
    const missing = { ...readyStatus, impl: 'codex', installed: false, ready: false, verification: 'never' }
    svc.getAll.mockResolvedValue(mergedResult(baseConfig, [missing]))
    svc.startInstall.mockRejectedValue(new Error('registry unavailable'))
    render(<WorkersPage />)
    await waitFor(() => screen.getByRole('button', { name: '安装最新版本' }))
    fireEvent.click(screen.getByRole('button', { name: '安装最新版本' }))
    fireEvent.click(screen.getByRole('button', { name: '开始安装' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('安装失败: registry unavailable'))
    expect(screen.getByRole('button', { name: '安装最新版本' })).toBeTruthy()
  })

  it('验证失败后 refresh 不清除失败原因，且保留恢复安装入口', async () => {
    const enabled = {
      ...baseConfig,
      implementations: {
        ...baseConfig.implementations,
        codex: { enabled: true, connection: { mode: 'existing_host' as const } },
      },
    }
    svc.getAll.mockResolvedValue(mergedResult(enabled, [{ ...readyStatus, impl: 'codex', verification: 'never' }]))
    svc.startVerify.mockResolvedValue({ passed: false, detail: 'authentication rejected' })
    render(<WorkersPage />)
    await waitFor(() => screen.getByRole('button', { name: '验证' }))
    fireEvent.click(screen.getByRole('button', { name: '验证' }))
    fireEvent.click(screen.getByRole('button', { name: '开始验证' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('验证失败: authentication rejected'))
    expect(screen.getByRole('button', { name: '重装最新版本' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '切换到已验证回退版本' })).toBeTruthy()
  })

  it('未验证的 ready 实现仍标记为可派用', async () => {
    const enabled = {
      ...baseConfig,
      implementations: {
        ...baseConfig.implementations,
        codex: { enabled: true, connection: { mode: 'existing_host' as const } },
      },
    }
    svc.getAll.mockResolvedValue(mergedResult(enabled, [{
      ...readyStatus,
      impl: 'codex',
      verification: 'never',
      ready: true,
    }]))
    render(<WorkersPage />)
    await waitFor(() => screen.getByText('Codex'))
    const codexRow = screen.getByRole('heading', { name: 'Codex', level: 2 }).closest('article')
    expect(codexRow).not.toBeNull()
    expect(within(codexRow!).getByText('可派用')).toBeTruthy()
    expect(within(codexRow!).getByText('未验证')).toBeTruthy()
  })

  it('派用偏好只在点击保存后提交', async () => {
    const enabled = {
      ...baseConfig,
      implementations: {
        ...baseConfig.implementations,
        codex: { enabled: true, connection: { mode: 'existing_host' as const } },
      },
    }
    svc.getAll.mockResolvedValue(mergedResult(enabled, []))
    svc.putConfig.mockResolvedValue({ ...enabled, revision: 2 })
    render(<WorkersPage />)
    await waitFor(() => screen.getByText('Codex'))
    const preferenceInputs = screen.getAllByLabelText('派用偏好')
    fireEvent.change(preferenceInputs[1], { target: { value: '优先用于代码审查' } })
    fireEvent.blur(preferenceInputs[1])
    expect(svc.putConfig).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: '保存偏好' })[1])
    await waitFor(() => expect(svc.putConfig).toHaveBeenCalled())
    const [, config] = svc.putConfig.mock.calls[0]
    expect(config.implementations.codex.preference).toBe('优先用于代码审查')
  })

  it('Agent 不可用时保留期望配置但不伪造状态', async () => {
    svc.getAll.mockResolvedValue({
      config: baseConfig,
      agent_status: 'unavailable' as const,
      statuses: [],
      unavailable_reason: 'RPC temporarily unavailable',
    })
    render(<WorkersPage />)
    await waitFor(() => screen.getByRole('alert'))
    expect(screen.getByRole('alert')).toHaveTextContent('Agent 不可用')
    expect(screen.getAllByText('状态未知')).toHaveLength(3)
  })
})
