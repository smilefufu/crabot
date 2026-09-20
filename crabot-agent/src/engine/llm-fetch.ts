import { getGlobalDispatcher, type Dispatcher } from 'undici'
import { STREAM_TTFB_MS, STREAM_IDLE_MS } from './stream-timeout.js'

// 仅覆盖 LLM 请求的底层等待预算；每次转发给当前全局 dispatcher，保留代理热更新。
// 不创建或关闭连接池，流中途超时和取消仍由 withStreamTimeout 的 signal 控制。
const dispatcher: Pick<Dispatcher, 'dispatch'> = {
  dispatch(options, handler) {
    return getGlobalDispatcher().dispatch({
      ...options,
      headersTimeout: STREAM_TTFB_MS,
      // 响应头先到而首个 SSE chunk 尚未到时，也需完整首响应预算。
      bodyTimeout: Math.max(STREAM_TTFB_MS, STREAM_IDLE_MS),
    }, handler)
  },
}

export function fetchLlm(url: string, options: RequestInit): Promise<Response> {
  return fetch(url, { ...options, dispatcher } as RequestInit)
}
