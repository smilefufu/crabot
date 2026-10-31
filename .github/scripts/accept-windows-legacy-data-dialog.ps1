param([Parameter(Mandatory=$true)][int]$GuiPid,[Parameter(Mandatory=$true)][string]$DataDirectory,[Parameter(Mandatory=$true)][string]$Version)
$ErrorActionPreference='Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') { throw 'Disposable hosted runner required' }
Add-Type @'
using System;using System.Text;using System.Collections.Generic;using System.Runtime.InteropServices;
public class CrabotFirstUseUI {
 public delegate bool Visitor(IntPtr window,IntPtr data);
 [DllImport("user32.dll")] static extern bool EnumWindows(Visitor callback,IntPtr data);
 [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr window,Visitor callback,IntPtr data);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageTimeoutW")] static extern IntPtr ReadText(IntPtr window,uint message,IntPtr length,StringBuilder text,uint flags,uint timeout,out IntPtr result);
 public static string Text(IntPtr window){var text=new StringBuilder(8192);IntPtr result;ReadText(window,13,(IntPtr)text.Capacity,text,2,500,out result);return text.ToString();}
 public static IntPtr[] Windows(){var list=new List<IntPtr>();EnumWindows((w,d)=>{list.Add(w);return true;},IntPtr.Zero);return list.ToArray();}
 public static IntPtr[] Children(IntPtr window){var list=new List<IntPtr>();EnumChildWindows(window,(w,d)=>{list.Add(w);return true;},IntPtr.Zero);return list.ToArray();}
 public static uint Pid(IntPtr window){uint pid;GetWindowThreadProcessId(window,out pid);return pid;}
}
'@
$observed=[Collections.Generic.HashSet[string]]::new()
$deadline=(Get-Date).AddMinutes(4)
while((Get-Date) -lt $deadline){
 if(!(Get-Process -Id $GuiPid -ErrorAction SilentlyContinue)){throw 'Actual first-use GUI exited before confirmation'}
 foreach($window in [CrabotFirstUseUI]::Windows()){
  if([CrabotFirstUseUI]::Pid($window) -ne $GuiPid){continue}
  $title=[CrabotFirstUseUI]::Text($window)
  if($observed.Add($title)){Write-Output ('CRABOT_FIRST_USE_WINDOW title='+$title)}
  $children=[CrabotFirstUseUI]::Children($window)
  $text=(@([CrabotFirstUseUI]::Text($window))+@($children|ForEach-Object{[CrabotFirstUseUI]::Text($_)})) -join "`n"
  $button=@($children|Where-Object{[CrabotFirstUseUI]::Text($_) -eq '接入已有数据'})
  if($button.Count -eq 1){
   # TaskDialog's detail can be DirectUI text without its own HWND. Read the
   # actual accessibility names too; the data/version assertion stays required.
   $accessible = (& (Join-Path $PSScriptRoot 'read-windows-dialog.ps1') -Handle ($window.ToInt64())) | ConvertFrom-Json
   $text += "`n" + ($accessible -join "`n")
   if(!$text.Contains($DataDirectory) -or !$text.Contains($Version)){
    Write-Output ('CRABOT_FIRST_USE_TEXT ' + (ConvertTo-Json -InputObject $text -Compress))
    throw 'Actual data confirmation did not display the original data/version'
   }
   $automation=[Windows.Automation.AutomationElement]::FromHandle($window)
   $condition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,'接入已有数据')
   $controls=$automation.FindAll([Windows.Automation.TreeScope]::Subtree,$condition)
   $actions=@($controls | Where-Object { $_.GetCurrentPropertyValue([Windows.Automation.AutomationElement]::IsInvokePatternAvailableProperty) -eq $true })
   if($actions.Count -ne 1){throw 'Expected one actionable data confirmation button in the actual dialog accessibility tree'}
   $invoke=$actions[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
   $invoke.Invoke()
   $closedBy=(Get-Date).AddSeconds(10)
   while(([CrabotFirstUseUI]::Windows() -contains $window) -and [CrabotFirstUseUI]::Text($window) -eq $title){
    if((Get-Date) -ge $closedBy){throw 'Native confirmation was not dismissed after its accessible Invoke action'}
    Start-Sleep -Milliseconds 100
   }
   Write-Output 'CRABOT_FIRST_USE_UI original_data_and_version_visible=true native_confirmation_invoked_and_dismissed=true'
   exit 0
  }
  if($text -match 'Error|无法核验|未能启动|启动失败'){throw ('First-use failure before confirmation: '+$text)}
 }
 Start-Sleep -Milliseconds 200
}
throw 'Timed out waiting for the actual first-use data confirmation'
