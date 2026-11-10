import { afterEach, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runShellWithGrace, stdoutFileForLog, stderrFileForLog } from '../../../src/engine/bg-entities/bg-shell'
import { BgEntityRegistry } from '../../../src/engine/bg-entities/registry'
import type { BgShellRegistryRecord } from '../../../src/engine/bg-entities/types'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'output-retention-'))
  roots.push(root)
  vi.stubEnv('DATA_DIR', root)
  return { root, registry: new BgEntityRegistry(path.join(root, 'registry.json')) }
}

it.each([0, 7])('retains the final stdout/stderr before publishing background exit %i', async exitCode => {
  const { root, registry } = await fixture()
  let outputAtNotification: string | undefined
  const onShellExit = vi.fn(async ({ entity_id }) => {
    const record = await registry.get(entity_id)
    outputAtNotification = await fs.readFile((record as BgShellRegistryRecord).log_file, 'utf8')
  })
  const result = await runShellWithGrace({
    command: `sleep .2; printf final-stdout; printf final-stderr >&2; exit ${exitCode}`,
    cwd: root, registry, owner: { worker_id: 'w', incarnation_id: 'i' }, spawned_by_task_id: 'w',
    gracePeriodMs: 5, onShellExit,
  })
  expect(result.kind).toBe('background')
  if (result.kind !== 'background') throw new Error('not promoted')
  await vi.waitFor(() => expect(outputAtNotification).toContain('final-stdout'), { timeout: 3000 })
  expect(outputAtNotification).toContain('final-stderr')
  expect(onShellExit).toHaveBeenCalledTimes(1)
  expect(await registry.get(result.entity_id)).toMatchObject({
    status: exitCode === 0 ? 'completed' : 'failed', exit_code: exitCode,
    exit_notification: { status: 'pending' },
  })
})

it('keeps captures and does not publish successful completion if retaining output fails', async () => {
  const { root, registry } = await fixture()
  const original = fs.appendFile.bind(fs)
  const stat = fs.stat.bind(fs)
  vi.spyOn(fs, 'stat').mockImplementation(async (...args) => {
    const value = await stat(...args)
    return String(args[0]).endsWith('.log') ? { ...value, size: 0 } as typeof value : value
  })
  vi.spyOn(fs, 'appendFile').mockImplementation(async (file, data, ...args) => {
    if (String(data).includes('[capture recovery:')) throw new Error('diagnostic disk write failure')
    return original(file, data, ...args)
  })
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  const ended = vi.fn()
  const result = await runShellWithGrace({
    command: 'sleep .2; printf retained-output', cwd: root, registry,
    owner: { worker_id: 'w', incarnation_id: 'i' }, spawned_by_task_id: 'w', gracePeriodMs: 5, onShellExit: ended,
  })
  if (result.kind !== 'background') throw new Error('not promoted')
  await vi.waitFor(() => expect(errors).toHaveBeenCalled(), { timeout: 3000 })
  const record = await registry.get(result.entity_id) as BgShellRegistryRecord
  expect(record.status).toBe('running')
  expect(ended).not.toHaveBeenCalled()
  expect(await fs.readFile(stdoutFileForLog(record.log_file), 'utf8')).toBe('retained-output')
  expect(await fs.stat(stderrFileForLog(record.log_file))).toBeDefined()
})
