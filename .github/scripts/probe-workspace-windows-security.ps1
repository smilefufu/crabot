# Evidence on newly created files only. Never used as migration permission or completion.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CrabotWorkspaceSecurityProbe {
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    static extern uint GetNamedSecurityInfoW(string path, uint type, uint fields, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    static extern bool SetFileSecurityW(string path, uint fields, IntPtr descriptor);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    static extern uint SetNamedSecurityInfoW(string path, uint type, uint fields, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetSecurityDescriptorControl(IntPtr descriptor, out ushort control, out uint revision);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool SetSecurityDescriptorControl(IntPtr descriptor, ushort mask, ushort bits);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, uint revision, uint fields, out IntPtr text, out uint length);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes { public int length; public IntPtr descriptor; public int inherit; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true, EntryPoint = "CreateFileW")]
    static extern SafeFileHandle CreateNewFile(string path, uint access, uint share, ref SecurityAttributes security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool BackupWrite(SafeFileHandle file, byte[] bytes, uint length, out uint written, bool abort, bool security, ref IntPtr context);
    static uint CreateWithSecurity(string target, IntPtr descriptor) {
        var attributes = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = descriptor, inherit = 0 };
        using (var file = CreateNewFile(target, 0x40000000, 3, ref attributes, 1, 0x2200080, IntPtr.Zero)) {
            return file.IsInvalid ? (uint)Marshal.GetLastWin32Error() : 0u;
        }
    }
    static uint WithNonInheritingParent(string target, IntPtr descriptor, IntPtr dacl, bool create) {
        string parent = System.IO.Path.GetDirectoryName(target);
        IntPtr ignored, original = Read(parent, 0x77, out ignored), temporary = IntPtr.Zero;
        try {
            uint size;
            Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;FA;;;" + System.Security.Principal.WindowsIdentity.GetCurrent().User.Value + ")", 1, out temporary, out size));
            Check(SetFileSecurityW(parent, 4, temporary));
            try {
                if (create) return CreateWithSecurity(target, descriptor);
                uint error = SetNamedSecurityInfoW(target, 1, 0x80000004, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
                if (error != 0) return error;
                return SetFileSecurityW(target, 4, descriptor) ? 0u : (uint)Marshal.GetLastWin32Error();
            } finally { Check(SetFileSecurityW(parent, 4, original)); }
        } finally { if (temporary != IntPtr.Zero) LocalFree(temporary); LocalFree(original); }
    }
    public static Snapshot DuringMove;
    static uint WithNonInheritingSibling(string target, IntPtr descriptor, IntPtr dacl) {
        string scratch = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(target), "owned-security-" + Guid.NewGuid().ToString());
        string held = System.IO.Path.Combine(scratch, "original.txt");
        IntPtr temporary = IntPtr.Zero;
        System.IO.Directory.CreateDirectory(scratch);
        try {
            uint size;
            Check(ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;FA;;;" + System.Security.Principal.WindowsIdentity.GetCurrent().User.Value + ")", 1, out temporary, out size));
            Check(SetFileSecurityW(scratch, 4, temporary));
            System.IO.File.Move(target, held);
            uint error = SetNamedSecurityInfoW(held, 1, 0x80000004, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
            if (error != 0) return error;
            Check(SetFileSecurityW(held, 4, descriptor));
            DuringMove = Observe(held);
            System.IO.File.Move(held, target);
            return 0;
        } finally {
            if (System.IO.File.Exists(held) && !System.IO.File.Exists(target)) System.IO.File.Move(held, target);
            if (temporary != IntPtr.Zero) LocalFree(temporary);
            System.IO.Directory.Delete(scratch, false);
        }
    }
    static uint RestoreSecurityStream(string target, IntPtr descriptor) {
        uint length = GetSecurityDescriptorLength(descriptor);
        if (length == 0 || length > 16 * 1024 * 1024) throw new InvalidOperationException("Unbounded probe descriptor");
        byte[] bytes = new byte[20 + length];
        Buffer.BlockCopy(BitConverter.GetBytes(3u), 0, bytes, 0, 4);
        Buffer.BlockCopy(BitConverter.GetBytes(2u), 0, bytes, 4, 4);
        Buffer.BlockCopy(BitConverter.GetBytes((long)length), 0, bytes, 8, 8);
        Marshal.Copy(descriptor, bytes, 20, (int)length);
        using (var file = CreateFileW(target, 0xC0000, 3, IntPtr.Zero, 3, 0x2200000, IntPtr.Zero)) {
            if (file.IsInvalid) return (uint)Marshal.GetLastWin32Error();
            IntPtr context = IntPtr.Zero;
            uint written, error = 0;
            try {
                if (!BackupWrite(file, bytes, (uint)bytes.Length, out written, false, true, ref context)) error = (uint)Marshal.GetLastWin32Error();
                else if (written != bytes.Length) error = 13;
            } finally {
                if (!BackupWrite(file, null, 0, out written, true, true, ref context) && error == 0) error = (uint)Marshal.GetLastWin32Error();
            }
            return error;
        }
    }
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static IntPtr Read(string path, uint fields, out IntPtr dacl) {
        IntPtr owner, group, sacl, descriptor;
        uint error = GetNamedSecurityInfoW(path, 1, fields, out owner, out group, out dacl, out sacl, out descriptor);
        if (error != 0) throw new Win32Exception((int)error);
        return descriptor;
    }
    public sealed class Snapshot { public string sddl; public ushort control; }
    public static Snapshot Observe(string path) {
        IntPtr dacl, descriptor = Read(path, 0x77, out dacl), text = IntPtr.Zero;
        try {
            uint revision, length; ushort control;
            Check(GetSecurityDescriptorControl(descriptor, out control, out revision));
            Check(ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, 7, out text, out length));
            return new Snapshot { sddl = Marshal.PtrToStringUni(text), control = control };
        } finally { if (text != IntPtr.Zero) LocalFree(text); LocalFree(descriptor); }
    }
    public static uint Apply(string source, string target, string mode) {
        DuringMove = null;
        IntPtr dacl, descriptor = Read(source, mode == "query-dacl-only" ? 7u : 0x77u, out dacl);
        try {
            ushort control; uint revision;
            Check(GetSecurityDescriptorControl(descriptor, out control, out revision));
            if (mode == "isolated-sibling-move") return WithNonInheritingSibling(target, descriptor, dacl);
            if (mode == "explicit-create") return CreateWithSecurity(target, descriptor);
            if (mode == "isolated-parent-create" || mode == "isolated-parent-assign") return WithNonInheritingParent(target, descriptor, dacl, mode == "isolated-parent-create");
            if (mode == "backup-security-stream") return RestoreSecurityStream(target, descriptor);
            if (mode == "modern-direct") return SetNamedSecurityInfoW(target, 1, 4, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
            if (mode == "modern-protected-then-original") {
                uint error = SetNamedSecurityInfoW(target, 1, 0x80000004, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
                if (error != 0) return error;
            }
            if (mode == "protected-flag-then-original" && !SetFileSecurityW(target, 0x80000004, descriptor)) return (uint)Marshal.GetLastWin32Error();
            if (mode == "request-matches-source") Check(SetSecurityDescriptorControl(descriptor, 0x100, (ushort)((control & 0x400) != 0 ? 0x100 : 0)));
            return SetFileSecurityW(target, 4, descriptor) ? 0u : (uint)Marshal.GetLastWin32Error();
        } finally { LocalFree(descriptor); }
    }
}
'@
$probeId = 'crabot-workspace-security-' + [Guid]::NewGuid().ToString()
$source = [IO.Path]::Combine([IO.Path]::GetTempPath(), $probeId)
$targets = [IO.Path]::Combine($env:GITHUB_WORKSPACE, '.desktop-build', $probeId)
try {
    & node -e "const fs=require('node:fs'),p=require('node:path'),n=require('./scripts/lib/process-identity.cjs');n.createPrivateDirectory(process.argv[1]);fs.writeFileSync(p.join(process.argv[1],'original.txt'),'finite original bytes');n.createPrivateDirectory(process.argv[2]);console.log(JSON.stringify({evidence_only:true,different_devices:fs.statSync(process.argv[1]).dev!==fs.statSync(process.argv[2]).dev}));" $source $targets
    if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare owned security probe' }
    @{ evidence_only = $true; source_filesystem = ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($source))).DriveFormat; target_filesystem = ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($targets))).DriveFormat; elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress
    $original = [CrabotWorkspaceSecurityProbe]::Observe([IO.Path]::Combine($source, 'original.txt'))
    foreach ($mode in @('query-dacl-only', 'query-full', 'request-matches-source', 'modern-direct', 'modern-protected-then-original', 'protected-flag-then-original', 'backup-security-stream', 'explicit-create', 'isolated-parent-create', 'isolated-parent-assign', 'isolated-sibling-move')) {
        $target = [IO.Path]::Combine($targets, $mode)
        & node -e "require('./scripts/lib/process-identity.cjs').createPrivateDirectory(process.argv[1])" $target
        if ($LASTEXITCODE -ne 0) { throw 'Cannot create private security probe target' }
        $file = [IO.Path]::Combine($target, 'original.txt')
        $before = $null
        $create = $mode -in @('explicit-create', 'isolated-parent-create')
        if (-not $create) {
            & "$env:SystemRoot\System32\robocopy.exe" $source $target /E /COPY:DATS /DCOPY:DATE /SL /SJ /R:0 /W:0 /NFL /NDL /NJH /NJS /NP | Out-Null
            if ($LASTEXITCODE -gt 7) { throw 'Cannot copy finite security probe' }
            $before = [CrabotWorkspaceSecurityProbe]::Observe($file)
        }
        $parentBefore = [CrabotWorkspaceSecurityProbe]::Observe($target)
        $errorCode = [CrabotWorkspaceSecurityProbe]::Apply([IO.Path]::Combine($source, 'original.txt'), $file, $mode)
        if ($create) {
            if ($errorCode -ne 0) { throw "Cannot create finite explicit descriptor file: $errorCode" }
            [IO.File]::WriteAllText($file, 'finite original bytes')
        }
        $after = [CrabotWorkspaceSecurityProbe]::Observe($file)
        if ([IO.File]::ReadAllText($file) -ne 'finite original bytes') { throw 'Probe target content changed' }
        @{ evidence_only = $true; mode = $mode; error_code = $errorCode; during_move = [CrabotWorkspaceSecurityProbe]::DuringMove; source = $original; before = $before; after = $after; parent_before = $parentBefore; parent_after = [CrabotWorkspaceSecurityProbe]::Observe($target) } | ConvertTo-Json -Depth 4 -Compress
    }
    $sourceAfter = [CrabotWorkspaceSecurityProbe]::Observe([IO.Path]::Combine($source, 'original.txt'))
    if ($original.sddl -ne $sourceAfter.sddl -or $original.control -ne $sourceAfter.control -or [IO.File]::ReadAllText([IO.Path]::Combine($source, 'original.txt')) -ne 'finite original bytes') { throw 'Probe source changed' }
    $global:LASTEXITCODE = 0
} finally {
    if ([IO.Directory]::Exists($targets)) { [IO.Directory]::Delete($targets, $true) }
    if ([IO.Directory]::Exists($source)) { [IO.Directory]::Delete($source, $true) }
}
