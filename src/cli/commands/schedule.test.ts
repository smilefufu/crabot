import { describe, it, expect } from 'vitest'
import {
  buildCreateScheduleBody,
  buildShowSchedulePath,
  buildUpdateScheduleBody,
  type ScheduleSnapshot,
} from './schedule.js'

describe('buildShowSchedulePath', () => {
  it('默认只读取 Schedule metadata，不请求脚本源码', () => {
    expect(buildShowSchedulePath('schedule-1')).toBe('/api/schedules/schedule-1')
  })

  it('显式要求时才请求脚本源码', () => {
    expect(buildShowSchedulePath('schedule-1', true)).toBe('/api/schedules/schedule-1?include_script_source=true')
  })
})

function makeCronSchedule(): ScheduleSnapshot {
  return {
    trigger: { type: 'cron', expression: '0 0 * * *', timezone: 'Asia/Shanghai' },
    task_template: {
      title: 'orig title',
      priority: 'normal',
      description: 'orig task desc',
      type: 'orig_type',
      tags: ['a', 'b'],
    },
  }
}

function makeScriptSchedule(): ScheduleSnapshot {
  return {
    trigger: { type: 'interval', seconds: 60 },
    script: {
      source: 'echo old',
      source_sha256: 'old-hash',
      timeout_seconds: 120,
      deliver_result: false,
    },
  }
}

