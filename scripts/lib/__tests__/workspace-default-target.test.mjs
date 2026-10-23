import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import management from '../desktop-management.cjs'
import native from '../process-identity.cjs'
import policy from '../workspace-target-policy.cjs'
import { WorkspaceCatalog } from '../../../crabot-shared/dist/workspace-catalog.js'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import { beginWorkspaceRelocationIntent, readWorkspaceRelocationIntent } from '../workspace-relocation-intent.mjs'

for (const allowed of [true, false]) test('locked host intent accepts only the actual managed default return: ' + allowed, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-default-return-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const data = management.ensurePrivateDataRoot(path.join(root, 'data')), source = path.join(root, 'external-workspaces')
  const catalog = new WorkspaceCatalog({ dataRoot: data, storageRoot: source, files: native }); await catalog.initialize()
  await fs.writeFile(path.join(source, 'kept'), 'original business bytes')
  const target = path.join(data, allowed ? 'workspaces' : 'agent'), host = policy.workspaceRelocationTargetPolicy(data)
  assert.equal(host.managedDefaultTarget, path.join(data, 'workspaces'))
  const lock = await acquireCliLock(data, 'workspace-relocation')
  try {
    const input = { dataDir: data, id: randomUUID(), target, expectedRevision: (await catalog.snapshot()).revision, ...host }
    if (allowed) {
      const intent = await beginWorkspaceRelocationIntent(input)
      assert.equal(intent.target, target)
      assert.equal(Object.hasOwn(intent, 'managedDefaultTarget'), false)
      assert.equal(Object.hasOwn(intent, 'protectedTargets'), false)
    } else {
      await assert.rejects(beginWorkspaceRelocationIntent(input), { code: 'WORKSPACE_INVALID_REQUEST' })
      assert.equal(readWorkspaceRelocationIntent(data), null)
    }
    await assert.rejects(fs.stat(target), { code: 'ENOENT' })
    assert.equal(await fs.readFile(path.join(source, 'kept'), 'utf8'), 'original business bytes')
  } finally { releaseCliLock(lock) }
})
