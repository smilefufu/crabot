import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import AdminModule from './index.js'

// #4: module_id 会拼进 module-configs/<id>.json。config 路由已在路由层挡穿越，
// 但 start/restart 经 handleStartModuleAdmin → handleGetModuleConfig 走到同一文件 sink，
// 绕过路由守卫。守卫下沉到 sink 后，穿越 id 读得空配置、写被硬拒，且不触碰目录外文件。
describe('#4 module-config 文件 sink 路径穿越守卫', () => {
  let admin: AdminModule
  let dataDir: string
  let secretPath: string

  beforeAll(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-cfg-guard-'))
    // 在 module-configs 目录外放一个“机密”文件，构造 ../ 穿越目标
    secretPath = path.join(dataDir, 'secret.json')
    await fs.writeFile(
      secretPath,
      JSON.stringify({ module_id: 'x', config: { STOLEN: 'yes' }, updated_at: '' })
    )

    admin = new AdminModule(
      {
        moduleId: 'admin-cfg-guard-test',
        moduleType: 'admin',
        version: '0.1.0',
        protocolVersion: '0.1.0',
        port: 0,
        subscriptions: [],
      },
      {
        web_port: 0,
        data_dir: dataDir,
        password_env: 'UNUSED',
        jwt_secret_env: 'UNUSED',
        token_ttl: 3600,
      }
    )
  })

  afterAll(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('handleGetModuleConfig 对穿越 id 返回空配置，不读目录外文件', async () => {
    // module-configs/../secret.json 指向上面写的机密文件
    const result = await admin['handleGetModuleConfig']({ module_id: '../secret' })
    expect(result).toEqual({ config: {} })
  })

  it('handleSetModuleConfig 对穿越 id 硬拒，不写目录外文件', async () => {
    await expect(
      admin['handleSetModuleConfig']({ module_id: '../pwned', config: { EVIL: '1' } })
    ).rejects.toThrow(/Invalid module id/)
    // 确认目录外没有被写出文件
    await expect(fs.access(path.join(dataDir, 'pwned.json'))).rejects.toThrow()
  })

  it('合法 ASCII module_id 仍正常读写', async () => {
    await admin['handleSetModuleConfig']({ module_id: 'memory-default', config: { A: '1' } })
    const result = await admin['handleGetModuleConfig']({ module_id: 'memory-default' })
    expect(result.config).toEqual({ A: '1' })
  })
})
