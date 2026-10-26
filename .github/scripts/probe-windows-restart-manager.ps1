# CI-only read observations of the finite files created by the JS probe.
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'Disposable Windows CI only' }
[Console]::InputEncoding = [Text.Encoding]::UTF8
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class ReferenceApiProbe {
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  public static extern uint RmStartSession(out uint handle, uint flags, StringBuilder key);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
  public static extern uint RmRegisterResources(uint handle, uint count, [In, MarshalAs(UnmanagedType.LPArray, ArraySubType=UnmanagedType.LPWStr)] string[] files, uint applications, IntPtr processes, uint services, IntPtr names);
  [DllImport("rstrtmgr.dll")]
  public static extern uint RmGetList(uint handle, out uint needed, ref uint count, IntPtr entries, out uint reboot);
  [DllImport("rstrtmgr.dll")]
  public static extern uint RmEndSession(uint handle);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern uint GetShortPathName(string file, StringBuilder output, uint size);
}
'@
foreach ($case in $request) {
  [string[]]$files = $case.files
  if ($files.Length -gt 100000) { throw 'Finite resource bound exceeded' }
  if ($case.short_paths) {
    $shortAvailable = $true
    $files = @($files | ForEach-Object {
      $output = [Text.StringBuilder]::new(32769)
      $length = [ReferenceApiProbe]::GetShortPathName($_, $output, 32769)
      if ($length -eq 0 -or $length -ge 32769) { $shortAvailable = $false }
      else { $output.ToString() }
    })
    if (-not $shortAvailable) { Write-Output ('CRABOT_WINDOWS_RM_API ' + (@{kind=$case.kind; short_path_available=$false} | ConvertTo-Json -Compress)); continue }
  }
  [uint32]$handle = 0
  $start = [ReferenceApiProbe]::RmStartSession([ref]$handle, 0, [Text.StringBuilder]::new(33))
  $result = @{ kind=$case.kind; start=$start; count=$files.Length; max_path_length=($files | Measure-Object -Property Length -Maximum).Maximum }
  if ($start -eq 0) {
    try {
      [int]$batch = if ($case.batch) { $case.batch } else { $files.Length }
      [uint32]$registered = 0
      for ($offset=0; $offset -lt $files.Length; $offset+=$batch) {
        [string[]]$part = $files[$offset..([Math]::Min($offset+$batch, $files.Length)-1)]
        $registered = [ReferenceApiProbe]::RmRegisterResources($handle, $part.Length, $part, 0, [IntPtr]::Zero, 0, [IntPtr]::Zero)
        if ($registered -ne 0) { break }
      }
      $result.register = $registered
      if ($registered -eq 0) {
        [uint32]$needed=0; [uint32]$count=0; [uint32]$reboot=0
        $result.list = [ReferenceApiProbe]::RmGetList($handle, [ref]$needed, [ref]$count, [IntPtr]::Zero, [ref]$reboot)
        $result.needed=$needed; $result.reboot=$reboot
      }
    } finally { $result.end = [ReferenceApiProbe]::RmEndSession($handle) }
  }
  Write-Output ('CRABOT_WINDOWS_RM_API ' + ($result | ConvertTo-Json -Compress))
}
