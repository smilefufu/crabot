import { randomUUID } from 'node:crypto'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js'
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'
import { ACTION_TOOLS, NATIVE_TOOLS, READ_TOOLS, errorResult, type NativeDriver,
  type PerformComputerUseActionsParams, type PerformComputerUseActionsResult } from './types.js'

const BATCH_SCHEMA = { type: 'object' as const, additionalProperties: false, required: ['steps'], properties: {
  steps: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', additionalProperties: false,
    required: ['tool', 'args'], properties: { tool: { type: 'string', enum: [...ACTION_TOOLS] }, args: { type: 'object' } } } },
  observe: { type: 'object', additionalProperties: false, required: ['pid', 'window_id'],
    properties: { pid: { type: 'integer' }, window_id: { type: 'integer' } } },
} }

export function nativePayload(result: CallToolResult): Record<string, unknown> {
  if (result.structuredContent) return result.isError ? { ...result.structuredContent,
    mcp_error_text: result.content.filter(item => item.type === 'text').map(item => (item as { text: string }).text),
  } : result.structuredContent
  for (const item of result.content) {
    if (item.type !== 'text') continue
    try { const parsed = JSON.parse(item.text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed } catch { /* Native non-JSON text remains in content. */ }
  }
  return { content: result.content.filter(item => item.type !== 'image') }
}

function outcome(result: CallToolResult): 'completed' | 'failed' | 'unknown' {
  const data = nativePayload(result)
  if (data.effect === 'unknown' || data.status === 'unknown' || data.execution_state === 'unknown') return 'unknown'
  if (result.isError || data.ok === false || data.success === false || data.error
    || ['refused', 'partial', 'failed'].includes(String(data.effect))
    || ['refused', 'partial', 'failed'].includes(String(data.status))) return 'failed'
  return 'completed'
}

function additionalNativeText(result: CallToolResult, text: string): CallToolResult['content'] {
  return result.content.filter(item => {
    if (item.type !== 'text' || item.text === text) return false
    try { return JSON.stringify(JSON.parse(item.text)) !== JSON.stringify(result.structuredContent) }
    catch { return true }
  })
}

function interruptible<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {}
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('COMPUTER_USE_NOT_STARTED'))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
  return Promise.race([pending, interrupted]).finally(() => signal.removeEventListener('abort', abort))
}

/** One instance controller. Caller keys come exclusively from the host's credential registry. */
export class ComputerUseCoordinator {
  private catalog?: Tool[]
  private readonly validators = new Map<string, ReturnType<AjvJsonSchemaValidator['getValidator']>>()
  private readonly sessions = new Map<string, string>()
  private readonly references = new Map<string, { caller: string; pid?: number; window_id?: number }>()
  private readonly observed = new Set<string>()
  private busy = false
  private quarantined = false
  private cleanup?: Promise<void>
  private cleanupError?: Error
  private reconnection?: Promise<void>
  private closed = false
  private requiresObservation = false
  private active?: { caller: string; controller: AbortController }
  private readonly pendingSessionEnds = new Set<string>()

  constructor(private driver: NativeDriver, private readonly authorize: (caller: string) => Promise<boolean>,
    private readonly reconnect?: () => Promise<NativeDriver>, private readonly availabilityChanged: (available: boolean) => void = () => {}) {}

  async tools(): Promise<Tool[]> {
    if (!this.catalog) {
      await this.loadTools(this.driver)
    }
    return structuredClone(this.catalog!)
  }

  private async loadTools(driver: NativeDriver): Promise<void> {
    const all = await driver.tools()
    const selected = NATIVE_TOOLS.map(name => {
      const native = all.find(tool => tool.name === name)
      if (!native) throw new Error(`CUA_DRIVER_CONTRACT_MISMATCH: ${name}`)
      const tool = structuredClone(native)
      delete tool.inputSchema.properties?.session
      if (tool.inputSchema.required) tool.inputSchema.required = tool.inputSchema.required.filter(key => key !== 'session')
      tool.inputSchema.additionalProperties = false
      this.validators.set(name, new AjvJsonSchemaValidator().getValidator(tool.inputSchema))
      return tool
    })
    this.validators.set('perform_actions', new AjvJsonSchemaValidator().getValidator(BATCH_SCHEMA))
    this.catalog = [...selected, { name: 'perform_actions', description: 'Execute 1–16 already determined native actions under one desktop controller (60s total). Validate every step before input. Do not use steps that depend on a new observation; put a layout-changing action last. Stops on error, partial or unknown; never replays. Optionally observe the target once at the end. completed means a response was received, not that the user goal succeeded.', inputSchema: BATCH_SCHEMA }]
  }

