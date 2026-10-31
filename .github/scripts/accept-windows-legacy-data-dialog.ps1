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
 [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr window,uint message,IntPtr a,IntPtr b);
 public static string Text(IntPtr window){var text=new StringBuilder(8192);IntPtr result;ReadText(window,13,(IntPtr)text.Capacity,text,2,500,out result);return text.ToString();}
 public static IntPtr[] Windows(){var list=new List<IntPtr>();EnumWindows((w,d)=>{list.Add(w);return true;},IntPtr.Zero);return list.ToArray();}
 public static IntPtr[] Children(IntPtr window){var list=new List<IntPtr>();EnumChildWindows(window,(w,d)=>{list.Add(w);return true;},IntPtr.Zero);return list.ToArray();}
 public static uint Pid(IntPtr window){uint pid;GetWindowThreadProcessId(window,out pid);return pid;}
 public static void Click(IntPtr window){SendMessage(window,245,IntPtr.Zero,IntPtr.Zero);}
}
'@
$deadline=(Get-Date).AddMinutes(4)
while((Get-Date) -lt $deadline){
 if(!(Get-Process -Id $GuiPid -ErrorAction SilentlyContinue)){throw 'Actual first-use GUI exited before confirmation'}
 foreach($window in [CrabotFirstUseUI]::Windows()){
  if([CrabotFirstUseUI]::Pid($window) -ne $GuiPid){continue}
  $children=[CrabotFirstUseUI]::Children($window)
  $text=(@([CrabotFirstUseUI]::Text($window))+@($children|ForEach-Object{[CrabotFirstUseUI]::Text($_)})) -join "`n"
  $button=@($children|Where-Object{[CrabotFirstUseUI]::Text($_) -eq '接入已有数据'})
  if($button.Count -eq 1){
   if(!$text.Contains($DataDirectory) -or !$text.Contains($Version)){throw 'Actual data confirmation did not display the original data/version'}
   [CrabotFirstUseUI]::Click($button[0])
   Write-Output 'CRABOT_FIRST_USE_UI original_data_and_version_visible=true native_confirmation_clicked=true'
   exit 0
  }
  if($text -match 'Error|无法核验|未能启动|启动失败'){throw ('First-use failure before confirmation: '+$text)}
 }
 Start-Sleep -Milliseconds 200
}
throw 'Timed out waiting for the actual first-use data confirmation'
