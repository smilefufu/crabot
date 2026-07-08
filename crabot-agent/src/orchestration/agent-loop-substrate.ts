import type { AgentHandler } from '../agent/agent-handler.js'
import type { ExecuteTaskParams, ExecuteTaskResult } from '../types.js'

export type AgentLoopExecuteTaskFn = (
  params: ExecuteTaskParams & { related_task_id?: string }
) => Promise<ExecuteTaskResult & { trace_id?: string }>

export class AgentLoopSubstrate {
  private agentHandler: AgentHandler | null = null

  constructor(private executeTaskFn?: AgentLoopExecuteTaskFn) {}

  setWorkerHandler(handler: AgentHandler): void {
    this.agentHandler = handler
  }

  async executeAgentLoop(
    params: ExecuteTaskParams & { related_task_id?: string },
  ): Promise<ExecuteTaskResult & { trace_id?: string }> {
    if (this.executeTaskFn) return this.executeTaskFn(params)
    if (!this.agentHandler) {
      throw new Error('AgentLoopSubstrate worker handler is not configured')
    }
    return this.agentHandler.executeTask(params)
  }

  executeAgentLoopInBackground(
    params: ExecuteTaskParams & { related_task_id?: string },
    label = 'agent loop',
    onError?: (error: unknown) => void | Promise<void>,
  ): void {
    this.executeAgentLoop(params).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[AgentLoopSubstrate] Unexpected error in ${label}: ${msg}`)
      if (onError) {
        Promise.resolve(onError(err)).catch((callbackErr) => {
          const callbackMsg = callbackErr instanceof Error ? callbackErr.message : String(callbackErr)
          console.error(`[AgentLoopSubstrate] Error handler failed in ${label}: ${callbackMsg}`)
        })
      }
    })
  }
}