  private validate(caller: string, name: string, args: Record<string, unknown>): void {
    const validator = this.validators.get(name)
    if (!validator || !validator(args).valid) throw new Error('COMPUTER_USE_INPUT_INVALID')
    if (this.requiresObservation && name !== 'perform_actions' && !READ_TOOLS.has(name) && !this.observed.has(caller)) throw new Error('COMPUTER_USE_OBSERVATION_REQUIRED')
    if (ACTION_TOOLS.has(name) && (args.x !== undefined || args.from_x !== undefined || args.from_zoom === true) && !this.observed.has(caller)) throw new Error('COMPUTER_USE_OBSERVATION_REQUIRED')
    for (const field of ['element_token', 'capture_id']) {
      if (args[field] === undefined) continue
      const reference = this.references.get(String(args[field]))
      if (reference?.caller !== caller) throw new Error('COMPUTER_USE_REFERENCE_INVALID')
      const target = args.target && typeof args.target === 'object' ? args.target as Record<string, unknown> : args
      if ((reference.pid !== undefined && target.pid !== undefined && reference.pid !== target.pid)
        || (reference.window_id !== undefined && target.window_id !== undefined && reference.window_id !== target.window_id)) throw new Error('COMPUTER_USE_REFERENCE_TARGET_MISMATCH')
    }
  }

