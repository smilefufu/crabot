# Exact Write-CrabotLauncher from published v2026.10.14.1 and v2026.10.15.1.
param([string]$Directory, [switch]$PrivateNode)
$script:PrivateNode = $PrivateNode.IsPresent
function Write-CrabotLauncher($directory) {
    $default = "@echo off`nnode `"%~dp0cli.mjs`" %*"
    $private = @'
@echo off
setlocal
if not exist "%LOCALAPPDATA%\crabot\node\node.exe" (
  echo Crabot Node is missing. Run install.ps1 again. 1>&2
  exit /b 1
)
set "PATH=%LOCALAPPDATA%\crabot\node;%PATH%"
"%LOCALAPPDATA%\crabot\node\node.exe" "%~dp0cli.mjs" %*
'@
    $cmdPath = Join-Path $directory 'crabot.cmd'
    if (Test-Path -LiteralPath $cmdPath -PathType Leaf) {
        $existing = (Get-Content -LiteralPath $cmdPath -Raw).Replace("`r`n", "`n").TrimEnd()
        if ($existing -cne $default -and $existing -cne $private.Replace("`r`n", "`n").TrimEnd()) { return }
    }
    $content = if ($script:PrivateNode) { $private } else { $default }
    Set-Content -LiteralPath $cmdPath -Value $content -Encoding ASCII
}

Write-CrabotLauncher $Directory
