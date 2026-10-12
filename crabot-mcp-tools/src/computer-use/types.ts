import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js'

export type ComputerUseActionTool = 'click' | 'double_click' | 'right_click' | 'type_text'
  | 'press_key' | 'hotkey' | 'set_value' | 'scroll' | 'drag' | 'invoke_menu'
export interface ComputerUseActionStep { tool: ComputerUseActionTool; args: Record<string, unknown> }
export interface ComputerUseObserveTarget { pid: number; window_id: number }
export interface PerformComputerUseActionsParams { steps: ComputerUseActionStep[]; observe?: ComputerUseObserveTarget }
export type ComputerUseStepStatus = 'completed' | 'failed' | 'unknown' | 'not_executed'
export type ComputerUseBatchStatus = 'completed' | 'failed' | 'partial' | 'unknown'
export interface ComputerUseStepResult { index: number; tool: ComputerUseActionTool; status: ComputerUseStepStatus; result?: Record<string, unknown> }
export interface PerformComputerUseActionsResult { status: ComputerUseBatchStatus; steps: ComputerUseStepResult[]; observation?: Record<string, unknown> }

export const DRIVER_VERSION = '0.34.1'
export const NATIVE_TOOLS = ['list_apps', 'list_windows', 'get_window_state', 'get_desktop_state', 'zoom',
  'launch_app', 'bring_to_front', 'set_window_frame', 'invoke_menu', 'click', 'double_click',
  'right_click', 'type_text', 'press_key', 'hotkey', 'set_value', 'scroll', 'drag', 'verify_state'] as const
export const ACTION_TOOLS: ReadonlySet<string> = new Set(['click', 'double_click', 'right_click', 'type_text',
  'press_key', 'hotkey', 'set_value', 'scroll', 'drag', 'invoke_menu'])
export const READ_TOOLS: ReadonlySet<string> = new Set(['list_apps', 'list_windows', 'get_window_state', 'get_desktop_state', 'zoom', 'verify_state'])
export interface NativeDriver {
  tools(): Promise<Tool[]>
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<CallToolResult>
  close(): Promise<void>
}

export function errorResult(code: string): CallToolResult {
  const data = { code, ...(code === 'COMPUTER_USE_UNKNOWN' ? { effect: 'unknown' } : {}) }
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data }
}
