$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $repo 'install.ps1')
function Assert($value, $message) { if (-not $value) { throw $message } }
foreach ($base in @(
    [pscustomobject]@{ ResponseUri = [uri]'https://github.com/smilefufu/crabot/releases/tag/v2026.10.12.4' },
    [pscustomobject]@{ RequestMessage = [pscustomobject]@{ RequestUri = [uri]'https://github.com/smilefufu/crabot/releases/tag/v2026.10.12.4' } }
)) {
    $script:ResponseFixture = [pscustomobject]@{ BaseResponse = $base }
    function Invoke-WebRequest { return $script:ResponseFixture }
    Assert ((Get-LatestRelease) -eq 'v2026.10.12.4') 'latest must work with PS5 and PS7 response shapes'
}
Remove-Item Function:Invoke-WebRequest
$script:CorepackJS = $null
function corepack { $global:LASTEXITCODE = 17 }
$failed = $false
try { Invoke-Pnpm install } catch { $failed = $true }
Assert $failed 'native pnpm failures must stop installation'
Remove-Item Function:corepack
$root = Join-Path ([IO.Path]::GetTempPath()) ('installer-ps-test-' + [guid]::NewGuid().ToString('N'))
try {
    foreach ($file in @('cli.mjs','package.json','dist/cli/main.js','scripts/start.mjs','crabot-memory/pyproject.toml','crabot-memory/uv.lock','scripts/prepare-scrapling.mjs')) {
        $path = Join-Path $root $file
        New-Item -ItemType Directory -Force -Path (Split-Path $path -Parent) | Out-Null
        Set-Content -LiteralPath $path -Value '// fixture'
    }
    Verify-Release $root 'v2026.10.12.4'
    Set-Content -LiteralPath (Join-Path $root 'scripts/prepare-computer-use.mjs') -Value '// mixed generation'
    $failed = $false
    try { Verify-Release $root 'v2026.10.12.4' } catch { $failed = $true }
    Assert $failed 'legacy release must reject mixed new components'
} finally { Remove-Item -LiteralPath $root -Recurse -Force }
if ($env:OS -eq 'Windows_NT') {
    $launcherRoot = Join-Path ([IO.Path]::GetTempPath()) ('launcher space-' + [guid]::NewGuid().ToString('N'))
    $oldLocal = $env:LOCALAPPDATA; $oldPath = $env:Path
    try {
        $env:LOCALAPPDATA = Join-Path $launcherRoot 'local'
        $nodeDir = Join-Path $env:LOCALAPPDATA 'crabot/node'
        New-Item -ItemType Directory -Force -Path $nodeDir | Out-Null
        Copy-Item -LiteralPath (Get-Command node).Source -Destination (Join-Path $nodeDir 'node.exe')
        $product = Join-Path $launcherRoot 'product space'
        $oldNode = Join-Path $launcherRoot 'old-node'
        New-Item -ItemType Directory -Force -Path $product, $oldNode | Out-Null
        Set-Content -LiteralPath (Join-Path $oldNode 'node.cmd') -Value '@exit /b 99' -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $product 'cli.mjs') -Value "if (!process.execPath.includes('crabot')) process.exit(98); console.log('private-node-ok')" -Encoding ASCII
        Set-Content -LiteralPath (Join-Path $product 'crabot.cmd') -Value @('@echo off','node "%~dp0cli.mjs" %*') -Encoding ASCII
        $script:PrivateNode = $true
        Write-CrabotLauncher $product
        $env:Path = "$oldNode;$oldPath"
        $output = & (Join-Path $product 'crabot.cmd')
        Assert ($LASTEXITCODE -eq 0 -and $output -contains 'private-node-ok') 'new terminal launcher must ignore old Machine PATH Node'
        Remove-Item -LiteralPath (Join-Path $nodeDir 'node.exe')
        & (Join-Path $product 'crabot.cmd') 2>$null
        Assert ($LASTEXITCODE -ne 0) 'missing private Node must fail rather than use the old Node'
        Set-Content -LiteralPath (Join-Path $product 'crabot.cmd') -Value '@echo custom' -Encoding ASCII
        Write-CrabotLauncher $product
        Assert ((Get-Content -LiteralPath (Join-Path $product 'crabot.cmd') -Raw).Trim() -eq '@echo custom') 'custom launchers must survive'
    } finally {
        $env:LOCALAPPDATA = $oldLocal; $env:Path = $oldPath
        Remove-Item -LiteralPath $launcherRoot -Recurse -Force
    }
    Assert (-not (Test-GitBash (Join-Path $env:WINDIR 'System32/bash.exe'))) 'WSL launcher must not be selected as Git Bash'
    $realGit = Get-Command git
    $gitBash = [IO.Path]::GetFullPath((Join-Path (Split-Path $realGit.Source -Parent) '../bin/bash.exe'))
    Assert (Test-GitBash $gitBash) 'native Git Bash from git/cmd must be detected'
}
Write-Host 'PowerShell installer regressions passed'
