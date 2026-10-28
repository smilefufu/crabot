$ErrorActionPreference = 'Stop'
$repo = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
. (Join-Path $repo 'install.ps1')
function Assert($value, $message) { if (-not $value) { throw $message } }
$originalEnsureNode = (Get-Item Function:Ensure-Node).ScriptBlock
$originalProgress = $ProgressPreference
$originalArchitecture = $env:PROCESSOR_ARCHITECTURE
$originalWowArchitecture = $env:PROCESSOR_ARCHITEW6432
try {
    $env:PROCESSOR_ARCHITECTURE = 'AMD64'; $env:PROCESSOR_ARCHITEW6432 = $null
    $ProgressPreference = 'Continue'
    function Ensure-Node {
        if ($ProgressPreference -ne 'SilentlyContinue') { throw 'download progress is enabled' }
        throw 'progress fixture stop'
    }
    $message = ''
    try { Install-Crabot } catch { $message = $_.Exception.Message }
    Assert ($message -eq 'progress fixture stop') 'installer downloads must suppress PS5 progress rendering'
    Assert ($ProgressPreference -eq 'Continue') 'installer must preserve the caller progress preference'
} finally {
    Set-Item Function:Ensure-Node -Value $originalEnsureNode
    $ProgressPreference = $originalProgress
    $env:PROCESSOR_ARCHITECTURE = $originalArchitecture
    $env:PROCESSOR_ARCHITEW6432 = $originalWowArchitecture
}
foreach ($base in @(
    [pscustomobject]@{ ResponseUri = [uri]'https://github.com/smilefufu/crabot/releases/tag/v2026.10.12.4' },
    [pscustomobject]@{ RequestMessage = [pscustomobject]@{ RequestUri = [uri]'https://github.com/smilefufu/crabot/releases/tag/v2026.10.12.4' } }
)) {
    $script:ResponseFixture = [pscustomobject]@{ BaseResponse = $base }
    function Invoke-WebRequest { return $script:ResponseFixture }
    Assert ((Get-LatestRelease) -eq 'v2026.10.12.4') 'latest must work with PS5 and PS7 response shapes'
}
Remove-Item Function:Invoke-WebRequest
$downloadFixture = Join-Path ([IO.Path]::GetTempPath()) ('source-fallback-' + [guid]::NewGuid().ToString('N'))
try {
    foreach ($failure in @('HTTP 403 Forbidden', 'Access to the path is denied', 'unexpected failure')) {
        $script:ToolDownloadCalls = @()
        $script:ToolDownloadFailure = $failure
        function Invoke-WebRequest($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec) {
            $script:ToolDownloadCalls += [pscustomobject]@{ Uri = $Uri; Budget = $TimeoutSec }
            if ($Uri -eq 'https://mirror.invalid/fixed.zip') { throw $script:ToolDownloadFailure }
            [IO.File]::WriteAllText($OutFile, 'verified-later')
        }
        $errorMessage = $null
        try { Get-ToolArchive 'https://mirror.invalid/fixed.zip' 'https://official.invalid/fixed.zip' $downloadFixture 30 }
        catch { $errorMessage = $_.Exception.Message }
        if ($failure -eq 'HTTP 403 Forbidden') {
            Assert (-not $errorMessage) 'known source failure must retry the same official payload'
            Assert ($script:ToolDownloadCalls.Count -eq 2) 'official tool retry must happen only once'
            Assert ($script:ToolDownloadCalls[1].Budget -le $script:ToolDownloadCalls[0].Budget) 'tool fallback must share the remaining budget'
        } else {
            Assert ($errorMessage -eq $failure) 'I/O and unknown failures must stay terminal'
            Assert ($script:ToolDownloadCalls.Count -eq 1) 'terminal tool errors must not retry official'
        }
    }
} finally {
    Remove-Item Function:Invoke-WebRequest
    Remove-Item -LiteralPath $downloadFixture -Force -ErrorAction SilentlyContinue
}
$script:CorepackJS = $null
function node { $global:LASTEXITCODE = 17 }
$failed = $false
try { Invoke-Pnpm install } catch { $failed = $true }
Assert $failed 'native pnpm failures must stop installation'
Remove-Item Function:node
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
$slackFixture = Join-Path ([IO.Path]::GetTempPath()) ('installer-slack-legacy-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $slackFixture | Out-Null
try {
    $probe = Join-Path $slackFixture 'probe.ps1'
    Set-Content -LiteralPath $probe -Encoding UTF8 -Value @'
param($Installer, $Root, $TargetVersion, $Mode)
. $Installer -Version $TargetVersion -InstallDir (Join-Path $Root 'installed')
$env:PROCESSOR_ARCHITECTURE = 'AMD64'; $env:PROCESSOR_ARCHITEW6432 = $null
function Ensure-Node {}
function Ensure-Uv {}
function Ensure-Bash {}
function Ensure-Pnpm {}
function Assert-CrabotStopped {}
function Invoke-WebRequest($Uri, $OutFile, [switch]$UseBasicParsing, $TimeoutSec) {
    if ($OutFile.EndsWith('.sha256')) {
        Set-Content -LiteralPath $OutFile -Value (Get-FileHash -LiteralPath $OutFile.Substring(0, $OutFile.Length - 7) -Algorithm SHA256).Hash
    } else { Set-Content -LiteralPath $OutFile -Value 'archive fixture' }
}
function Expand-Archive($LiteralPath, $DestinationPath, [switch]$Force) {
    $release = Join-Path $DestinationPath "crabot-$Version-windows-x64"
    foreach ($file in @('cli.mjs','package.json','scripts/fixture','crabot-memory/pyproject.toml','crabot-memory/uv.lock','dist/fixture')) {
        $path = Join-Path $release $file
        New-Item -ItemType Directory -Force -Path (Split-Path $path -Parent) | Out-Null
        Set-Content -LiteralPath $path -Value 'fixture'
    }
    foreach ($mod in @('crabot-shared','scripts/lib','crabot-core','crabot-admin','crabot-agent','crabot-channel-dingtalk','crabot-channel-slack','crabot-channel-feishu','crabot-channel-telegram','crabot-channel-wechat','crabot-mcp-tools')) {
        if ($mod -eq 'crabot-channel-slack' -and $Mode -ne 'complete') {
            if ($Mode -eq 'partial') { New-Item -ItemType Directory -Path (Join-Path $release $mod) | Out-Null }
            continue
        }
        if ($mod -eq 'crabot-core' -and $Mode -eq 'missing-core') { continue }
        foreach ($file in @('package.json','pnpm-lock.yaml')) {
            $path = Join-Path (Join-Path $release $mod) $file
            New-Item -ItemType Directory -Force -Path (Split-Path $path -Parent) | Out-Null
            Set-Content -LiteralPath $path -Value 'fixture'
        }
    }
}
# Stop after the actual dependency preflight, before product replacement or tool execution.
function Verify-Release { throw 'fixture-preflight-complete' }
try { Install-Crabot } catch {
    if ($_.Exception.Message -eq 'fixture-preflight-complete') { Write-Output 'fixture-preflight-complete'; exit 0 }
    Write-Output $_.Exception.Message; exit 2
}
exit 99
'@
    $shell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
    foreach ($case in @(
        @('v2026.9.23', 'absent', ''),
        @('v2026.10.12.4', 'absent', ''),
        @('v2026.10.12.4', 'complete', ''),
        @('pr-test', 'complete', ''),
        @('pr-test', 'absent', 'crabot-channel-slack'),
        @('v2026.10.12.4', 'partial', 'crabot-channel-slack'),
        @('v2026.10.12.4', 'missing-core', 'crabot-core')
    )) {
        $caseRoot = Join-Path $slackFixture ($case[0] + '-' + $case[1])
        $output = (& $shell -NoProfile -NonInteractive -File $probe (Join-Path $repo 'install.ps1') $caseRoot $case[0] $case[1] 2>&1) -join "`n"
        if ($case[2]) {
            Assert ($LASTEXITCODE -eq 1 -and $output.Contains("Release dependency manifest missing for $($case[2])")) "incomplete $($case[0])/$($case[1]) must be rejected: $output"
            Assert (-not $output.Contains('fixture-preflight-complete')) 'incomplete package must fail before product replacement'
        } else {
            Assert ($LASTEXITCODE -eq 0 -and $output.Contains('fixture-preflight-complete')) "supported $($case[0])/$($case[1]) must pass dependency preflight: $output"
        }
    }
} finally { Remove-Item -LiteralPath $slackFixture -Recurse -Force }
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
        function node { if ($args[0] -eq '-v') { 'v22.12.0' } else { 'x64' }; $global:LASTEXITCODE = 0 }
        Ensure-Node
        Remove-Item Function:node
        Assert $script:PrivateNode 'Node 22.12 must select the validated private Node'
        Write-CrabotLauncher $product
        $env:Path = "$oldNode;$oldPath"
        $output = & (Join-Path $product 'crabot.cmd')
        Assert ($LASTEXITCODE -eq 0 -and $output -contains 'private-node-ok') 'new terminal launcher must ignore old Machine PATH Node'
        Remove-Item -LiteralPath (Join-Path $nodeDir 'node.exe')
        $savedPreference = $ErrorActionPreference
        try { $ErrorActionPreference = 'Continue'; & (Join-Path $product 'crabot.cmd') 2>$null }
        finally { $ErrorActionPreference = $savedPreference }
        Assert ($LASTEXITCODE -ne 0) 'missing private Node must fail rather than use the old Node'
        $oldTemp = $env:TEMP
        $env:TEMP = Join-Path $launcherRoot 'download space'
        New-Item -ItemType Directory -Path $env:TEMP | Out-Null
        try {
            foreach ($lockMode in @('readable', 'exclusive')) {
                $script:PrivateNode = $false
                $script:PayloadLock = $null
                $script:PayloadProcess = $null
                $script:LockMode = $lockMode
                function node { if ($args[0] -eq '-v') { 'v22.12.0' } else { 'x64' }; $global:LASTEXITCODE = 0 }
                function Expand-Archive($LiteralPath, $DestinationPath) {
                    Microsoft.PowerShell.Archive\Expand-Archive -LiteralPath $LiteralPath -DestinationPath $DestinationPath
                    $script:NodePayload = Join-Path $DestinationPath ([IO.Path]::GetFileNameWithoutExtension($LiteralPath))
                    $hidden = Join-Path $script:NodePayload 'hidden-payload-fixture'
                    [IO.File]::WriteAllText($hidden, 'complete-payload')
                    [IO.File]::SetAttributes($hidden, [IO.FileAttributes]::Hidden)
                    if ($script:LockMode -eq 'readable') {
                        $script:PayloadProcess = Start-Process -FilePath (Join-Path $script:NodePayload 'node.exe') -ArgumentList @('-e', 'setInterval(function(){},1000)') -WorkingDirectory $script:NodePayload -NoNewWindow -PassThru
                        $renameFailed = $false
                        try { Move-Item -LiteralPath $script:NodePayload -Destination (Join-Path $launcherRoot 'renamed-payload') }
                        catch { $renameFailed = $_.FullyQualifiedErrorId -like 'MoveDirectoryItemIOError,*' }
                        Assert $renameFailed 'a real process using the source directory must reproduce the directory move failure'
                    } else {
                        $script:PayloadLock = [IO.File]::Open((Join-Path $script:NodePayload 'README.md'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
                    }
                }
                $failure = $null
                try { Ensure-Node } catch { $failure = $_ }
                finally {
                    if ($script:PayloadLock) { $script:PayloadLock.Dispose() }
                    if ($script:PayloadProcess) {
                        if (-not $script:PayloadProcess.HasExited) { $script:PayloadProcess.Kill() }
                        Assert ($script:PayloadProcess.WaitForExit(10000)) 'fixture process must exit before cleanup'
                        $script:PayloadProcess.Dispose()
                    }
                    Remove-Item Function:node, Function:Expand-Archive
                    Get-ChildItem -LiteralPath $env:TEMP | Remove-Item -Recurse -Force
                }
                if ($lockMode -eq 'readable') {
                    Assert (-not $failure) "readable locked Node payload must install: $failure"
                    Assert $script:PrivateNode 'private Node must be selected only after successful installation'
                    $bootstrappedVersion = (& (Join-Path $nodeDir 'node.exe') -v).TrimStart('v')
                    Assert ($LASTEXITCODE -eq 0 -and [version]$bootstrappedVersion -ge [version]'22.14.0') 'cold old-Node repair must download and verify a usable official Node ZIP'
                    Assert ((& (Join-Path $nodeDir 'node.exe') -p 'process.arch') -eq 'x64') 'private official Node must execute as x64'
                    Assert (Test-Path -LiteralPath (Join-Path $nodeDir 'node_modules/npm/bin/npm-cli.js')) 'private Node must include the bundled npm files'
                    Assert (([IO.File]::ReadAllText((Join-Path $nodeDir 'hidden-payload-fixture'))) -eq 'complete-payload') 'private Node copy must preserve hidden payload files'
                    Remove-Item -LiteralPath $nodeDir -Recurse -Force
                } else {
                    Assert ($null -ne $failure) 'unreadable source files must remain installation failures'
                    Assert (-not $script:PrivateNode) 'a failed copy must not select the incomplete private Node'
                    Assert (-not (Test-Path -LiteralPath $nodeDir)) 'a failed copy must clean up the incomplete tool directory'
                }
            }
        } finally { $env:TEMP = $oldTemp }
        Set-Content -LiteralPath (Join-Path $product 'crabot.cmd') -Value '@echo custom' -Encoding ASCII
        Write-CrabotLauncher $product
        Assert ((Get-Content -LiteralPath (Join-Path $product 'crabot.cmd') -Raw).Trim() -eq '@echo custom') 'custom launchers must survive'
    } finally {
        $env:LOCALAPPDATA = $oldLocal; $env:Path = $oldPath
        Remove-Item -LiteralPath $launcherRoot -Recurse -Force
    }
    $corepackRoot = Join-Path ([IO.Path]::GetTempPath()) ('corepack-signature-' + [guid]::NewGuid().ToString('N'))
    $oldLocal = $env:LOCALAPPDATA; $oldPath = $env:Path; $oldCorepackHome = $env:COREPACK_HOME
    try {
        $env:LOCALAPPDATA = Join-Path $corepackRoot 'local'
        $env:COREPACK_HOME = Join-Path $corepackRoot 'cache'
        $oldTool = Join-Path $corepackRoot 'old'
        npm install --prefix $oldTool --ignore-scripts --no-audit --no-fund --registry=https://registry.npmjs.org corepack@0.29.4
        Assert-NativeSuccess 'Old Corepack fixture'
        $env:Path = "$(Join-Path $oldTool 'node_modules/.bin');$oldPath"
        Ensure-Pnpm
        Assert ($script:CorepackJS -and (Test-Path -LiteralPath $script:CorepackJS)) 'old npm signing keys must trigger the private Corepack fallback'
        $version = Invoke-Pnpm --version
        Assert ($version -eq '9.15.9') 'fallback must run the fixed project pnpm version with signature checks enabled'
    } finally {
        $env:LOCALAPPDATA = $oldLocal; $env:Path = $oldPath; $env:COREPACK_HOME = $oldCorepackHome
        Remove-Item -LiteralPath $corepackRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    $instanceRoot = Join-Path ([IO.Path]::GetTempPath()) ('instance-space-' + [guid]::NewGuid().ToString('N'))
    $dataRoot = Join-Path $instanceRoot ('data-' + [char]0x7a7a)
    New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
    try {
        $instance = @{ data_dir = $dataRoot; port_offset = 0 } | ConvertTo-Json
        [IO.File]::WriteAllText((Join-Path $instanceRoot 'instance.json'), $instance, [Text.UTF8Encoding]::new($false))
        Set-Content -LiteralPath (Join-Path $dataRoot 'mm.pid') -Value $PID -Encoding ASCII
        $probe = Join-Path $instanceRoot 'probe.ps1'
        $env:CRABOT_TEST_INSTALLER = Join-Path $repo 'install.ps1'
        $env:CRABOT_TEST_INSTANCE = $instanceRoot
        Set-Content -LiteralPath $probe -Encoding ASCII -Value @'
. $env:CRABOT_TEST_INSTALLER
Assert-CrabotStopped $env:CRABOT_TEST_INSTANCE
exit 99
'@
        $shell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
        $proc = Start-Process -FilePath $shell -ArgumentList @('-NoProfile','-NonInteractive','-File', "`"$probe`"") -NoNewWindow -Wait -PassThru
        Assert ($proc.ExitCode -eq 1) 'UTF-8 instance data paths must locate the live PID and reject reinstall'
    } finally {
        Remove-Item Env:CRABOT_TEST_INSTALLER, Env:CRABOT_TEST_INSTANCE -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $instanceRoot -Recurse -Force
    }
    Assert (-not (Test-GitBash (Join-Path $env:WINDIR 'System32/bash.exe'))) 'WSL launcher must not be selected as Git Bash'
    $realGit = Get-Command git
    $gitBash = [IO.Path]::GetFullPath((Join-Path (Split-Path $realGit.Source -Parent) '../bin/bash.exe'))
    Assert (Test-GitBash $gitBash) 'native Git Bash from git/cmd must be detected'
}
Write-Host 'PowerShell installer regressions passed'
