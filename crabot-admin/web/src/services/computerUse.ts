import { api } from './api'
import type { ComputerUseSetupStatus } from '../../../../crabot-shared/src/computer-use'
export type { ComputerUseSetupStatus }

export const computerUseService = {
  status: () => api.get<ComputerUseSetupStatus>('/computer-use/setup'),
  start: () => api.post<ComputerUseSetupStatus>('/computer-use/setup', { action: 'start' }),
  cancel: (setup_id: string, keepalive = false) => api.delete<ComputerUseSetupStatus>('/computer-use/setup', { setup_id }, keepalive),
  reveal: () => api.post<ComputerUseSetupStatus>('/computer-use/setup', { action: 'reveal_app' }),
}
export const setupRunning = (status?: ComputerUseSetupStatus | null): boolean =>
  ['permissions', 'capture', 'connecting'].includes(status?.setup?.phase ?? '')

export function desktopStatusText(status: ComputerUseSetupStatus): string {
  if (!status.standard) return '使用自定义后端'
  if (!status.enabled) return '已禁用'
  if (status.host.session !== 'active') return '需要图形登录会话'
  if (status.runtime.state === 'quarantined') return '暂不可用，等待安全恢复'
  if (status.permissions.accessibility === 'missing') return '尚需辅助功能授权'
  if (status.permissions.screen_recording === 'missing') return '尚需屏幕录制授权'
  if (status.runtime.checks?.some(check => check.status === 'fail')) return '桌面环境检查未通过'
  if (status.runtime.reason === 'COMPUTER_USE_PERMISSIONS_PENDING') return '正在检查系统权限'
  if (setupRunning(status)) return status.setup?.phase === 'permissions' ? '等待系统授权' : status.setup?.phase === 'capture' ? '正在验证屏幕访问' : '正在连接桌面工具'
  if (status.setup?.phase === 'cancelled') return '设置已取消'
  if (status.capture.status === 'failed') return '屏幕访问验证未通过'
  if (status.capture.status === 'unverified') return '尚待验证屏幕访问'
  return status.runtime.state === 'ready' ? '可用' : '桌面工具尚未就绪'
}

export function desktopErrorText(reason?: string): string | undefined {
  if (!reason) return undefined
  const descriptions: Record<string, string> = {
    COMPUTER_USE_DISABLED: '请先在 MCP 页面启用桌面控制，再开始设置。',
    COMPUTER_USE_CUSTOM_BACKEND: '当前使用自定义启动配置，请按该后端的说明设置。',
    COMPUTER_USE_INTERACTIVE_SESSION_REQUIRED: '请在运行 Crabot 的电脑上登录图形桌面。',
    COMPUTER_USE_PLATFORM_UNSUPPORTED: '当前系统或处理器尚不支持此桌面组件。',
    COMPUTER_USE_RUNTIME_MISSING: '桌面组件尚未安装完整，请通过 Crabot 安装或升级修复。',
    COMPUTER_USE_RUNTIME_INCOMPLETE: '桌面组件文件不完整，请通过 Crabot 安装或升级修复。',
    COMPUTER_USE_RUNTIME_MISMATCH: '桌面组件版本不匹配，请通过 Crabot 安装或升级修复。',
    COMPUTER_USE_RUNTIME_DAMAGED: '桌面组件文件校验失败，请通过 Crabot 安装或升级修复。',
    COMPUTER_USE_RUNTIME_UNAVAILABLE: '桌面组件尚未启动。请完成设置；仍然失败时可查看模块状态。',
    COMPUTER_USE_APP_SIGNATURE_INVALID: '桌面组件签名校验失败，请通过 Crabot 安装或升级修复。',
    COMPUTER_USE_HELPER_IDENTITY_INVALID: '系统返回的应用身份不匹配，请通过 Crabot 安装或升级修复。',
    COMPUTER_USE_HELPER_LAUNCH_FAILED: '无法启动桌面组件，请检查此电脑的图形登录状态。',
    COMPUTER_USE_HELPER_TIMEOUT: '系统检查超时，可以重新开始设置。',
    COMPUTER_USE_HELPER_BUSY: '另一项权限检查正在结束，请稍后重新检查。',
    COMPUTER_USE_PERMISSIONS_PENDING: '正在检查系统权限，请稍候。',
    COMPUTER_USE_HELPER_STOP_UNCONFIRMED: '上一次检查尚未确认退出，请稍后重新检查。',
    COMPUTER_USE_CAPTURE_FAILED: '授权开关已开启，但屏幕访问验证未通过。请留意系统确认窗口，然后重新设置。',
    COMPUTER_USE_AGENT_UNAVAILABLE: 'Crabot Agent 尚不可用，请检查模块状态或模型配置。',
    COMPUTER_USE_QUARANTINED: '桌面操作仍处于安全隔离中。设置不会重放动作或解除隔离，请由新观察核实实际状态。',
    COMPUTER_USE_NATIVE_CAPABILITY_UNAVAILABLE: '原生桌面能力检查未通过，请检查当前图形会话与辅助功能服务。',
    COMPUTER_USE_SETUP_TIMEOUT: '本次等待已结束。完成系统授权后可以重新开始设置。',
    COMPUTER_USE_SETUP_CANCELLED: '设置已取消，已经批准的系统权限仍然保留。',
  }
  return descriptions[reason] ?? '当前检查未完成，请重新检查；仍然失败时可查看模块状态。'
}