  async call(caller: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
    if (!await this.authorize(caller)) return errorResult('COMPUTER_USE_FORBIDDEN')
    if (this.closed || (this.quarantined && (!READ_TOOLS.has(name) || !this.reconnect))) return errorResult('COMPUTER_USE_QUARANTINED')
    if (this.busy) return errorResult('COMPUTER_USE_BUSY')
    this.busy = true
    const controller = new AbortController()
    this.active = { caller, controller }
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
      if (this.quarantined) {
        if (this.reconnection) return errorResult('COMPUTER_USE_QUARANTINED')
        this.reconnection = this.recover(controller.signal).finally(() => { this.reconnection = undefined })
        try { await interruptible(this.reconnection, controller.signal) }
        catch (error) {
          const data = { code: 'COMPUTER_USE_QUARANTINED', reason: error instanceof Error ? error.message : String(error) }
          return { isError: true, structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] }
        }
      }
      await this.tools()
      this.validate(caller, name, args)
      if (name === 'perform_actions') {
        const params = args as unknown as PerformComputerUseActionsParams
        for (const step of params.steps) this.validate(caller, step.tool, step.args)
        if (params.observe) this.validate(caller, 'get_window_state', params.observe as unknown as Record<string, unknown>)
        return await this.batch(caller, params, controller.signal)
      }
      return await this.execute(caller, name, args, controller.signal)
    } catch (error) {
      return errorResult(error instanceof Error ? error.message : 'COMPUTER_USE_FAILED')
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.active = undefined; this.busy = false
      void this.endRevokedSessions()
    }
  }

  private async execute(caller: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    if (!await this.authorize(caller)) return errorResult('COMPUTER_USE_FORBIDDEN')
    if (signal.aborted) return errorResult('COMPUTER_USE_NOT_STARTED')
    try {
      let session = this.sessions.get(caller)
      if (!session) {
        session = `crabot-${randomUUID()}`
        const started = await interruptible(this.driver.call('start_session', { session }, signal), signal)
        const state = outcome(started)
        if (state === 'unknown') this.quarantine()
        if (state !== 'completed') return { ...started, isError: true }
        this.sessions.set(caller, session)
      }
      if (signal.aborted) return errorResult('COMPUTER_USE_NOT_STARTED')
      const nativeArgs = { ...args, session }
      if (['get_window_state', 'get_desktop_state'].includes(name)) {
        // Coordinate metadata and image dimensions are produced together by Driver.
        Object.assign(nativeArgs, { max_image_dimension: args.max_image_dimension ?? 1024 })
      }
      const result = await interruptible(this.driver.call(name, nativeArgs, signal), signal)
      const state = outcome(result)
      if (state === 'unknown') { this.quarantine(); return { ...result, isError: true } }
      if (!READ_TOOLS.has(name)) {
        for (const owner of this.observed) if (owner !== caller) this.observed.delete(owner)
        for (const [ref, owner] of this.references) if (owner.caller !== caller) this.references.delete(ref)
      }
      const payload = nativePayload(result)
      const text = JSON.stringify(payload)
      const additionalText = additionalNativeText(result, text)
      const images = result.content.filter(item => item.type === 'image')
      if (Buffer.byteLength(text) + additionalText.reduce((bytes, item) => bytes + Buffer.byteLength((item as { text: string }).text), 0) > 100_000
        || images.length > 2 || images.some(item => Buffer.from(item.data, 'base64').length > 8 * 1024 * 1024 || Buffer.from(item.data, 'base64').toString('base64') !== item.data)) {
        this.forget(caller)
        return { ...errorResult('COMPUTER_USE_OUTPUT_LIMIT'), structuredContent: { code: 'COMPUTER_USE_OUTPUT_LIMIT', effect: payload.effect, verified: payload.verified } }
      }
      if ((name === 'get_window_state' || name === 'get_desktop_state') && state !== 'completed') this.forget(caller)
      if ((name === 'get_window_state' || name === 'get_desktop_state') && state === 'completed') {
        this.forget(caller)
        if (state === 'completed' && args.display_only !== true) this.observed.add(caller)
        const elements = Array.isArray(payload.elements) ? payload.elements : []
        const reference = { caller, pid: typeof payload.pid === 'number' ? payload.pid : undefined,
          window_id: typeof payload.window_id === 'number' ? payload.window_id : undefined }
        for (const element of elements) {
          if (element && typeof element === 'object' && typeof element.element_token === 'string') this.references.set(element.element_token, reference)
        }
        if (typeof payload.capture_id === 'string') this.references.set(payload.capture_id, reference)
      }
      return { ...result, isError: state !== 'completed', structuredContent: payload,
        content: [{ type: 'text', text }, ...additionalText, ...images] }
    } catch {
      this.quarantine()
      return errorResult('COMPUTER_USE_UNKNOWN')
    }
  }

  private async batch(caller: string, params: PerformComputerUseActionsParams, signal: AbortSignal): Promise<CallToolResult> {
    const batch: PerformComputerUseActionsResult = { status: 'completed', steps: params.steps.map((step, index) => ({ index, tool: step.tool, status: 'not_executed' })) }
    const images: CallToolResult['content'] = []
    for (const [index, step] of params.steps.entries()) {
      const result = await this.execute(caller, step.tool, step.args, signal)
      const data = nativePayload(result)
      const state = data.code === 'COMPUTER_USE_UNKNOWN' ? 'unknown' : outcome(result)
      batch.steps[index] = { index, tool: step.tool, status: state, result: data }
      if (Buffer.byteLength(JSON.stringify(batch)) > 100_000) {
        batch.steps[index].result = { code: 'COMPUTER_USE_OUTPUT_LIMIT', effect: data.effect }
        this.forget(caller); batch.status = 'partial'; break
      }
      if (state !== 'completed') { batch.status = state === 'unknown' ? 'unknown' : index > 0 || data.effect === 'partial' ? 'partial' : 'failed'; break }
    }
    if (params.observe && !this.quarantined && batch.steps.some(step => step.status !== 'not_executed')) {
      const observation = await this.execute(caller, 'get_window_state', { ...params.observe }, signal)
      batch.observation = nativePayload(observation)
      images.push(...observation.content.filter(item => item.type === 'image'))
      if (observation.isError && batch.status === 'completed') batch.status = 'failed'
      if (Buffer.byteLength(JSON.stringify(batch)) > 100_000) {
        batch.observation = { code: 'COMPUTER_USE_OUTPUT_LIMIT' }
        images.length = 0; this.forget(caller)
        if (batch.status === 'completed') batch.status = 'failed'
      }
    }
    return { isError: batch.status !== 'completed', structuredContent: batch as unknown as Record<string, unknown>, content: [{ type: 'text', text: JSON.stringify(batch) }, ...images] }
  }

  private forget(caller: string): void { this.observed.delete(caller); for (const [ref, owner] of this.references) if (owner.caller === caller) this.references.delete(ref) }
  async revoke(caller: string): Promise<void> {
    this.forget(caller)
    const session = this.sessions.get(caller)
    this.sessions.delete(caller)
    if (session) this.pendingSessionEnds.add(session)
    if (this.active?.caller === caller) this.active.controller.abort()
    await this.endRevokedSessions()
  }
  private async endRevokedSessions(): Promise<void> {
    if (this.busy || this.quarantined || !this.pendingSessionEnds.size) return
    this.busy = true
    try {
      for (const session of this.pendingSessionEnds) {
        await this.driver.call('end_session', { session }, AbortSignal.timeout(5_000))
        this.pendingSessionEnds.delete(session)
      }
    } catch { this.quarantine() } finally { this.busy = false }
  }
  private quarantine(): void {
    if (!this.quarantined) this.availabilityChanged(false)
    this.quarantined = true; this.requiresObservation = true
    this.references.clear(); this.observed.clear(); this.sessions.clear(); this.pendingSessionEnds.clear()
    this.cleanup ??= this.driver.close().catch(error => { this.cleanupError = error instanceof Error ? error : new Error(String(error)) })
  }

  private async recover(signal: AbortSignal): Promise<void> {
    let candidate: NativeDriver | undefined
    try {
      await this.cleanup
      if (this.cleanupError) throw this.cleanupError
      signal.throwIfAborted()
      if (this.closed) throw new Error('COMPUTER_USE_QUARANTINED')
      candidate = await this.reconnect!()
      signal.throwIfAborted()
      if (this.closed) throw new Error('COMPUTER_USE_QUARANTINED')
      await this.loadTools(candidate)
      signal.throwIfAborted()
      if (this.closed) throw new Error('COMPUTER_USE_QUARANTINED')
      this.driver = candidate
      this.cleanup = undefined
      this.quarantined = false
      this.availabilityChanged(true)
    } catch (error) {
      if (candidate) {
        this.cleanup = candidate.close().catch(error => { this.cleanupError = error instanceof Error ? error : new Error(String(error)) })
        await this.cleanup
      }
      throw error
    }
  }

  async close(): Promise<void> {
    this.closed = true
    this.active?.controller.abort()
    this.quarantine()
    await this.reconnection?.catch(() => {})
    await this.cleanup
    if (this.cleanupError) throw this.cleanupError
  }
}
