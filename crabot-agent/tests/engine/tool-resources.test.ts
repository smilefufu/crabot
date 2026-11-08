import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readExecutionResources, resourceChildEnv } from '../../src/engine/tool-resources'
import { launchHostProcess, runHostProcess } from '../../src/engine/host-process'

const dirs: string[] = []
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); dirs.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })) })
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crabot-cpu-')); dirs.push(root)
  const mount = path.join(root, 'cg'), leaf = path.join(mount, 'task', 'control')
  fs.mkdirSync(leaf, { recursive: true }); fs.mkdirSync(path.join(root, 'self'))
  fs.writeFileSync(path.join(root, 'self/cgroup'), '0::/task/control\n')
  fs.writeFileSync(path.join(root, 'self/mountinfo'), `1 0 0:1 / ${mount} rw - cgroup2 cgroup rw\n`)
  for (const dir of [mount, path.dirname(leaf), leaf]) {
    fs.writeFileSync(path.join(dir, 'cpu.max'), dir === path.dirname(leaf) ? '200000 100000' : 'max 100000')
    fs.writeFileSync(path.join(dir, 'memory.max'), dir === path.dirname(leaf) ? '4294967296' : 'max')
  }
  return { root, mount, leaf }
}

describe('actual execution budget', () => {
  it('uses ancestor quota rather than the 24 CPUs visible to a container', () => {
    const { root } = fixture()
    const budget = readExecutionResources({ platform: 'linux', procRoot: root, visibleCpuCount: 24 })
    expect(budget.observed).toEqual({ visible_cpu_count: 24, cpu_quota: 2, memory_bytes: 4294967296 })
    expect(budget.effective).toEqual({ cpu_count: 2, memory_bytes: 4294967296 })
    expect(budget.protection).toBe('unprotected')
    expect(resourceChildEnv({ PATH: '/bin', PYTEST_XDIST_AUTO_NUM_WORKERS: '24' }, budget).PYTEST_XDIST_AUTO_NUM_WORKERS).toBe('2')
    expect(process.env.PYTEST_XDIST_AUTO_NUM_WORKERS).toBeUndefined()
  })
  it('keeps declaration distinct, takes stricter constraints and floors fractional quota', () => {
    const { root, leaf } = fixture()
    fs.writeFileSync(path.join(leaf, 'cpu.max'), '150000 100000')
    vi.stubEnv('CRABOT_EXECUTION_CPU_LIMIT', '8'); vi.stubEnv('CRABOT_EXECUTION_MEMORY_BYTES', '2147483648')
    const budget = readExecutionResources({ platform: 'linux', procRoot: root, visibleCpuCount: 24 })
    expect(budget.declared).toEqual({ cpu: 8, memory_bytes: 2147483648 })
    expect(budget.observed.cpu_quota).toBe(1.5)
    expect(budget.effective).toEqual({ cpu_count: 1, memory_bytes: 2147483648 })
  })
  it('never treats a configured path on an ordinary filesystem as protection', async () => {
    const { root } = fixture(); vi.stubEnv('CRABOT_TOOL_CGROUP_ROOT', root)
    expect(readExecutionResources().protection).toBe('unavailable')
    const marker = path.join(root, 'executed')
    const outcome = await runHostProcess({ argv: [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
      limits: { timeoutMs: 2000, stdoutBytes: 4096, stderrBytes: 4096 } })
    expect(outcome.kind).toBe('spawn_error')
    expect(outcome.message).toContain('RESOURCE_PROTECTION_UNAVAILABLE')
    expect(fs.existsSync(marker)).toBe(false)
  })
  it('leaves unobservable cgroup facts unknown instead of claiming host RAM as tool budget', () => {
    const { root } = fixture(); fs.unlinkSync(path.join(root, 'self/cgroup'))
    const budget = readExecutionResources({ platform: 'linux', procRoot: root, visibleCpuCount: 24 })
    expect(budget.observed.cpu_quota).toBeNull(); expect(budget.effective.memory_bytes).toBeNull()
  })
})

it('maps an explicitly delegated bind subtree instead of reading the unrelated host root', () => {
  const { root, mount, leaf } = fixture()
  fs.writeFileSync(path.join(root, 'self/cgroup'), '0::/docker/task/control\n')
  fs.writeFileSync(path.join(root, 'self/mountinfo'), `1 0 0:1 / /nonexistent rw - cgroup2 cgroup rw\n2 0 0:1 /docker ${mount} rw - cgroup2 cgroup rw\n`)
  expect(readExecutionResources({ platform: 'linux', procRoot: root, visibleCpuCount: 24 }).effective.cpu_count).toBe(2)
})

it('passes the effective auto budget to a real child, without rewriting explicit arguments', async () => {
  vi.stubEnv('CRABOT_EXECUTION_CPU_LIMIT', '2')
  vi.stubEnv('PYTEST_XDIST_AUTO_NUM_WORKERS', '24')
  const output = await runHostProcess({ argv: [process.execPath, '-e', 'console.log(process.env.PYTEST_XDIST_AUTO_NUM_WORKERS); console.log(process.argv[1])', '--', '-n24'],
    limits: { timeoutMs: 2000, stdoutBytes: 4096, stderrBytes: 4096 } })
  expect(output.stdout.trim()).toBe('2\n-n24')
  expect(process.env.PYTEST_XDIST_AUTO_NUM_WORKERS).toBe('24')
})

it('rejects incomplete protected stdio before allocating a scope or executing code', () => {
  vi.stubEnv('CRABOT_TOOL_CGROUP_ROOT', '/not-used')
  expect(() => launchHostProcess({ argv: [process.execPath, '-e', 'process.exit(0)'], stdio: ['ignore'] })).toThrow('three explicit stdio')
})
