import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { MANAGER_WORKFLOW_GUIDANCE, WORKER_WORKFLOW_GUIDANCE } from '../../src/prompts/workflow-guidance.js'
import { assembleManagerSystemPrompt } from '../../src/manager/prompt.js'
import { assembleBuiltinWorkerPrompt } from '../../src/prompts/builtin-worker.js'
import { workerTaskInstructions } from '../../src/guidance/worker-bridge.js'
const baseline = resolve(__dirname, '../../eval/workbuddy/baselines/2026-11-10')
const manifest = JSON.parse(readFileSync(resolve(baseline, 'manifest.json'), 'utf8'))

describe('evaluated workflows are installed in product roles', () => {
  it('keeps the evaluated Manager/Worker text and Skill payload hashes', () => {
    expect(MANAGER_WORKFLOW_GUIDANCE).toBe(readFileSync(resolve(baseline, 'harness/latest/manager.md'), 'utf8').trim())
    expect(WORKER_WORKFLOW_GUIDANCE).toBe(readFileSync(resolve(baseline, 'harness/latest/worker.md'), 'utf8').trim())
    for (const name of ['browser-interaction-test-check', 'web-page-visual-check', 'pptx-source-to-delivery']) {
      const content = readFileSync(resolve(__dirname, '../../../crabot-admin/builtins/skills', name, 'SKILL.md'))
      expect(createHash('sha256').update(content).digest('hex')).toBe(manifest.inputs[`harness/latest/skills/${name}/SKILL.md`])
    }
  })
  it('ordinary Manager receives the template once and the independent daily workflow remains isolated', () => {
    const prompt = assembleManagerSystemPrompt({ managerKey: 'fixture::ordinary', isSystemThread: false })
    expect(prompt.split(MANAGER_WORKFLOW_GUIDANCE)).toHaveLength(2)
    expect(assembleManagerSystemPrompt({ managerKey: 'fixture::daily', isSystemThread: true, isBuiltinDailyReflection: true })).not.toContain(MANAGER_WORKFLOW_GUIDANCE)
  })
  it('builtin and native CLI mainline instructions contain identical Worker workflows once', () => {
    const builtin = assembleBuiltinWorkerPrompt({ workspaceRoot: '/fixture', imageAvailable: false })
    for (const prompt of [builtin, workerTaskInstructions(false), workerTaskInstructions(true)]) expect(prompt.split(WORKER_WORKFLOW_GUIDANCE)).toHaveLength(2)
    expect(builtin).not.toContain(MANAGER_WORKFLOW_GUIDANCE)
  })
})
