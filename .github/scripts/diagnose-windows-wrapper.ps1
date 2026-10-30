$ErrorActionPreference = 'Stop'
$archive = Get-ChildItem "$env:GITHUB_WORKSPACE/artifact" -Recurse -Filter '*candidate.exe' | Select-Object -ExpandProperty FullName
if (@($archive).Count -ne 1) { throw 'Expected one candidate EXE' }
$root = Join-Path $env:RUNNER_TEMP ('crabot-wrapper-' + [guid]::NewGuid().ToString('N'))
New-Item $root -ItemType Directory | Out-Null
& 7z x $archive "-o$root/wrapper" -y | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Outer extraction failed' }
$payload = Get-ChildItem "$root/wrapper" -Recurse -Filter 'app-64.7z' | Select-Object -ExpandProperty FullName
if (@($payload).Count -ne 1) { throw 'Expected embedded x64 package' }
$fixture = Join-Path $root 'fixture'
$relative = 'resources/offline/core/.scrapling-runtime-desktop-ci-b21869a0a229da99-8413626c/packages/playwright/driver/package/lib/tools/skills/playwright-component-testing/references/gallery-spec.md'
New-Item (Join-Path $fixture (Split-Path $relative)) -ItemType Directory -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $fixture $relative), 'real-package-path-regression')
[IO.File]::WriteAllText((Join-Path $fixture 'CrabotInstaller.exe'), 'host-placeholder')
$payload = Join-Path $root 'fixture.7z'
Push-Location $fixture
& 7z a -t7z $payload '*' | Out-Null
Pop-Location
if ($LASTEXITCODE -ne 0) { throw 'Fixture archive failed' }
$report = @{}
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
 InitPluginsDir
 ReadEnvStr $0 CRABOT_PROBE_LEAF
 StrCpy $INSTDIR "$PLUGINSDIR\$0"
 CreateDirectory "$INSTDIR"
 SetOutPath "$INSTDIR"
 ReadEnvStr $1 CRABOT_PROBE_LOG
 FileOpen $ProbeLog "$1" w
 FileWrite $ProbeLog "target=$INSTDIR$\r$\n"
 !insertmacro extractUsing7za "@PAYLOAD@"
 IfFileExists "$INSTDIR\resources\offline\core\.scrapling-runtime-desktop-ci-b21869a0a229da99-8413626c\packages\playwright\driver\package\lib\tools\skills\playwright-component-testing\references\gallery-spec.md" 0 +2
  FileWrite $ProbeLog "long-file-present$\r$\n"
 FileWrite $ProbeLog "completed$\r$\n"
 FileClose $ProbeLog
SectionEnd
'@
$probe = $probe.Replace('@PLUGIN@', $plugin.DirectoryName).Replace('@MACRO@',$macroFile).Replace('@EXE@',"$root/probe.exe").Replace('@PAYLOAD@',$payload.Replace('$','$$'))
[IO.File]::WriteAllText("$root/probe.nsi", $probe)
& $nsis /V2 "$root/probe.nsi"
if ($LASTEXITCODE -ne 0) { throw 'NSIS diagnostic compile failed' }
foreach ($kind in @('crabot-installer','i')) {
 $env:CRABOT_PROBE_LEAF=$kind
 $env:CRABOT_PROBE_LOG=Join-Path $root "$kind.txt"
 $process=Start-Process "$root/probe.exe" -Wait -PassThru
 $log=[IO.File]::ReadAllText($env:CRABOT_PROBE_LOG)
 $report[$kind]=@{exit=$process.ExitCode;log=$log}
 $report | ConvertTo-Json -Depth 5 | Tee-Object -FilePath "$env:GITHUB_WORKSPACE/wrapper-diagnostic.json"
}
