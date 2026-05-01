import { describe, it, expect } from 'vitest'
import { buildCreateScheduleBody } from './schedule.js'

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

    it('--target-channel/--target-session 进 task_template.input', () => {
      const body = buildCreateScheduleBody({
        title: 't',
        priority: 'normal',
        cron: '0 0 * * *',
        targetChannel: 'telegram-001',
        targetSession: 'sess-abc',
      })
      const tt = body['task_template'] as Record<string, unknown>
      expect(tt['input']).toEqual({
        target_channel_id: 'telegram-001',
        target_session_id: 'sess-abc',
      })
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

    it('--cron 和 --trigger-at 都缺失报错', () => {
      expect(() =>
        buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
        })
      ).toThrow(/必须提供 --cron.*或 --trigger-at/)
    })

    it('--cron 和 --trigger-at 同时提供报错', () => {
      expect(() =>
        buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
          cron: '0 0 * * *',
          triggerAt: '2026-05-01T09:00:00+08:00',
        })
      ).toThrow(/互斥/)
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

  describe('creator_friend_id 通过 env 注入', () => {
    it('CRABOT_TASK_FRIEND_ID 非空时塞进 body', () => {
      const original = process.env.CRABOT_TASK_FRIEND_ID
      process.env.CRABOT_TASK_FRIEND_ID = 'friend-master-123'
      try {
        const body = buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
          cron: '0 0 * * *',
        })
        expect(body['creator_friend_id']).toBe('friend-master-123')
      } finally {
        if (original === undefined) delete process.env.CRABOT_TASK_FRIEND_ID
        else process.env.CRABOT_TASK_FRIEND_ID = original
      }
    })

    it('CRABOT_TASK_FRIEND_ID 未设置时不塞 creator_friend_id', () => {
      const original = process.env.CRABOT_TASK_FRIEND_ID
      delete process.env.CRABOT_TASK_FRIEND_ID
      try {
        const body = buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
          cron: '0 0 * * *',
        })
        expect(body['creator_friend_id']).toBeUndefined()
      } finally {
        if (original !== undefined) process.env.CRABOT_TASK_FRIEND_ID = original
      }
    })

    it('CRABOT_TASK_FRIEND_ID 是空白字符串时也不塞', () => {
      const original = process.env.CRABOT_TASK_FRIEND_ID
      process.env.CRABOT_TASK_FRIEND_ID = '   '
      try {
        const body = buildCreateScheduleBody({
          title: 't',
          priority: 'normal',
          cron: '0 0 * * *',
        })
        expect(body['creator_friend_id']).toBeUndefined()
      } finally {
        if (original === undefined) delete process.env.CRABOT_TASK_FRIEND_ID
        else process.env.CRABOT_TASK_FRIEND_ID = original
      }
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
