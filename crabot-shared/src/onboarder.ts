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
  ui_mode: 'qrcode' | 'redirect' | 'pending' | 'challenge_code'
  authorization_command?: string
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
  authorized_identity?: { platform_user_id: string; platform_display_name?: string }
  /**
   * OAuth 类 onboarder 完成后，若仍需用户去平台后台批准 scopes，提供深链。
   * Admin UI 应在创建实例后明显引导用户点击，否则首次 API 调用会因权限缺失报错。
   */
  scope_grant_url?: string
  /**
   * OAuth 类 onboarder 完成后，若仍需用户去平台后台手动订阅事件，提供深链 + 事件清单 + 平台特定步骤。
   * 与 scope_grant_url 关注点不同：scope 决定 API 调用权限，event_subscription 决定哪些事件会被推过来。
   * Admin UI 应在创建实例后明显引导用户配置，否则相关 channel 事件不会触发。
   */
  event_subscription?: {
    /** 平台事件订阅页直链 */
    url: string
    /** 事件清单：中文名 + identifier */
    events: ReadonlyArray<{ name: string; identifier: string }>
    /** 平台特定按顺序展示的提示（如飞书的"必须发版"） */
    extra_instructions?: ReadonlyArray<string>
  }
}

export interface Onboarder {
  begin(params?: Record<string, unknown>): Promise<OnboarderBeginResult>
  poll(sessionId: string): AsyncIterable<OnboarderEvent>
  submit?(sessionId: string, input: { challenge_code: string }): Promise<void>
  finish(sessionId: string, params?: Record<string, unknown>): Promise<OnboarderFinishResult>
  cancel(sessionId: string): void
  startGc?(): void
  stopGc?(): void
  dispose?(): Promise<void>
}

export type OnboarderFactory = () => Onboarder
