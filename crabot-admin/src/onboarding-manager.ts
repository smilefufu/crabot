/**
 * OnboardingManager — 通用 Channel 配置入口管理
 *
 * 协议：base-protocol §10、crabot-module-spec §3.2 onboarding_methods
 *
 * 启动时扫描 ChannelManager 中的所有 ChannelImplementation，对每个 builtin 模块的
 * onboarding_methods 调 require(handler).createOnboarder() 构造 Onboarder 缓存。
 *
 * REST 路由（在 admin index.ts 中暴露）通过 (implementation_id, method_id) 找到 onboarder
 * 并代理 begin / poll / finish / cancel。
 */

import path from 'node:path'
import type { Onboarder } from 'crabot-shared'
import type { ChannelImplementation } from './types.js'

interface CachedOnboarder {
  implementation_id: string
  method_id: string
  onboarder: Onboarder
}

export class OnboardingManager {
  private onboarders = new Map<string, CachedOnboarder>()

  /** key: `${implementation_id}:${method_id}` */
  private static key(implementationId: string, methodId: string): string {
    return `${implementationId}:${methodId}`
  }

  /**
   * 扫描所有 builtin implementation 的 onboarding_methods，加载 handler。
   * 加载失败不抛错——记一条 warn，让其他 method 继续工作。
   */
  loadFromImplementations(impls: ChannelImplementation[]): void {
    for (const impl of impls) {
      if (impl.type !== 'builtin' || !impl.module_path || !impl.onboarding_methods) continue
      for (const method of impl.onboarding_methods) {
        try {
          const handlerPath = path.resolve(__dirname, '..', impl.module_path, method.handler)
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const mod = require(handlerPath) as { createOnboarder?: () => Onboarder }
          if (typeof mod.createOnboarder !== 'function') {
            console.warn(`[OnboardingManager] ${impl.id}:${method.id} handler missing createOnboarder()`)
            continue
          }
          const onboarder = mod.createOnboarder()
          onboarder.startGc?.()
          this.onboarders.set(OnboardingManager.key(impl.id, method.id), {
            implementation_id: impl.id,
            method_id: method.id,
            onboarder,
          })
          console.log(`[OnboardingManager] loaded ${impl.id}:${method.id}`)
        } catch (err) {
          console.warn(`[OnboardingManager] failed to load ${impl.id}:${method.id}:`, err)
        }
      }
    }
  }

  shutdown(): void {
    for (const cached of this.onboarders.values()) {
      try {
        cached.onboarder.stopGc?.()
      } catch {
        // ignore
      }
    }
    this.onboarders.clear()
  }

  get(implementationId: string, methodId: string): Onboarder | undefined {
    return this.onboarders.get(OnboardingManager.key(implementationId, methodId))?.onboarder
  }
}
