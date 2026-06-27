import { describe, it, expect, afterEach } from 'vitest'
import { resolve } from 'node:path'
import { getAdminDataDir, getAdminLogsDir } from '../../src/core/data-paths.js'

function clearEnv() {
  delete process.env.CRABOT_ADMIN_DATA_DIR
  delete process.env.DATA_DIR
}

describe('data-paths：admin 数据目录解析', () => {
  afterEach(clearEnv)

  it('CRABOT_ADMIN_DATA_DIR 优先（模块级）', () => {
    clearEnv()
    process.env.CRABOT_ADMIN_DATA_DIR = '/x/.crabot/data/admin'
    expect(getAdminDataDir()).toBe(resolve('/x/.crabot/data/admin'))
  })

  it('仅顶层 DATA_DIR 时 join("admin")', () => {
    clearEnv()
    process.env.DATA_DIR = '/x/.crabot/data'
    expect(getAdminDataDir()).toBe(resolve('/x/.crabot/data', 'admin'))
  })

  it('都没有时回退 ./data/admin', () => {
    clearEnv()
    expect(getAdminDataDir()).toBe(resolve('./data/admin'))
  })

  it('getAdminLogsDir = 顶层 logs（admin 的兄弟）', () => {
    clearEnv()
    process.env.CRABOT_ADMIN_DATA_DIR = '/x/.crabot/data/admin'
    expect(getAdminLogsDir()).toBe(resolve('/x/.crabot/data/admin', '..', 'logs'))
  })
})
