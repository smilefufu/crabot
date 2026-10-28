// Fresh bundled installation only. Existing legacy inventory requires S5 takeover.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SystemRegistry, systemError } from './lib/system-registry.mjs'
import { installSystemUserService, systemdAvailable } from './lib/system-service.mjs'
import cliLocation from './lib/cli-location.cjs'
import { verifyRootExecutable } from './lib/system-user.mjs'
try {
  const root = fileURLToPath(new URL('../', import.meta.url)), registry = new SystemRegistry()
  registry.authority()
  const installation = cliLocation.assertSelectedCli(root)
  if (!installation || installation.scope !== 'system') throw systemError('只接受已选中的完整system发行。')
  verifyRootExecutable(path.join(root, 'scripts/system-user-helper.mjs'))
  verifyRootExecutable(path.join(root, '.product-runtime/node/bin/node'))
  if (!fs.existsSync('/etc/crabot')) { fs.mkdirSync('/etc/crabot', { mode: 0o755 }); fs.chmodSync('/etc/crabot', 0o755) }
  if (!fs.existsSync(path.join(registry.directory, 'instances.json'))) {
    const old = '/etc/crabot/registry/ports.json'
    if (fs.existsSync(old)) {
      const stat = fs.lstatSync(old)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw systemError('发现无法核实的旧注册表，请先完成兼容转换。')
      const legacy = JSON.parse(fs.readFileSync(old, 'utf8'))
      if (!Array.isArray(legacy) || legacy.length) throw systemError('发现旧system用户，未创建空注册表覆盖；请先完成兼容转换。')
    }
    await registry.update(() => [], { create: true })
  } else registry.read()
  if (systemdAvailable()) installSystemUserService(installation.root)
  else console.log('[crabot] 此环境没有systemd，未安装托管服务；保留CLI模式，托管开通验收尚不可用。')
} catch (error) { console.error('[crabot] ' + error.message); process.exitCode = 1 }
