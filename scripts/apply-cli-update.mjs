#!/usr/bin/env node
// Internal entry: always executed by the already-verified target's own Node.
import { realpathSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import product from './lib/product-runtime.cjs'
import { applyStoppedCliUpgrade } from './lib/standalone-cli-upgrade.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const runtime = product.loadProductRuntime(root, { required: true })
if (realpathSync(process.execPath) !== realpathSync(runtime.executables.node)) throw new Error('CLI 更新必须使用目标内置 Node。')
const [sourceRoot, dataDir, ...extra] = process.argv.slice(2)
if (!sourceRoot || !dataDir || extra.length) throw new Error('CLI 更新参数不完整。')
const result = await applyStoppedCliUpgrade({ sourceRoot, targetRoot: root, dataDir, log: message => console.log(`[upgrade] ${message}`) })
console.log(`[upgrade] 已切换至 ${result.version} 并核验迁移；服务保持停止，启动与健康尚待 crabot start 验证。`)
