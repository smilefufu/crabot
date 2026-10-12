import { defineTool, type ToolDefinition } from '../engine/index.js'
import { GUIDANCE } from './content.js'

export type GuidanceRole = 'manager' | 'worker'
export interface GuidanceOptions { readonly computerUse?: boolean }
export type GuidanceName = keyof typeof GUIDANCE

export function guidanceNames(role: GuidanceRole, options: GuidanceOptions = {}): GuidanceName[] {
  return (Object.keys(GUIDANCE) as GuidanceName[]).filter(name => name.startsWith(`${role}.`) && (options.computerUse || !name.endsWith('.computer-use')))
}

export function guidanceCatalog(role: GuidanceRole, options: GuidanceOptions = {}): string {
  return '## 内置 guidance\n\n' + guidanceNames(role, options).map(name =>
    `${name} — ${GUIDANCE[name].title}。${GUIDANCE[name].body.split('\n')[0]}`,
  ).join('\n')
}

export function renderGuidance(role: GuidanceRole, name: string, options: GuidanceOptions = {}): string {
  if (!guidanceNames(role, options).includes(name as GuidanceName)) throw new Error(`当前角色没有 guidance：${name}`)
  const guide = GUIDANCE[name as GuidanceName]
  return `## Guidance: ${name}（${guide.title}）\n\n${guide.body}`
}

export function createGuidanceTool(role: GuidanceRole, options: GuidanceOptions = {}): ToolDefinition {
  return defineTool({
    name: 'load_guidance',
    description: '按名称读取内置工作流。首次进入目录描述的场景时，在相关动作前读取；上下文已有完整有效正文则直接沿用。仅支持当前角色目录，与用户 Skill 独立。',
    inputSchema: { type: 'object', properties: { name: { type: 'string', enum: guidanceNames(role, options) } }, required: ['name'], additionalProperties: false },
    isReadOnly: true,
    ...(options.computerUse ? { traceMetadata: { computer_use_guidance: true } } : {}),
    async call(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)
        || Object.keys(input).length !== 1 || typeof (input as { name?: unknown }).name !== 'string') {
        return { isError: true, output: '请提供一个目录中的 guidance 名称。' }
      }
      const name = (input as { name: string }).name
      try {
        const output = renderGuidance(role, name, options)
        return { output, isError: false }
      } catch (error) { return { output: (error as Error).message, isError: true } }
    },
  })
}
