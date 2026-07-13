/**
 * subagent 错误分类器
 *
 * subagent 失败可能由多种原因：LLM provider quota 耗尽、credential 失效、网络抖动、
 * 服务端 overload、内部 tool 失败等。每种应给上层（Front / 父 Worker）不同的处置建议：
 * - quota / auth：不可重试，立即告知 master 改配置
 * - rate_limit / model_error / network / timeout：可重试，但应退避或换 subagent
 * - unknown：让 master 看 trace 详情
 *
 * 这个分类器把抛出来的异常或返回的 error string 归到一类，并附 hint，给上层 LLM 看。
 */

export type SubAgentErrorKind =
  | 'quota'
  | 'auth'
  | 'rate_limit'
  | 'model_error'
  | 'network'
  | 'timeout'
  | 'tool_error'
  | 'max_turns'
  | 'unknown'

export interface SubAgentErrorClassification {
  readonly kind: SubAgentErrorKind
  readonly retryable: boolean
  readonly summary: string
  readonly hint: string
}

interface ErrorLike {
  status?: number
  name?: string
  message?: string
  error?: unknown
}

function getStatus(err: ErrorLike): number | undefined {
  if (typeof err.status === 'number') return err.status
  return undefined
}

function getMessage(err: unknown): string {
  if (err == null) return ''
  if (typeof err === 'string') return err
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && 'message' in err && typeof (err as ErrorLike).message === 'string') {
    return String((err as ErrorLike).message)
  }
  try { return JSON.stringify(err) } catch { return String(err) }
}

function getBodyText(err: unknown): string {
  if (err == null || typeof err !== 'object') return ''
  const e = err as ErrorLike
  if (e.error === undefined) return ''
  try { return JSON.stringify(e.error) } catch { return '' }
}

function hasAny(s: string, needles: ReadonlyArray<string>): boolean {
  const lower = s.toLowerCase()
  return needles.some((n) => lower.includes(n.toLowerCase()))
}

const QUOTA_NEEDLES = [
  'usage limit',
  'billing cycle',
  'quota',
  'permission_error',
  'insufficient_quota',
  'credit balance',
  'monthly limit',
  'exceeded.*limit',
]

const AUTH_NEEDLES = [
  'invalid_api_key',
  'authentication_error',
  'authentication',
  'invalid api key',
  'unauthorized',
  'token expired',
  'bad credentials',
]

const RATE_LIMIT_NEEDLES = ['rate_limit', 'rate limit', 'too many requests']

const TIMEOUT_NEEDLES = ['etimedout', 'timed out', 'timeout', 'aborted', 'request was aborted']

const NETWORK_NEEDLES = ['econnreset', 'econnrefused', 'enotfound', 'enetunreach', 'socket hang up', 'getaddrinfo']

const MODEL_ERROR_NEEDLES = [
  'overloaded_error',
  'overloaded',
  'internal server error',
  'service unavailable',
  'temporarily unavailable',
]

export function classifySubAgentError(err: unknown): SubAgentErrorClassification {
  const text = `${getMessage(err)} ${getBodyText(err)}`
  const status = (err && typeof err === 'object') ? getStatus(err as ErrorLike) : undefined
  const name = (err && typeof err === 'object' && 'name' in (err as object)) ? String((err as ErrorLike).name ?? '') : ''

  // quota：HTTP 403 + permission/quota 信号；或文本里 quota / billing cycle / usage limit
  if (
    (status === 403 && hasAny(text, ['permission_error', 'usage limit', 'quota'])) ||
    hasAny(text, QUOTA_NEEDLES)
  ) {
    return {
      kind: 'quota',
      retryable: false,
      summary: 'Subagent 的 LLM provider 当前计费周期配额已耗尽。',
      hint: '不要重试同一 subagent。请告知 master 该 subagent 配置的 model provider quota 已满，需要换 provider/model 或充值刷新配额。',
    }
  }

  // auth
  if (status === 401 || hasAny(text, AUTH_NEEDLES)) {
    return {
      kind: 'auth',
      retryable: false,
      summary: 'Subagent 的 LLM provider credential 无效或过期。',
      hint: '不要重试。请告知 master 在 Admin Web 检查该 subagent 对应 model_role 的 provider API key / OAuth token 是否有效。',
    }
  }

  // rate_limit
  if (status === 429 || hasAny(text, RATE_LIMIT_NEEDLES)) {
    return {
      kind: 'rate_limit',
      retryable: true,
      summary: 'Subagent 被 LLM provider 限流（429）。',
      hint: '可短期后退（30-60s）后重试，或改用其他 subagent / model_role。若连续 3 次仍限流，告知 master 切换 provider。',
    }
  }

  // model_error: 5xx
  if (
    (status !== undefined && status >= 500 && status < 600) ||
    /\bhttp\s+50[23]\b/i.test(text) ||
    hasAny(text, MODEL_ERROR_NEEDLES)
  ) {
    return {
      kind: 'model_error',
      retryable: true,
      summary: 'Subagent 的 LLM provider 上游错误（5xx / overloaded）。',
      hint: '可后退（10-30s）后重试 1-2 次。若反复失败，告知 master 切换 provider 或稍后再试。',
    }
  }

  // timeout
  if (name === 'AbortError' || hasAny(text, TIMEOUT_NEEDLES)) {
    return {
      kind: 'timeout',
      retryable: true,
      summary: 'Subagent 调用超时或被中断。',
      hint: '可重试 1 次；若再次超时，考虑拆小 subagent 任务（缩短上下文）或换更快的 model_role。',
    }
  }

  // network
  if (hasAny(text, NETWORK_NEEDLES)) {
    return {
      kind: 'network',
      retryable: true,
      summary: 'Subagent 调用因网络错误失败。',
      hint: '可立即重试 1 次。若连续失败，告知 master 检查机器网络或 provider endpoint 连通性。',
    }
  }

  return {
    kind: 'unknown',
    retryable: true,
    summary: 'Subagent 调用失败，错误类型未识别。',
    hint: '建议先用 find_task / get_task_progress 查该子任务的执行进度，再决定是否重试或上报给 master。',
  }
}