describe('buildCreateScheduleBody', () => {
  describe('cron 触发器', () => {
    it('最小合法输入', () => {
      const body = buildCreateScheduleBody({
        title: 'quant-signal 巡检 — {{date}}',
        priority: 'normal',
        cron: '15 */4 * * *',
      })
      expect(body).toEqual({
        name: 'quant-signal 巡检 — {{date}}',
        enabled: true,
        trigger: {
          type: 'cron',
          expression: '15 */4 * * *',
          timezone: 'Asia/Shanghai',
        },
        task_template: {
          title: 'quant-signal 巡检 — {{date}}',
          priority: 'normal',
          tags: [],
        },
      })
    })

    it('--name 显式覆盖 task title 作为 schedule.name', () => {
      const body = buildCreateScheduleBody({
        title: 'GitHub 早报 — {{date}}',
        name: 'GitHub 排行榜每日早报',
        priority: 'normal',
        cron: '50 7 * * *',
      })
      expect(body['name']).toBe('GitHub 排行榜每日早报')
      const tt = body['task_template'] as Record<string, unknown>
      expect(tt['title']).toBe('GitHub 早报 — {{date}}')
    })

    it('--timezone 覆盖默认值', () => {
      const body = buildCreateScheduleBody({
        title: 't',
        priority: 'low',
        cron: '0 0 * * *',
        timezone: 'UTC',
      })
      expect((body['trigger'] as Record<string, unknown>)['timezone']).toBe('UTC')
    })

    it('--tag 多次收集进 task_template.tags', () => {
      const body = buildCreateScheduleBody({
        title: 't',
        priority: 'normal',
        cron: '0 0 * * *',
        tag: ['quant-signal', 'patrol', 'daily'],
      })
      const tt = body['task_template'] as Record<string, unknown>
      expect(tt['tags']).toEqual(['quant-signal', 'patrol', 'daily'])
    })

    it('--task-type 写入 task_template.type', () => {
      const body = buildCreateScheduleBody({
        title: 't',
        priority: 'low',
        cron: '0 0 * * *',
        taskType: 'daily_reflection',
      })
      const tt = body['task_template'] as Record<string, unknown>
      expect(tt['type']).toBe('daily_reflection')
    })

    it('--task-description 写入 task_template.description（不写到顶层）', () => {
      const body = buildCreateScheduleBody({
        title: 't',
        priority: 'low',
        cron: '0 0 * * *',
        taskDescription: 'LLM prompt for the worker',
      })
      const tt = body['task_template'] as Record<string, unknown>
      expect(tt['description']).toBe('LLM prompt for the worker')
      expect(body['description']).toBeUndefined()
    })

    it('--description 写入顶层 schedule.description', () => {
      const body = buildCreateScheduleBody({
        title: 't',
        priority: 'low',
        cron: '0 0 * * *',
        description: '人读说明',
      })
      expect(body['description']).toBe('人读说明')
      const tt = body['task_template'] as Record<string, unknown>
      expect(tt['description']).toBeUndefined()
    })

    it('--target-channel/--target-session/--target-type 进顶层 target_session', () => {
      const body = buildCreateScheduleBody({
        title: 't',
        priority: 'normal',
        cron: '0 0 * * *',
        targetChannel: 'telegram-001',
        targetSession: 'sess-abc',
        targetType: 'private',
      })
      expect(body['target_session']).toEqual({
        channel_id: 'telegram-001',
        session_id: 'sess-abc',
        type: 'private',
      })
      // task_template.input 不应再被写入 target_*
      const tt = body['task_template'] as Record<string, unknown>
      expect(tt['input']).toBeUndefined()
    })

    it('三个 target flag 缺 --target-channel 报错', () => {
      expect(() =>
        buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
          cron: '0 0 * * *',
          targetSession: 'sess-abc',
          targetType: 'private',
        })
      ).toThrow(/--target-channel.*--target-session.*--target-type 必须同时提供/)
    })

    it('三个 target flag 缺 --target-session 报错', () => {
      expect(() =>
        buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
          cron: '0 0 * * *',
          targetChannel: 'telegram-001',
          targetType: 'private',
        })
      ).toThrow(/--target-channel.*--target-session.*--target-type 必须同时提供/)
    })

    it('三个 target flag 缺 --target-type 报错', () => {
      expect(() =>
        buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
          cron: '0 0 * * *',
          targetChannel: 'telegram-001',
          targetSession: 'sess-abc',
        })
      ).toThrow(/--target-channel.*--target-session.*--target-type 必须同时提供/)
    })

    it('--target-type 不在白名单报错', () => {
      expect(() =>
        buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
          cron: '0 0 * * *',
          targetChannel: 'telegram-001',
          targetSession: 'sess-abc',
          targetType: 'channel',
        })
      ).toThrow(/--target-type 必须是 private \| group/)
    })

    it('--disabled 把 enabled 设为 false', () => {
      const body = buildCreateScheduleBody({
        title: 't',
        priority: 'low',
        cron: '0 0 * * *',
        disabled: true,
      })
      expect(body['enabled']).toBe(false)
    })
  })

  describe('once 触发器', () => {
    it('--trigger-at ISO 8601 含时区', () => {
      const body = buildCreateScheduleBody({
        title: 'remind me',
        priority: 'normal',
        triggerAt: '2026-05-01T09:00:00+08:00',
      })
      const trigger = body['trigger'] as Record<string, unknown>
      expect(trigger['type']).toBe('once')
      // 归一化为 UTC ISO
      expect(trigger['execute_at']).toBe('2026-05-01T01:00:00.000Z')
    })

    it('once 不附带 timezone 字段', () => {
      const body = buildCreateScheduleBody({
        title: 'remind me',
        priority: 'normal',
        triggerAt: '2026-05-01T09:00:00+08:00',
      })
      const trigger = body['trigger'] as Record<string, unknown>
      expect(trigger['timezone']).toBeUndefined()
    })
  })

  describe('interval 触发器', () => {
    it('--interval-seconds 进 trigger', () => {
      const body = buildCreateScheduleBody({
        title: 'patrol',
        priority: 'normal',
        intervalSeconds: '3600',
      })
      expect(body['trigger']).toEqual({ type: 'interval', seconds: 3600 })
    })

    it('interval 与 cron 互斥', () => {
      expect(() =>
        buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
          intervalSeconds: '60',
          cron: '0 0 * * *',
        })
      ).toThrow(/--cron \/ --interval-seconds \/ --trigger-at 三者互斥/)
    })

    it('interval 与 trigger-at 互斥', () => {
      expect(() =>
        buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
          intervalSeconds: '60',
          triggerAt: '2026-05-01T09:00:00+08:00',
        })
      ).toThrow(/--cron \/ --interval-seconds \/ --trigger-at 三者互斥/)
    })

    it('interval-seconds 非正整数报错', () => {
      expect(() =>
        buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
          intervalSeconds: '0',
        })
      ).toThrow(/--interval-seconds 必须是正整数/)

      expect(() =>
        buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
          intervalSeconds: 'abc',
        })
      ).toThrow(/--interval-seconds 必须是正整数/)
    })
  })

  describe('参数校验', () => {
    it('--title 为空报错', () => {
      expect(() =>
        buildCreateScheduleBody({
          title: '   ',
          priority: 'normal',
          cron: '0 0 * * *',
        })
      ).toThrow(/title 不能为空/)
    })

    it('--priority 不在白名单报错', () => {
      expect(() =>
        buildCreateScheduleBody({
          title: 't',
          priority: 'medium',
          cron: '0 0 * * *',
        })
      ).toThrow(/priority 必须是/)
    })

    it('三种 trigger flag 都缺失报错', () => {
      expect(() =>
        buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
        })
      ).toThrow(/必须提供 --cron \/ --interval-seconds \/ --trigger-at/)
    })

    it('--cron 和 --trigger-at 同时提供报错', () => {
      expect(() =>
        buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
          cron: '0 0 * * *',
          triggerAt: '2026-05-01T09:00:00+08:00',
        })
      ).toThrow(/--cron \/ --interval-seconds \/ --trigger-at 三者互斥/)
    })

    it('cron 字段不足 5 个报错', () => {
      expect(() =>
        buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
          cron: '0 0 * *',
        })
      ).toThrow(/至少需要 5 个字段/)
    })

    it('trigger-at 不可解析报错', () => {
      expect(() =>
        buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
          triggerAt: 'not-an-iso-date',
        })
      ).toThrow(/格式无效/)
    })
  })

  describe('script 内容', () => {
    it('与 instruction 二选一且不把 creator 写进 body', () => {
      process.env.CRABOT_TASK_FRIEND_ID = 'untrusted'
      const body = buildCreateScheduleBody({
        name: 'script job',
        script: 'echo ok',
        timeoutSeconds: '30',
        deliverResult: 'true',
        intervalSeconds: '60',
      })
      delete process.env.CRABOT_TASK_FRIEND_ID
      expect(body).toMatchObject({
        name: 'script job',
        script: { source: 'echo ok', timeout_seconds: 30, deliver_result: true },
      })
      expect(body['task_template']).toBeUndefined()
      expect(body['creator_friend_id']).toBeUndefined()
    })
  })

  describe('与现存 schedule 数据 shape 对齐回归测试', () => {
    // 验证 build 出的 body 喂给 admin handleCreateSchedule 后落盘的形态
    // 跟 data/admin/schedules.json 里的现存条目（Front 工具创建的那 5 条）字段同 shape
    it('构造出的 body 包含 admin 协议要求的所有顶层字段', () => {
      const body = buildCreateScheduleBody({
        title: 'quant-signal 巡检 — {{date}}',
        name: 'quant-signal 盘中顶底信号巡检',
        priority: 'normal',
        cron: '0 */4 * * *',
        timezone: 'Asia/Shanghai',
        taskType: 'quant_signal_patrol',
        tag: ['quant-signal', 'intraday', 'signal'],
        description: '每 4 小时由 Crabot 主动检查量化信号',
      })
      expect(Object.keys(body).sort()).toEqual(
        ['description', 'enabled', 'name', 'task_template', 'trigger'].sort()
      )
      const tt = body['task_template'] as Record<string, unknown>
      // priority/tags 必填，title 必填，type/description 可选
      expect(tt).toMatchObject({
        title: 'quant-signal 巡检 — {{date}}',
        priority: 'normal',
        tags: ['quant-signal', 'intraday', 'signal'],
        type: 'quant_signal_patrol',
      })
      const trigger = body['trigger'] as Record<string, unknown>
      expect(trigger).toEqual({
        type: 'cron',
        expression: '0 */4 * * *',
        timezone: 'Asia/Shanghai',
      })
    })
  })
})

