# Crabot Windows Installer
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1

param(
    [switch]$FromSource,
    [string]$Version = "latest",
    [string]$InstallDir = "$env:USERPROFILE\.crabot"
)

$RequiredNodeVersion = "22.14.0"
$ErrorActionPreference = 'Stop'

function Write-Info($msg)  { Write-Host "[crabot] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "[crabot] $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "[crabot] $msg" -ForegroundColor Red }

function Assert-NativeSuccess($stage) {
    if ($LASTEXITCODE -ne 0) { throw "$stage failed (exit code $LASTEXITCODE)" }
}
$script:ToolPaths = @()
$script:PrivateNode = $false
function Add-ToolPath($directory) {
    $env:Path = "$directory;$env:Path"
    $script:ToolPaths += $directory
}


# Installer-owned helpers also work with legacy packages; verify every file before executing.
$InstallerHelperRevision = 'bf27d0652f8edc227cbac9b128e505344666006a'
$InstallerHelperHashes = @{
    'scripts/installer-deps.mjs' = 'd4fd4bed9aa55ab09c65f7f63ffb8bfe275fbfac953caca131e5504df67d72b7'
    'scripts/lib/install-network.mjs' = 'a6df9a4f7133e3efcf7ab82e89e44e4867c8ba2e04eb0366b05d030a4fb1ab6f'
    'scripts/lib/memory-deps.mjs' = '4a916bc72dcfb2d484a4f60b2ff5b2b82d7a863362f0ad52a798a5d456e11f65'
    'scripts/lib/run-bounded.mjs' = '20cd05bbf043961f774a68d83c5c4ab5885a33dda0e36409788341b054132df7'
    'scripts/lib/toolchain.mjs' = 'b6f7ce6aeb57c793aae19701aaed2785760064b60f539d0d01e78b9d39f9cc20'
}
$script:InstallerHelper = $null
$script:InstallerHelperTemp = $null
$script:NpmContext = '-'
function Get-InstallerHelper {
    if ($script:InstallerHelper) { return $script:InstallerHelper }
    $candidate = $PSScriptRoot
    $valid = [bool]$candidate
    if ($valid) {
        foreach ($relative in $InstallerHelperHashes.Keys) {
            $file = Join-Path $candidate $relative
            if (-not (Test-Path -LiteralPath $file) -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $InstallerHelperHashes[$relative]) { $valid = $false; break }
        }
    }
    if ($valid) { $script:InstallerHelper = Join-Path $candidate 'scripts/installer-deps.mjs'; return $script:InstallerHelper }
    $script:InstallerHelperTemp = Join-Path $env:TEMP ('crabot-installer-helpers-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $script:InstallerHelperTemp | Out-Null
    foreach ($relative in $InstallerHelperHashes.Keys) {
        $file = Join-Path $script:InstallerHelperTemp $relative
        New-Item -ItemType Directory -Force -Path (Split-Path $file -Parent) | Out-Null
        Invoke-WebRequest "https://raw.githubusercontent.com/smilefufu/crabot/$InstallerHelperRevision/$relative" -OutFile $file -UseBasicParsing -TimeoutSec 60
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ine $InstallerHelperHashes[$relative]) { throw 'Installer helper checksum mismatch' }
    }
    $script:InstallerHelper = Join-Path $script:InstallerHelperTemp 'scripts/installer-deps.mjs'
    return $script:InstallerHelper
}
function Get-MirrorMetadata($uri) {
    $client = New-Object Net.WebClient
    $client.Encoding = [Text.Encoding]::UTF8
    try {
        $task = $client.DownloadStringTaskAsync([Uri]$uri)
        if ($task.Wait(5000)) { return $task.Result }
        $client.CancelAsync()
    } catch { return $null }
    finally { $client.Dispose() }
    return $null
}
function Get-ToolArchive($mirror, $official, $file, $budgetSeconds = 900) {
    $started = [Diagnostics.Stopwatch]::StartNew()
    $url = if ($mirror) { $mirror } else { $official }
    while ($true) {
        $remaining = [int][Math]::Floor($budgetSeconds - $started.Elapsed.TotalSeconds)
        if ($remaining -le 0) { throw 'Tool download timed out' }
        try {
            $response = Invoke-WebRequest $url -OutFile $file -UseBasicParsing -TimeoutSec $remaining -PassThru
            $base = $response.BaseResponse
            if ($base) {
                $actual = if ($base.PSObject.Properties.Name -contains 'ResponseUri') { $base.ResponseUri } else { $base.RequestMessage.RequestUri }
                Write-Info "Tool archive host: $($actual.Host)"
            }
            return
        }
        catch {
            $message = $_.Exception.Message
            if ($url -eq $official -or $message -match 'Access.*denied|permission|ENOSPC|disk.*full|path.*not found' -or $message -notmatch '403|404|408|429|50[0-9]|timed out|connection|transport|decryption|name.*resolved') { throw }
            Write-Warn 'Domestic tool download failed; retrying the same official version.'
            Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
            $url = $official
        }
    }
}

