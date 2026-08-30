/**
 * 流式超时原语：给任意 LLM 流加 TTFB（首 chunk）和空闲（相邻 chunk 间隔）两道超时。
 *
 * 背景：非流式 / 静默连接的请求，链路上的网关 / 反代可能在长时间无字节时把连接掐掉
 * （表现为 `UND_ERR_SOCKET: other side closed`）。流式让字节持续流动能缓解，但仍需
 * 主动超时来：① 首 chunk 迟迟不来时尽早 abort 换新连接（而不是干等到对端掐线）；
 * ② 流中途挂起（连接还在但不再吐 chunk）时及时止损。
 *
 * 超时触发的是内部 AbortController，并翻译成可重试的 StreamTimeoutError，与用户主动
 * 取消（userSignal）严格区分——后者原样抛出 AbortError，不可重试。
 */

import { StreamTimeoutError } from './retry-utils.js'
import type { StreamChunk } from './types.js'

// 默认值偏保守，容得下慢 prefill 的大上下文请求；可用环境变量覆盖。
export const STREAM_TTFB_MS = Number(process.env.CRABOT_STREAM_TTFB_MS) || 90_000
export const STREAM_IDLE_MS = Number(process.env.CRABOT_STREAM_IDLE_MS) || 120_000

export interface StreamTimeoutOptions {
  /** 首 chunk 超时（ms）。默认 STREAM_TTFB_MS。 */
  readonly ttfbMs?: number
  /** 相邻 chunk 间隔上限（ms）。默认 STREAM_IDLE_MS。 */
  readonly idleMs?: number
}

/**
 * 包装一个「按 signal 取消」的流工厂，加上 TTFB + 空闲超时。
 *
 * @param makeStream 接收组合后的 AbortSignal，返回单次流。超时会通过该 signal 中断底层请求。
 * @param userSignal 调用方的取消信号（task 级）。用户取消 → 原样 AbortError；超时 → StreamTimeoutError。
 */
export async function* withStreamTimeout<T>(
  makeStream: (signal: AbortSignal) => AsyncGenerator<T>,
  userSignal: AbortSignal | undefined,
  opts: StreamTimeoutOptions = {},
): AsyncGenerator<T> {
  const ttfbMs = opts.ttfbMs ?? STREAM_TTFB_MS
  const idleMs = opts.idleMs ?? STREAM_IDLE_MS

  // 不用 AbortSignal.any：它会把组合 signal 挂到长寿命的 task 级 userSignal 的 dependent
  // 链上，只有 GC 才解开 —— 每次 LLM 调用都挂一个，长跑会把 ctrl/timer/stream 帧滞留到
  // native heap（正是 anthropic-adapter 那段手工 add/removeEventListener 要避免的泄漏，见
  // 2026-06-06 kernel watchdog 复盘）。改为手工桥接 + finally 确定性摘除。
  const ctrl = new AbortController()
  let onUserAbort: (() => void) | null = null
  if (userSignal) {
    if (userSignal.aborted) {
      ctrl.abort()
    } else {
      onUserAbort = () => ctrl.abort()
      userSignal.addEventListener('abort', onUserAbort, { once: true })
    }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  let phase: 'ttfb' | 'idle' = 'ttfb'
  let timedOut = false

  const arm = (ms: number): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, ms)
    // 别让超时定时器拖住事件循环 / 进程退出
    ;(timer as { unref?: () => void }).unref?.()
  }

  try {
    arm(ttfbMs)
    for await (const chunk of makeStream(ctrl.signal)) {
      phase = 'idle'
      arm(idleMs)
      yield chunk
    }
  } catch (err) {
    // 超时触发的 abort（且非用户取消）→ 翻译成可重试错误；用户取消原样抛出
    if (timedOut && !userSignal?.aborted) {
      throw new StreamTimeoutError(phase, phase === 'ttfb' ? ttfbMs : idleMs)
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
    if (userSignal && onUserAbort) userSignal.removeEventListener('abort', onUserAbort)
  }
}
