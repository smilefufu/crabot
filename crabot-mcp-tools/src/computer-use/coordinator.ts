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
  if (result.structuredContent) return result.structuredContent
  for (const item of result.content) {
    if (item.type !== 'text') continue
    try { const parsed = JSON.parse(item.text); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed } catch { /* Native non-JSON text remains in content. */ }
  }
  return { content: result.content.filter(item => item.type !== 'image') }
}

function outcome(result: CallToolResult): 'completed' | 'failed' | 'unknown' {
  const data = nativePayload(result)
  if (data.effect === 'unknown' || data.status === 'unknown') return 'unknown'
  if (result.isError || data.ok === false || data.success === false || data.error
    || ['refused', 'partial', 'failed'].includes(String(data.effect))
    || ['refused', 'partial', 'failed'].includes(String(data.status))) return 'failed'
  return 'completed'
}

/** One instance controller. Caller keys come exclusively from the host's credential registry. */
export class ComputerUseCoordinator {
  private catalog?: Tool[]
  private readonly validators = new Map<string, ReturnType<AjvJsonSchemaValidator['getValidator']>>()
  private readonly sessions = new Map<string, string>()
  private readonly references = new Map<string, string>()
  private readonly observed = new Set<string>()
  private busy = false
  private quarantined = false

  constructor(private readonly driver: NativeDriver, private readonly authorize: (caller: string) => Promise<boolean>) {}

  async tools(): Promise<Tool[]> {
    if (!this.catalog) {
      const all = await this.driver.tools()
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
    return structuredClone(this.catalog)
  }

  private validate(caller: string, name: string, args: Record<string, unknown>): void {
    const validator = this.validators.get(name)
    if (!validator || !validator(args).valid) throw new Error('COMPUTER_USE_INPUT_INVALID')
    if ((args.x !== undefined || args.from_x !== undefined || args.from_zoom === true) && !this.observed.has(caller)) throw new Error('COMPUTER_USE_OBSERVATION_REQUIRED')
    for (const field of ['element_token', 'capture_id']) {
      if (args[field] !== undefined && this.references.get(String(args[field])) !== caller) throw new Error('COMPUTER_USE_REFERENCE_INVALID')
    }
  }

  async call(caller: string, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    if (!await this.authorize(caller)) return errorResult('COMPUTER_USE_FORBIDDEN')
    if (this.quarantined) return errorResult('COMPUTER_USE_QUARANTINED')
    if (this.busy) return errorResult('COMPUTER_USE_BUSY')
    this.busy = true
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
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
    } finally { clearTimeout(timer); this.busy = false }
  }

  private async execute(caller: string, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult> {
    if (!await this.authorize(caller)) return errorResult('COMPUTER_USE_FORBIDDEN')
    if (signal.aborted) return errorResult('COMPUTER_USE_NOT_STARTED')
    let session = this.sessions.get(caller)
    if (!session) {
      session = `crabot-${randomUUID()}`
      const started = await this.driver.call('start_session', { session }, signal)
      if (started.isError) return started
      this.sessions.set(caller, session)
    }
    const nativeArgs = { ...args, session }
    if (['get_window_state', 'get_desktop_state'].includes(name)) {
      // Coordinate metadata and image dimensions are produced together by Driver.
      Object.assign(nativeArgs, { max_image_dimension: 1024, ...(name === 'get_window_state' ? { max_dimension: Math.min(Number(args.max_dimension ?? 1024), 1024) } : {}) })
    }
    try {
      const pending = this.driver.call(name, nativeArgs, signal)
      let abort!: () => void
      const interrupted = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error('interrupted'))
        else { abort = () => reject(new Error('interrupted')); signal.addEventListener('abort', abort, { once: true }) }
      })
      const result = await Promise.race([pending, interrupted]).finally(() => signal.removeEventListener('abort', abort))
      if (outcome(result) === 'unknown') { await this.quarantine(); return { ...result, isError: true } }
      if (!READ_TOOLS.has(name)) {
        for (const [ref, owner] of this.references) if (owner !== caller) { this.references.delete(ref); this.observed.delete(owner) }
      }
      const payload = nativePayload(result)
      const text = JSON.stringify(payload)
      const images = result.content.filter(item => item.type === 'image')
      if (Buffer.byteLength(text) > 100_000 || images.length > 2 || images.some(item => Buffer.from(item.data, 'base64').length > 8 * 1024 * 1024)) {
        this.forget(caller)
        return { ...errorResult('COMPUTER_USE_OUTPUT_LIMIT'), structuredContent: { code: 'COMPUTER_USE_OUTPUT_LIMIT', effect: payload.effect, verified: payload.verified } }
      }
      if (name === 'get_window_state' || name === 'get_desktop_state') {
        this.forget(caller)
        if (outcome(result) === 'completed' && args.display_only !== true) this.observed.add(caller)
        const elements = Array.isArray(payload.elements) ? payload.elements : []
        for (const element of elements) {
          if (element && typeof element === 'object' && typeof element.element_token === 'string') this.references.set(element.element_token, caller)
        }
        if (typeof payload.capture_id === 'string') this.references.set(payload.capture_id, caller)
      }
      return { ...result, isError: outcome(result) !== 'completed', structuredContent: payload,
        content: [{ type: 'text', text }, ...images] }
    } catch {
      await this.quarantine()
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
      if (state !== 'completed') { batch.status = state === 'unknown' ? 'unknown' : index > 0 || data.effect === 'partial' ? 'partial' : 'failed'; break }
    }
    if (params.observe && !this.quarantined && batch.steps.some(step => step.status !== 'not_executed')) {
      const observation = await this.execute(caller, 'get_window_state', { ...params.observe }, signal)
      batch.observation = nativePayload(observation)
      images.push(...observation.content.filter(item => item.type === 'image'))
      if (observation.isError && batch.status === 'completed') batch.status = 'failed'
    }
    return { isError: batch.status !== 'completed', structuredContent: batch as unknown as Record<string, unknown>, content: [{ type: 'text', text: JSON.stringify(batch) }, ...images] }
  }

  private forget(caller: string): void { this.observed.delete(caller); for (const [ref, owner] of this.references) if (owner === caller) this.references.delete(ref) }
  private async quarantine(): Promise<void> { this.quarantined = true; this.references.clear(); this.observed.clear(); await this.driver.close() }
  async close(): Promise<void> { this.quarantined = true; this.references.clear(); this.observed.clear(); await this.driver.close() }
}
