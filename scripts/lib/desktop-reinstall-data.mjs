// Trusted installer code only. Static compatibility diagnosis is not permission
// to copy, migrate, clear a fence, import target JS or launch an instance.
import path from 'node:path'
import { createHash } from 'node:crypto'
import installation from './desktop-installation.cjs'
import { acquireExistingCliLock, releaseCliLock, cliLockToken } from './cli-lock.mjs'
import { captureStoppedDesktopRemoval } from './desktop-removal-context.mjs'
import { verifyDesktopPayload } from './desktop-payload.mjs'
import { readPending } from './desktop-preparation-files.mjs'
import { verifyDataCompatibility } from './data-compatibility.mjs'
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const fail = () => { throw Object.assign(new Error('重装兼容检查条件已变化，原数据和维护保护已保留。'), { code: 'CRABOT_DESKTOP_REMOVAL' }) }
export async function inspectDesktopReinstallData({ payload, installRoot, operationId, verifyStopped, signal }) {
  if (typeof verifyStopped !== 'function') fail()
  const source = await verifyDesktopPayload(payload, { signal }), own = installation.readDesktopInstallation(installRoot)
  const rootLock = await acquireExistingCliLock(own.root, 'desktop-reinstall-inspect'), rootToken = cliLockToken(rootLock)
  let dataLock, dataToken
  try {
    dataLock = await acquireExistingCliLock(own.dataDir, 'desktop-reinstall-inspect'); dataToken = cliLockToken(dataLock)
    const context = await captureStoppedDesktopRemoval({ installRoot: own.root, operationId })
    if (!same(context.own.record, own.record) || !same(context.proof.payload, source.record)) fail()
    const pending = await readPending(own.root)
    const payloadSha = createHash('sha256').update(JSON.stringify(source.record) + '\n').digest('hex')
    if (pending && (pending.installation_id !== own.record.installation_id || !same(pending.selection, source.record.selection) || pending.payload_sha256 !== payloadSha)) fail()
    const current = async () => {
      context.assertStopped()
      await context.proofCurrent()
      if (!same(await readPending(own.root), pending)) fail()
      context.assertStopped()
    }
    await current(); await verifyStopped(); await current(); signal?.throwIfAborted()
    // Only trusted static readers run; source module/migration JS is never imported.
    const result = verifyDataCompatibility(path.join(source.directory, 'core'), own.dataDir)
    await current(); signal?.throwIfAborted()
    return result
  } finally {
    if (dataToken && cliLockToken(dataLock) === dataToken) releaseCliLock(dataLock)
    if (rootToken && cliLockToken(rootLock) === rootToken) releaseCliLock(rootLock)
  }
}
