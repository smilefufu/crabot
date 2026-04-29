# Crabot Windows Installer
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1

param(
    [switch]$FromSource,
    [string]$Version = "latest",
    [string]$InstallDir = "$env:USERPROFILE\.crabot"
)

$RequiredNodeVersion = "22.14.0"

function Write-Info($msg)  { Write-Host "[crabot] $msg" -ForegroundColor Green }
function Write-Warn($msg)  { Write-Host "[crabot] $msg" -ForegroundColor Yellow }
function Write-Err($msg)   { Write-Host "[crabot] $msg" -ForegroundColor Red }

# --- Node.js ---
function Ensure-Node {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $ver = (node -v).TrimStart('v')
        Write-Info "Node.js $ver found"
        return
    }
    Write-Err "Node.js not found. Please install Node.js >= $RequiredNodeVersion from https://nodejs.org"
    exit 1
}

# --- uv ---
function Ensure-Uv {
    $uvCmd = Get-Command uv -ErrorAction SilentlyContinue
    if ($uvCmd) {
        Write-Info "uv found"
        return
    }
    Write-Info "Installing uv..."
    Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
}

# --- pnpm（仅源码安装路径需要） ---
function Ensure-Pnpm {
    $corepackCmd = Get-Command corepack -ErrorAction SilentlyContinue
    if (-not $corepackCmd) {
        Write-Err "corepack not found (Node 16.13+ required). Reinstall Node.js."
        exit 1
    }
    Write-Info "Activating pnpm via corepack..."
    corepack enable
    corepack prepare --activate
    $pnpmVer = (corepack pnpm --version)
    Write-Info "pnpm $pnpmVer ready"
}

# --- Main ---
Write-Host "`n== Crabot Installer ==`n" -ForegroundColor Cyan

Ensure-Node
Ensure-Uv

if ($FromSource) {
    Ensure-Pnpm
    Write-Info "Source install..."
    corepack pnpm install
    # shared 必须先编译
    Push-Location crabot-shared
    corepack pnpm install; corepack pnpm run build
    Pop-Location
    foreach ($mod in @('crabot-core','crabot-admin','crabot-agent','crabot-channel-host','crabot-channel-wechat','crabot-channel-telegram','crabot-mcp-tools')) {
        if (Test-Path $mod) {
            Push-Location $mod
            corepack pnpm install; corepack pnpm run build
            Pop-Location
        }
    }
    if (Test-Path 'crabot-admin/web') {
        Push-Location 'crabot-admin/web'
        corepack pnpm install; corepack pnpm run build
        Pop-Location
    }
    corepack pnpm run build:cli
    Set-Location crabot-memory
    uv sync
    Set-Location ..
} else {
    Write-Info "Release install..."
    if ($Version -eq "latest") {
        # 用 /releases/latest 的重定向拿真实 tag
        # （atom feed 的 <title> 是 release 标题，可能含 commit message + 中文，不能当 tag 用）
        try {
            $resp = Invoke-WebRequest -Uri "https://github.com/smilefufu/crabot/releases/latest" -UseBasicParsing -MaximumRedirection 5
            $finalUrl = $resp.BaseResponse.ResponseUri.AbsoluteUri
        } catch {
            Write-Err "Failed to fetch latest version from GitHub: $_"
            exit 1
        }
        if ($finalUrl -match '/tag/(.+)$') {
            $Version = $Matches[1]
        } else {
            Write-Err "Failed to parse latest version from $finalUrl"
            exit 1
        }
        Write-Info "Latest version: $Version"
    }
    $filename = "crabot-$Version-windows-x64.zip"
    $url = "https://github.com/smilefufu/crabot/releases/download/$Version/$filename"

    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    Write-Info "Downloading $filename..."
    Invoke-WebRequest -Uri $url -OutFile "$env:TEMP\$filename"

    Write-Info "Extracting..."
    Expand-Archive -Path "$env:TEMP\$filename" -DestinationPath $InstallDir -Force
    Remove-Item "$env:TEMP\$filename"

    Set-Location "$InstallDir\crabot-memory"
    uv sync
    Set-Location $InstallDir
}

# PATH
$crabotDir = if ($FromSource) { (Get-Location).Path } else { $InstallDir }
$currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($currentPath -notlike "*$crabotDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$crabotDir;$currentPath", "User")
    Write-Info "Added $crabotDir to user PATH"
}

# 创建 crabot.cmd 如果不存在
$cmdPath = Join-Path $crabotDir "crabot.cmd"
if (-not (Test-Path $cmdPath)) {
    '@echo off`nnode "%~dp0cli.mjs" %*' | Out-File -FilePath $cmdPath -Encoding ASCII
}

Write-Host "`n== Done! ==`n" -ForegroundColor Cyan
Write-Info "Run 'crabot start' to start Crabot (will prompt for admin password on first run)."
Write-Info "Run 'crabot --help' for all commands."
