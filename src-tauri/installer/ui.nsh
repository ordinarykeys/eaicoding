!define EAICODING_UI_SOURCE_DIR "${__FILEDIR__}"
!macro EAICODING_INSTALLER_STRINGS
!include "${EAICODING_UI_SOURCE_DIR}\strings.nsh"
!macroend
; Harness native NSIS presentation adapted for Tauri. MIT; see THIRD_PARTY_NOTICES.md.
!include "${__FILEDIR__}\theme.nsh"
!include "${__FILEDIR__}\pages.nsh"
!define MUI_CUSTOMFUNCTION_GUIINIT InstallerGuiInit
!insertmacro MUI_INSTFILESPAGE_INTERFACE
Var InstallerProgressWindow

Function InstallerInitialize
    StrCpy $InstallerTheme "auto"
    Call InstallerResolveTheme
    InitPluginsDir
    File /oname=$PLUGINSDIR\7za.exe "${__FILEDIR__}\..\target\installer-ui\7za.exe"
    File /oname=$PLUGINSDIR\7zip-LICENSE.txt "${__FILEDIR__}\..\target\installer-ui\7zip-LICENSE.txt"
    File /oname=$PLUGINSDIR\window-frame.dll "${__FILEDIR__}\..\target\installer-ui\window-frame.dll"
    File /oname=$PLUGINSDIR\brand.bmp "${__FILEDIR__}\..\target\installer-ui\brand.bmp"
    File /oname=$PLUGINSDIR\brand-2x.bmp "${__FILEDIR__}\..\target\installer-ui\brand-2x.bmp"
    File /oname=$PLUGINSDIR\brand-dark.bmp "${__FILEDIR__}\..\target\installer-ui\brand-dark.bmp"
    File /oname=$PLUGINSDIR\brand-dark-2x.bmp "${__FILEDIR__}\..\target\installer-ui\brand-dark-2x.bmp"
FunctionEnd

; Same DWM frame, fixed logical dimensions and control layout as Harness lifecycle.nsh.
Function InstallerGuiInit
    ${If} $PassiveMode = 1
        Return
    ${EndIf}
    HideWindow
    System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i 0x800A0000)'
    System::Call 'user32::GetDC(p $HWNDPARENT) p.r0'
    System::Call 'gdi32::GetDeviceCaps(p r0, i 88) i.s'
    Pop $InstallerDpi
    System::Call 'user32::ReleaseDC(p $HWNDPARENT, p r0)'
    System::Call 'kernel32::MulDiv(i 600, i $InstallerDpi, i 96) i.s'
    Pop $InstallerSize
    System::Call 'user32::GetSystemMetrics(i 0) i.r0'
    System::Call 'user32::GetSystemMetrics(i 1) i.r1'
    IntOp $0 $0 - $InstallerSize
    IntOp $0 $0 / 2
    IntOp $1 $1 - $InstallerSize
    IntOp $1 $1 / 2
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r0, i r1, i $InstallerSize, i $InstallerSize, i 0x34)'
    System::Call '$PLUGINSDIR\window-frame.dll::InstallerApplyFrame(p $HWNDPARENT) i.r0 ?c'
    ${If} $0 < 0
        MessageBox MB_OK|MB_ICONSTOP "$(INSTALLER_UI_ERROR)"
        SetErrorLevel 2
        Quit
    ${EndIf}
FunctionEnd

Function InstallerWelcome
    Call SkipIfPassive
    StrCpy $InstallerPath $INSTDIR
    StrCpy $InstallerPhase "welcome"
    Call InstallerCreate
FunctionEnd

Function InstallerProgressShow
    ${If} $PassiveMode = 1
        Return
    ${EndIf}
    SetAutoClose true
    ShowWindow $mui.InstFilesPage 0
    StrCpy $0 0
    StrCpy $1 "$PLUGINSDIR\brand-2x.bmp"
    ${If} $InstallerTheme == "dark"
        StrCpy $0 1
        StrCpy $1 "$PLUGINSDIR\brand-dark-2x.bmp"
    ${EndIf}
    System::Call '$PLUGINSDIR\window-frame.dll::InstallerShowProgress(p $HWNDPARENT, p $mui.InstFilesPage.ProgressBar, i r0, i $InstallerDpi, w r1, w "$(INSTALLER_NATIVE_PROGRESS)", w "$(INSTALLER_PROGRESS_EXTRACT)", w "$(INSTALLER_PROGRESS_COPY)", w "$(INSTALLER_PROGRESS_REGISTER)", w "$(INSTALLER_PROGRESS_CLEAN)", w "$(INSTALLER_PROGRESS_RUNTIME)") p.s ?c'
    Pop $InstallerProgressWindow
    ${If} $InstallerProgressWindow == 0
        MessageBox MB_OK|MB_ICONSTOP "$(INSTALLER_UI_ERROR)"
        SetErrorLevel 2
        Quit
    ${EndIf}
    ShowWindow $HWNDPARENT 5
FunctionEnd

Function InstallerFinish
    Call SkipIfPassive
    System::Call '$PLUGINSDIR\window-frame.dll::InstallerFinishProgress(p $InstallerProgressWindow) i.r0 ?c'
    ${If} $0 == 0
        Quit
    ${EndIf}
    System::Call 'user32::DestroyWindow(p $InstallerProgressWindow)'
    StrCpy $InstallerPhase "success"
    Call InstallerCreate
FunctionEnd

; Preserve the NSIS caller's registers and error flag, as in Harness's worker callbacks.
!macro InstallerPublishStage Stage
  Push $0
  StrCpy $0 0
  ${If} ${Errors}
    StrCpy $0 1
  ${EndIf}
  System::Store /NOUNLOAD "S"
  System::Call /NOUNLOAD 'user32::SetPropW(p $HWNDPARENT, w "EAiCodingInstaller.Stage", p ${Stage})'
  System::Store "L"
  ${If} $0 == 1
    SetErrors
  ${Else}
    ClearErrors
  ${EndIf}
  Pop $0
!macroend
