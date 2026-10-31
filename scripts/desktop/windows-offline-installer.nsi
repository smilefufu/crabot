; Extract immutable programs directly to their final location. GUI first use
; owns existing-data admission; no second installer or business process waits here.
!include "common.nsh"
!include "MUI2.nsh"
!include "extractAppPackage.nsh"
!define CRABOT_GUI "$%CRABOT_WINDOWS_GUI%"
!define CRABOT_DECODER "$%CRABOT_WINDOWS_DECODER%"
!macroundef extractUsing7za
!macro extractUsing7za FILE
  DetailPrint "正在解包程序到 $INSTDIR"
  nsExec::ExecToLog '"$PLUGINSDIR\7za.exe" x -y -bb1 -bsp0 "-o$INSTDIR" "${FILE}"'
  Pop $0
  ${If} $0 != 0
    SetErrorLevel 1
    Abort "程序解包尚未完成，原数据未改动。请重新运行安装包。"
  ${EndIf}
!macroend
RequestExecutionLevel user
InstallDir "$PROFILE\Crabot"
Var ExistingDesktopRoot
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
  AddSize ${APP_64_UNPACKED_SIZE}
  InitPluginsDir
  File /oname=$PLUGINSDIR\7za.exe "${CRABOT_DECODER}"
  SetOutPath "$INSTDIR"
  !insertmacro extractEmbeddedAppPackage
  IfFileExists "\\?\$INSTDIR\${CRABOT_GUI}" Ready
    SetErrorLevel 1
    Abort "程序解包尚未完成，原数据未改动。请重新运行安装包。"
  Ready:
  IfFileExists "$SMPROGRAMS\Crabot.lnk" ShortcutReady
  CreateShortcut "$SMPROGRAMS\Crabot.lnk" "$INSTDIR\${CRABOT_GUI}"
  ShortcutReady:
SectionEnd
Function OpenCrabot
  ; Finish exits this installer instead of waiting for first-use dialogs.
  Exec '"$INSTDIR\${CRABOT_GUI}"'
FunctionEnd
