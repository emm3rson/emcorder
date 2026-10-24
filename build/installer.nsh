!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  # The default upgrade logic preserves missing shortcuts and their old metadata.
  # Repair both links on explicit installs, including upgrades from 0.1.0.
  StrCpy $keepShortcuts "false"
  !insertmacro addStartMenuLink $keepShortcuts
  !insertmacro addDesktopLink $keepShortcuts

  ${ifNot} ${FileExists} "$newStartMenuLink"
  ${orIfNot} ${FileExists} "$newDesktopLink"
    MessageBox MB_OK|MB_ICONSTOP "EmCorder could not create its Start menu or desktop shortcut." /SD IDOK
    SetErrorLevel 2
    Abort
  ${endIf}
!macroend