// ---------------------------------------------------------------------------
// buildUpdateScheduleBody — 顶层标量 + 骨架
// ---------------------------------------------------------------------------

describe('buildUpdateScheduleBody — 顶层标量', () => {
  it('至少一个 flag 必给（空 opts 报错）', () => {
    expect(() =>
      buildUpdateScheduleBody(makeCronSchedule(), {})
    ).toThrow(/至少需要提供一个修改字段/)
  })

  it('单独 --name 只写 name 字段', () => {
    const body = buildUpdateScheduleBody(makeCronSchedule(), { name: '新名字' })
    expect(body).toEqual({ name: '新名字' })
  })

  it('--description 写 description', () => {
    const body = buildUpdateScheduleBody(makeCronSchedule(), { description: '新描述' })
    expect(body).toEqual({ description: '新描述' })
  })

  it('--enabled "true" → enabled: true', () => {
    const body = buildUpdateScheduleBody(makeCronSchedule(), { enabled: 'true' })
    expect(body).toEqual({ enabled: true })
  })

  it('--enabled "false" → enabled: false', () => {
    const body = buildUpdateScheduleBody(makeCronSchedule(), { enabled: 'false' })
    expect(body).toEqual({ enabled: false })
  })

  it('--enabled 非法值报错', () => {
    expect(() =>
      buildUpdateScheduleBody(makeCronSchedule(), { enabled: 'yes' })
    ).toThrow(/--enabled 必须是 true \| false/)
  })

  it('多字段一起写', () => {
    const body = buildUpdateScheduleBody(makeCronSchedule(), {
      name: '新',
      description: '新描述',
      enabled: 'false',
    })
    expect(body).toEqual({ name: '新', description: '新描述', enabled: false })
  })
})

