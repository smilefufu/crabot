import type { ResumeCheckpoint } from '../types.js'
import type { EngineMessage } from '../engine/types.js'
import { redactSecrets } from '../engine/redact-secrets.js'
import { hasDanglingToolUse } from '../engine/tool-message-integrity.js'

export type ResumeGuard = { ok: true } | { ok: false; reason: 'empty_checkpoint' | 'version_mismatch' | 'dangling_tool_use' }

export function isResumable(cp: ResumeCheckpoint, currentVersion: string): ResumeGuard {
  if (cp.agent_version !== currentVersion) return { ok: false, reason: 'version_mismatch' }
  if (!cp.messages || cp.messages.length === 0) return { ok: false, reason: 'empty_checkpoint' }
  if (hasDanglingToolUse(cp.messages)) return { ok: false, reason: 'dangling_tool_use' }
  return { ok: true }
}

/**
 * 对 ResumeCheckpoint 做脱敏处理，用于 UI 读路径（get_trace）。
 * 纯函数，返回新对象；落盘和 resume 读路径不受影响。
 */
export function redactCheckpoint(cp: ResumeCheckpoint, secrets: readonly string[]): ResumeCheckpoint {
  const redactedSystemPrompt = redactSecrets(cp.system_prompt, secrets)
  const messagesJson = redactSecrets(JSON.stringify(cp.messages), secrets)
  const redactedMessages = JSON.parse(messagesJson) as EngineMessage[]
  return {
    ...cp,
    system_prompt: redactedSystemPrompt,
    messages: redactedMessages,
  }
}

export function buildResumeWakeupMessage(): EngineMessage {
  return {
    id: `resume-wakeup-${Date.now()}`,
    role: 'user',
    content:
      '[系统] 你（agent）刚重启过，正在恢复此 task。若你之前 spawn 过子 agent 或在 end_turn 等待，' +
      '它们已随重启中断——用 list_entities / find_task / get_task_progress / 读 result 文件自查进度后，继续把任务做完。',
    timestamp: Date.now(),
  }
}

export function buildRestartCompletedWakeupMessage(): EngineMessage {
  return {
    id: `restart-done-${Date.now()}`,
    role: 'user',
    content:
      '[系统] 你请求的整实例重启已完成，你现在运行在重启后的新进程里。控制权交回给你：' +
      '若重启就是本任务的全部目标，向 master 确认重启完成即可（任务随之结束）；' +
      '若重启只是中间一步（如自我进化），用 list_entities / find_task / get_task_progress 自查后继续后续工作。',
    timestamp: Date.now(),
  }
}

export function buildTerminalSupplementWakeupMessage(text: string): EngineMessage {
  return {
    id: `terminal-supplement-${Date.now()}`,
    role: 'user',
    content: `用户补充：\n${text}`,
    timestamp: Date.now(),
  }
}
