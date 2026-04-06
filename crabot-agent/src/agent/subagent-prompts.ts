/**
 * Sub-agent system prompt templates.
 *
 * Each key corresponds to a model slot key (e.g. 'vision_expert').
 * Worker uses these when building delegate_to_subagent tools.
 */

export interface SubAgentDefinition {
  /** Model slot key (must match a key in model_config) */
  readonly slotKey: string
  /** Human-readable slot description (used in LLM requirements and Admin UI) */
  readonly slotDescription: string
  /** Recommended model capabilities for this slot */
  readonly recommendedCapabilities: readonly string[]
  /** Tool name exposed to Worker (prefixed with delegate_to_) */
  readonly toolName: string
  /** Tool description for Worker's LLM */
  readonly toolDescription: string
  /** System prompt for the sub-agent */
  readonly systemPrompt: string
  /** Description shown in Worker's system prompt */
  readonly workerHint: string
  /** Max turns for the sub-agent engine loop */
  readonly maxTurns: number
}

export const SUBAGENT_DEFINITIONS: readonly SubAgentDefinition[] = [
  {
    slotKey: 'vision_expert',
    slotDescription: '视觉专家 Sub-agent，用于截图分析、UI 识别、浏览器页面理解（可选）',
    recommendedCapabilities: ['vision'],
    toolName: 'delegate_to_vision_expert',
    toolDescription: '将视觉分析任务委派给视觉专家 Sub-agent。Sub-agent 在独立上下文中运行，擅长截图分析、UI 识别、浏览器页面理解。只返回最终分析结果。',
    systemPrompt: [
      '你是一个视觉分析专家。你擅长分析图片、截图和 UI 界面。',
      '',
      '## 工作规则',
      '1. 专注于完成委派给你的任务，给出清晰准确的分析结果',
      '2. 描述你看到的内容时要具体和结构化',
      '3. 不要做超出任务范围的事情',
      '4. 如果任务需要使用工具（如截图、点击等），直接使用',
      '5. 完成后给出简洁的最终结论',
    ].join('\n'),
    workerHint: '视觉分析专家，擅长截图分析、UI 识别、浏览器页面理解',
    maxTurns: 20,
  },
  {
    slotKey: 'coding_expert',
    slotDescription: '编码专家 Sub-agent，用于代码编写、代码分析、bug 修复（可选）',
    recommendedCapabilities: ['coding', 'tool_use'],
    toolName: 'delegate_to_coding_expert',
    toolDescription: '将编码任务委派给编码专家 Sub-agent。Sub-agent 在独立上下文中运行，擅长代码编写、代码分析、bug 修复。只返回最终结果。',
    systemPrompt: [
      '你是一个编码专家。你擅长编写高质量代码、分析代码问题和修复 bug。',
      '',
      '## 工作规则',
      '1. 专注于完成委派给你的任务',
      '2. 给出可直接使用的代码或明确的分析结论',
      '3. 如果需要读取文件或执行命令，直接使用工具',
      '4. 不要做超出任务范围的事情',
      '5. 完成后给出简洁的最终结论和代码',
    ].join('\n'),
    workerHint: '编码专家，擅长代码编写、代码分析、bug 修复',
    maxTurns: 30,
  },
] as const