describe('buildUpdateScheduleBody — trigger 字段级 merge', () => {
  function makeIntervalSchedule(): ScheduleSnapshot {
    return { ...makeCronSchedule(), trigger: { type: 'interval', seconds: 60 } }
  }
  function makeOnceSchedule(): ScheduleSnapshot {
    return { ...makeCronSchedule(), trigger: { type: 'once', execute_at: '2026-07-01T00:00:00Z' } }
  }

  it('cron schedule + --cron 只改 expression 保留 timezone', () => {
    const body = buildUpdateScheduleBody(makeCronSchedule(), { cron: '15 */4 * * *' })
    expect(body['trigger']).toEqual({
      type: 'cron',
      expression: '15 */4 * * *',
      timezone: 'Asia/Shanghai',
    })
  })

  it('cron schedule + --timezone 只改 timezone 保留 expression', () => {
    const body = buildUpdateScheduleBody(makeCronSchedule(), { timezone: 'UTC' })
    expect(body['trigger']).toEqual({
      type: 'cron',
      expression: '0 0 * * *',
      timezone: 'UTC',
    })
  })

  it('cron schedule + --cron + --timezone 同时改', () => {
    const body = buildUpdateScheduleBody(makeCronSchedule(), {
      cron: '0 9 * * *',
      timezone: 'UTC',
    })
    expect(body['trigger']).toEqual({
      type: 'cron',
      expression: '0 9 * * *',
      timezone: 'UTC',
    })
  })

  it('interval schedule + --interval-seconds 更新', () => {
    const body = buildUpdateScheduleBody(makeIntervalSchedule(), { intervalSeconds: '7200' })
    expect(body['trigger']).toEqual({ type: 'interval', seconds: 7200 })
  })

  it('once schedule + --trigger-at 更新（归一化为 UTC ISO）', () => {
    const body = buildUpdateScheduleBody(makeOnceSchedule(), {
      triggerAt: '2026-08-01T09:00:00+08:00',
    })
    expect(body['trigger']).toEqual({
      type: 'once',
      execute_at: '2026-08-01T01:00:00.000Z',
    })
  })

  it('cron schedule + --interval-seconds 报跨类型错', () => {
    expect(() =>
      buildUpdateScheduleBody(makeCronSchedule(), { intervalSeconds: '60' })
    ).toThrow(/当前 schedule 是 cron 类型.*--interval-seconds 仅适用于 interval 类型/)
  })

  it('interval schedule + --cron 报跨类型错', () => {
    expect(() =>
      buildUpdateScheduleBody(makeIntervalSchedule(), { cron: '0 0 * * *' })
    ).toThrow(/当前 schedule 是 interval 类型.*--cron 仅适用于 cron 类型/)
  })

  it('once schedule + --cron 报跨类型错', () => {
    expect(() =>
      buildUpdateScheduleBody(makeOnceSchedule(), { cron: '0 0 * * *' })
    ).toThrow(/当前 schedule 是 once 类型.*--cron 仅适用于 cron 类型/)
  })

  it('cron schedule + --trigger-at 报跨类型错', () => {
    expect(() =>
      buildUpdateScheduleBody(makeCronSchedule(), { triggerAt: '2026-08-01T00:00:00Z' })
    ).toThrow(/当前 schedule 是 cron 类型.*--trigger-at 仅适用于 once 类型/)
  })

  it('cron schedule + 非法 cron expression 报错', () => {
    expect(() =>
      buildUpdateScheduleBody(makeCronSchedule(), { cron: '0 0 * *' })
    ).toThrow(/--cron 表达式无效/)
  })

  it('interval schedule + 非正整数报错', () => {
    expect(() =>
      buildUpdateScheduleBody(makeIntervalSchedule(), { intervalSeconds: '0' })
    ).toThrow(/--interval-seconds 必须是正整数/)
  })

  it('once schedule + 非 ISO trigger-at 报错', () => {
    expect(() =>
      buildUpdateScheduleBody(makeOnceSchedule(), { triggerAt: 'not-iso' })
    ).toThrow(/--trigger-at 格式无效/)
  })
})

