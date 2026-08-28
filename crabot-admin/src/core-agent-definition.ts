/**
 * Static core Agent contract（protocol-admin §3.19.8）。
 * Legacy implementation records are not authoritative——此定义由 release 唯一拥有。
 */
import type { AgentImplementation } from './types.js'

const CORE_BODY: AgentImplementation = {
  id: 'default',
  name: 'Crabot Default Agent',
  type: 'builtin',
  implementation_type: 'config_only',
  engine: 'claude-agent-sdk',
  supported_roles: ['front', 'worker'],
  model_format: 'anthropic',
  model_roles: [
    {
      key: 'powerful',
      description: '强力模型，用于主 worker / 复杂推理 / planning / Manager loop 对话与决策',
      required: true,
      recommended_capabilities: ['tool_use', 'long_context'],
      used_by: ['front', 'worker'],
      fallback: 'global_default',
    },
    {
      key: 'cost_effective',
      description: '性价比模型，用于简单执行 / 摘要 / 低复杂度调用 / 视觉内容消化',
      required: false,
      recommended_capabilities: ['fast'],
      used_by: ['front', 'worker'],
      fallback: 'global_default',
    },
  ],
  extra_schema: [
    {
      key: 'progress_report_master_private',
      title: 'Master 私聊汇报',
      description: 'Master 私聊场景下的进度汇报行为',
      type: 'select',
      default: 'digest',
      options: [
        { value: 'silent', label: '静默' },
        { value: 'text_forward', label: '文本转发' },
        { value: 'digest', label: '定期摘要' },
      ],
    },
    {
      key: 'progress_report_other_private',
      title: '其他私聊汇报',
      description: '非 Master 的普通好友私聊场景下的进度汇报行为',
      type: 'select',
      default: 'silent',
      options: [
        { value: 'silent', label: '静默' },
        { value: 'text_forward', label: '文本转发' },
        { value: 'digest', label: '定期摘要' },
      ],
    },
    {
      key: 'progress_report_group',
      title: '群聊汇报',
      description: '群聊场景下的进度汇报行为',
      type: 'select',
      default: 'silent',
      options: [
        { value: 'silent', label: '静默' },
        { value: 'text_forward', label: '文本转发' },
        { value: 'digest', label: '定期摘要' },
      ],
    },
    {
      key: 'progress_digest_interval_seconds',
      title: '摘要间隔（秒）',
      description: '定期摘要模式下的汇报间隔',
      type: 'number',
      default: 1800,
      visible_when: {
        any_of: [
          'progress_report_master_private',
          'progress_report_other_private',
          'progress_report_group',
        ],
        equals: 'digest',
      },
    },
    {
      key: 'progress_digest_mode',
      title: '摘要模式',
      description: 'llm: 用 LLM 生成摘要；extract: 直接提取关键句',
      type: 'select',
      default: 'llm',
      options: [
        { value: 'llm', label: 'LLM 摘要' },
        { value: 'extract', label: '提取关键句' },
      ],
      visible_when: {
        any_of: [
          'progress_report_master_private',
          'progress_report_other_private',
          'progress_report_group',
        ],
        equals: 'digest',
      },
    },
    {
      key: 'group_attention_min_ms',
      title: '群聊最小巡检间隔（ms）',
      description: 'Agent 刚回复后的最小巡检间隔',
      type: 'number',
      default: 120000,
    },
    {
      key: 'group_attention_max_ms',
      title: '群聊最大巡检间隔（ms）',
      description: '群聊巡检间隔的上限',
      type: 'number',
      default: 1800000,
    },
    {
      key: 'goal_mode_enabled',
      title: '目标模式',
      description: '启用后 Worker 可设定任务目标承诺，完成时触发独立审计校验；关闭后直接完成任务无需审计',
      type: 'boolean',
      default: true,
    },
  ],
  version: '0.1.0',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
}

export const CORE_AGENT_DEFINITION: AgentImplementation = Object.freeze({
  ...CORE_BODY,
  id: 'crabot-agent',
  name: 'Crabot Core Agent',
})
