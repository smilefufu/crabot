/**
 * ModuleInstaller P6-D 退役语义测试。
 * 旧「install/preview 拒绝 Agent 包」断言已随入口删除而退役：现在没有任何经
 * ModuleInstaller 到达 runtime/build/record 创建的路径；门禁唯一保留在
 * ModuleValidator.validate（module_type=agent → HOTPLUG_NOT_ALLOWED）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import { ModuleInstaller } from './module-installer.js'
import { ModuleValidator } from './module-validator.js'

describe('ModuleInstaller P6-D retirement', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = path.join(process.cwd(), 'test-data', `installer-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await fs.mkdir(dataDir, { recursive: true })
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('install/uninstall/preview 入口不存在', async () => {
    const installer = new ModuleInstaller(dataDir)
    const anyInstaller = installer as unknown as Record<string, unknown>
    expect(anyInstaller.install).toBeUndefined()
    expect(anyInstaller.uninstall).toBeUndefined()
    expect(anyInstaller.preview).toBeUndefined()
  })

  it('validator 对 agent manifest 输出 HOTPLUG_NOT_ALLOWED（非可安装 definition）', async () => {
    const pkg = path.join(dataDir, 'pkg')
    await fs.mkdir(pkg, { recursive: true })
    await fs.writeFile(path.join(pkg, 'crabot-module.yaml'), [
      'module_id: rogue-agent',
      'name: Rogue',
      'version: 1.0.0',
      'module_type: agent',
      'protocol_version: "0.2.0"',
      'runtime:',
      '  type: nodejs',
      'entry: index.js',
      'agent:',
      '  engine: custom',
      '  supported_roles: [front]',
      '  model_format: openai',
      '  model_roles: []',
    ].join('\n'))
    await fs.writeFile(path.join(pkg, 'index.js'), 'console.log(1)')
    const validator = new ModuleValidator()
    await expect(validator.validate(pkg)).rejects.toThrow('ADMIN_HOTPLUG_NOT_ALLOWED')
  })
})
