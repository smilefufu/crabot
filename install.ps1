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

# --- Git Bash ---
# crabot-agent 的 Bash 工具依赖 bash.exe。Windows 上三段式探测：
#   1. CRABOT_BASH_PATH env（已配置）
#   2. PATH 里的 bash.exe
#   3. PATH 里的 git.exe 推 ..\..\bin\bash.exe（Git for Windows 默认 PATH 选项的常见情况）
# 都没有 → 下载 PortableGit 自解压到 $InstallDir\PortableGit，写 user env CRABOT_BASH_PATH。
$PortableGitVersion = "2.54.0"
function Ensure-Bash {
    if ($env:CRABOT_BASH_PATH -and (Test-Path $env:CRABOT_BASH_PATH)) {
        Write-Info "bash configured via CRABOT_BASH_PATH: $env:CRABOT_BASH_PATH"
        return
    }
    $bashCmd = Get-Command bash -ErrorAction SilentlyContinue
    if ($bashCmd) {
        Write-Info "bash found at $($bashCmd.Source)"
        return
    }
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd) {
        $candidate = [System.IO.Path]::GetFullPath((Join-Path (Split-Path $gitCmd.Source -Parent) "..\..\bin\bash.exe"))
        if (Test-Path $candidate) {
            Write-Info "bash found via git path: $candidate"
            [Environment]::SetEnvironmentVariable("CRABOT_BASH_PATH", $candidate, "User")
            $env:CRABOT_BASH_PATH = $candidate
            return
        }
    }
    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64') {
        Write-Err "Detected $env:PROCESSOR_ARCHITECTURE — auto-install only supports x64."
        Write-Err "Please install Git for Windows manually: https://git-scm.com/downloads/win"
        exit 1
    }

    $filename = "PortableGit-$PortableGitVersion-64-bit.7z.exe"
    $url = "https://github.com/git-for-windows/git/releases/download/v$PortableGitVersion.windows.1/$filename"
    $exe = Join-Path $env:TEMP $filename
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    $dest = Join-Path $InstallDir "PortableGit"

    Write-Info "Installing PortableGit $PortableGitVersion (~65MB) to $dest..."
    try {
        Invoke-WebRequest -Uri $url -OutFile $exe -UseBasicParsing
    } catch {
        Write-Err "Failed to download PortableGit from ${url}                                                                       : $_"
        Write-Err "Install Git for Windows manually: https://git-scm.com/downloads/win"
        exit 1
    }

    # PortableGit 是 7-zip SFX 自解压包，-o<dir> -y 静默解压
    $proc = Start-Process -FilePath $exe -ArgumentList @("-o`"$dest`"", "-y") -Wait -NoNewWindow -PassThru
    Remove-Item $exe -ErrorAction SilentlyContinue
    if ($proc.ExitCode -ne 0) {
        Write-Err "PortableGit extraction failed with exit code $($proc.ExitCode)"
        exit 1
    }

    $bashPath = Join-Path $dest "bin\bash.exe"
    if (-not (Test-Path $bashPath)) {
        Write-Err "PortableGit extracted but bash.exe missing at $bashPath"
        exit 1
    }
    [Environment]::SetEnvironmentVariable("CRABOT_BASH_PATH", $bashPath, "User")
    $env:CRABOT_BASH_PATH = $bashPath
    Write-Info "PortableGit installed. CRABOT_BASH_PATH set to $bashPath"
}

# --- pnpm（仅源码安装路径需要） ---
function Ensure-Pnpm {
    $corepackCmd = Get-Command corepack -ErrorAction SilentlyContinue
    if (-not $corepackCmd) {
        Write-Err "corepack not found (Node 16.13+ required). Reinstall Node.js."
        exit 1
    }
    # 不调 `corepack enable` —— 它会往 Node 安装目录（Program Files）写 pnpm/yarn
    # 系统 shim，非管理员 cmd 必然 EPERM。后续所有 `corepack pnpm ...` 调用会按
    # packageManager 字段按需下载到用户 cache 执行，不需要 enable。
    $pnpmVer = (corepack pnpm --version)
    Write-Info "pnpm $pnpmVer ready"
}

# --- Main ---
Write-Host "`n== Crabot Installer ==`n" -ForegroundColor Cyan

Ensure-Node
Ensure-Uv
Ensure-Bash

if ($FromSource) {
    Ensure-Pnpm
    Write-Info "Source install..."
    corepack pnpm install
    # shared 必须先编译
    Push-Location crabot-shared
    corepack pnpm install; corepack pnpm run build
    Pop-Location
    foreach ($mod in @('crabot-core','crabot-admin','crabot-agent','crabot-channel-host','crabot-channel-wechat','crabot-channel-telegram','crabot-channel-feishu','crabot-mcp-tools')) {
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
# 同步更新当前 session 的 $env:Path——SetEnvironmentVariable 只写注册表，
# 当前进程的 PATH 不会自动刷新。同 session 后续操作（如 crabot start）能立即用。
if ($env:Path -notlike "*$crabotDir*") {
    $env:Path = "$crabotDir;$env:Path"
}

# 创建 crabot.cmd 如果不存在
$cmdPath = Join-Path $crabotDir "crabot.cmd"
if (-not (Test-Path $cmdPath)) {
    # 注意：PowerShell 单引号字符串不转义 `n（会写出字面 `n 而非换行），必须用
    # 数组 + Set-Content 保证 Windows CRLF 行尾正确写两行。
    @('@echo off', 'node "%~dp0cli.mjs" %*') | Set-Content -Path $cmdPath -Encoding ASCII
}

Write-Host "`n== Done! ==`n" -ForegroundColor Cyan
Write-Info "Run 'crabot start' to start Crabot (will prompt for admin password on first run)."
Write-Info "Run 'crabot --help' for all commands."
Write-Warn "如果新开的终端找不到 crabot 命令，请重启资源管理器（任务管理器 → Windows 资源管理器 → 重启）或注销重登一次，让 user PATH 广播生效。"