# --- Node.js in a writable user directory ---
function Ensure-Node {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        try {
            $ver = (node -v).TrimStart('v')
            $ok = $LASTEXITCODE -eq 0 -and [version]$ver -ge [version]$RequiredNodeVersion
            $cpu = node -p 'process.arch'
            if ($ok -and $LASTEXITCODE -eq 0 -and $cpu -eq 'x64') { Write-Info "Node.js $ver found"; return }
        } catch { Write-Warn "Current Node is unusable: $_" }
    }
    $nodeDir = Join-Path $env:LOCALAPPDATA 'crabot\node'
    $cached = Join-Path $nodeDir 'node.exe'
    if (Test-Path -LiteralPath $cached) {
        $ver = (& $cached -v).TrimStart('v')
        if ($LASTEXITCODE -eq 0 -and [version]$ver -ge [version]$RequiredNodeVersion) { $script:PrivateNode = $true; Add-ToolPath $nodeDir; return }
    }
    $stage = Join-Path $env:TEMP ("crabot-node-{0}" -f [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        $filename = 'node-v22.23.3-win-x64.zip'
        $expected = '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71'
        $base = 'https://cdn.npmmirror.com/binaries/node/v22.23.3'
        $metadata = Get-MirrorMetadata "$base/SHASUMS256.txt"
        $mirror = if ($metadata -match "$expected\s+$([regex]::Escape($filename))") { "$base/$filename" } else { $null }
        Write-Info "Node download source: $(if ($mirror) { $base } else { 'https://nodejs.org/dist/v22.23.3 (domestic unavailable)' })"
        $archive = Join-Path $stage $filename
        Get-ToolArchive $mirror "https://nodejs.org/dist/v22.23.3/$filename" $archive
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $expected) { throw 'Node archive checksum mismatch' }
        Expand-Archive -LiteralPath $archive -DestinationPath $stage
        $payload = Join-Path $stage ([IO.Path]::GetFileNameWithoutExtension($filename))
        $version = (& (Join-Path $payload 'node.exe') -v).TrimStart('v')
        Assert-NativeSuccess 'Downloaded Node version probe'
        if ([version]$version -lt [version]$RequiredNodeVersion) { throw 'Downloaded Node is below the required version' }
        if (Test-Path -LiteralPath $nodeDir) { Remove-Item -LiteralPath $nodeDir -Recurse -Force }
        New-Item -ItemType Directory -Force -Path (Split-Path $nodeDir -Parent) | Out-Null
        Write-Info "Installing Node.js $version to $nodeDir..."
        # Windows may allow reads while a process or scanner prevents directory moves.
        try { Copy-Item -LiteralPath $payload -Destination $nodeDir -Recurse -Force }
        catch {
            Remove-Item -LiteralPath $nodeDir -Recurse -Force -ErrorAction SilentlyContinue
            throw
        }
        $script:PrivateNode = $true
        Add-ToolPath $nodeDir
    } finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}