/**
 * 构造 subagent 失败时返回给 LLM 的工具结果 output（JSON 字符串）。
 * 把 classifier 的判断 + subagent meta + trace id 一并塞进去，让上层 LLM 一眼看清
 * 是 quota / auth 这类不可重试错误，还是真要重试 / 上报 master。
 */
export interface SubAgentFailureContext {
  readonly errorSource: unknown
  readonly subagentName: string
  readonly providerEndpoint: string
  readonly model: string
  readonly childTraceId?: string
  /** subagent 在挂掉前已经吐出来的部分内容（forkEngine.result.output），有就保留 */
  readonly partialOutput?: string
  /** forkEngine 走完了几轮 */
  readonly totalTurns?: number
  /**
   * 显式指定 classifier kind，绕过 errorSource 文本解析。
   * 用于"非异常 outcome"路径（如 max_turns）—— engine 没抛错，但 caller 知道这是个失败终态。
   */
  readonly kindOverride?: SubAgentErrorKind
  /**
   * 引擎层 stop reason；max_turns 时由 caller 显式置 'max_turns'。
   * 顶层暴露便于父 LLM 一眼判定，不必去解 hint 文本。
   */
  readonly stopReason?: 'max_turns' | 'failed'
}

export interface SubAgentFailureOutput {
  readonly outcome: 'failed'
  readonly error_kind: SubAgentErrorKind
  readonly retryable: boolean
  readonly summary: string
  readonly hint: string
  readonly error_message: string
  readonly subagent: string
  readonly provider_endpoint: string
  readonly model: string
  readonly partial_output?: string
  readonly totalTurns?: number
  readonly child_trace_id?: string
  /** 'max_turns' 表示 engine 触顶截断（非异常），'failed' 表示真异常。缺省维持向后兼容。 */
  readonly stop_reason?: 'max_turns' | 'failed'
  /** truncated=true 等价 stop_reason='max_turns'；冗余字段方便父侧布尔判断。 */
  readonly truncated?: boolean
}

const MAX_ERROR_MESSAGE_CHARS = 500
const MAX_PARTIAL_OUTPUT_CHARS = 500

/**
 * max_turns 截断的 classifier：subagent 没抛错，但 engine outcome='max_turns'。
 * retryable=true（拆任务 / 上调 budget 后可再试），但不可重试同样 prompt 同样 budget。
 */
function classifyMaxTurns(): SubAgentErrorClassification {
  return {
    kind: 'max_turns',
    retryable: true,
    summary: 'Subagent 触达 max_turns 上限，未在 budget 内完成任务即被引擎截断。',
    hint:
      '不要原 prompt 直接重试——同样的 budget 会再次触顶。' +
      '处理选项：(a) 把任务拆成更小子步骤分多次 delegate；(b) 调更强的 subagent；' +
      '(c) 若已多次截断，调 ask_human 把 partial_output 给 master 让人判断。' +
      '可用 get_task_progress 查该子任务进度找出卡在哪一步。',
  }
}

export function buildSubAgentFailureOutput(ctx: SubAgentFailureContext): SubAgentFailureOutput {
  const cls = ctx.kindOverride === 'max_turns'
    ? classifyMaxTurns()
    : classifySubAgentError(ctx.errorSource)
  const rawMessage = ctx.kindOverride === 'max_turns'
    ? `subagent reached max_turns (${ctx.totalTurns ?? '?'} turns)`
    : getMessage(ctx.errorSource) || 'subagent failed without error message'
  const out: Record<string, unknown> = {
    outcome: 'failed' as const,
    error_kind: cls.kind,
    retryable: cls.retryable,
    summary: cls.summary,
    hint: cls.hint,
    error_message: rawMessage.slice(0, MAX_ERROR_MESSAGE_CHARS),
    subagent: ctx.subagentName,
    provider_endpoint: ctx.providerEndpoint,
    model: ctx.model,
  }
  if (ctx.partialOutput) out.partial_output = ctx.partialOutput.slice(0, MAX_PARTIAL_OUTPUT_CHARS)
  if (ctx.totalTurns !== undefined) out.totalTurns = ctx.totalTurns
  if (ctx.childTraceId) out.child_trace_id = ctx.childTraceId
  if (ctx.stopReason !== undefined) {
    out.stop_reason = ctx.stopReason
    out.truncated = ctx.stopReason === 'max_turns'
  }
  return out as unknown as SubAgentFailureOutput
}
