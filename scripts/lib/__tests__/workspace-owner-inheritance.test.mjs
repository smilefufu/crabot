import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import native from '../process-identity.cjs'
import management from '../desktop-management.cjs'
import { WorkspaceCatalog } from '../../../crabot-shared/dist/workspace-catalog.js'
import { beginWorkspaceRelocationIntent, readWorkspaceRelocationIntent } from '../workspace-relocation-intent.mjs'
import { acquireCliLock, releaseCliLock } from '../cli-lock.mjs'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
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
    `$ErrorActionPreference='Stop';Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CrabotAclFixture {
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)]
  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint size);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true, ExactSpelling=true)]
  static extern bool SetFileSecurityW(string path, uint fields, IntPtr descriptor);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
  public static void Set(string path, string text) {
    IntPtr descriptor; uint size;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(text, 1, out descriptor, out size)) throw new Win32Exception();
    try { if (!SetFileSecurityW(path, 4, descriptor)) throw new Win32Exception(); }
    finally { LocalFree(descriptor); }
  }
}
'@
[CrabotAclFixture]::Set($env:CRABOT_TEST_FILE,$env:CRABOT_TEST_SDDL)`],
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
    if (kind === 'file inheritance flags') assert.equal(before.includes(Buffer.from('(A;OI;')), true, 'fixture must retain the actual unsupported flag')
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
    "$ErrorActionPreference='Stop';$a=New-Object System.Security.AccessControl.DirectorySecurity;$a.SetSecurityDescriptorSddlForm($env:CRABOT_TEST_SDDL);Set-Acl -LiteralPath $env:CRABOT_TEST_FILE -AclObject $a"],
    { env: { ...process.env, CRABOT_TEST_FILE: f.source, CRABOT_TEST_SDDL: acl }, stdio: 'pipe' })
  await assert.rejects(inspectWorkspaceCopySource(f.source, { metadataCompatibility: policy }), { code: 'WORKSPACE_COPY_ACL_UNSUPPORTED' })
})


test('unsupported Windows ACL rejects the actual cross-volume intent before fencing or stopping existing execution', windows, async t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(tmpdir(), 'workspace-acl-admission-')))
  const other = path.resolve('.desktop-build')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(other, { recursive: true })
  if (fs.statSync(root).dev === fs.statSync(other).dev) { t.skip('requires two actual writable volumes'); return }
  const data = management.ensurePrivateDataRoot(path.join(root, 'data'))
  const catalog = new WorkspaceCatalog({ dataRoot: data, files: native }); await catalog.initialize()
  const snapshot = await catalog.snapshot(), file = path.join(snapshot.storage_root, 'limited.txt')
  fs.writeFileSync(file, 'keep original project work')
  const owner = native.inspectProcess(process.pid).owner
  setAcl(file, 'O:' + owner + 'D:P(A;;FR;;;' + owner + ')')
  const original = native.inspectFileMetadata(file).metadata
  const child = spawn(process.execPath, ['-e', 'setTimeout(()=>process.exit(0),30000)'], { stdio: 'ignore' })
  await once(child, 'spawn'); const processIdentity = native.inspectProcess(child.pid), ended = once(child, 'exit')
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await ended })
  const lock = await acquireCliLock(data, 'workspace-relocation')
  try {
    await assert.rejects(beginWorkspaceRelocationIntent({ dataDir: data, id: randomUUID(), target: path.join(other, 'not-created-' + randomUUID()),
      expectedRevision: snapshot.revision, protectedRoots: [] }), { code: 'WORKSPACE_COPY_ACL_UNSUPPORTED' })
    assert.equal(readWorkspaceRelocationIntent(data), null)
    assert.deepEqual(await catalog.snapshot(), snapshot)
    assert.equal(native.sameProcess(processIdentity, native.inspectProcess(child.pid)), true)
    assert.equal(child.exitCode, null)
    assert.deepEqual(native.inspectFileMetadata(file).metadata, original)
    assert.equal(fs.readFileSync(file, 'utf8'), 'keep original project work')
  } finally { releaseCliLock(lock) }
})
