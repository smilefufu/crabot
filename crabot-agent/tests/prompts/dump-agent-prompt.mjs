import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const { assembleAgentPrompt } = require('../../dist/prompts/assemble-agent.js')

const prompt = assembleAgentPrompt({
  goalModeEnabled: true,
  adminPersonality: '你是 Crabot 在开发工作区的主控 agent。保持直接、谨慎、证据驱动。',
  sceneProfile: {
    label: 'crabot-dev',
    content: 'Crabot 自身开发场景；代码改动需要对齐 crabot-docs 里的设计记录。',
  },
  skillListing: [
    '## available_skills',
    '- workspace-context-maintenance: 维护工作区上下文文档',
    '- writing-plans: 将 spec 落成实施计划',
  ].join('\n'),
  availableSubAgents: [
    { toolName: 'research_collector', workerHint: '信息收集类工作的默认派遣对象' },
    { toolName: 'code_planner', workerHint: '复杂编码任务的计划拆解专家' },
    { toolName: 'code_writer', workerHint: '执行一个自包含编码 task' },
    { toolName: 'task_reviewer', workerHint: '默认 task 审查员：一次性审 spec_compliance 与 code_quality' },
    { toolName: 'spec_reviewer', workerHint: '按 task 规范审查实现是否合规' },
    { toolName: 'code_quality_reviewer', workerHint: '审查代码质量、命名、错误处理和测试覆盖' },
  ],
})

const outArg = process.argv[2]
if (!outArg) {
  process.stdout.write(prompt)
} else {
  const outPath = resolve(process.cwd(), outArg)
  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, prompt, 'utf8')
}
