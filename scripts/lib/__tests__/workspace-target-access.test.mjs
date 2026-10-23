import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import native from '../process-identity.cjs'
import { inspectWorkspaceRelocationTarget } from '../../../crabot-shared/dist/workspace-relocation-target.js'

const windows = { skip: process.platform !== 'win32', timeout: 30000 }
function permissions(directory, rights) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference='Stop'
    $file=$env:CRABOT_ACCESS_TEST_PATH
    $acl=Get-Acl -LiteralPath $file
    $acl.SetAccessRuleProtection($true,$false)
    foreach($rule in @($acl.Access)){$acl.RemoveAccessRuleSpecific($rule)}
    $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,$env:CRABOT_ACCESS_TEST_RIGHTS,'ContainerInherit,ObjectInherit','None','Allow')
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $file -AclObject $acl
  `], { env: { ...process.env, CRABOT_ACCESS_TEST_PATH: directory, CRABOT_ACCESS_TEST_RIGHTS: rights }, stdio: 'pipe' })
}
test('Windows preview observes actual directory ACL without creating a file or treating Node access as proof', windows, async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'workspace-access-中文 space-')))
  const source = path.join(root, 'source'), targetParent = path.join(root, 'target')
  await fs.mkdir(source); await fs.mkdir(targetParent); await fs.writeFile(path.join(source, 'kept'), 'original')
  try {
    assert.equal(typeof native.inspectDirectoryWriteAccess, 'function')
    assert.equal(native.inspectDirectoryWriteAccess(targetParent), true)
    const before = await fs.readdir(targetParent)
    permissions(targetParent, 'ReadAndExecute')
    assert.equal(native.inspectDirectoryWriteAccess(targetParent), false)
    await assert.rejects(inspectWorkspaceRelocationTarget(source, path.join(targetParent, 'missing'),
      { protectedRoots: [], inspectTargetAccess: native.inspectDirectoryWriteAccess }), { code: 'WORKSPACE_UNAVAILABLE' })
    assert.deepEqual(await fs.readdir(targetParent), before)
    assert.equal(await fs.readFile(path.join(source, 'kept'), 'utf8'), 'original')
    permissions(targetParent, 'FullControl')
    assert.equal(native.inspectDirectoryWriteAccess(targetParent), true)
    const preview = await inspectWorkspaceRelocationTarget(source, path.join(targetParent, 'missing'),
      { protectedRoots: [], inspectTargetAccess: native.inspectDirectoryWriteAccess })
    assert.equal(preview.mode, 'rename')
    assert.deepEqual(await fs.readdir(targetParent), before)
    await assert.rejects(inspectWorkspaceRelocationTarget(source, path.join(targetParent, 'missing'), { protectedRoots: [] }), { code: 'WORKSPACE_UNAVAILABLE' })
  } finally { permissions(targetParent, 'FullControl'); await fs.rm(root, { recursive: true, force: true }) }
})
