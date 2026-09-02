; Inno Setup script for Celestrian (docs/tasks.md B8).
; Driven by scripts\package_windows.cmd, which passes AppVersion and
; SourceExe. The ui\ folder ships beside the exe exactly as the build's
; POST_BUILD copy lays it out (the app serves its WebView from there).

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceExe
  #define SourceExe "..\build\Celestrian_artefacts\Release\Celestrian.exe"
#endif

[Setup]
AppId={{7C2E5B3A-1F8D-4E66-9C0B-2D5A6E7F8A91}
AppName=Celestrian
AppVersion={#AppVersion}
AppPublisher=Celestrian
DefaultDirName={autopf}\Celestrian
DefaultGroupName=Celestrian
OutputDir=..\dist
OutputBaseFilename=Celestrian-{#AppVersion}-windows-setup
Compression=lzma2
SolidCompression=yes
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
LicenseFile=..\LICENSE
UninstallDisplayIcon={app}\Celestrian.exe

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; Flags: ignoreversion
; The UI bundle next to the exe (see CMakeLists.txt POST_BUILD copy).
Source: "..\build\Celestrian_artefacts\Release\ui\*"; DestDir: "{app}\ui"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Celestrian"; Filename: "{app}\Celestrian.exe"
Name: "{autodesktop}\Celestrian"; Filename: "{app}\Celestrian.exe"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Run]
Filename: "{app}\Celestrian.exe"; Description: "Launch Celestrian"; Flags: nowait postinstall skipifsilent
