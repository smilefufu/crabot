param(
 [Parameter(Mandatory=$true)][string]$Installer,
 [string]$TemporaryDirectory,
 [string]$UpgradeInstaller,
 [string]$ExpectedVersion,
 [ValidateSet('direct','finish','menu')][string]$UpgradeLaunch = 'direct',
 [ValidateSet('complete','retry','space')][string]$Expected = 'complete'
)
$ErrorActionPreference = 'Stop'
$Installer = (Resolve-Path $Installer).Path
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable Windows CI only' }
# OS entry acceptance uses the disposable runner's real user profile. Changing
# USERPROFILE/APPDATA splits installer known folders from the Start menu we open.
$homeRoot = [Environment]::GetFolderPath('UserProfile')
if ([IO.Path]::GetFullPath($env:USERPROFILE) -ne $homeRoot -or (Test-Path -LiteralPath (Join-Path $homeRoot '.crabot'))) { throw 'Expected an unused hosted CI user profile' }
$osStartMenu = Join-Path ([Environment]::GetFolderPath('Programs')) 'Crabot.lnk'
$menuBefore = if(Test-Path -LiteralPath $osStartMenu){[IO.File]::ReadAllBytes($osStartMenu)}else{$null}
if(Test-Path -LiteralPath $osStartMenu){Remove-Item -LiteralPath $osStartMenu}
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
    if (!(Test-Path -LiteralPath (Join-Path $target 'app/installers')) -and !(Test-Path -LiteralPath (Join-Path $target 'program/desktop-payload.json'))) { throw 'Finish appeared before the final programs were extracted' }
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
   $selection = if(Test-Path (Join-Path $target 'program/gui/resources/desktop-release.json')){Join-Path $target 'program/gui/resources/desktop-release.json'}else{Join-Path $target 'current-release.json'}
   $command = Join-Path $target 'bin/crabot.exe'
   if ((Test-Path -LiteralPath $selection) -and (Test-Path -LiteralPath $command)) {
    $raw = & $command status --json 2>&1
    if ($LASTEXITCODE -eq 0) {
     try { $status = ($raw -join "`n") | ConvertFrom-Json } catch { $status=$null }
     if ($status.running -eq $true -and $status.data_dir -eq (Join-Path $target 'data')) {
      $readyModules = @($status.modules | Where-Object { $_.module_id -in @('admin-web','crabot-agent','memory-default') -and $_.status -eq 'running' })
      if (!$UpgradeInstaller -or $readyModules.Count -eq 3) { $verified=$true; break }
     }
    }
   }
  }
  Start-Sleep -Milliseconds 250
 }
 if (!$verified) {
  $baselineStage = if($UpgradeInstaller){'desktop14-before-candidate'}else{'fresh-candidate'}
  $state = @{stage=$baselineStage; installer_exited=$process.HasExited; finish_clicked=$finished; target=$target}
  if($status){$state.running=$status.running; $state.modules=@($status.modules | Select-Object module_id,status,pid)}
  Write-Output ('CRABOT_INITIAL_ENTRY_FAILURE ' + ($state | ConvertTo-Json -Depth 4 -Compress))
  foreach($log in @('desktop-profile/bootstrap.log','logs/mm.stdout.log','logs/mm.stderr.log','logs/admin-web.log','logs/crabot-agent.log','logs/memory-default.log')) {
   $file=Join-Path (Join-Path $target 'data') $log
   if(Test-Path -LiteralPath $file){Write-Output ('CRABOT_INITIAL_ENTRY_LOG '+$log); Get-Content -LiteralPath $file -Tail 12 -ErrorAction Continue | Write-Output}
  }
  $bootstrap=Join-Path $env:APPDATA 'Crabot/bootstrap/desktop-profile/bootstrap.log'
  if(Test-Path -LiteralPath $bootstrap){Write-Output 'CRABOT_INITIAL_ENTRY_BOOTSTRAP'; Get-Content -LiteralPath $bootstrap -Tail 12 -ErrorAction Continue | Write-Output}
  throw 'Timed out waiting for the actual single-layer installation and first GUI startup'
 }
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
  if ($UpgradeLaunch -eq 'direct') {
   # Match the feedback: the user force-killed the old service. Preserve all old
   # recovery files; the candidate must check OS processes and recover by itself.
   $moduleFiles = @(Get-ChildItem (Join-Path $data 'module-runtime-registry/records') -Filter '*.json')
   if ($moduleFiles.Count -lt 3) { throw 'Original modules have not registered their recovery records' }
   $oldModules = @($moduleFiles | ForEach-Object { Get-Content $_.FullName -Raw | ConvertFrom-Json })
   foreach ($oldProcess in @($beforeRuntime.mm, $beforeRuntime.controller)) {
    if ($oldProcess) { & "$env:SystemRoot/System32/taskkill.exe" /PID $oldProcess.pid /F 2>&1 | Write-Output }
   }
   foreach ($oldModule in $oldModules) { & "$env:SystemRoot/System32/taskkill.exe" /PID $oldModule.root_pid /T /F 2>&1 | Write-Output }
   if (@(Get-ChildItem (Join-Path $data 'module-runtime-registry/records') -Filter '*.json').Count -ne $moduleFiles.Count) { throw 'Force-kill fixture unexpectedly lost original recovery files' }
   $oldGui = [IO.Path]::GetFullPath((Join-Path $target ('app/releases/' + $beforeSelection.gui_id + '/Crabot.exe')))
   # Fixture cleanup of the known baseline GUI after its Core has stopped. The
   # candidate must itself observe absence; no stop/migration receipt is forged.
   foreach ($row in @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $oldGui })) {
    & "$env:SystemRoot/System32/taskkill.exe" /PID $row.ProcessId /T /F 2>&1 | Write-Output
   }
  } else {
   # Match normal Quit: use the baseline's own stop coordinator before exiting its GUI.
   & $command stop 2>&1 | Write-Output
   if ($LASTEXITCODE -ne 0) { throw 'Original desktop.14 did not stop normally' }
   $oldGui = [IO.Path]::GetFullPath((Join-Path $target ('app/releases/' + $beforeSelection.gui_id + '/Crabot.exe')))
   foreach ($row in @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $oldGui })) {
    & "$env:SystemRoot/System32/taskkill.exe" /PID $row.ProcessId /T /F 2>&1 | Write-Output
   }
   $baselineMenu = (New-Object -ComObject WScript.Shell).CreateShortcut($osStartMenu)
   Write-Output ('CRABOT_BASELINE_MENU ' + (@{link=$osStartMenu; exists=(Test-Path -LiteralPath $osStartMenu); target=$baselineMenu.TargetPath; expected=$oldGui} | ConvertTo-Json -Compress))
   if ($baselineMenu.TargetPath -ne $oldGui) { throw ('Original actual OS Start menu mismatch: expected=' + $oldGui + '; actual=' + $baselineMenu.TargetPath + '; link=' + $osStartMenu) }
  }
  Start-Sleep -Seconds 2
  $candidateArgs = if ($UpgradeLaunch -eq 'finish') { "/D=$target" } else { "/S /D=$target" }
  $candidate = Start-Process (Resolve-Path $UpgradeInstaller).Path -ArgumentList $candidateArgs -PassThru
  $null = $candidate.Handle
  [void]$owned.Add([uint32]$candidate.Id)
  if ($UpgradeLaunch -eq 'finish') {
   $candidateFinished = $false
   $finishLimit = (Get-Date).AddMinutes(10)
   while ((Get-Date) -lt $finishLimit) {
    foreach ($row in @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)) {
     if ($owned.Contains([uint32]$row.ParentProcessId)) { [void]$owned.Add([uint32]$row.ProcessId) }
    }
    foreach ($window in [WrapperUI]::Windows()) {
     if (!$owned.Contains([WrapperUI]::Pid($window))) { continue }
     $all = (@([WrapperUI]::Text($window)) + @([WrapperUI]::Children($window) | ForEach-Object { [WrapperUI]::Text($_) })) -join "`n"
     if ($all -match '无法关闭|Can.t modify|安装已中止|无法创建程序目录|Installation Aborted') { throw ('Candidate installer failed: ' + $all) }
     $next = [WrapperUI]::GetDlgItem($window,1)
     if ($next -eq [IntPtr]::Zero -or ![WrapperUI]::IsWindowEnabled($next)) { continue }
     $label = [WrapperUI]::Text($next)
     if ($label -match '下一步|安装|Next|Install') { [WrapperUI]::Click($next); Start-Sleep -Milliseconds 300 }
     elseif (!$candidateFinished -and $label -match '完成|Finish') {
      $candidateFinished = $true
      [WrapperUI]::Click($next)
      Write-Output 'CRABOT_WINDOWS_UPGRADE finish_clicked=true direct_candidate_launch=false'
     }
    }
    $candidate.Refresh()
    if ($candidate.HasExited) { break }
    Start-Sleep -Milliseconds 250
   }
   if (!$candidateFinished -or !$candidate.HasExited -or $candidate.ExitCode -ne 0) { throw 'Actual upgrade installer did not finish successfully' }
  } elseif (!$candidate.WaitForExit(600000) -or $candidate.ExitCode -ne 0) { throw 'Candidate program installation failed' }
  $newGui = [IO.Path]::GetFullPath((Join-Path $target 'program/gui/Crabot.exe'))
  if (!(Test-Path -LiteralPath $newGui)) { throw 'Expected the fixed newly installed GUI' }
  if ($UpgradeLaunch -eq 'direct') {
   $candidateGui = Start-Process $newGui -PassThru
   [void]$owned.Add([uint32]$candidateGui.Id)
  } elseif ($UpgradeLaunch -eq 'menu') {
   $menu = (New-Object -ComObject WScript.Shell).CreateShortcut($osStartMenu)
   if ($menu.TargetPath -ne $newGui) { throw ('Installed OS Start menu still targets original GUI: ' + $menu.TargetPath) }
   Start-Process $osStartMenu
   Write-Output 'CRABOT_WINDOWS_UPGRADE os_start_menu_launched=true direct_candidate_launch=false'
  }
  $updated = $false
  $limit = (Get-Date).AddMinutes(4)
  while ((Get-Date) -lt $limit) {
   foreach ($row in @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $newGui })) { [void]$owned.Add([uint32]$row.ProcessId) }
   foreach ($window in [WrapperUI]::Windows()) {
    if ([WrapperUI]::Console($window) -and [WrapperUI]::IsWindowVisible($window) -and !$originalConsoles.Contains($window)) {
     throw ('Upgrade/startup opened a console or Windows Terminal: ' + [WrapperUI]::Text($window))
    }
    if (!$owned.Contains([WrapperUI]::Pid($window))) { continue }
    $all = (@([WrapperUI]::Text($window)) + @([WrapperUI]::Children($window) | ForEach-Object { [WrapperUI]::Text($_) })) -join "`n"
    if ($all -match '启动失败|退出状态尚未核实|尚未转换数据|尚未完成|无法创建') { throw ('Actual upgrade failed: ' + $all) }
   }
   $current = Get-Content (Join-Path $target 'program/gui/resources/desktop-release.json') -Raw | ConvertFrom-Json
   $bootLog = Join-Path $data 'desktop-profile/bootstrap.log'
   if ($current.version -eq $ExpectedVersion -and (Test-Path $bootLog)) {
    $boot = @(Get-Content $bootLog | ForEach-Object { $_ | ConvertFrom-Json })
    if (@($boot | Where-Object { $_.phase -eq 'app-ready' -and $_.app_version -eq $ExpectedVersion }).Count) {
     $raw = & $command status --json 2>&1
     if ($LASTEXITCODE -eq 0) {
      $status = ($raw -join "`n") | ConvertFrom-Json
      if ($status.running -eq $true -and $status.data_dir -eq $data -and !(Test-Path (Join-Path $data 'desktop-maintenance.json'))) {
       $readyModules = @($status.modules | Where-Object { $_.module_id -in @('admin-web','crabot-agent','memory-default') -and $_.status -eq 'running' })
       if ($readyModules.Count -eq 3) { $updated=$true; break }
      }
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
  $current = Get-Content (Join-Path $target 'program/gui/resources/desktop-release.json') -Raw | ConvertFrom-Json
  $afterRuntime = Get-Content (Join-Path $data 'instance-runtime.json') -Raw | ConvertFrom-Json
  $afterInstallation = Get-Content (Join-Path $target 'desktop-installation.json') -Raw | ConvertFrom-Json
  if ($afterRuntime.install_root -ne ([IO.Path]::GetFullPath((Join-Path $target 'program/core')))) { throw 'CLI still uses original Core' }
  if ($afterRuntime.instance_id -ne $beforeRuntime.instance_id -or $afterRuntime.generation -eq $beforeRuntime.generation) { throw 'Expected same data instance, new Core generation' }
  if ($afterInstallation.installation_id -ne $installed.installation_id) { throw 'Upgrade created a different installation' }
  if ([IO.File]::ReadAllText($sentinel) -ne 'preserve existing desktop data') { throw 'Original data changed' }
  if ($credentialHash -and (Get-FileHash $credential).Hash -ne $credentialHash) { throw 'Original credentials changed' }
  $shortcut = $osStartMenu
  $link = (New-Object -ComObject WScript.Shell).CreateShortcut($shortcut)
  if ($link.TargetPath -ne $newGui) { throw 'Start menu still opens the previous GUI' }
  if ($UpgradeLaunch -ne 'direct') {
   $osMenu = (New-Object -ComObject WScript.Shell).CreateShortcut($osStartMenu)
   if ($osMenu.TargetPath -ne $newGui) { throw 'Actual OS Start menu still targets original GUI after upgrade' }
  }
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
  $menuReopened = $false
  if ($UpgradeLaunch -eq 'finish') {
   # Close only the fixture's known GUI after the candidate's own stop. Reopen
   # through the actual OS link, without invoking an internal candidate EXE.
   $beforeMenuGeneration = (Get-Content (Join-Path $data 'instance-runtime.json') -Raw | ConvertFrom-Json).generation
   & $command stop 2>&1 | Write-Output
   if ($LASTEXITCODE -ne 0) { throw 'Candidate did not stop before Start menu reopen' }
   foreach ($row in @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $newGui })) {
    $guiProcess = Get-Process -Id $row.ProcessId -ErrorAction SilentlyContinue
    if ($guiProcess) { $guiProcess.Kill(); if (!$guiProcess.WaitForExit(5000)) { throw 'Fixture GUI did not exit before menu reopen' } }
   }
   $bootLog = Join-Path $data 'desktop-profile/bootstrap.log'
   # bootstrap.log is deliberately replaced on every launch; compare the new
   # launch timestamp and runtime generation, never an accumulating line count.
   $readyBefore = (Get-Content $bootLog | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.phase -eq 'app-ready' -and $_.app_version -eq $ExpectedVersion } | Select-Object -Last 1).at
   if (!$readyBefore) { throw 'Initial candidate app-ready evidence missing before menu reopen' }
   Start-Process $osStartMenu
   $limit = (Get-Date).AddMinutes(4)
   while ((Get-Date) -lt $limit) {
    $menuGuiProcesses = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $newGui })
    foreach ($row in $menuGuiProcesses) { [void]$owned.Add([uint32]$row.ProcessId) }
    foreach ($window in [WrapperUI]::Windows()) {
     if ([WrapperUI]::Console($window) -and [WrapperUI]::IsWindowVisible($window) -and !$originalConsoles.Contains($window)) { throw 'Start menu reopen displayed a new console' }
    }
    $readyNow = (Get-Content $bootLog | ForEach-Object { $_ | ConvertFrom-Json } | Where-Object { $_.phase -eq 'app-ready' -and $_.app_version -eq $ExpectedVersion } | Select-Object -Last 1).at
    if ($readyNow -and $readyNow -gt $readyBefore -and $menuGuiProcesses.Count -gt 0) {
     $raw = & $command status --json 2>&1
     if ($LASTEXITCODE -eq 0) {
      $state = ($raw -join "`n") | ConvertFrom-Json
      $runtime = Get-Content (Join-Path $data 'instance-runtime.json') -Raw | ConvertFrom-Json
      $readyModules = @($state.modules | Where-Object { $_.module_id -in @('admin-web','crabot-agent','memory-default') -and $_.status -eq 'running' })
      if ($state.running -eq $true -and $state.data_dir -eq $data -and $readyModules.Count -eq 3 -and $runtime.generation -ne $beforeMenuGeneration -and $runtime.install_root -eq ([IO.Path]::GetFullPath((Join-Path $target 'program/core')))) { $menuReopened=$true; break }
     }
    }
    Start-Sleep -Milliseconds 750
   }
   if (!$menuReopened) {
    Get-Content $bootLog | ForEach-Object { $_ | ConvertFrom-Json } | Select-Object phase,at,app_version,code | ConvertTo-Json -Compress | Write-Output
    & $command status --json 2>&1 | Write-Output
    throw 'Actual Start menu did not reopen the candidate GUI and Core after Finish'
   }
   if ([IO.File]::ReadAllText($sentinel) -ne 'preserve existing desktop data' -or ($credentialHash -and (Get-FileHash $credential).Hash -ne $credentialHash)) { throw 'Start menu reopen changed original data or credentials' }
  }
  @{actual_exe_upgrade=$true; start_menu_reopened_after_finish=$menuReopened; repeated_stop_start_cycles=2; force_killed_original=($UpgradeLaunch -eq 'direct'); candidate_launch=$UpgradeLaunch; actual_os_start_menu=($UpgradeLaunch -ne 'direct'); from=$beforeSelection.version; to=$ExpectedVersion; actual_gui_version=$true; actual_new_core=$true; native_cli_same_data=$true; same_installation=$true; original_data_preserved=$true; start_menu_targets_new_gui=$true; no_new_visible_console=$true} | ConvertTo-Json -Compress | Write-Output
  return
 }
 @{actual_exe_ui=$true; next_pages=$clicked; retry_dialog=$false; second_installer=$false; selected_path_with_spaces=$true; installer_exit_zero=$true; finish_launched_gui=$true; gui_started_actual_core=$true; native_cli_same_data=$true; no_new_visible_console=$true} | ConvertTo-Json -Compress | Write-Output
} finally {
 $command = Join-Path $target 'bin/crabot.exe'
 if (Test-Path -LiteralPath $command) { & $command stop 2>&1 | Write-Output }
 foreach ($id in $owned) {
  $fixtureProcess = $null
  try {
   $fixtureProcess = [Diagnostics.Process]::GetProcessById($id)
   $image = $fixtureProcess.MainModule.FileName
   # Old numeric IDs may have been reused. Only our installed images are cleanup targets.
   if ($image -and $image.StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) {
    $fixtureProcess.Kill()
    if (!$fixtureProcess.WaitForExit(5000)) { throw 'Fixture GUI did not exit' }
   }
  } catch {
   if ($fixtureProcess -and !$fixtureProcess.HasExited) { throw }
  } finally { if ($fixtureProcess) { $fixtureProcess.Dispose() } }
 }
 if($menuBefore){[IO.File]::WriteAllBytes($osStartMenu,$menuBefore)}elseif(Test-Path -LiteralPath $osStartMenu){Remove-Item -LiteralPath $osStartMenu}

}
