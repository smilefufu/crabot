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
        $atom = (Invoke-WebRequest -Uri "https://github.com/smilefufu/crabot/releases.atom").Content
        if ($atom -match '<title>([^<]+)</title>.*?<title>([^<]+)</title>') {
            $Version = $Matches[2].Trim()
        } else {
            Write-Err "Failed to fetch latest version from GitHub."
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

# 设置管理密码
Write-Host "`n== Admin Password ==`n" -ForegroundColor Cyan
$dataDir = if ($FromSource) { Join-Path (Get-Location) "data" } else { Join-Path $InstallDir "data" }
$adminDir = Join-Path $dataDir "admin"
$adminEnv = Join-Path $adminDir ".env"
New-Item -ItemType Directory -Force -Path $adminDir | Out-Null

$needPassword = $true
if (Test-Path $adminEnv) {
    $content = Get-Content $adminEnv -Raw
    if ($content -match "CRABOT_ADMIN_PASSWORD=") {
        Write-Info "Admin password already configured."
        $needPassword = $false
    }
}

if ($needPassword) {
    while ($true) {
        $secPass = Read-Host "Set admin password" -AsSecureString
        $password = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secPass))
        if ($password.Length -lt 4) {
            Write-Warn "Password must be at least 4 characters."
            continue
        }
        $secConfirm = Read-Host "Confirm password" -AsSecureString
        $confirm = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
            [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secConfirm))
        if ($password -ne $confirm) {
            Write-Warn "Passwords do not match. Try again."
            continue
        }
        break
    }
    Add-Content -Path $adminEnv -Value "CRABOT_ADMIN_PASSWORD=$password"
    Write-Info "Password saved."
}

Write-Host "`n== Done! ==`n" -ForegroundColor Cyan
Write-Info "Run 'crabot start' to start Crabot."
Write-Info "Run 'crabot --help' for all commands."