describe('buildUpdateScheduleBody — task_template 字段级 merge', () => {
  it('--title 只改 title 保留 priority/tags/description/type', () => {
    const body = buildUpdateScheduleBody(makeCronSchedule(), { title: '新标题' })
    expect(body['task_template']).toEqual({
      title: '新标题',
      priority: 'normal',
      description: 'orig task desc',
      type: 'orig_type',
      tags: ['a', 'b'],
    })
  })

  it('--task-priority 只改 priority', () => {
    const body = buildUpdateScheduleBody(makeCronSchedule(), { taskPriority: 'urgent' })
    const tt = body['task_template'] as Record<string, unknown>
    expect(tt['priority']).toBe('urgent')
    expect(tt['title']).toBe('orig title')
    expect(tt['tags']).toEqual(['a', 'b'])
  })

  it('--task-priority 不在白名单报错', () => {
    expect(() =>
      buildUpdateScheduleBody(makeCronSchedule(), { taskPriority: 'medium' })
    ).toThrow(/--task-priority 必须是 low \| normal \| high \| urgent/)
  })

  it('--task-description 改', () => {
    const body = buildUpdateScheduleBody(makeCronSchedule(), { taskDescription: '新任务描述' })
    expect((body['task_template'] as Record<string, unknown>)['description']).toBe('新任务描述')
  })

  it('--task-type 改', () => {
    const body = buildUpdateScheduleBody(makeCronSchedule(), { taskType: 'new_type' })
    expect((body['task_template'] as Record<string, unknown>)['type']).toBe('new_type')
  })

  it('--tag 覆盖原 tags（不追加）', () => {
    const body = buildUpdateScheduleBody(makeCronSchedule(), { tag: ['c', 'd'] })
    expect((body['task_template'] as Record<string, unknown>)['tags']).toEqual(['c', 'd'])
  })

  it('--clear-tags 清空 tags', () => {
    const body = buildUpdateScheduleBody(makeCronSchedule(), { clearTags: true })
    expect((body['task_template'] as Record<string, unknown>)['tags']).toEqual([])
  })

  it('--tag 与 --clear-tags 互斥', () => {
    expect(() =>
      buildUpdateScheduleBody(makeCronSchedule(), { tag: ['x'], clearTags: true })
    ).toThrow(/--tag 与 --clear-tags 互斥/)
  })

  it('--title + --task-priority 同时改', () => {
    const body = buildUpdateScheduleBody(makeCronSchedule(), {
      title: '新',
      taskPriority: 'high',
    })
    const tt = body['task_template'] as Record<string, unknown>
    expect(tt['title']).toBe('新')
    expect(tt['priority']).toBe('high')
  })
})

describe('buildUpdateScheduleBody — content branch', () => {
  it('从 instruction 原子切换为 script', () => {
    expect(buildUpdateScheduleBody(makeCronSchedule(), { script: 'echo next' })).toEqual({
      script: { source: 'echo next', deliver_result: false },
      task_template: null,
    })
  })

  it('修改脚本配置沿用显式读取的 source', () => {
    expect(buildUpdateScheduleBody(makeScriptSchedule(), {
      timeoutSeconds: '45',
      deliverResult: 'true',
    })).toEqual({
      script: { source: 'echo old', timeout_seconds: 45, deliver_result: true },
    })
  })

  it('从 script 切换为 instruction', () => {
    expect(buildUpdateScheduleBody(makeScriptSchedule(), { title: '巡检' })).toEqual({
      task_template: { title: '巡检', priority: 'normal', tags: [] },
      script: null,
    })
  })
})
