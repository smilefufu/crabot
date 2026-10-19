; Only the self-extracting host is temporary. Never recursively remove the
; selected Crabot root: data, workspaces and retained interpreters live there.
!include "common.nsh"
!include "MUI2.nsh"
!include "extractAppPackage.nsh"
RequestExecutionLevel user
InstallDir "$PROFILE\Crabot"
Var CrabotTarget
!insertmacro MUI_PAGE_WELCOME
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
  ; Capacity is checked before extracting the large offline payload to TEMP.
  System::Call 'Kernel32::GetDiskFreeSpaceExW(t "$TEMP", *l .r1, p 0, p 0)i.r0'
  StrCmp $0 0 TempUnknown
  System::Int64Op ${APP_64_UNPACKED_SIZE} * 1024
  Pop $2
  System::Int64Op $2 + 536870912
  Pop $2
  System::Int64Op $1 < $2
  Pop $0
  StrCmp $0 1 TempFull TempReady
  TempUnknown:
    MessageBox MB_OK|MB_ICONSTOP "无法核验系统临时目录空间，请确认临时目录可用后重试。安装文件尚未写入所选目录。"
    SetErrorLevel 1
    Quit
  TempFull:
    MessageBox MB_OK|MB_ICONSTOP "系统临时目录（$TEMP）空间不足，请清理临时文件后重试。安装文件尚未写入所选目录。"
    SetErrorLevel 1
    Quit
  TempReady:
FunctionEnd
Section "安装 Crabot"
  StrCpy $CrabotTarget "$INSTDIR"
  InitPluginsDir
  StrCpy $INSTDIR "$PLUGINSDIR\crabot-installer"
  SetOutPath "$INSTDIR"
  !insertmacro extractEmbeddedAppPackage
  ExecWait '$"$INSTDIR\${APP_EXECUTABLE_FILENAME}$" $"--install-root=$CrabotTarget\.$"' $0
  SetOutPath "$EXEDIR"
  RMDir /r "$PLUGINSDIR\crabot-installer"
  StrCpy $INSTDIR "$CrabotTarget"
  SetErrorLevel $0
  ${If} $0 != 0
    Abort "安装未完成，原文件和准备记录已保留。"
  ${EndIf}
SectionEnd
