; Replace the fixed program directory; user data remains outside it. GUI first use
; owns existing-data admission; no second installer or business process waits here.
!include "common.nsh"
!include "MUI2.nsh"
!include "extractAppPackage.nsh"
!define CRABOT_GUI "$%CRABOT_WINDOWS_GUI%"
!define CRABOT_DECODER "$%CRABOT_WINDOWS_DECODER%"
!define CRABOT_DIRECTORY_HELPER "$%CRABOT_WINDOWS_DIRECTORY_HELPER%"
!define CRABOT_FILE_TABLE "$%CRABOT_WINDOWS_FILE_TABLE%"
!macroundef extractUsing7za
!macro extractUsing7za FILE
  DetailPrint "正在解包程序到 $INSTDIR"
  nsExec::ExecToLog '"$PLUGINSDIR\7za.exe" x -y -bb1 -bsp0 -spd -scsUTF-8 "-x@$PLUGINSDIR\preserved-files.txt" "-o$INSTDIR" "${FILE}"'
  Pop $0
  ${If} $0 != 0
    SetErrorLevel 1
    Abort "程序解包尚未完成，原数据未改动。请重新运行安装包。"
  ${EndIf}
!macroend
RequestExecutionLevel user
InstallDir "$PROFILE\Crabot"
InstallDirRegKey HKCU "Software\Crabot\Desktop" "InstallLocation"
Var ExistingDesktopRoot
Var OverlayMode
!define MUI_FINISHPAGE_RUN
!define MUI_FINISHPAGE_RUN_FUNCTION OpenCrabot
!define MUI_FINISHPAGE_RUN_TEXT "打开 Crabot"
!insertmacro MUI_PAGE_WELCOME
!define MUI_PAGE_CUSTOMFUNCTION_PRE DirectoryPage
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro addLangs
Function .onInit
  !insertmacro check64BitAndSetRegView
  ReadRegStr $0 HKLM "SOFTWARE\Microsoft\Windows NT\CurrentVersion" "CurrentBuildNumber"
  IntCmp $0 22000 Supported Unsupported Supported
  Unsupported:
    MessageBox MB_OK|MB_ICONSTOP "Crabot 需要 Windows 11 或更新版本。"
    SetErrorLevel 1
    Quit
  Supported:
  ; The archive is the only large TEMP file. Decoded programs go to the chosen disk.
  System::Call 'Kernel32::GetDiskFreeSpaceExW(t "$TEMP", *l .r1, p 0, p 0)i.r0'
  StrCmp $0 0 TempUnknown
  FileOpen $3 "$EXEPATH" r
  IfErrors TempUnknown
  FileSeek $3 0 END $4
  FileClose $3
  System::Int64Op $4 + 67108864
  Pop $2
  System::Int64Op $1 < $2
  Pop $0
  StrCmp $0 1 TempFull FindDesktop
  TempUnknown:
    MessageBox MB_OK|MB_ICONSTOP "无法读取系统临时目录空间，请确认临时目录可用后重试。尚未写入安装目录。"
    SetErrorLevel 1
    Quit
  TempFull:
    MessageBox MB_OK|MB_ICONSTOP "系统临时目录空间不足以暂存压缩包，尚未写入安装目录。请释放空间或更改系统临时目录后重试。"
    SetErrorLevel 1
    Quit
  FindDesktop:
  IfFileExists "$INSTDIR\desktop-installation.json" RegisteredTarget
  StrCmp $INSTDIR "$PROFILE\Crabot" 0 RegistryDone
  Goto RegistrySearch
  RegisteredTarget:
    StrCpy $ExistingDesktopRoot $INSTDIR
    Goto RegistryDone
  RegistrySearch:
  ; Existing desktop upgrades retain their original program location. This OS
  ; registration is a location hint; the GUI verifies actual binding and data.
  StrCpy $0 0
  RegistryLoop:
    EnumRegKey $1 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall" $0
    StrCmp $1 "" RegistryDone
    IntOp $0 $0 + 1
    StrCpy $2 $1 7
    StrCmp $2 "Crabot-" 0 RegistryLoop
    ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\$1" "InstallLocation"
    IfFileExists "$2\desktop-installation.json" 0 RegistryLoop
    StrCmp $ExistingDesktopRoot "" 0 RegistryDone
    StrCpy $ExistingDesktopRoot $2
    StrCpy $INSTDIR $2
    Goto RegistryLoop
  RegistryDone:
FunctionEnd
Function DirectoryPage
  StrCmp $ExistingDesktopRoot "" Done
  Abort
  Done:
