param(
 [Parameter(Mandatory=$true)][string]$Installer,
 [ValidateSet('complete','retry','space')][string]$Expected = 'complete'
)
$ErrorActionPreference = 'Stop'
# Only create/format our new virtual disk on a disposable hosted CI machine.
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Hosted runner required' }
$root = Join-Path $env:RUNNER_TEMP ('wrapper-capacity-' + [guid]::NewGuid().ToString('N'))
New-Item $root -ItemType Directory | Out-Null
$disk = Join-Path $root 'new-temp.vhd'
$letter = @('R','S','T','U','V','W','X','Y','Z') | Where-Object { !(Test-Path ($_ + ':\')) } | Select-Object -First 1
if (!$letter -or (Test-Path $disk)) { throw 'New isolated virtual disk unavailable' }
function DiskPart([string[]]$Commands) {
 $script = Join-Path $root 'commands.txt'
 $Commands | Set-Content $script -Encoding ascii
 & "$env:SystemRoot/System32/diskpart.exe" /s $script | Write-Output
 if ($LASTEXITCODE -ne 0) { throw 'Virtual disk command failed' }
}
try {
 DiskPart @("create vdisk file=`"$disk`" maximum=4096 type=expandable", "select vdisk file=`"$disk`"", 'attach vdisk', 'create partition primary', 'format fs=ntfs quick label=CrabotTempTest', "assign letter=$letter")
 $volume = Get-Volume -DriveLetter $letter
 if ($volume.FileSystemLabel -ne 'CrabotTempTest' -or $volume.Size -gt 4GB) { throw 'Unexpected test volume' }
 $temporary = $letter + ':\temp'
 New-Item $temporary -ItemType Directory | Out-Null
 if ($Expected -eq 'space') {
  $reserve = [IO.File]::Create(($letter + ':\reserved.bin'))
  try { $reserve.SetLength(1GB) } finally { $reserve.Dispose() }
 }
 Write-Output ("CRABOT_TEMP_VOLUME expected=$Expected free=" + (Get-Volume -DriveLetter $letter).SizeRemaining)
 & (Join-Path $PSScriptRoot 'smoke-windows-wrapper-ui.ps1') -Installer $Installer -TemporaryDirectory $temporary -Expected $Expected
} finally {
 if (Test-Path $disk) {
  DiskPart @("select vdisk file=`"$disk`"", 'detach vdisk')
  Remove-Item $disk -Force
 }
}