# --- uv ---
function Ensure-Uv {
    $uvCmd = Get-Command uv -ErrorAction SilentlyContinue
    if ($uvCmd) {
        uv --no-config export --help > $null
        if ($LASTEXITCODE -eq 0) {
            uv --no-config --show-settings python list --only-downloads --output-format json > $null
            if ($LASTEXITCODE -eq 0) { uv --version; Assert-NativeSuccess 'uv version probe'; return }
        }
    }
    $version = '0.13.0'
    $filename = 'uv-x86_64-pc-windows-msvc.zip'
    $expected = '088962f9e7b7bd9ea740c04c650b2a21c8928c345bd99ac24350dc924dba656c'
    $base = 'https://mirrors.ustc.edu.cn/github-release/astral-sh/uv/LatestRelease'
    $metadata = Get-MirrorMetadata "$base/uv-installer.sh"
    $mirror = if ($metadata -match 'APP_VERSION="0\.13\.0"') { "$base/$filename" } else { $null }
    Write-Info "uv download source: $(if ($mirror) { $base } else { 'official 0.13.0 (domestic missing/unavailable)' })"
    $stage = Join-Path $env:TEMP ('crabot-uv-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $stage | Out-Null
    try {
        $archive = Join-Path $stage $filename
        Get-ToolArchive $mirror "https://github.com/astral-sh/uv/releases/download/$version/$filename" $archive
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $expected) { throw 'uv archive checksum mismatch' }
        Expand-Archive -LiteralPath $archive -DestinationPath $stage
        $payload = @(Get-ChildItem -LiteralPath $stage -Filter uv.exe -File -Recurse)
        if ($payload.Count -ne 1) { throw 'uv archive payload is invalid' }
        $bin = Join-Path $env:USERPROFILE '.local/bin'
        New-Item -ItemType Directory -Force -Path $bin | Out-Null
        foreach ($name in @('uv.exe','uvx.exe')) { Copy-Item -LiteralPath (Join-Path $payload[0].DirectoryName $name) -Destination (Join-Path $bin $name) -Force }
        Add-ToolPath $bin
        uv --version
        Assert-NativeSuccess 'uv version probe'
    } finally { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
}

function Test-GitBash($candidate) {
    if (-not $candidate -or -not (Test-Path -LiteralPath $candidate)) { return $false }
    if ($candidate.StartsWith($env:WINDIR, [StringComparison]::OrdinalIgnoreCase)) { return $false }
    $env:CRABOT_BASH_CANDIDATE = $candidate
    try {
        @'
const {spawnSync}=require("node:child_process"); const r=spawnSync(process.env.CRABOT_BASH_CANDIDATE,["--noprofile","--norc","-c","uname -s"],{encoding:"utf8",timeout:10000}); process.exit(!r.error && r.status===0 && /^(MINGW|MSYS)/.test(r.stdout.trim()) ? 0 : 1)
'@ | node
        return $LASTEXITCODE -eq 0
    } finally { Remove-Item Env:CRABOT_BASH_CANDIDATE -ErrorAction SilentlyContinue }
}

# --- Git Bash (reject the WSL launcher on PATH) ---
$PortableGitVersion = '2.54.0'
$PortableGitSha256 = 'bea006a6cc69673f27b1647e84ab3a68e912fbc175ab6320c5987e012897f311'
function Ensure-Bash {
    $candidates = @($env:CRABOT_BASH_PATH)
    $bashCmd = Get-Command bash -ErrorAction SilentlyContinue
    if ($bashCmd) { $candidates += $bashCmd.Source }
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd) {
        $parent = Split-Path $gitCmd.Source -Parent
        foreach ($relative in @('..\bin\bash.exe', '..\..\bin\bash.exe')) {
            $candidates += [IO.Path]::GetFullPath((Join-Path $parent $relative))
        }
    }
    $candidates += Join-Path $InstallDir 'PortableGit\bin\bash.exe'
    foreach ($candidate in $candidates) {
        if (Test-GitBash $candidate) {
            $env:CRABOT_BASH_PATH = $candidate
            [Environment]::SetEnvironmentVariable('CRABOT_BASH_PATH', $candidate, 'User')
            return
        }
    }
    $filename = "PortableGit-$PortableGitVersion-64-bit.7z.exe"
    $exe = Join-Path $env:TEMP ("{0}-{1}.exe" -f $filename, [guid]::NewGuid().ToString('N'))
    $dest = Join-Path $InstallDir 'PortableGit'
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    try {
        Invoke-WebRequest "https://github.com/git-for-windows/git/releases/download/v$PortableGitVersion.windows.1/$filename" -OutFile $exe -UseBasicParsing
        if ((Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash -ine $PortableGitSha256) { throw 'PortableGit checksum mismatch' }
        $proc = Start-Process -FilePath $exe -ArgumentList @("-o`"$dest`"", '-y') -NoNewWindow -PassThru
        if (-not $proc.WaitForExit(120000)) { $proc.Kill(); throw 'PortableGit extraction timed out' }
        if ($proc.ExitCode -ne 0) { throw "PortableGit extraction failed: $($proc.ExitCode)" }
        $bash = Join-Path $dest 'bin\bash.exe'
        if (-not (Test-GitBash $bash)) { throw 'PortableGit did not provide a working Git Bash' }
        $env:CRABOT_BASH_PATH = $bash
        [Environment]::SetEnvironmentVariable('CRABOT_BASH_PATH', $bash, 'User')
    } finally { Remove-Item -LiteralPath $exe -Force -ErrorAction SilentlyContinue }
}

# --- pnpm (prepare a pinned private Corepack when needed) ---
function Ensure-Pnpm {
    Invoke-Pnpm --version | ForEach-Object { Write-Host $_ }
    Write-Info 'pnpm 9.15.9 ready'
}
function Invoke-Pnpm {
    $helper = Get-InstallerHelper
    $preference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & node $helper pnpm (Get-Location).Path $script:NpmContext @args 2>&1
        $status = $LASTEXITCODE
    } finally { $ErrorActionPreference = $preference }
    $result = $null
    foreach ($line in $output) {
        $text = [string]$line
        if ($text.StartsWith('CRABOT_TOOL_RESULT=')) { $result = $text.Substring(19) }
        elseif ($text) { Write-Output $text }
    }
    if ($status -ne 0) { throw "pnpm failed (exit code $status)" }
    if (-not $result) { throw 'pnpm helper did not return its verified tool context' }
    $script:NpmContext = $result
    $context = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($result)) | ConvertFrom-Json
    $script:CorepackJS = $context.corepack
}
function Get-LatestRelease {
    $response = Invoke-WebRequest 'https://github.com/smilefufu/crabot/releases/latest' -UseBasicParsing -MaximumRedirection 5
    $base = $response.BaseResponse
    if ($base.PSObject.Properties.Name -contains 'ResponseUri') { $uri = $base.ResponseUri.AbsoluteUri }
    else { $uri = $base.RequestMessage.RequestUri.AbsoluteUri }
    if ($uri -notmatch '/tag/([^/?#]+)') { throw "Failed to parse latest release: $uri" }
    return [uri]::UnescapeDataString($Matches[1])
}
function Verify-Release($root, $targetVersion) {
    foreach ($file in @('cli.mjs','package.json','dist/cli/main.js','scripts/start.mjs','crabot-memory/pyproject.toml','crabot-memory/uv.lock')) {
        if (-not (Test-Path -LiteralPath (Join-Path $root $file) -PathType Leaf)) { throw "Release package missing $file" }
    }
    $check = Join-Path $root 'scripts/check-release.mjs'
    if (Test-Path -LiteralPath $check) { node $check $targetVersion; Assert-NativeSuccess 'Release verification'; return }
    if ($targetVersion -notin @('v2026.9.23','v2026.10.12.4')) { throw 'Release package missing scripts/check-release.mjs' }
    foreach ($file in @('scripts/prepare-computer-use.mjs','scripts/computer-use/runtime.json','crabot-mcp-tools/dist/computer-use/service.js')) {
        if (Test-Path -LiteralPath (Join-Path $root $file)) { throw "Mixed release generation: $file" }
    }
    if ($targetVersion -eq 'v2026.10.12.4') {
        node (Join-Path $root 'scripts/prepare-scrapling.mjs') --check
        Assert-NativeSuccess 'Legacy Scrapling verification'
    } elseif (Test-Path -LiteralPath (Join-Path $root 'scripts/prepare-scrapling.mjs')) { throw 'Mixed release generation: Scrapling' }
}

function Assert-CrabotStopped($targetInstallDir) {
    $dataDir = Join-Path $targetInstallDir 'data'
    $portOffset = 0
    $instancePath = Join-Path $targetInstallDir 'instance.json'
    if (Test-Path -LiteralPath $instancePath -PathType Leaf) {
        $instance = Get-Content -LiteralPath $instancePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($instance.data_dir) {
            $dataDir = $instance.data_dir
        }
        if ($null -ne $instance.port_offset) {
            $portOffset = [int]$instance.port_offset
        }
    }

    $pidPath = Join-Path $dataDir 'mm.pid'
    if (Test-Path -LiteralPath $pidPath -PathType Leaf) {
        $crabotPid = 0
        $pidText = (Get-Content -LiteralPath $pidPath -Raw).Trim()
        if ([int]::TryParse($pidText, [ref]$crabotPid) -and (Get-Process -Id $crabotPid -ErrorAction SilentlyContinue)) {
            Write-Err "Crabot is running (PID $crabotPid). Run 'crabot stop', then run the installer again."
            exit 1
        }
    }

    try {
        $health = Invoke-RestMethod -Uri "http://localhost:$((19000 + $portOffset))/health" -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 2
        if ($health.data.status -eq 'healthy') {
            Write-Err "Crabot is running. Run 'crabot stop', then run the installer again."
            exit 1
        }
    } catch {
        # The management service is not running or is not a Crabot instance.
    }
}

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

function Install-Crabot {
try {
# Windows PowerShell 5.1 progress rendering slows large downloads; keep this local.
$ProgressPreference = 'SilentlyContinue'
# --- Main ---
Write-Host "`n== Crabot Installer ==`n" -ForegroundColor Cyan

$nativeArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
if ($nativeArch -ne 'AMD64') { throw "Unsupported Windows architecture: $nativeArch; only native x64 releases are published" }
$InstallDir = [IO.Path]::GetFullPath($InstallDir)
if ($Version -notmatch '^[A-Za-z0-9._-]+$') { throw 'Invalid release version' }
Ensure-Node
Ensure-Uv
Ensure-Bash
if (-not $FromSource) { Ensure-Pnpm }

if ($FromSource) {
    Write-Info "Source install..."
    $sourceRoot = if ($PSScriptRoot) { $PSScriptRoot } else { (Get-Location).Path }
    Push-Location $sourceRoot
    try {
        @'
import { runSourceUpgrade } from './scripts/upgrade-lib/source.mjs'
await runSourceUpgrade(process.cwd(), console)
'@ | node --input-type=module
        Assert-NativeSuccess 'Source preparation/build'
    } finally { Pop-Location }
} else {
    Write-Info "Release install..."
    if ($Version -eq "latest") {
        $Version = Get-LatestRelease
        Write-Info "Latest version: $Version"
    }
    Assert-CrabotStopped $InstallDir

    $filename = "crabot-$Version-windows-x64.zip"
    $url = "https://github.com/smilefufu/crabot/releases/download/$Version/$filename"
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $stageParent = Join-Path (Split-Path $InstallDir -Parent) (".crabot-i-{0}" -f [guid]::NewGuid().ToString('N').Substring(0, 8))
    $stageRelease = Join-Path $stageParent "crabot-$Version-windows-x64"
    $archivePath = Join-Path $stageParent $filename

    New-Item -ItemType Directory -Force -Path $stageParent | Out-Null
    try {
        Write-Info "Downloading $filename..."
        Invoke-WebRequest -Uri $url -OutFile $archivePath -UseBasicParsing -TimeoutSec 900

        $checksumUrl = "$url.sha256"
        $checksumPath = "$archivePath.sha256"
        Write-Info "Verifying release checksum..."
        Invoke-WebRequest -Uri $checksumUrl -OutFile $checksumPath -UseBasicParsing -TimeoutSec 60
        $expectedHash = ((Get-Content -LiteralPath $checksumPath -Raw).Trim() -split "\s+")[0]
        if ($expectedHash -notmatch '^[a-f0-9]{64}$') { throw 'Invalid release checksum manifest' }
        $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
        if ($actualHash -ine $expectedHash) {
            Write-Err "Release archive checksum verification failed."
            exit 1
        }

        Write-Info "Extracting..."
        Expand-Archive -LiteralPath $archivePath -DestinationPath $stageParent -Force
        if (-not (Test-Path -LiteralPath (Join-Path $stageRelease "cli.mjs") -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Join-Path $stageRelease "package.json") -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Join-Path $stageRelease "scripts") -PathType Container) -or
            -not (Test-Path -LiteralPath (Join-Path $stageRelease "crabot-memory") -PathType Container) -or
            -not (Test-Path -LiteralPath (Join-Path $stageRelease "dist") -PathType Container)) {
            Write-Err "Invalid release archive: expected files are missing from $stageRelease"
            exit 1
        }

        $runtimeModules = @('crabot-shared','scripts/lib','crabot-core','crabot-admin','crabot-agent','crabot-channel-dingtalk','crabot-channel-feishu','crabot-channel-telegram','crabot-channel-wechat','crabot-mcp-tools')
        foreach ($mod in $runtimeModules) {
            $moduleDir = Join-Path $stageRelease $mod
            if (-not (Test-Path -LiteralPath (Join-Path $moduleDir 'package.json') -PathType Leaf) -or
                -not (Test-Path -LiteralPath (Join-Path $moduleDir 'pnpm-lock.yaml') -PathType Leaf)) {
                Write-Err "Release dependency manifest missing for $mod"
                exit 1
            }
        }
        $stageMemoryDir = Join-Path $stageRelease 'crabot-memory'
        if (-not (Test-Path -LiteralPath (Join-Path $stageMemoryDir 'pyproject.toml') -PathType Leaf) -or
            -not (Test-Path -LiteralPath (Join-Path $stageMemoryDir 'uv.lock') -PathType Leaf)) {
            Write-Err "Memory dependency manifest missing at $stageMemoryDir"
            exit 1
        }

        $shortStage = Join-Path $stageParent 'p'
        Move-Item -LiteralPath $stageRelease -Destination $shortStage
        $stageRelease = $shortStage
        Verify-Release $stageRelease $Version

        $retainedEntries = @('PortableGit', 'data', 'instance.json', 'agent-venv', 'VERSION', 'crabot.cmd')
        foreach ($entry in Get-ChildItem -LiteralPath $stageRelease -Force) {
            if ($retainedEntries -contains $entry.Name) {
                continue
            }
            $target = Join-Path $InstallDir $entry.Name
            if ($entry.Name -ne '.computer-use-runtime' -and (Test-Path -LiteralPath $target)) {
                Remove-Item -LiteralPath $target -Recurse -Force
            }
            if ($entry.Name -eq '.computer-use-runtime' -and (Test-Path -LiteralPath $target)) {
                foreach ($child in Get-ChildItem -LiteralPath $entry.FullName -Force) {
                    $destination = Join-Path $target $child.Name
                    if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
                    Move-Item -LiteralPath $child.FullName -Destination $destination
                }
            } else { Move-Item -LiteralPath $entry.FullName -Destination $target }
        }

        foreach ($legacyDir in Get-ChildItem -LiteralPath $InstallDir -Directory -Filter 'crabot-*-windows-x64' -ErrorAction SilentlyContinue) {
            Remove-Item $legacyDir.FullName -Recurse -Force
        }

        # The root package has no release lockfile; retain its bundled production dependencies.
        # Do not resolve new commander, js-yaml or rotating-file-stream versions here.
        foreach ($mod in $runtimeModules) {
            $moduleDir = Join-Path $InstallDir $mod
            $nodeModulesDir = Join-Path $moduleDir 'node_modules'
            if (Test-Path -LiteralPath $nodeModulesDir -PathType Container) {
                Remove-Item -LiteralPath $nodeModulesDir -Recurse -Force
            }

            Write-Info "Restoring dependencies: $mod"
            Push-Location $moduleDir
            try {
                Invoke-Pnpm install --prod --frozen-lockfile
                if ($LASTEXITCODE -ne 0) {
                    exit $LASTEXITCODE
                }
            } finally {
                Pop-Location
            }
        }

        $memoryDir = Join-Path $InstallDir "crabot-memory"
        Write-Info "Syncing Memory dependencies..."
        Push-Location $memoryDir
        try {
            node (Get-InstallerHelper) memory $memoryDir -
            if ($LASTEXITCODE -ne 0) {
                exit $LASTEXITCODE
            }
        } finally {
            Pop-Location
        }

        Verify-Release $InstallDir $Version

    } finally {
        Remove-Item $stageParent -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# PATH
foreach ($directory in $script:ToolPaths) {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($directory -notin ($userPath -split ";")) { [Environment]::SetEnvironmentVariable("Path", "$directory;$userPath", "User") }
}
$crabotDir = if ($FromSource) { $sourceRoot } else { $InstallDir }

$legacyReleasePattern = ('^{0}\\crabot-[^\\]+-windows-x64\\?$' -f [regex]::Escape($crabotDir.TrimEnd('\')))
function Update-CrabotPath($pathValue) {
    $entries = @($pathValue -split ';' | Where-Object { $_ })
    $filtered = @($entries | Where-Object {
        $normalized = $_.Trim().TrimEnd('\')
        $normalized -notmatch $legacyReleasePattern -and $normalized -ine $crabotDir.TrimEnd('\')
    })
    return ((@($crabotDir) + $filtered) -join ';')
}

$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
$newUserPath = Update-CrabotPath $currentPath
if ($newUserPath -cne $currentPath) {
    [Environment]::SetEnvironmentVariable("Path", $newUserPath, "User")
    Write-Info "Updated user PATH for $crabotDir"
}
# SetEnvironmentVariable changes the registry; refresh this session too.
# Commands run immediately after installation need the new PATH.
$newSessionPath = Update-CrabotPath $env:Path
if ($newSessionPath -cne $env:Path) {
    $env:Path = $newSessionPath
}

# Update only recognized product launchers; preserve custom contents.
Write-CrabotLauncher $crabotDir

if (-not $FromSource) { Set-Content -LiteralPath (Join-Path $InstallDir 'VERSION') -Value $Version -Encoding ASCII }
Write-Host "`n== Done! ==`n" -ForegroundColor Cyan
Write-Info "Run 'crabot start' to start Crabot (will prompt for admin password on first run)."
Write-Info "Run 'crabot --help' for all commands."
Write-Warn "If a new terminal cannot find crabot, restart Windows Explorer or sign out and back in to refresh the user PATH."

} finally {
    if ($script:InstallerHelperTemp) { Remove-Item -LiteralPath $script:InstallerHelperTemp -Recurse -Force -ErrorAction SilentlyContinue }
}
}
if ($MyInvocation.InvocationName -ne '.') { Install-Crabot }
