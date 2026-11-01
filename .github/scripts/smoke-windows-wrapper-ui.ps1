param(
 [Parameter(Mandatory=$true)][string]$Installer,
 [string]$TemporaryDirectory,
 [string]$UpgradeInstaller,
 [string]$ExpectedVersion,
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
$target = Join-Path ([IO.Path]::GetPathRoot($env:RUNNER_TEMP)) ('Crabot wrapper UI ' + [guid]::NewGuid().ToString('N'))
if (Test-Path -LiteralPath $target) { throw 'Expected an absent new folder directly under the selected drive' }
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
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd,StringBuilder text,int length);
 public static bool Console(IntPtr hwnd) { var name=new StringBuilder(256);GetClassName(hwnd,name,name.Capacity);return name.ToString()=="ConsoleWindowClass" || name.ToString()=="CASCADIA_HOSTING_WINDOW_CLASS"; }
 public static uint Pid(IntPtr hwnd) { uint pid;GetWindowThreadProcessId(hwnd,out pid);return pid; }
 public static void Click(IntPtr hwnd) { SendMessage(hwnd,0xF5,IntPtr.Zero,IntPtr.Zero); }
}
'@
if ($TemporaryDirectory) {
 $env:TEMP = (Resolve-Path $TemporaryDirectory).Path
 $env:TMP = $env:TEMP
}
$originalConsoles = [Collections.Generic.HashSet[IntPtr]]::new()
foreach ($window in [WrapperUI]::Windows()) {
 if ([WrapperUI]::Console($window) -and [WrapperUI]::IsWindowVisible($window)) { [void]$originalConsoles.Add($window) }
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
   if (!$UpgradeInstaller -and [WrapperUI]::Console($window) -and [WrapperUI]::IsWindowVisible($window) -and !$originalConsoles.Contains($window)) {
    throw ('Crabot installation/startup opened a visible console: ' + [WrapperUI]::Text($window))
   }
   if (!$owned.Contains([WrapperUI]::Pid($window))) { continue }
   $children = [WrapperUI]::Children($window)
   $text = @([WrapperUI]::Text($window)) + @($children | ForEach-Object { [WrapperUI]::Text($_) })
   $all = $text -join "`n"
   $description = ($text | Where-Object { $_ } | Select-Object -First 12) -join ' | '
   if ($description -and $observed.Add($description)) { Write-Output "CRABOT_WINDOWS_WRAPPER_UI window=$description" }
   if ($all -match '无法关闭|cannot be closed|Can.t modify') { throw "Unexpected Retry: $all" }
   if ($all -match '安装已中止|安装程序并未成功|无法创建程序目录|无法准备所选程序目录|Installation Aborted') { throw "Installer visibly aborted: $all" }
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
 if ($UpgradeInstaller) {
  if (!$ExpectedVersion) { throw 'Expected candidate version required for upgrade acceptance' }
  $beforeSelection = Get-Content (Join-Path $target 'current-release.json') -Raw | ConvertFrom-Json
  if ($beforeSelection.version -ne '0.1.0-desktop.14') { throw 'Expected the actual delivered desktop.14 baseline' }
  $data = Join-Path $target 'data'
  $beforeRuntime = Get-Content (Join-Path $data 'instance-runtime.json') -Raw | ConvertFrom-Json
  $sentinel = Join-Path $data 'upgrade-preserved.txt'
  [IO.File]::WriteAllText($sentinel, 'preserve existing desktop data')
  $credential = Join-Path $data 'admin/credentials.json'
  $credentialHash = if (Test-Path -LiteralPath $credential) { (Get-FileHash $credential).Hash } else { $null }
  $command = Join-Path $target 'bin/crabot.exe'
  # Match the feedback: the user force-killed the old service. Preserve all old
  # recovery files; the candidate must check OS processes and recover by itself.
  foreach ($oldProcess in @($beforeRuntime.mm, $beforeRuntime.controller)) {
   if ($oldProcess) { & "$env:SystemRoot/System32/taskkill.exe" /PID $oldProcess.pid /T /F 2>&1 | Write-Output }
  }
  $oldGui = Join-Path $target ('app/releases/' + $beforeSelection.gui_id + '/Crabot.exe')
  # Fixture cleanup of the known baseline GUI after its Core has stopped. The
  # candidate must itself observe absence; no stop/migration receipt is forged.
  foreach ($row in @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $oldGui })) {
   & "$env:SystemRoot/System32/taskkill.exe" /PID $row.ProcessId /T /F 2>&1 | Write-Output
  }
  Start-Sleep -Seconds 2
  $candidate = Start-Process (Resolve-Path $UpgradeInstaller).Path -ArgumentList "/S /D=$target" -PassThru
  [void]$owned.Add([uint32]$candidate.Id)
  if (!$candidate.WaitForExit(600000) -or $candidate.ExitCode -ne 0) { throw 'Candidate program installation failed' }
  $newRoots = @(Get-ChildItem (Join-Path $target 'app/releases') -Directory | Where-Object { $_.Name -ne $beforeSelection.gui_id })
  if ($newRoots.Count -ne 1) { throw 'Expected one newly unpacked GUI, retaining original GUI' }
  $newGui = Join-Path $newRoots[0].FullName 'Crabot.exe'
  $candidateGui = Start-Process $newGui -PassThru
  [void]$owned.Add([uint32]$candidateGui.Id)
  $updated = $false
  $limit = (Get-Date).AddMinutes(4)
  while ((Get-Date) -lt $limit) {
   foreach ($window in [WrapperUI]::Windows()) {
    if ([WrapperUI]::Console($window) -and [WrapperUI]::IsWindowVisible($window) -and !$originalConsoles.Contains($window)) {
     throw ('Upgrade/startup opened a console or Windows Terminal: ' + [WrapperUI]::Text($window))
    }
    if (!$owned.Contains([WrapperUI]::Pid($window))) { continue }
    $all = (@([WrapperUI]::Text($window)) + @([WrapperUI]::Children($window) | ForEach-Object { [WrapperUI]::Text($_) })) -join "`n"
    if ($all -match '启动失败|退出状态尚未核实|尚未转换数据|尚未完成|无法创建') { throw ('Actual upgrade failed: ' + $all) }
   }
   $current = Get-Content (Join-Path $target 'current-release.json') -Raw | ConvertFrom-Json
   $bootLog = Join-Path $data 'desktop-profile/bootstrap.log'
   if ($current.version -eq $ExpectedVersion -and (Test-Path $bootLog)) {
    $boot = @(Get-Content $bootLog | ForEach-Object { $_ | ConvertFrom-Json })
    if (@($boot | Where-Object { $_.phase -eq 'app-ready' -and $_.app_version -eq $ExpectedVersion }).Count) {
     $raw = & $command status --json 2>&1
     if ($LASTEXITCODE -eq 0) {
      $status = ($raw -join "`n") | ConvertFrom-Json
      if ($status.running -eq $true -and $status.data_dir -eq $data) { $updated=$true; break }
     }
    }
   }
   Start-Sleep -Milliseconds 750
  }
  if (!$updated) {
   foreach ($log in @((Join-Path $data 'desktop-profile/bootstrap.log'), (Join-Path $env:APPDATA 'Crabot/bootstrap/desktop-profile/bootstrap.log'))) {
    if (Test-Path $log) { Get-Content $log | Write-Output }
   }
   throw 'Candidate did not select and start its actual GUI/Core version'
  }
  $current = Get-Content (Join-Path $target 'current-release.json') -Raw | ConvertFrom-Json
  $afterRuntime = Get-Content (Join-Path $data 'instance-runtime.json') -Raw | ConvertFrom-Json
  $afterInstallation = Get-Content (Join-Path $target 'desktop-installation.json') -Raw | ConvertFrom-Json
  if ($afterRuntime.install_root -ne (Join-Path $target ('releases/' + $current.core_id))) { throw 'CLI still uses original Core' }
  if ($afterRuntime.instance_id -ne $beforeRuntime.instance_id -or $afterRuntime.generation -eq $beforeRuntime.generation) { throw 'Expected same data instance, new Core generation' }
  if ($afterInstallation.installation_id -ne $installed.installation_id) { throw 'Upgrade created a different installation' }
  if ([IO.File]::ReadAllText($sentinel) -ne 'preserve existing desktop data') { throw 'Original data changed' }
  if ($credentialHash -and (Get-FileHash $credential).Hash -ne $credentialHash) { throw 'Original credentials changed' }
  $shortcut = Join-Path $env:APPDATA 'Microsoft/Windows/Start Menu/Programs/Crabot.lnk'
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
  if ($link.TargetPath -ne $newGui) { throw 'Start menu still opens the previous GUI' }
  for ($cycle=1; $cycle -le 2; $cycle++) {
   & $command stop 2>&1 | Write-Output
   if ($LASTEXITCODE -ne 0) { throw "Candidate stop failed in cycle $cycle" }
   & $command stop 2>&1 | Write-Output
   if ($LASTEXITCODE -ne 0) { throw "Repeated candidate stop failed in cycle $cycle" }
   $status = ((& $command status --json 2>&1) -join "`n") | ConvertFrom-Json
   if ($status.running -ne $false) { throw 'Stopped candidate still reports running' }
   & $command start -d 2>&1 | Write-Output
   if ($LASTEXITCODE -ne 0) { throw "Candidate start failed in cycle $cycle" }
   $status = ((& $command status --json 2>&1) -join "`n") | ConvertFrom-Json
   if ($status.running -ne $true -or $status.data_dir -ne $data) { throw 'Restart did not recover the same data instance' }
  }
  @{actual_exe_upgrade=$true; repeated_stop_start_cycles=2; force_killed_original=$true; from=$beforeSelection.version; to=$ExpectedVersion; actual_gui_version=$true; actual_new_core=$true; native_cli_same_data=$true; same_installation=$true; original_data_preserved=$true; start_menu_targets_new_gui=$true; no_new_visible_console=$true} | ConvertTo-Json -Compress | Write-Output
  return
 }
 @{actual_exe_ui=$true; next_pages=$clicked; retry_dialog=$false; second_installer=$false; selected_path_with_spaces=$true; installer_exit_zero=$true; finish_launched_gui=$true; gui_started_actual_core=$true; native_cli_same_data=$true; no_new_visible_console=$true} | ConvertTo-Json -Compress | Write-Output
} finally {
 $command = Join-Path $target 'bin/crabot.exe'
 if (Test-Path -LiteralPath $command) { & $command stop 2>&1 | Write-Output }
 foreach ($id in $owned) { Stop-Process -Id $id -ErrorAction SilentlyContinue }
}
