# Isolated OS capability evidence only; never a workspace-ready/completion proof.
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class CrabotWorkspaceFlushProbe {
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool FlushFileBuffers(SafeFileHandle handle);
    public sealed class Result {
        public bool opened;
        public int open_error;
        public bool flushed;
        public int flush_error;
    }
    public static Result Observe(string path, uint access, uint flags, bool restoreReadOnly) {
        var result = new Result();
        using (var handle = CreateFileW(path, access, 3, IntPtr.Zero, 3, flags, IntPtr.Zero)) {
            result.opened = !handle.IsInvalid;
            if (!result.opened) { result.open_error = Marshal.GetLastWin32Error(); return result; }
            if (restoreReadOnly) System.IO.File.SetAttributes(path, System.IO.FileAttributes.ReadOnly);
            result.flushed = FlushFileBuffers(handle);
            if (!result.flushed) result.flush_error = Marshal.GetLastWin32Error();
        }
        return result;
    }
}
'@
$probeRoot = [IO.Path]::Combine([IO.Path]::GetTempPath(), 'crabot-workspace-sync-' + [Guid]::NewGuid().ToString())
[IO.Directory]::CreateDirectory($probeRoot) | Out-Null
$probeFile = [IO.Path]::Combine($probeRoot, 'finite.txt')
try {
    [IO.File]::WriteAllText($probeFile, 'owned finite flush probe')
    $observations = @()
    $observations += @{ kind = 'file-write'; result = [CrabotWorkspaceFlushProbe]::Observe($probeFile, 1073741824, 2097152, $false) }
    $observations += @{ kind = 'directory-write'; result = [CrabotWorkspaceFlushProbe]::Observe($probeRoot, 1073741824, 35651584, $false) }
    $observations += @{ kind = 'directory-read-write'; result = [CrabotWorkspaceFlushProbe]::Observe($probeRoot, 3221225472, 35651584, $false) }
    [IO.File]::SetAttributes($probeFile, [IO.FileAttributes]::ReadOnly)
    $observations += @{ kind = 'readonly-open-write'; result = [CrabotWorkspaceFlushProbe]::Observe($probeFile, 1073741824, 2097152, $false) }
    [IO.File]::SetAttributes($probeFile, [IO.FileAttributes]::Normal)
    $observations += @{ kind = 'restore-readonly-before-flush'; result = [CrabotWorkspaceFlushProbe]::Observe($probeFile, 1073741824, 2097152, $true) }
    if ([IO.File]::ReadAllText($probeFile) -ne 'owned finite flush probe') { throw 'Probe content changed' }
    $elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    @{ evidence_only = $true; elevated = $elevated; observations = $observations; readonly_restored = ([IO.File]::GetAttributes($probeFile) -band [IO.FileAttributes]::ReadOnly) -ne 0 } | ConvertTo-Json -Depth 5 -Compress
} finally {
    if ([IO.File]::Exists($probeFile)) { [IO.File]::SetAttributes($probeFile, [IO.FileAttributes]::Normal) }
    [IO.Directory]::Delete($probeRoot, $true)
}
