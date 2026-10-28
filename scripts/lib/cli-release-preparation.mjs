// Immutable payload preparation shared by user and administrator coordinators.
// Does not read instance data, stop services, migrate or change selection.
import { promises as fs } from 'node:fs'
import { stageRelease } from '../upgrade-lib/release.mjs'
import { prepareCliPayload, locateCliInstallation } from './cli-installation.mjs'
import { verifyCoreRelease } from './core-release.mjs'

export async function prepareDownloadedCliPayload({ root, artifact, scope, logger }) {
  try {
    const installation = locateCliInstallation(root)
    if (!installation?.selected || installation.scope !== scope) throw new Error('更新来源与此安装管理范围不一致。')
    await verifyCoreRelease(root)
    const staged = await stageRelease({ ...artifact, logger })
    const prepared = await prepareCliPayload({ sourceRoot: staged, installRoot: installation.root, scope,
      version: artifact.version.replace(/^v/, '') })
    if (prepared.id === installation.id) throw new Error('目标与当前核心相同，无需切换。')
    return prepared
  } finally { await fs.rm(artifact.tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
}
