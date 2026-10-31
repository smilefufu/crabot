param(
 [Parameter(Mandatory=$true)][string]$Installer,
 [string]$TemporaryDirectory,
 [ValidateSet('complete','retry','space')][string]$Expected = 'complete'
)
$ErrorActionPreference = 'Stop'
$Installer = (Resolve-Path $Installer).Path
# A simulated user profile must inherit the real user's private temp ACL,
# rather than the runner's shared workspace volume. The selected app root stays on D:.
$homeRoot = Join-Path ([IO.Path]::GetTempPath()) ('wrapper-home-' + [guid]::NewGuid().ToString('N'))
$env:USERPROFILE = $homeRoot
$env:HOME = $homeRoot
$env:APPDATA = Join-Path $homeRoot 'AppData/Roaming'
$env:LOCALAPPDATA = Join-Path $homeRoot 'AppData/Local'
New-Item $env:APPDATA,$env:LOCALAPPDATA -ItemType Directory -Force | Out-Null
$target = Join-Path $env:RUNNER_TEMP ('crabot wrapper UI ' + [guid]::NewGuid().ToString('N'))
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WrapperUI {
 public delegate bool Visitor(IntPtr hwnd,IntPtr unused);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor callback,IntPtr unused);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr hwnd,Visitor callback,IntPtr unused);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] public static extern IntPtr ReadText(IntPtr hwnd,uint message,IntPtr length,StringBuilder text,uint flags,uint timeout,out IntPtr result);
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hwnd,int id);
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd,uint message,IntPtr wparam,IntPtr lparam);
 public static string Text(IntPtr hwnd) { var text=new StringBuilder(4096);IntPtr result;ReadText(hwnd,0xD,(IntPtr)text.Capacity,text,2,500,out result);return text.ToString(); }
 public static IntPtr[] Windows() { var result=new List<IntPtr>();EnumWindows((hwnd,unused)=>{result.Add(hwnd);return true;},IntPtr.Zero);return result.ToArray(); }
 public static IntPtr[] Children(IntPtr hwnd) { var result=new List<IntPtr>();EnumChildWindows(hwnd,(child,unused)=>{result.Add(child);return true;},IntPtr.Zero);return result.ToArray(); }
 public static uint Pid(IntPtr hwnd) { uint pid;GetWindowThreadProcessId(hwnd,out pid);return pid; }
 public static void Click(IntPtr hwnd) { SendMessage(hwnd,0xF5,IntPtr.Zero,IntPtr.Zero); }
}
'@
if ($TemporaryDirectory) {
 $env:TEMP = (Resolve-Path $TemporaryDirectory).Path
 $env:TMP = $env:TEMP
}
$process = Start-Process $Installer -ArgumentList "/D=$target" -PassThru
$null = $process.Handle
$owned = [Collections.Generic.HashSet[uint32]]::new()
[void]$owned.Add([uint32]$process.Id)
$clicked = 0
$finished = $false
$verified = $false
$observed = [Collections.Generic.HashSet[string]]::new()
$deadline = (Get-Date).AddMinutes(10)
try {
 while ((Get-Date) -lt $deadline) {
  foreach ($row in @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)) {
   if ($owned.Contains([uint32]$row.ParentProcessId)) { [void]$owned.Add([uint32]$row.ProcessId) }
  }
  foreach ($window in [WrapperUI]::Windows()) {
   if (!$owned.Contains([WrapperUI]::Pid($window))) { continue }
   $children = [WrapperUI]::Children($window)
   $text = @([WrapperUI]::Text($window)) + @($children | ForEach-Object { [WrapperUI]::Text($_) })
   $all = $text -join "`n"
   $description = ($text | Where-Object { $_ } | Select-Object -First 12) -join ' | '
   if ($description -and $observed.Add($description)) { Write-Output "CRABOT_WINDOWS_WRAPPER_UI window=$description" }
   if ($all -match '无法关闭|cannot be closed|Can.t modify') { throw "Unexpected Retry: $all" }
   if ($all -match '系统临时目录' -and $all -match '空间不足') {
    if ($Expected -ne 'space') { throw "Unexpected TEMP rejection: $all" }
    if (Test-Path -LiteralPath $target) { throw 'Capacity rejection wrote the target' }
    $verified = $true
    Write-Output 'CRABOT_WINDOWS_WRAPPER_UI capacity_rejection_before_target_write=true'
    break
   }
   if ([WrapperUI]::Text($window) -eq '安装位置' -or $all -match 'CrabotInstaller.exe|旧安装接管') { throw 'A second installer or data admission appeared during installation' }
   $next = [WrapperUI]::GetDlgItem($window,1)
   if ($next -eq [IntPtr]::Zero -or ![WrapperUI]::IsWindowEnabled($next)) { continue }
   $label = [WrapperUI]::Text($next)
   if ($label -match '下一步|安装|Next|Install') {
    [WrapperUI]::Click($next); $clicked++
    Start-Sleep -Milliseconds 300
   } elseif (!$finished -and $label -match '完成|Finish') {
    if (!(Test-Path -LiteralPath (Join-Path $target 'app/installers'))) { throw 'Finish appeared before the final programs were extracted' }
    if (Test-Path -LiteralPath (Join-Path $target 'data')) { throw 'Installer initialized business data before first GUI launch' }
    $finished=$true
    [WrapperUI]::Click($next)
    Write-Output 'CRABOT_WINDOWS_WRAPPER_UI finish_clicked=true installer_data_writes=false'
   }
  }
  if ($verified) { break }
  $process.Refresh()
  if ($process.HasExited) {
   if (!$finished -or $process.ExitCode -ne 0) { throw "Installer exited before Finish or returned $($process.ExitCode)" }
   $selection = Join-Path $target 'current-release.json'
   $command = Join-Path $target 'bin/crabot.exe'
   if ((Test-Path -LiteralPath $selection) -and (Test-Path -LiteralPath $command)) {
    $raw = & $command status --json 2>&1
    if ($LASTEXITCODE -eq 0) {
     try { $status = ($raw -join "`n") | ConvertFrom-Json } catch { $status=$null }
     if ($status.running -eq $true -and $status.data_dir -eq (Join-Path $target 'data')) { $verified=$true; break }
    }
   }
  }
  Start-Sleep -Milliseconds 250
 }
 if (!$verified) { throw 'Timed out waiting for the actual single-layer installation and first GUI startup' }
 if ($Expected -eq 'space') { return }
 $installed=Get-Content (Join-Path $target 'desktop-installation.json') -Raw | ConvertFrom-Json
 if ($installed.install_root -ne $target) { throw 'GUI bound another installation root' }
 @{actual_exe_ui=$true; next_pages=$clicked; retry_dialog=$false; second_installer=$false; selected_path_with_spaces=$true; installer_exit_zero=$true; finish_launched_gui=$true; gui_started_actual_core=$true; native_cli_same_data=$true} | ConvertTo-Json -Compress | Write-Output
} finally {
 $command = Join-Path $target 'bin/crabot.exe'
 if (Test-Path -LiteralPath $command) { & $command stop 2>&1 | Write-Output }
 foreach ($id in $owned) { Stop-Process -Id $id -ErrorAction SilentlyContinue }
}
