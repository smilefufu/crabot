# Evidence on newly created files only. Never used as migration permission or completion.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
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
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
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
        IntPtr dacl, descriptor = Read(source, mode == "query-dacl-only" ? 7u : 0x77u, out dacl);
        try {
            ushort control; uint revision;
            Check(GetSecurityDescriptorControl(descriptor, out control, out revision));
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
    $original = [CrabotWorkspaceSecurityProbe]::Observe([IO.Path]::Combine($source, 'original.txt'))
    foreach ($mode in @('query-dacl-only', 'query-full', 'request-matches-source', 'modern-direct', 'modern-protected-then-original', 'protected-flag-then-original')) {
        $target = [IO.Path]::Combine($targets, $mode)
        & node -e "require('./scripts/lib/process-identity.cjs').createPrivateDirectory(process.argv[1])" $target
        if ($LASTEXITCODE -ne 0) { throw 'Cannot create private security probe target' }
        & "$env:SystemRoot\System32\robocopy.exe" $source $target /E /COPY:DATS /DCOPY:DATE /SL /SJ /R:0 /W:0 /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -gt 7) { throw 'Cannot copy finite security probe' }
        $file = [IO.Path]::Combine($target, 'original.txt')
        $before = [CrabotWorkspaceSecurityProbe]::Observe($file)
        $errorCode = [CrabotWorkspaceSecurityProbe]::Apply([IO.Path]::Combine($source, 'original.txt'), $file, $mode)
        $after = [CrabotWorkspaceSecurityProbe]::Observe($file)
        if ([IO.File]::ReadAllText($file) -ne 'finite original bytes') { throw 'Probe target content changed' }
        @{ evidence_only = $true; mode = $mode; error_code = $errorCode; source = $original; before = $before; after = $after } | ConvertTo-Json -Depth 4 -Compress
    }
    $sourceAfter = [CrabotWorkspaceSecurityProbe]::Observe([IO.Path]::Combine($source, 'original.txt'))
    if ($original.sddl -ne $sourceAfter.sddl -or $original.control -ne $sourceAfter.control -or [IO.File]::ReadAllText([IO.Path]::Combine($source, 'original.txt')) -ne 'finite original bytes') { throw 'Probe source changed' }
    $global:LASTEXITCODE = 0
} finally {
    if ([IO.Directory]::Exists($targets)) { [IO.Directory]::Delete($targets, $true) }
    if ([IO.Directory]::Exists($source)) { [IO.Directory]::Delete($source, $true) }
}
