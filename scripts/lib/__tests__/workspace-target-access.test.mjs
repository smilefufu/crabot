import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import native from '../process-identity.cjs'
import { inspectWorkspaceRelocationTarget } from '../../../crabot-shared/dist/workspace-relocation-target.js'

const windows = { skip: process.platform !== 'win32', timeout: 30000 }
// Only this finite Node test process; account/group policy and other processes are untouched.
function ordinaryProcessPrivileges() {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class CrabotAccessTestPrivileges {
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct Privilege { public uint Count; public Luid Id; public uint Attributes; }
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid id);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool all, ref Privilege next, uint size, out Privilege previous, out uint needed);
  static Privilege Change(int pid, string name, uint attributes) {
    if (name!="SeBackupPrivilege" && name!="SeRestorePrivilege") throw new ArgumentException("Unexpected test privilege");
    IntPtr process=OpenProcess(0x1000,false,pid), token=IntPtr.Zero;
    if (process==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      if (!OpenProcessToken(process,0x20|0x8,out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
      Luid id; if (!LookupPrivilegeValue(null,name,out id)) throw new Win32Exception(Marshal.GetLastWin32Error());
      var next=new Privilege {Count=1,Id=id,Attributes=attributes}; Privilege previous; uint needed;
      if (!AdjustTokenPrivileges(token,false,ref next,(uint)Marshal.SizeOf(typeof(Privilege)),out previous,out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
      int error=Marshal.GetLastWin32Error(); if (error!=0 && error!=1300) throw new Win32Exception(error);
      return previous;
    } finally {if(token!=IntPtr.Zero)CloseHandle(token);CloseHandle(process);}
  }
  public static string Disable(int pid) {
    var saved=new List<string>();
    try {
      foreach(var name in new[]{"SeBackupPrivilege","SeRestorePrivilege"}) {
        var previous=Change(pid,name,0); if(previous.Count==1)saved.Add(name+"="+previous.Attributes);
      }
      return String.Join(";",saved);
    } catch { Restore(pid,String.Join(";",saved));throw; }
  }
  public static void Restore(int pid,string state) {
    foreach(var entry in state.Split(new[]{';'},StringSplitOptions.RemoveEmptyEntries)) {
      var parts=entry.Split('=');Change(pid,parts[0],UInt32.Parse(parts[1]));
    }
  }
}
'@
if($env:CRABOT_ACCESS_TEST_RESTORE -eq '1') {
  [CrabotAccessTestPrivileges]::Restore([int]$env:CRABOT_ACCESS_TEST_PID,$env:CRABOT_ACCESS_TEST_PRIVILEGES)
} else { [CrabotAccessTestPrivileges]::Disable([int]$env:CRABOT_ACCESS_TEST_PID) }
`
  const run = (restore, state = '') => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, CRABOT_ACCESS_TEST_PID: String(process.pid), CRABOT_ACCESS_TEST_RESTORE: restore ? '1' : '0', CRABOT_ACCESS_TEST_PRIVILEGES: state }, encoding: 'utf8',
  }).trim()
  const previous = run(false)
  return () => { run(true, previous) }
}

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
  const restorePrivileges = ordinaryProcessPrivileges()
  try {
    assert.equal(typeof native.inspectDirectoryWriteAccess, 'function')
    assert.equal(native.inspectDirectoryWriteAccess(targetParent), true)
    const before = await fs.readdir(targetParent)
    permissions(targetParent, 'ReadAndExecute')
    const ordinaryWrite = path.join(targetParent, 'denied-ordinary-write')
    let denied = false
    try { await fs.writeFile(ordinaryWrite, 'finite ACL test only', { flag: 'wx' }) }
    catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; denied = true }
    if (!denied || native.inspectDirectoryWriteAccess(targetParent) !== false) {
      const acl = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `ConvertTo-Json -InputObject @((Get-Acl -LiteralPath $env:CRABOT_ACCESS_TEST_PATH).Access | Select-Object IsInherited,AccessControlType,FileSystemRights) -Compress`],
        { env: { ...process.env, CRABOT_ACCESS_TEST_PATH: targetParent }, encoding: 'utf8' })
      console.log('Windows target access diagnostic', { ordinary_write_denied: denied, native_writable: native.inspectDirectoryWriteAccess(targetParent), acl: JSON.parse(acl) })
    }
    assert.equal(denied, true, 'The fixture must deny actual ordinary file creation before checking the native observer')
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
  } finally {
    try { permissions(targetParent, 'FullControl'); await fs.rm(root, { recursive: true, force: true }) }
    finally { restorePrivileges() }
  }
})
