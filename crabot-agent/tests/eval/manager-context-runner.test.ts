import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  redactForEvaluation,
  runBehaviorEvaluation,
  runDeterministicEvaluation,
  selectMemoryWriteCalls,
} from '../../eval/manager-context/runner.js'

const EVAL_ENV_NAMES = [
  'EVAL_FORMAT',
  'EVAL_ENDPOINT',
  'EVAL_API_KEY',
  'EVAL_MODEL',
  'EVAL_ACCOUNT_ID',
] as const

const originalEvalEnv = Object.fromEntries(EVAL_ENV_NAMES.map((name) => [name, process.env[name]]))

afterEach(() => {
  for (const name of EVAL_ENV_NAMES) {
    const original = originalEvalEnv[name]
    if (original === undefined) delete process.env[name]
    else process.env[name] = original
  }
})

describe('manager context 隔离评测 runner', () => {
  it('确定性档穿过真实 Manager 栈并锁住五类零容忍断言', async () => {
    const root = await fs.mkdtemp(path.join(tmpdir(), 'manager-context-runner-test-'))
    try {
      const report = await runDeterministicEvaluation({
        fixtureDir: path.resolve(process.cwd(), 'eval/manager-context/fixtures'),
        tempRoot: root,
      })

      expect(report.status).toBe('passed')
      expect(report.requests.length).toBeGreaterThan(4)
      expect(report.memory_calls).toEqual([])
      expect(report.assertions.every((entry) => entry.passed)).toBe(true)

      const ids = new Set(report.assertions.map((entry) => entry.id))
      for (const id of [
        'workboard-not-injected-before-inspect',
        'project-doc-not-injected-before-read',
        'interleaved-worker-a-target',
        'revision-does-not-archive-old-result',
        'memory-has-no-workboard-or-project-doc-mirror',
      ]) {
        expect(ids).toContain(id)
      }

      const workboardRequests = report.requests.filter((request) => request.scenario === 'deterministic-workboard')
      expect(JSON.stringify(workboardRequests[0])).not.toContain('WORKBOARD_SENTINEL_MARSHMALLOW_CONTEXT')
      expect(JSON.stringify(workboardRequests[1])).toContain('WORKBOARD_SENTINEL_MARSHMALLOW_CONTEXT')

      const projected = JSON.stringify(report)
      expect(projected).not.toContain(root)
      expect(projected).toContain('<project_root>')
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 20_000)

  it('脱敏删除凭据、图片原文和运行时绝对路径', () => {
    const root = path.join(tmpdir(), 'manager-context-sensitive-root')
    const redacted = redactForEvaluation({
      authorization: 'Bearer secret-token',
      nested: {
        api_key: 'sk-secret',
        message: `路径 ${root}/data，Authorization: Bearer another-token`,
        image: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'raw-image-data' } },
      },
    }, new Map([[root, '<data_root>']]))
    const output = JSON.stringify(redacted)

    expect(output).not.toContain('secret-token')
    expect(output).not.toContain('sk-secret')
    expect(output).not.toContain('another-token')
    expect(output).not.toContain('raw-image-data')
    expect(output).not.toContain(root)
    expect(output).toContain('<data_root>')
    expect(output).toContain('[REDACTED_IMAGE]')
  })

  it('任务板镜像检查忽略只读查询但保留 Memory 写操作', () => {
    const calls = [
      { method: 'search_short_term', params: { query: '任务板内容' } },
      { method: 'search_long_term', params: { query: '项目决策' } },
      { method: 'quick_capture', params: { content: '跨任务偏好' } },
    ]

    expect(selectMemoryWriteCalls(calls)).toEqual([
      { method: 'quick_capture', params: { content: '跨任务偏好' } },
    ])
  })

  it('行为档缺少显式专用 Provider 配置时明确跳过且不发请求', async () => {
    for (const name of EVAL_ENV_NAMES) delete process.env[name]

    const report = await runBehaviorEvaluation({
      fixtureDir: path.resolve(process.cwd(), 'eval/manager-context/fixtures'),
    })

    expect(report.status).toBe('skipped')
    expect(report.skipped_reason).toContain('EVAL_API_KEY')
    expect(report.requests).toEqual([])
    expect(report.memory_calls).toEqual([])
    expect(report.messaging_calls).toEqual([])
    expect(report.worker_calls).toEqual([])
  })
})