FunctionEnd
Section "安装 Crabot"
  IfFileExists "$INSTDIR\program\desktop-payload.json" +2
  AddSize ${APP_64_UNPACKED_SIZE}
  InitPluginsDir
  File /oname=$PLUGINSDIR\7za.exe "${CRABOT_DECODER}"
  File /oname=$PLUGINSDIR\directory.exe "${CRABOT_DIRECTORY_HELPER}"
  File /oname=$PLUGINSDIR\program-files.tsv "${CRABOT_FILE_TABLE}"
  nsExec::ExecToStack '"$PLUGINSDIR\directory.exe" "$INSTDIR"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    SetErrorLevel 1
    DetailPrint "$1"
    Abort "无法创建程序目录 $INSTDIR。尚未解包程序；原数据未改动。错误：$0 $1"
  ${EndIf}
  CheckRunning:
  nsExec::ExecToStack '"$PLUGINSDIR\directory.exe" "$INSTDIR" --check-programs'
  Pop $0
  Pop $1
  StrCmp $0 0 NotRunning
  StrCmp $0 2 InUse
  SetErrorLevel 1
  Abort "无法检查本安装的程序文件。错误：$1"
  InUse:
  MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION "Crabot 程序文件仍在使用中。请退出 Crabot（包括托盘后台），然后重试。$\r$\n$1" /SD IDCANCEL IDRETRY CheckRunning
  SetErrorLevel 1
  Abort "已取消安装，尚未替换程序，原数据保留。"
  NotRunning:
  ; Only the dedicated product directory is replaced. Never remove INSTDIR,
  ; data, workspaces, historical runtimes or the installation/data binding.
  IfFileExists "$INSTDIR\program\*" 0 ProgramReady
  IfFileExists "$INSTDIR\program\desktop-payload.json" KnownProgram
  ReadRegStr $0 HKCU "Software\Crabot\Desktop" "InstallLocation"
  StrCmp $0 "$INSTDIR" KnownProgram
  SetErrorLevel 1
  Abort "所选位置已有无法识别的 program 文件夹，未删除或覆盖。请选择其它程序位置。"
  KnownProgram:
  ProgramReady:
  StrCpy $OverlayMode ""
  IfSilent 0 PrepareOverlay
  StrCpy $OverlayMode "--silent"
  PrepareOverlay:
  DetailPrint "正在比较运行环境并检查需要替换的文件"
  nsExec::ExecToStack '"$PLUGINSDIR\directory.exe" "$INSTDIR" --prepare-overlay "$PLUGINSDIR\program-files.tsv" "$PLUGINSDIR\preserved-files.txt" --parent=$HWNDPARENT $OverlayMode'
  Pop $0
  Pop $1
  StrCmp $0 0 OverlayReady
  StrCmp $0 2 OverlayInUse
  StrCmp $0 3 OverlayCancelled
  SetErrorLevel 1
  Abort "无法准备程序覆盖。用户数据未改动。错误：$1"
  OverlayInUse:
  MessageBox MB_RETRYCANCEL|MB_ICONINFORMATION "需要替换的程序文件仍被使用。请关闭对应程序后重试。尚未替换程序。$\r$\n$1" /SD IDCANCEL IDRETRY CheckRunning
  OverlayCancelled:
  SetErrorLevel 1
  Abort "已取消安装，尚未替换程序，原数据保留。"
  OverlayReady:
  WriteRegStr HKCU "Software\Crabot\Desktop" "InstallLocation" "$INSTDIR"
  SetOutPath "$INSTDIR"
  !insertmacro extractEmbeddedAppPackage
  IfFileExists "\\?\$INSTDIR\${CRABOT_GUI}" Ready
    SetErrorLevel 1
    Abort "程序解包尚未完成，原数据未改动。请重新运行安装包。"
  Ready:
  DetailPrint "正在核对程序并更新启动入口（不转换数据）"
  nsExec::ExecToStack '"$INSTDIR\program\core\.product-runtime\node\node.exe" "$INSTDIR\program\core\scripts\desktop\finish-fixed-install.mjs" "$INSTDIR"'
  Pop $0
  Pop $1
  StrCmp $0 0 EntriesReady
  SetErrorLevel 1
  Abort "程序安装尚未完成。用户数据未改动，请重新运行安装包。错误：$1"
  EntriesReady:
  ClearErrors
  CreateShortcut "$SMPROGRAMS\Crabot.lnk" "$INSTDIR\${CRABOT_GUI}"
  IfErrors 0 ShortcutReady
  SetErrorLevel 1
  Abort "无法更新开始菜单入口，请重新运行安装包。用户数据未改动。"
  ShortcutReady:
SectionEnd
Function OpenCrabot
  ; Finish exits this installer instead of waiting for first-use dialogs.
  Exec '"$INSTDIR\${CRABOT_GUI}"'
FunctionEnd
