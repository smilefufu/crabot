// CLI and browser-admin release adapters share read/copy preparation. The target
// coordinator owns the stopped-state transaction; these functions never stop/start MM.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { stageRelease } from '../upgrade-lib/release.mjs'
import { prepareCliPayload, locateCliInstallation } from './cli-installation.mjs'
import { verifyCoreRelease } from './core-release.mjs'
import { runBounded } from './run-bounded.mjs'
import product from './product-runtime.cjs'

function currentInstallation(root) {
  const installation = locateCliInstallation(root)
  if (!installation?.selected || installation.scope !== 'user') throw new Error('此入口只更新当前独立 user CLI；system 和桌面安装必须使用对应管理入口。')
  return installation
}

// May run while MM is active: no data snapshot/migration, selector switch or service mutation.
export async function prepareDownloadedCliUpgrade({ root, artifact, logger }) {
  try {
    const installation = currentInstallation(root)
    await verifyCoreRelease(root) // Repair a damaged source from an external complete installer first.
    const staged = await stageRelease({ ...artifact, logger })
    const prepared = await prepareCliPayload({ sourceRoot: staged, installRoot: installation.root,
      version: artifact.version.replace(/^v/, '') })
    if (prepared.id === installation.id) throw new Error('目标与当前核心相同，无需切换。')
    return prepared
  } finally { await fs.rm(artifact.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}

export async function applyPreparedCliUpgrade({ root, dataDir, prepared }) {
  const source = currentInstallation(root), target = locateCliInstallation(prepared.coreRoot)
  if (!target || target.root !== source.root || target.id !== prepared.id || target.scope !== 'user') throw new Error('待安装核心不属于此 CLI 安装。')
  const release = await verifyCoreRelease(target.coreRoot, { version: prepared.version })
  if (release.inventory_sha256 !== prepared.id) throw new Error('待安装核心已改变。')
  const runtime = product.loadProductRuntime(target.coreRoot, { required: true })
  await runBounded(runtime.executables.node, [path.join(target.coreRoot, 'scripts/apply-cli-update.mjs'), root, dataDir], {
    cwd: target.coreRoot, env: { ...process.env, CRABOT_PRODUCT_REQUIRED: '1', CRABOT_HOME: target.coreRoot, DATA_DIR: dataDir },
  })
  return prepared
}

export async function applyDownloadedCliUpgrade(options) {
  const prepared = await prepareDownloadedCliUpgrade(options)
  return applyPreparedCliUpgrade({ ...options, prepared })
}
