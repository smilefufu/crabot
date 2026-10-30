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
# Run the pinned NSIS macro itself, not just the underlying Shell API.
$bundle = Join-Path $root 'nsis.7z'
Invoke-WebRequest 'https://github.com/electron-userland/electron-builder-binaries/releases/download/nsis-3.0.4.1/nsis-3.0.4.1.7z' -OutFile $bundle
if ((Get-FileHash $bundle -Algorithm SHA256).Hash.ToLowerInvariant() -ne '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa') { throw 'NSIS SHA256 mismatch' }
& 7z x $bundle "-o$root/nsis" -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'NSIS extraction failed' }
$env:NSISDIR = "$root/nsis"
$nsis = "$root/nsis/Bin/makensis.exe"
$plugin = Get-ChildItem "$root/wrapper" -Recurse -Filter 'nsis7z.dll' | Select-Object -First 1
if (!$plugin) { throw 'Embedded NSIS extraction plugin absent' }
$macroFile = Join-Path $root 'extractAppPackage.nsh'
Copy-Item (Join-Path $PSScriptRoot 'fixtures/windows-wrapper-extract-original.nsh') $macroFile
$macro = [IO.File]::ReadAllText($macroFile)
$macro = $macro.Replace('    CopyFiles /SILENT', '    IfErrors 0 +2' + "`n" + '      FileWrite $ProbeLog "before-copy:error$\r$\n"' + "`n" + '    CopyFiles /SILENT')
$macro = $macro.Replace('    DetailPrint `Can', '    FileWrite $ProbeLog "after-copy:error$\r$\n"' + "`n" + '    DetailPrint `Can')
[IO.File]::WriteAllText($macroFile, $macro)
$probe = @'
Unicode true
SilentInstall silent
RequestExecutionLevel user
!include "LogicLib.nsh"
!addplugindir "@PLUGIN@"
!define PRODUCT_NAME "Crabot Installer"
LangString appCannotBeClosed 1033 "Cannot close installer"
!include "@MACRO@"
OutFile "@EXE@"
Var ProbeLog
Section
 ReadEnvStr $INSTDIR CRABOT_PROBE_TARGET
 CreateDirectory "$INSTDIR"
 SetOutPath "$INSTDIR"
 FileOpen $ProbeLog "$INSTDIR\probe.txt" w
 InitPluginsDir
 !insertmacro extractUsing7za "@PAYLOAD@"
 FileWrite $ProbeLog "completed$\r$\n"
 FileClose $ProbeLog
SectionEnd
'@
$probe = $probe.Replace('@PLUGIN@', $plugin.DirectoryName).Replace('@MACRO@',$macroFile).Replace('@EXE@',"$root/probe.exe").Replace('@PAYLOAD@',$payload.Replace('$','$$'))
[IO.File]::WriteAllText("$root/probe.nsi", $probe)
& $nsis /V2 "$root/probe.nsi"
if ($LASTEXITCODE -ne 0) { throw 'NSIS diagnostic compile failed' }
foreach ($kind in @('normal','long-profile')) {
 $env:CRABOT_PROBE_TARGET = Join-Path $root "nsis-$kind"
 $oldTemp=$env:TEMP; $oldTmp=$env:TMP
 if ($kind -eq 'long-profile') {
  $env:TEMP = Join-Path $root 'ordinary-windows-user-profile/AppData/Local/Temp'
  $env:TMP = $env:TEMP
  New-Item $env:TEMP -ItemType Directory -Force | Out-Null
 }
 $process=Start-Process "$root/probe.exe" -Wait -PassThru
 $env:TEMP=$oldTemp; $env:TMP=$oldTmp
 $log=[IO.File]::ReadAllText("$env:CRABOT_PROBE_TARGET/probe.txt")
 $report["nsis_$kind"] = @{ exit=$process.ExitCode; log=$log; files=@(Get-ChildItem $env:CRABOT_PROBE_TARGET -Recurse -File).Count }
 $report | ConvertTo-Json -Depth 5 | Tee-Object -FilePath "$env:GITHUB_WORKSPACE/wrapper-diagnostic.json"
 if ($report["nsis_$kind"].files -ne $files.Count + 1) { throw "NSIS did not extract all real files for $kind" }
}
