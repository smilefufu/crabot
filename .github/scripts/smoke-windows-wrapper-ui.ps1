param([Parameter(Mandatory=$true)][string]$Installer)
$ErrorActionPreference = 'Stop'
$Installer = (Resolve-Path $Installer).Path
$homeRoot = Join-Path $env:RUNNER_TEMP ('wrapper-home-' + [guid]::NewGuid().ToString('N'))
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
$process = Start-Process $Installer -ArgumentList "/D=$target" -PassThru
$null = $process.Handle
$owned = [Collections.Generic.HashSet[uint32]]::new()
[void]$owned.Add([uint32]$process.Id)
$clicked = 0
$verified = $false
$confirmed = $false
$observed = [Collections.Generic.HashSet[string]]::new()
$deadline = (Get-Date).AddMinutes(15)
try {
 while ((Get-Date) -lt $deadline) {
  # Track only this newly launched installer's descendants on the isolated runner.
  $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)
  foreach ($row in $rows) { if ($owned.Contains([uint32]$row.ParentProcessId)) { [void]$owned.Add([uint32]$row.ProcessId) } }
  foreach ($window in [WrapperUI]::Windows()) {
   if (!$owned.Contains([WrapperUI]::Pid($window))) { continue }
   $children = [WrapperUI]::Children($window)
   $text = @([WrapperUI]::Text($window)) + @($children | ForEach-Object { [WrapperUI]::Text($_) })
   $all = $text -join "`n"
   $description = ($text | Where-Object { $_ } | Select-Object -First 12) -join ' | '
   if ($description -and $observed.Add($description)) { Write-Output "CRABOT_WINDOWS_WRAPPER_UI window=$description" }
   if ($all -match '无法关闭|cannot be closed|Can.t modify') { throw "Outer EXE entered the reported Retry dialog: $all" }
   if ([WrapperUI]::Text($window) -eq '安装位置') {
    $hostProcess = Get-CimInstance Win32_Process -Filter ("ProcessId=" + [WrapperUI]::Pid($window))
    if (!$hostProcess.CommandLine.Contains("--install-root=$target\.")) { throw 'Installer lost the selected destination argument' }
    $install = @($children | Where-Object { [WrapperUI]::Text($_) -eq '安装' })
    if ($install.Count -ne 1) { throw "Expected the actual host's Install button" }
    [WrapperUI]::Click($install[0])
    $confirmed = $true
    Write-Output "CRABOT_WINDOWS_WRAPPER_UI install_confirmed"
    continue
   }
   if ($confirmed -and [WrapperUI]::Text($window) -eq '安装完成') {
    $finish = @($children | Where-Object { [WrapperUI]::Text($_) -eq '完成' })
    if ($finish.Count -ne 1) { throw "Expected the actual host's Finish button" }
    [WrapperUI]::Click($finish[0])
    $verified = $true
    Write-Output "CRABOT_WINDOWS_WRAPPER_UI installation_completed"
    break
   }
   if ($all.Contains('安装尚未完成')) { throw "Real installation failed: $all" }
   if ($clicked -lt 2) {
    $next = [WrapperUI]::GetDlgItem($window,1)
    if ($next -ne [IntPtr]::Zero -and [WrapperUI]::IsWindowEnabled($next)) {
     $label = [WrapperUI]::Text($next)
     if ($label -match '下一步|安装|Next|Install') {
      [WrapperUI]::Click($next)
      $clicked++
      Write-Output "CRABOT_WINDOWS_WRAPPER_UI outer_page=$clicked"
      Start-Sleep -Milliseconds 400
     }
    }
   }
  }
  if ($verified) { break }
  $process.Refresh()
  if ($process.HasExited) { throw "Outer installer exited before the real GUI host was usable (code $($process.ExitCode))" }
  Start-Sleep -Milliseconds 250
 }
 if (!$verified) { throw 'Timed out waiting for the actual installer completion' }
 if (!(Test-Path $target)) { throw 'Installer reported completion without the selected root' }
 $installed = Get-Content (Join-Path $target 'desktop-installation.json') -Raw | ConvertFrom-Json
 if ($installed.install_root -ne $target) { throw 'The actual installation used a different destination' }
 $finishDeadline = (Get-Date).AddSeconds(90)
 while ((Get-Date) -lt $finishDeadline) {
  $process.Refresh()
  if ($process.HasExited) { break }
  foreach ($window in [WrapperUI]::Windows()) {
   if (!$owned.Contains([WrapperUI]::Pid($window))) { continue }
   $button = [WrapperUI]::GetDlgItem($window,1)
   if ($button -ne [IntPtr]::Zero -and [WrapperUI]::IsWindowEnabled($button) -and [WrapperUI]::Text($button) -match '完成|Finish') { [WrapperUI]::Click($button) }
  }
  Start-Sleep -Milliseconds 250
 }
 $process.Refresh()
 if (!$process.HasExited -or $process.ExitCode -ne 0) { throw 'Outer installer did not finish with success' }
 @{ actual_exe_ui=$true; next_pages=$clicked; reported_retry_dialog=$false; host_confirmation=$true; selected_path_with_spaces=$true; actual_installation_completed=$true; outer_exit_zero=$true; business_mm_started=$false } | ConvertTo-Json -Compress | Write-Output
} finally {
 # Stop only tracked runner test processes. The installed business App is not launched.
 foreach ($id in $owned) { Stop-Process -Id $id -ErrorAction SilentlyContinue }
}
