import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import native from '../process-identity.cjs'
import { inspectWorkspaceCopySource } from '../workspace-copy.mjs'
import { inspectWorkspaceFileMetadata, verifyWorkspaceRelocationCopy } from '../workspace-file-metadata.mjs'
import { copyWorkspaceTreePinned } from '../workspace-windows-copy.mjs'
const windows = { skip: process.platform !== 'win32', timeout: 30000 }
const policy = 'windows-owner-inheritance-v1'
function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'workspace-owner-inheritance-')))
  const source = path.join(root, 'source'), target = path.join(root, 'container/tree')
  for (const directory of [source, path.dirname(target), target]) native.createPrivateDirectory(directory)
  const file = path.join(source, 'original.txt'); fs.writeFileSync(file, 'original retained bytes')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { source, target, file }
}
function setAcl(file, sddl) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$a=New-Object System.Security.AccessControl.FileSecurity;$a.SetSecurityDescriptorSddlForm($env.CRABOT_TEST_SDDL);Set-Acl -LiteralPath $env.CRABOT_TEST_FILE -AclObject $a'],
  { env: { ...process.env, CRABOT_TEST_FILE: file, CRABOT_TEST_SDDL: sddl }, stdio: 'pipe' })
}
test('private Windows copy preserves two raw proofs and never changes the source ACL', windows, async t => {
  const f = fixture(t), original = await inspectWorkspaceFileMetadata(f.file)
  const pins = [f.source, f.target, path.dirname(f.target)].map(directory => native.pinDirectory(directory))
  try {
    await inspectWorkspaceCopySource(f.source, { metadataCompatibility: policy })
    await copyWorkspaceTreePinned(...pins, { metadataCompatibility: policy, journal: {
      async register() { return { dispatch: 'dispatch' } }, async permit() { return { dispatch: 'dispatch' } }, async complete() {},
    } })
    const proof = await verifyWorkspaceRelocationCopy(f.source, f.target, { metadataCompatibility: policy })
    assert.equal(proof.metadata_compatibility, policy)
    assert.equal(proof.legacy_owner_inheritance_files === 0, proof.metadata_fingerprint === proof.target_metadata_fingerprint)
    assert.deepEqual(await inspectWorkspaceFileMetadata(f.file), original)
    const copy = path.join(f.target, 'original.txt')
    fs.writeFileSync(copy + ':extra', 'unapproved stream')
    await assert.rejects(verifyWorkspaceRelocationCopy(f.source, f.target, { metadataCompatibility: policy }), { code: 'CRABOT_FILE_METADATA' })
  } finally { for (const pin of pins.reverse()) native.releaseDirectoryPin(pin) }
})
for (const kind of ['extra user', 'deny', 'restricted', 'file inheritance flags', 'different user']) {
  test('Windows compatibility preflight blocks ' + kind + ' before any copy or source mutation', windows, async t => {
    const f = fixture(t), owner = native.inspectProcess(process.pid).owner
    const aces = {
      'extra user': '(A;;FA;;;' + owner + ')(A;;FR;;;WD)',
      'deny': '(D;;WD;;;WD)(A;;FA;;;' + owner + ')',
      'restricted': '(A;;FR;;;' + owner + ')',
      'file inheritance flags': '(A;OI;FA;;;' + owner + ')',
      'different user': '(A;;FA;;;WD)',
    }
    setAcl(f.file, 'O:' + owner + 'D:P' + aces[kind])
    const before = native.inspectFileMetadata(f.file).metadata
    assert.equal(native.inspectWorkspaceOwnerAccess(f.file), false)
    await assert.rejects(inspectWorkspaceCopySource(f.source, { metadataCompatibility: policy }), { code: 'WORKSPACE_COPY_ACL_UNSUPPORTED' })
    assert.deepEqual(native.inspectFileMetadata(f.file).metadata, before)
    assert.deepEqual(fs.readdirSync(f.target), [])
    assert.equal(fs.readFileSync(f.file, 'utf8'), 'original retained bytes')
  })
}
test('directories, extra hard links, unchanged and protected security never qualify as the one inheritance difference', windows, async t => {
  const f = fixture(t), other = path.join(f.target, 'other.txt'); fs.copyFileSync(f.file, other)
  assert.equal(native.compareWorkspaceOwnerInheritance(f.file, f.file), false)
  assert.equal(native.compareWorkspaceOwnerInheritance(f.source, f.target), false)
  const owner = native.inspectProcess(process.pid).owner
  setAcl(other, 'O:' + owner + 'D:P(A;;FA;;;' + owner + ')')
  assert.equal(native.compareWorkspaceOwnerInheritance(f.file, other), false)
  fs.linkSync(f.file, path.join(f.source, 'link'))
  assert.equal(native.inspectWorkspaceOwnerAccess(f.file), false)
  assert.equal(native.compareWorkspaceOwnerInheritance(f.file, other), false)
})
test('compatibility refuses non-private parents even if the files have current-user full access', windows, async t => {
  const f = fixture(t), owner = native.inspectProcess(process.pid).owner
  const acl = 'O:' + owner + 'D:P(A;OICI;FA;;;' + owner + ')(A;OICI;FR;;;WD)'
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '$a=New-Object System.Security.AccessControl.DirectorySecurity;$a.SetSecurityDescriptorSddlForm($env.CRABOT_TEST_SDDL);Set-Acl -LiteralPath $env.CRABOT_TEST_FILE -AclObject $a'],
    { env: { ...process.env, CRABOT_TEST_FILE: f.source, CRABOT_TEST_SDDL: acl }, stdio: 'pipe' })
  await assert.rejects(inspectWorkspaceCopySource(f.source, { metadataCompatibility: policy }), { code: 'WORKSPACE_COPY_ACL_UNSUPPORTED' })
})
