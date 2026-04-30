/**
 * Onboarder 接口（base-protocol.md §10）
 *
 * 模块通过 yaml.onboarding_methods 声明交互式配置入口；handler 文件 export createOnboarder()，
 * Admin 在用户进入 onboarding 时直接 import handler 调用。
 *
 * 注意：onboarder 在模块"启动前"运行，不通过 RPC 暴露。
 */

export type OnboarderEvent =
  | { type: 'pending' }
  | { type: 'slow_down' }
  | { type: 'success' }
  | { type: 'error'; code: string; message?: string }

export interface OnboarderBeginResult {
  session_id: string
  ui_mode: 'qrcode' | 'redirect' | 'pending'
  verification_uri?: string
  /** 推荐轮询间隔（秒） */
  interval?: number
  /** 过期时间戳（毫秒，UNIX epoch） */
  expires_at?: number
  display?: { title?: string; description?: string }
}

export interface OnboarderFinishResult {
  /** 写入 channel-config 的环境变量 */
  env: Record<string, string>
  /** 推荐的实例名（admin 可不采用） */
  suggested_name?: string
}

export interface Onboarder {
  begin(params?: Record<string, unknown>): Promise<OnboarderBeginResult>
  poll(sessionId: string): AsyncIterable<OnboarderEvent>
  finish(sessionId: string, params?: Record<string, unknown>): Promise<OnboarderFinishResult>
  cancel(sessionId: string): void
  startGc?(): void
  stopGc?(): void
}

export type OnboarderFactory = () => Onboarder
