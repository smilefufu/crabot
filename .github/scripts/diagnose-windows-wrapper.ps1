$ErrorActionPreference = 'Stop'
$archive = Get-ChildItem "$env:GITHUB_WORKSPACE/artifact" -Recurse -Filter '*candidate.exe' | Select-Object -ExpandProperty FullName
if (@($archive).Count -ne 1) { throw 'Expected one candidate EXE' }
$root = Join-Path $env:RUNNER_TEMP ('crabot-wrapper-' + [guid]::NewGuid().ToString('N'))
New-Item $root -ItemType Directory | Out-Null
& 7z x $archive "-o$root/wrapper" -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Outer extraction failed' }
$payload = Get-ChildItem "$root/wrapper" -Recurse -Filter 'app-64.7z' | Select-Object -ExpandProperty FullName
if (@($payload).Count -ne 1) { throw 'Expected embedded x64 package' }
$source = Join-Path $root '7z-out'
$target = Join-Path $root 'crabot-installer'
& 7z x $payload "-o$source" -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Payload extraction failed' }
$files = @(Get-ChildItem $source -Recurse -File)
$longest = @($files | Sort-Object { $_.FullName.Length } -Descending | Select-Object -First 10 | ForEach-Object { @{ length=$_.FullName.Length; relative=$_.FullName.Substring($source.Length+1) } })
$tooLong = @($files | Where-Object { $_.FullName.Length -ge 260 }).Count
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class CopyProbe {
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct SHFILEOPSTRUCT {
  public IntPtr hwnd; public uint wFunc; [MarshalAs(UnmanagedType.LPWStr)] public string pFrom;
  [MarshalAs(UnmanagedType.LPWStr)] public string pTo; public ushort fFlags;
  [MarshalAs(UnmanagedType.Bool)] public bool aborted; public IntPtr hNameMappings;
  [MarshalAs(UnmanagedType.LPWStr)] public string title;
 }
 [DllImport("shell32.dll",CharSet=CharSet.Unicode)] public static extern int SHFileOperation(ref SHFILEOPSTRUCT operation);
}
'@
New-Item $target -ItemType Directory | Out-Null
$operation = New-Object CopyProbe+SHFILEOPSTRUCT
$operation.wFunc = 2
$operation.pFrom = "$source\*" + [char]0 + [char]0
$operation.pTo = $target + [char]0 + [char]0
$operation.fFlags = 0x614
$code = [CopyProbe]::SHFileOperation([ref]$operation)
$report = @{ source_files=$files.Count; paths_over_259=$tooLong; longest=$longest; copy_error=$code; copy_error_hex=('{0:X}' -f $code); aborted=$operation.aborted; copied_files=@(Get-ChildItem $target -Recurse -File).Count }
$report | ConvertTo-Json -Depth 5 | Tee-Object -FilePath "$env:GITHUB_WORKSPACE/wrapper-diagnostic.json"
