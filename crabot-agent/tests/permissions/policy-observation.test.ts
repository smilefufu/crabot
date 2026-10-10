import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { BUILTIN_WORKER_PERMISSIONS } from '../../src/workers/builtin/runtime.js'
import { assertExecutionPolicy, executionAdmission } from '../../src/workers/execution-policy.js'
import { checkFileAccess, authorizeTool, entryAuthorization, roleAuthorization } from '../../src/permissions/tool-authorization.js'
import { checkToolPermission } from '../../src/engine/permission-checker.js'
import { runEngine } from '../../src/engine/query-loop.js'
import { executionObservation, requestObservation, persistObservation, readObservation } from '../../src/permissions/execution-observation.js'
import { chunksFromContent } from '../engine/helpers/mock-stream.js'
import type { LLMAdapter } from '../../src/engine/llm-adapter.js'
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'entry-scope-')); roots.push(root)
  const workspace = path.join(root, 'workspace'); await fs.mkdir(workspace)
  return { root, workspace, principal: { ...BUILTIN_WORKER_PERMISSIONS, storage: { workspace_path: workspace, access: 'readwrite' as const } } }
}
it('scope guards new parents, lexical prefixes, traversal, existing and dangling symlinks', async () => {
  const { root, workspace, principal } = await fixture()
  await fs.mkdir(path.join(root, 'workspace-other')); await fs.writeFile(path.join(root, 'secret'), 'outside')
  await fs.symlink(root, path.join(workspace, 'escape'))
  await fs.symlink(path.join(root, 'not-created'), path.join(workspace, 'dangling'))
  for (const value of ['../secret', '../workspace-other/file', 'escape/secret', 'escape/new/child', 'dangling/new']) {
    expect((await checkFileAccess(principal, value, workspace, true)).allowed, value).toBe(false)
  }
  expect((await checkFileAccess(principal, 'new/child/file', workspace, true)).allowed).toBe(true)
  expect((await checkFileAccess({ ...principal, storage: null }, '.', workspace, false)).allowed).toBe(false)
})
it('a request bypass and a direct call both retain the host entry guard', async () => {
  const { principal } = await fixture(); principal.tool_access = { ...principal.tool_access, shell: false }
  const call = vi.fn(async () => ({ isError: false, output: 'side effect' }))
  const tool = authorizeTool({ name: 'Bash', description: '', inputSchema: {}, isReadOnly: false, call }, entryAuthorization('worker', 'shell', () => principal))
  expect((await checkToolPermission('Bash', {}, tool, { mode: 'bypass' })).allowed).toBe(false)
  expect((await tool.call({}, {})).isError).toBe(true); expect(call).not.toHaveBeenCalled()
})
it('CLI admission requires explicit whole host authority and rejects unsupported Windows scope', () => {
  const principal = { ...BUILTIN_WORKER_PERMISSIONS, storage: { workspace_path: '/', access: 'readwrite' as const } }
  expect(executionAdmission('codex', principal, 'linux').status).toBe('allowed')
  expect(executionAdmission('claude-code', { ...principal, storage: null }, 'linux').status).toBe('blocked')
  expect(executionAdmission('codex', principal, 'win32').status).toBe('blocked')
  expect(() => assertExecutionPolicy('builtin', undefined, true)).toThrow('CAPABILITY_UNKNOWN')
  expect(() => assertExecutionPolicy('builtin', undefined)).not.toThrow()
})
it('one tool thunk snapshot drives provider schemas, lookup and the observation, including denied exit tools', async () => {
  const call = vi.fn(async () => ({ isError: false, output: 'unused' }))
  const tool = authorizeTool({ name: 'finish', description: '', inputSchema: {}, isReadOnly: true, exitsLoop: true, call }, {
    ...roleAuthorization('worker'), check: async () => ({ allowed: false, reason: 'ROLE_FORBIDDEN: fixture' }),
  })
  const tools = vi.fn(() => [tool]); let requests = 0; const observed: string[][] = []
  const adapter: LLMAdapter = { updateConfig() {}, async *stream(input) {
    expect(input.tools?.map(item => item.name)).toEqual(['finish'])
    yield* chunksFromContent(requests++ === 0 ? [{ type: 'tool_use', id: 'exit', name: 'finish', input: {} }] : [{ type: 'text', text: 'finished normally' }], requests === 1 ? 'tool_use' : 'end_turn')
  } }
  const result = await runEngine({ prompt: 'fixture', adapter, options: { model: 'fixture', systemPrompt: '', tools,
    permissionConfig: { mode: 'bypass' }, maxTurns: 3, silentEndTurnPolicy: 'allow', disableCompaction: true,
    onBeforeLlmCall: async actual => { observed.push(requestObservation(actual, { role: 'worker', impl: 'builtin', source: 'builtin_request' }).tools!) },
  } })
  expect(result.exitToolCall).toBeUndefined(); expect(call).not.toHaveBeenCalled()
  expect(requests).toBe(2); expect(tools).toHaveBeenCalledTimes(2); expect(observed).toEqual([['finish'], ['finish']])
  expect(JSON.stringify(result.finalMessages)).toContain('ROLE_FORBIDDEN')
})
it('missing observations are legacy unknown; corruption and write failures are errors', async () => {
  const { root } = await fixture(); const file = path.join(root, 'observation.json')
  const fallback = executionObservation({ role: 'worker', impl: 'builtin', source: 'legacy', state: 'legacy_unknown' })
  expect(await readObservation(file, fallback)).toEqual(fallback)
  await fs.writeFile(file, '{broken')
  await expect(readObservation(file, fallback)).rejects.toThrow()
  await expect(persistObservation(path.join(file, 'child.json'), fallback)).rejects.toThrow()
})

it('missing host declarations fail assembly and observation revisions include profiles and constraints', () => {
  const bare = { name: 'fixture', description: '', inputSchema: {}, isReadOnly: true, call: async () => ({ isError: false, output: '' }) }
  expect(() => requestObservation([bare], { role: 'worker', impl: 'builtin', source: 'builtin_request' })).toThrow('CAPABILITY_UNAVAILABLE')
  const tool = authorizeTool(bare, roleAuthorization('worker'))
  const input = { role: 'worker' as const, impl: 'builtin' as const, source: 'builtin_request' as const }
  const initial = requestObservation([tool], input).revision
  expect(requestObservation([tool], { ...input, child_profiles: ['code_writer'] }).revision).not.toBe(initial)
  expect(requestObservation([tool], { ...input, constraints: ['fixture'] }).revision).not.toBe(initial)
})
