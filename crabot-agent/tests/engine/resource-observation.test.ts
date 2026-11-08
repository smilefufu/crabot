import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { executionObservation, requestObservation, readObservation, persistObservation } from '../../src/permissions/execution-observation'
import { assembleBuiltinWorkerPrompt } from '../../src/prompts/builtin-worker'
import { assembleManagerSystemPrompt } from '../../src/manager/prompt'
import { assembleSubAgentPrompt } from '../../src/agent/subagent-prompt-assembler'
afterEach(() => vi.unstubAllEnvs())
it('projects a real budget into planned/assembled observations and Manager/Worker/child model contexts', () => {
  vi.stubEnv('CRABOT_EXECUTION_CPU_LIMIT', '2')
  const input = { role: 'worker' as const, impl: 'builtin' as const, source: 'builtin_request' as const }
  expect(executionObservation(input).resources?.effective.cpu_count).toBe(2)
  const observation = requestObservation([], input)
  expect(observation.resources?.effective.cpu_count).toBe(2)
  vi.stubEnv('CRABOT_EXECUTION_CPU_LIMIT', '1')
  expect(requestObservation([], input).revision).not.toBe(observation.revision)
  for (const prompt of [
    assembleBuiltinWorkerPrompt({ workspaceRoot: '/work', imageAvailable: false }),
    assembleManagerSystemPrompt({ managerKey: 'feishu:chat', isSystemThread: false }),
    assembleSubAgentPrompt({ name: 'fixture', role: '', workflow: '', deliverables: '', when_to_use: '' } as any, { parentTaskId: 't', callerLabel: 'worker' }),
  ]) expect(prompt).toContain('"cpu_count":1')
})
it('keeps historical/CLI unknowns and rejects malformed stored resource claims', async () => {
  vi.stubEnv('CRABOT_EXECUTION_CPU_LIMIT', '2')
  const fallback = executionObservation({ role: 'worker', impl: 'builtin', source: 'legacy', state: 'legacy_unknown' })
  expect(fallback.resources).toBeUndefined()
  expect(executionObservation({ role: 'worker', impl: 'codex', source: 'cli_provision' }).resources).toBeUndefined()
  expect(requestObservation([], { role: 'worker', impl: 'codex', source: 'cli_provision' }).resources).toBeUndefined()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resources-record-')), file = path.join(root, 'observed.json')
  try {
    const record = requestObservation([], { role: 'worker', impl: 'builtin', source: 'builtin_request' })
    delete record.resources
    await persistObservation(file, record)
    expect((await readObservation(file, fallback)).resources).toBeUndefined()
    await fs.writeFile(file, JSON.stringify({ ...record, resources: { protection: 'cgroup_v2' } }))
    await expect(readObservation(file, fallback)).rejects.toThrow('Corrupt execution observation')
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})
